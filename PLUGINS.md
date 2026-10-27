# Writing a music source

Every music source is a **Stremio addon** of type `music`. The Music UI only speaks that one
protocol, so a new source never needs UI changes. There are three ways to add one:

| | What | Language | Where | Runs |
|---|---|---|---|---|
| **Built-in** | ships with the app | TypeScript | `server/src/music-sources/<id>/` | in the backend |
| **Folder plugin** | your own code, no rebuild | JavaScript (ES module) | `/config/music-sources/<name>/` | its own sandboxed process |
| **Remote addon** | any Stremio addon with `"music"` in `types` | anything | a URL | elsewhere |

Built-in and folder sources implement the same `MusicSource` interface
(`server/src/music-sources/sdk.ts`, also shipped as `sdk.d.ts`). The backend serves each one as
a Stremio addon at `<app>/sources/<id>/manifest.json`. That's useful for debugging, and the
endpoints require signing in.

---

## Quick start: folder plugin (no rebuild)

```sh
docker exec -it stremio-music sm-new-source my-source     # creates /config/music-sources/my-source
# edit /config/music-sources/my-source/index.js
docker exec -it stremio-music sm-test-source /config/music-sources/my-source
```

Then open **Music → Sources → Reload plugins** (or restart the container). The new source is
enabled and goes last in the order. Load errors appear on the Sources page instead of crashing
anything.

The scaffold is the template (`server/src/music-sources/_template`), compiled to JavaScript:
`index.js`, `icon.svg`, `sdk.d.ts` (types for your editor; `// @ts-check` is on), and
`package.json`. It serves demo data, so it passes the contract tests and shows up straight away.
Replace that data with calls to your service.

Folders whose name starts with `.` or `_` are skipped (rename to `_my-source` to disable one).

## Quick start: built-in source (in the repo)

```sh
cd server
npm run new-source my-source      # creates src/music-sources/my-source/ and registers it in index.ts
# implement it, record fixtures.json (below)
npm run build && npm run test:sources
```

Built-ins must pass the contract tests: they run in `docker build`, so a failing source fails the
image.

---

## The interface

```ts
const source: MusicSource = {
  manifest: { /* see below */ },
  async catalog(req, ctx) { return [/* MusicMetaPreview */]; },  // lists & search
  async meta(id, ctx)     { return /* MusicMeta | null */; },     // artist / album / track / station page
  async streams(id, ctx)  { return [/* MusicStream */]; },        // how to play a track or station
  async test(ctx)         { return { ok: true, message: '…' }; }, // "Test connection" (optional)
  hooks: { scrobble, setLiked },                                  // optional integrations
};
export default source;
```

Every method gets a `ctx` (see [The context](#the-context-ctx)). Return `null` / `[]` for ids you
don't know, and throw for real failures. The error is shown on the Sources page, and other
sources keep working.

### Manifest

| Field | |
|---|---|
| `id` | `[a-z0-9-]`, unique. **Every meta and track id you return must start with `<id>:`.** That's how requests get routed back to your source. |
| `name`, `version` (semver), `description` | shown on the Sources page |
| `icon` | file name in the source folder (`icon.svg`/`.png`) or an https URL |
| `attribution` | e.g. "Data from radio-browser.info", shown with the source |
| `capabilities` | `catalogs`, `search`, `meta`, `streams`, `downloadable`, `live`; must match what you implement (checked) |
| `catalogs` | `[{ id, name, kind?, extra? }]`. `extra` lists accepted parameters: `search`, `genre` (with `options`), `skip`, or your own; `isRequired: true` for search-only catalogs. A catalog with no required extra is a *feed* and appears on Home. |
| `settings` | the settings form; see [Settings](#settings) |
| `rateLimit` | `{ requestsPerSecond, burst, concurrency }`, enforced on `ctx.fetch` |
| `cache` | `{ catalog, meta, streams }` seconds; responses are cached for this long |
| `userAgent` | defaults to `StremioMusic/<version> (self-hosted)`. Set it when an API asks for an identifying UA. |
| `allowedHosts` | hosts `ctx.fetch` may call (`api.example.org`, `*.example.org`). Hosts of `url`-type settings are added automatically. |

### Ids and the meta shape

Metas are standard Stremio metas with `type: "music"` and a `music` object (extra fields are
allowed by the protocol):

```jsonc
// catalog item (MusicMetaPreview)
{
  "id": "my-source:album:123",
  "type": "music",
  "name": "Album title",
  "poster": "https://…/cover.jpg", "posterShape": "square",
  "releaseInfo": "1997", "genres": ["Jazz"],
  "music": {
    "kind": "album",                  // artist | album | track | station | playlist
    "artist": "Name", "artistId": "my-source:artist:9",
    "mbid": "MusicBrainz release id",  // lets the UI merge the same album across sources
    "trackCount": 12,
    "licence": { "name": "CC BY 4.0", "url": "https://…", "attribution": "…" }
  }
}

// meta (MusicMeta): same, plus `videos` = tracks for albums/playlists/artists
{
  "...": "...",
  "videos": [
    { "id": "my-source:track:456", "title": "Track", "episode": 1, "season": 1,   // track no, disc no
      "released": "1997-01-01T00:00:00Z",
      "music": { "artist": "Name", "duration": 241, "mbid": "recording id" } }
  ]
}
```

- **album / playlist / artist**: `videos` are the tracks (an artist's top tracks). Link to albums
  with `links: [{ name, category: "album", url }]` or a catalog.
- **track**: no `videos`; streams are requested with the meta id.
- **station** (radio): no `videos`, `music.live: true`.
- Always set `licence` when the source has one (Creative Commons, public domain…). The UI shows it,
  and Phase 9 writes it next to downloads.

### Streams

Return one or more ways to play an id (a track id from `videos`, or a track/station meta id):

```jsonc
{ "url": "https://…/track.flac", "name": "FLAC",
  "behaviorHints": { "music": { "downloadable": true, "codec": "flac", "bitrate": 900, "filename": "01 - Track.flac" } } }
{ "infoHash": "…40 hex…", "fileIdx": 3, "name": "Torrent" }     // played through the built-in engine
{ "ytId": "…" }                                                 // play-only, never downloadable
```

- **Exactly one** of `url`, `infoHash` or `ytId` per stream.
- `downloadable: true` only when the source's terms allow downloading (and the capability says so).
  Live streams are never downloadable.
- **Never put credentials in a URL the browser could see.** If fetching needs auth, put the headers
  in `behaviorHints.proxyHeaders.request`. The backend strips them from what the browser receives
  and fetches the stream itself (the playback proxy arrives in Phase 7).

### Settings

```ts
settings: {
  server:   { type: 'url',    label: 'Server URL', default: 'http://navidrome:4533', required: true },
  username: { type: 'string', label: 'Username', perUser: true, required: true },
  password: { type: 'string', label: 'Password', perUser: true, secret: true, required: true },
  bitrate:  { type: 'select', label: 'Max bitrate', options: [{ value: '320', label: '320 kbit/s' }] },
}
```

- Types: `string`, `url`, `number`, `boolean`, `select`.
- `perUser`: every app user enters their own value (e.g. a Navidrome login). Other fields are set
  once by the admin.
- `secret`: encrypted at rest (AES-256-GCM, key from `APP_SECRET_KEY` / `APP_SECRET_KEY_FILE`,
  else `/config/secret.key`) and never sent back to the browser.
- `required`: until set, the source shows **Needs setup** and stays out of the Music UI (per user,
  for per-user fields).
- `ctx.settings` holds the merged values: defaults ← admin values ← the user's own values,
  secrets decrypted.

### The context (`ctx`)

| | |
|---|---|
| `ctx.settings` | see above |
| `ctx.user` | `{ id, username }` of the app user asking, or `null` |
| `ctx.fetch(url, { method, headers, body, timeoutMs })` | rate-limited per source, your User-Agent, 15 s timeout, 10 MB cap, only `allowedHosts`. Returns a buffered response (`ok`, `status`, `headers`, `text()`, `json()`). Use it for all requests: it's what makes the rate limit and the allow-list work. |
| `ctx.log.debug/info/warn/error(msg)` | shown in the source's **Logs** on the Sources page |

### Respect the service

- Set `rateLimit` to what the API's terms allow, and `cache` generously.
- Send the User-Agent the service asks for, and show its attribution (`attribution`, `licence`).
- Only mark things `downloadable` when the terms allow it.

---

## Folder plugin sandbox

Each folder plugin runs in its own Node process with the permission model on:

- can read only its own folder (no `/config`, `/music`, other plugins, or the app's secrets);
- can't write files, start processes, use worker threads or load native addons;
- gets no environment variables from the app; memory is capped at 128 MB;
- calls time out after 35 s; a crashed process restarts on the next call (at most 3 times in
  5 minutes).

**Limit:** Node 22 can't block network access, so plugin code *could* call the global `fetch`
itself, bypassing the rate limit and allow-list. Treat plugins in `/config/music-sources` as code
you trust, like anything else you install. Always use `ctx.fetch`.

Plugins are plain JavaScript ES modules (`index.js` with `export default`). The Ubuntu Node build
has no TypeScript support, so compile TypeScript yourself if you prefer it. npm packages work only
if bundled into the folder; Node built-ins (e.g. `node:crypto`) are fine.

---

## Contract tests and fixtures

```sh
npm run test:sources                                    # built-ins + template (in docker build too)
docker exec -it stremio-music sm-test-source /config/music-sources/my-source
```

The suite checks:
- the manifest validates, both as a source manifest and as a Stremio manifest;
- feed catalogs return valid items whose ids carry the source prefix;
- search works, and meta and streams round-trip;
- capability flags are consistent, and unknown ids return `null` / `[]`;
- `test()` succeeds;
- no request was made without a recorded response.

Requests are answered from `fixtures.json` in the source folder, so tests run offline and
deterministically:

```jsonc
{
  "settings": { "server": "http://navidrome:4533", "username": "demo", "password": "demo" },
  "responses": {
    "GET https://api.example.org/albums?limit=50": { "status": 200, "body": { "albums": [] } },
    "GET https://api.example.org/album/1": { "body": "<xml>…</xml>", "headers": { "content-type": "text/xml" } }
  }
}
```

Keys are `<METHOD> <exact URL>`. A missing fixture fails the test and names the URL to record.

---

## Remote addons

Paste any addon manifest URL on the Sources page (`https://…/manifest.json` or `stremio://…`). It's
accepted only if its `types` include `"music"`, and only its `music` catalogs are used. It doesn't
need the `music` object: without `music.kind`, a meta with `videos` counts as an album and one
without as a track. YouTube `ytId` streams are play-only.
