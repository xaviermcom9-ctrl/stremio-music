# Stremio Music – architecture

Status: approved 2026-10-27 (Phase 1).

Upstream pinned for this design: stremio-web `8329565` (5.0.0-beta.43, GPL-2.0),
`@stremio/stremio-core-web` 0.65.1, streaming server `server.js` v4.20.16.

---

## 1. Findings that drive the design

### 1.1 How the official apps run the streaming server

| | Qt shell (`stremio-shell`) | `stremio-shell-ng` (Rust) |
|---|---|---|
| Launch | `node server.js` as a child (`stremioprocess.cpp`) | same (`stremio_server/process.rs`) |
| Readiness | parses stdout for `EngineFS server started at <url>`; that URL becomes the server address | same line, 30 s startup timeout, then kill + retry |
| Crash | error event + dialog (max 5), restart after a 10 s timer; "fastReload" for intentional restarts | restart; Windows Job Object `KILL_ON_JOB_CLOSE` so ffmpeg descendants die with the shell |
| URL to UI | injected into the web UI | `?streamingServerUrl=<url>` on the web UI URL (`constants.rs`) |

In the web UI, `src/App/SearchParamsHandler.js` reads `?streamingServerUrl=`.
Loopback and default URLs are applied silently. Any other URL raises a confirmation modal.
The fallback is `CONSTANTS.DEFAULT_STREAMING_SERVER_URL = http://127.0.0.1:11470/`.

### 1.2 What I verified by running it (2026-10-27)

Engine tested in `ubuntu:26.04`, using Ubuntu's own `nodejs` 22.22.1 and `ffmpeg` 8.0.1:

- server.js v4.20.16 (sha256 `88e887f0…6e28`) starts and prints the readiness line.
  `/heartbeat`, `/settings`, `/stats.json`, `/network-info` and `/device-info` all return 200.
- **Software HLS transcoding works with ffmpeg 8.** `/hlsv2/…/master.m3u8` → `video0.m3u8` →
  `init.mp4` + `segment1.m4s` (HEVC → H.264) all returned 200. The hardware-acceleration
  probes (qsv/nvenc/vaapi) fail cleanly because there is no GPU. stremio-docker pins
  jellyfin-ffmpeg 4.4, but we don't need to.
- `APP_PATH` sets both the config and cache root (`cacheRoot` = APP_PATH in v4.20.16).
  The cache cap is the engine's `cacheSize` setting (default 2 GiB).
- **Bind address:** server.js calls `server.listen(11470)` with no host, so it binds all
  interfaces, falling back to ports 11471–11474. It also always opens HTTPS on 12470.
  No env var or flag changes this. Fix: a ~20-line preload, `node -r bind-loopback.cjs server.js`,
  that forces every `net.Server.listen` onto 127.0.0.1. With it, `/proc/net/tcp` shows only
  `127.0.0.1:11470` and `127.0.0.1:12470`. server.js itself is not modified.

Upstream UI (official Dockerfile build) behind one origin, with nginx standing in for our
backend: `/` → UI, `/engine/` → engine:

- Board (62 posters) and detail pages load (Cinemeta).
- Settings → Streaming shows `http://<host>/engine/` **Online**, Server Version 4.20.16.
  Core calls `/engine/settings`, `/casting`, `/network-info` and `/device-info`, so a
  **sub-path engine URL works with stremio-core**.
- Webpack emits relative asset paths and the router is hash-based (`#/…`), so the UI already
  works under a sub-path.
- Playback could **not** be confirmed in headless Chrome. That test used the engine's own HEVC
  sample (stremio-video plays it directly because `canPlayType` says yes, then fails to decode).
  The engine side of transcoding is verified directly (above). **A real-browser check by you is
  pending** (see PROGRESS.md).

### 1.2b Found while building Phase 2

- **stremio-video ignores the engine URL's path.** It builds engine URLs as
  `url.resolve(serverUrl, '/hlsv2/…')` (also `/subtitles.vtt`, `/proxy/`, `/opensubHash`,
  `/{infoHash}/create`, …). The leading slash drops `/engine/`, so transcoding, subtitles and
  torrents would break under any sub-path. Core's own calls (`settings`, `casting`, …) join
  correctly, which is why Settings still showed Online. Fixed with a pnpm patch making those
  paths relative (`web/patches/`, listed in `web/PATCHES.md`). Same requests, correct prefix.
- **The engine fetches URLs the UI gives it.** E.g. `hlsv2/probe?mediaURL=<public>/engine/<ih>/0`
  is fetched by the engine/ffmpeg itself. A public URL would leave the container and come back
  through the reverse proxy and login. The `/engine` proxy rewrites query values that point at
  `<this host>/…/engine/…` to `http://127.0.0.1:11470/…`.
- **No incoming torrent peers.** torrent-stream's `engine.listen()` is never called in v4.20.16:
  the engine only dials out (same as the desktop apps). The brief's "optional incoming peer port"
  can't apply to the engine; qBittorrent (Phase 9) keeps its own port.

### 1.3 Licensing

| Component | Licence | Consequence |
|---|---|---|
| stremio-web | GPL-2.0 | Fine for private use. Publishing the image publicly means publishing our fork's source. |
| stremio-core-web (npm, WASM) | MIT | fine |
| server.js (streaming server) | Embedded package.json says MIT, but **no licence text is shipped and the source is not public** | **Flagged.** Downloaded at image build (pinned URL + sha256), never committed to git, image kept private. Don't push the image to a public registry. |
| ffmpeg (Ubuntu package) | LGPL/GPL build | fine for private use |
| Stremio name/logos | trademarks | Movies & TV keeps upstream branding (private use). Music uses our own name/icon; no Spotify assets. |

---

## 2. Engine choice

**Recommendation: Option A – the official server.js inside the container.**

- Movies & TV parity means "upstream unchanged". The UI and stremio-video depend on server.js
  endpoints: `/hlsv2/*` (probe + HLS transcode), `/subtitles.vtt`, `/opensubHash`, `/settings`,
  `/stats.json`, `/casting`, `/{infoHash}/{fileIdx}`, `/create`. Option B would mean
  reimplementing and then tracking all of these.
- It works on the 26.04 base with distro Node + ffmpeg (verified above). No custom ffmpeg build.
- Music torrents (Phase 7) use the same engine: `/{infoHash}/{fileIdx}` fetches only the
  selected file, and `/{infoHash}/stats.json` lists files. One torrent engine, one cache, one cap.
- Risks: closed source with an unclear licence (mitigated above), pinned to one version
  (upgrades are deliberate: bump URL + sha256), and some outbound calls we don't control (e.g.
  the 12470 HTTPS certificate fetch from api.strem.io when "remote HTTPS" is enabled; it is off
  by default).

Option B (WebTorrent + ffmpeg in Node) stays the fallback if the server.js licence becomes a
problem. Resonance already has a WebTorrent engine we could reuse for music-only, but Movies &
TV transcoding parity would be a large project.

**Decided: Option A** (2026-10-27).

---

## 3. Container layout

```
                       LAN  (one port, 8095)
                              │
┌─────────────────────────────▼──────────────── container ───────────────┐
│ tini (PID 1, -g: signals go to the whole process group)                 │
│  └─ node backend  (Fastify, non-root PUID:PGID)                         │
│      ├─ /                    built stremio-web fork (static, SPA)       │
│      ├─ /engine/*            reverse proxy → 127.0.0.1:11470            │
│      ├─ /sources/<id>/…      built-in + folder plugins as Stremio addons │
│      ├─ /api/*               auth, music API, sources admin, downloads,  │
│      │                       playback proxy/transcode, player state      │
│      ├─ /health              backend + engine status (Docker HEALTHCHECK)│
│      ├─ engine supervisor ──► node -r bind-loopback.cjs server.js        │
│      │                         (127.0.0.1:11470/12470 only) ─► ffmpeg    │
│      └─ plugin hosts ───────► one child process per folder plugin (IPC)  │
│                                                                          │
│ volumes: /config  /cache  /music  /downloads                             │
└──────────────────────────────────────────────────────────────────────────┘
        │ docker network (media-stack_default): navidrome:4533, qbittorrent:8080
```

- **Base image:** `ubuntu:26.04` for both build and runtime stages. Ubuntu packages Node 22.22
  (satisfies stremio-web's `node >=22` and runs server.js) and ffmpeg 8, so there's no second Node
  runtime and no custom ffmpeg. The build stage adds pnpm (via corepack) and compilers if a native
  module is needed. Runtime: `nodejs ffmpeg tini ca-certificates`, plus a user created from
  `PUID`/`PGID` at start-up (gosu-style drop via `setpriv`, which is already in util-linux).
- **Single origin:** the UI uses relative URLs for everything (`engine/`, `api/`, `sources/`),
  resolved against `document.baseURI`. The same image works at `/` or at a sub-path behind a
  proxy. There's no CORS anywhere: the engine runs with `NO_CORS=1` and is only reachable through
  the backend.
- **Fork patches to Movies & TV (minimal, listed in `web/PATCHES.md`):**
  1. `DEFAULT_STREAMING_SERVER_URL` = `new URL('engine/', document.baseURI)`, treated as a
     default in `SearchParamsHandler` (no modal).
  2. Mode switch + `#/music/*` route registration.
  3. Phase 3: the service worker caches only the UI shell, never `api/`, `engine/` or `sources/`.

  Everything else stays upstream. The fork lives in `web/` as an imported upstream snapshot plus
  our commits on top, so upstream bumps are a rebase.

### 3.1 Engine supervision (replicates shell-ng inside the container)

| | |
|---|---|
| Start | `spawn(node, ['-r', bind-loopback.cjs, server.js], {detached: true})` (own process group). Env: `APP_PATH=HOME=/cache/engine`, `NO_CORS=1`, `FFMPEG_BIN`/`FFPROBE_BIN`. |
| Ready | readiness line on stdout **and** `GET /heartbeat` = 200; 30 s timeout → kill group, retry |
| Configure | after ready: `POST /settings` with `cacheSize` from `ENGINE_CACHE_SIZE` (e.g. `20GB`), so the cap is enforced by the engine itself |
| Monitor | `/heartbeat` every 10 s; 3 misses → restart |
| Crash | restart with backoff 1 s → 2 s → … 30 s; after 5 crashes in 5 min → state `failed` (shown in /health and the UI), keep retrying every 60 s |
| Stop (SIGTERM from `docker stop`) | stop accepting requests → `SIGTERM` to the engine's process group (kills ffmpeg children too) → wait 5 s → `SIGKILL` the group → exit. tini `-g` reaps anything left. Target: `docker stop` < 3 s. |
| Logs | engine stdout/stderr → backend log with an `[engine]` prefix, ring buffer shown in the admin UI |
| Health | `/health` → `{status, engine: {state, pid, uptime, restarts, version}, db, sources}`; HTTP 503 while the engine is `failed` |

### 3.2 Auth across the single origin

The session cookie (HttpOnly, SameSite=Lax, Secure when behind HTTPS) covers `/api`, `/engine`
and `/sources`. All browser requests are same-origin, so `<video>`, `<audio>`, stremio-core's
`fetch` and HLS segment requests all send it. Exception: "open in external player"/casting from
Movies & TV needs a URL that works without a cookie. That gets short-lived signed URLs, deferred
to when we hit it. `AUTH_MODE=proxy` (trusting e.g. `Remote-User` from an authenticating proxy)
is the documented opt-out.

---

## 4. Music data flow

```
Music UI (React, web/src/music)  ──►  /api/music/*  (aggregator: catalogs, search, meta,
                                         streams, library, player state)
                                         │  speaks only the Stremio addon protocol
             ┌───────────────────────────┼─────────────────────────┐
     built-in plugins             folder plugins             remote addons
   (in-process, /sources/…)   (child process, /sources/…)  (https URL, type "music")
```

- The Music UI does **not** use stremio-core's addon collection. Music sources are per app user,
  live server-side, and never get synced into your Stremio account's addon list. This keeps
  Movies & TV untouched. **Decided.** (The alternative, reusing core models for music, couples the
  two modes and pushes music addons into the Stremio account).
- The aggregator (ported from Resonance's `protocol/`: manifest validation, request building,
  LRU cache honouring `cacheMaxAge`/`staleRevalidate`, per-addon limiter, `Promise.allSettled`
  fan-out) is the only protocol consumer. That gives the UI one API, merged results with source
  badges, and per-source errors that don't break a page.
- Built-in and folder plugins are also exposed over HTTP at `/sources/<id>/manifest.json`, so
  they're real Stremio addons (contract tests hit them over HTTP; other clients could use them).
  The aggregator calls built-ins in-process to skip the HTTP hop.

---

## 5. Source plugin system

### 5.1 `MusicSource` interface (TypeScript)

```ts
export interface MusicSource {
  manifest: SourceManifest;
  /** optional; called once with resolved settings */
  init?(ctx: SourceContext): Promise<void>;
  catalog?(req: { catalogId: string; extra: CatalogExtra }, ctx: SourceContext): Promise<MusicMeta[]>;
  meta?(req: { id: string }, ctx: SourceContext): Promise<MusicMeta | null>;
  streams?(req: { id: string }, ctx: SourceContext): Promise<MusicStream[]>;
  /** "Test connection" button */
  test?(ctx: SourceContext): Promise<{ ok: boolean; message: string }>;
  /** optional integrations (Navidrome): scrobble, star/unstar, playlists */
  hooks?: Partial<SourceHooks>;
}

export interface SourceManifest {
  id: string;                    // [a-z0-9-]+, also the id prefix: "<id>:<native id>"
  name: string; version: string; description: string;
  icon: string;                  // file inside the plugin, served by the backend
  capabilities: {
    catalogs: boolean; search: boolean; meta: boolean; streams: boolean;
    downloadable: boolean; live: boolean;
  };
  catalogs: CatalogDef[];        // Stremio catalog defs, type always "music"
  settings: SettingsSchema;      // drives the auto-generated form
  perUser?: boolean;             // settings are per app user (Navidrome) vs global
  rateLimit: { requestsPerSecond: number; burst: number; concurrency: number };
  cache: { catalogTtl: number; metaTtl: number; streamTtl: number }; // seconds
  userAgent?: string;            // overrides the default "StremioMusic/<ver> (+contact)"
  allowedHosts?: string[];       // what ctx.fetch may call (folder plugins: enforced)
}

type SettingsSchema = Record<string, {
  type: 'string' | 'url' | 'number' | 'boolean' | 'select';
  label: string; default?: unknown; required?: boolean;
  secret?: boolean;              // encrypted at rest, never sent back to the browser
  options?: { value: string; label: string }[]; help?: string;
}>;

interface SourceContext {
  settings: Record<string, unknown>;   // decrypted, for this user (perUser) or global
  user: { id: string; name: string } | null;
  fetch: typeof fetch;                 // rate-limited, cached, UA set, host-allowlisted, timeout
  cache: { get; set };                 // namespaced KV
  log: Logger;
  signal: AbortSignal;
}
```

The adapter (`defineSource()` → Stremio addon router) handles ids, `type: "music"`,
`cacheMaxAge` from `manifest.cache`, input validation, and the limiter. A plugin only writes
API-mapping code.

### 5.2 Meta / track shape (documented in PLUGINS.md)

Standard Stremio meta, `type: "music"`, plus an optional `music` object (extra fields are
allowed by the protocol and ignored by other clients):

```jsonc
{
  "id": "navidrome:al-123", "type": "music", "name": "Album title",
  "poster": "...", "posterShape": "square", "releaseInfo": "1997",
  "music": {
    "kind": "album",              // artist | album | track | station | playlist
    "artist": "Name", "artistId": "navidrome:ar-9",
    "mbid": "musicbrainz release id",   // used to merge across sources
    "licence": { "name": "CC BY-SA 4.0", "url": "...", "attribution": "..." },
    "live": false
  },
  "videos": [                     // = tracks
    { "id": "navidrome:tr-1", "title": "Track", "episode": 1, "season": 1,   // track no / disc no
      "released": "1997-01-01T00:00:00Z",
      "music": { "duration": 241, "artist": "Name", "mbid": "recording id" } }
  ]
}
```

Streams: standard Stremio streams (`url`, `infoHash`+`fileIdx`, `ytId`), plus
`behaviorHints.music = { downloadable, live, codec, bitrate, filename }`. Built-in sources that
need credentials never return the upstream URL. They return `/api/play/<signed token>`, which the
backend resolves and proxies (Phase 7). For third-party addons without a `music` object, the
aggregator falls back to Resonance's heuristic (`videos` → album, otherwise track; `channel` →
artist).

### 5.3 Three ways to add a source

1. **Built-in:** `server/src/music-sources/<name>/index.ts` exporting a `MusicSource`, listed in
   `server/src/music-sources/index.ts`. `_template/` plus `npm run new-source <name>` scaffolds
   one. In the container, `sm-new-source <name>` writes a folder plugin to
   `/config/music-sources/<name>` instead.
2. **Folder plugin:** `/config/music-sources/<name>/index.js` (an ES module whose default export is
   the `MusicSource`, manifest included; no separate `plugin.json`). Loaded at start-up or via
   "Reload plugins". *Implemented as JavaScript:* Ubuntu's Node 22 is built without type
   stripping, so the scaffolder emits the template compiled by `tsc` plus `sdk.d.ts`.
   - Each runs in its **own child process**, not a `worker_thread`, because Node's permission
     model is per process: `node --permission --allow-fs-read=<plugin dir>`. So no fs writes, no
     reading /config or /music, no child processes, no native addons, no workers;
     `--max-old-space-size=128`; RPC over IPC with per-call timeouts.
   - **Limit to flag:** Node 22's permission model does not restrict the network. `ctx.fetch`
     enforces `allowedHosts`, but plugin code could still call the global `fetch` itself. Plugins
     in /config are therefore trusted code you installed. The UI says so.
   - The manifest is validated (zod) before the process starts. Load, validation or crash errors
     show on the Sources page with logs; the backend never crashes because of a plugin.
3. **Remote addon URL:** paste a manifest URL; it's fetched server-side and validated (Resonance
   `manifest.ts`), and accepted only if `types` includes `"music"`. Shown with its own
   name/icon; no settings form.

### 5.4 Storage, settings, secrets

- SQLite at `/config/app.db`: users, sessions, sources (kind, id, url/path, enabled, priority,
  global settings), per-user source settings, library (likes, saved albums, playlists), player
  state, downloads. **Decided: built-in `node:sqlite`** (no native dependency; still has an
  experimental warning in Node 22).
- Secret fields are encrypted with AES-256-GCM using a key from `APP_SECRET_KEY` or
  `APP_SECRET_KEY_FILE` (Docker secret). If neither is set, a key is generated into
  `/config/secret.key` (0600) and the UI warns that the key sits next to the data.
- Sources page: admins get enable/disable, reorder priority, settings form, Test connection,
  status (last error, latency, rate-limit hits) and log tail. *Implemented:* other users see the
  page too, but only sources with per-user fields (their own logins), because per-user
  credentials need a home.
- `npm run test:sources`: a contract suite run against every built-in plugin and `_template`
  (manifest valid, catalogs return valid metas, meta ids round-trip, streams have a source,
  `downloadable`/`live` consistent, respects the limiter). Runs in the Docker build stage, so a
  failing plugin fails the image build.

---

## 5b. Playback (Phase 7, as built)

- `POST /api/music/play {id, caps}`: the browser sends what `<audio>` can play (canPlayType), HLS
  support, https or not, and its data-saver cap; the server picks a stream (source priority, then the
  source's order; lossless if playable) and a delivery: `direct`, `proxy` (credentials / mixed
  content), `transcode` (ffmpeg -> MP3; unsupported codec or over the cap; input preferably the lossy
  version, which seeks fast), `engine` (torrents) or `youtube` (official embed, play-only).
- `/api/proxy/:token`: AES-GCM tokens (source, URL, headers, expiry, public flag). Hosts the source
  allows may be private (Navidrome); anything else must be public: DNS pinned, IP literals checked,
  every redirect hop re-checked. Keep-alive agents + a 10-minute redirect cache (archive.org).
- `/api/transcode/:token?br&t`: ffmpeg reads through `/api/proxy` over loopback with a per-process
  key (the auth hook accepts it from loopback only), so the same host rules apply; `t` = start time.
- Browser: one `<audio>` + player store (`web/src/music/player`): queue/shuffle/repeat, live
  reconnect with backoff, hls.js for HLS radio, Media Session, scrobble at 50 % / 4 min (radio at
  start), per-device data saver, local + server snapshot (`player_state`), "continue on this device".

## 6. Repository layout (proposed)

```
web/                      stremio-web fork (upstream 8329565 + our commits); music UI in web/src/music/
server/                   Fastify backend (TypeScript)
  src/engine/             supervisor, bind-loopback.cjs, proxy
  src/auth/  src/db/  src/api/  src/playback/  src/downloads/
  src/music/              aggregator + protocol client (from Resonance)
  src/music-sources/      navidrome/ internet-archive/ jamendo/ fma/ radio-browser/ _template/
  test/
engine/server.version     URL + sha256 of server.js (downloaded during docker build)
Dockerfile  docker-compose.yml  ARCHITECTURE.md  PLUGINS.md  README.md  PROGRESS.md
```

## 7. Dependencies (approved 2026-10-27)

Backend: `fastify`, `@fastify/static`, `@fastify/http-proxy`, `@fastify/cookie`,
`@fastify/rate-limit`, `zod`, `music-metadata` (Phase 9). Password hashing uses `node:crypto`
scrypt (no dependency). Runtime apt packages: `nodejs ffmpeg tini ca-certificates`.
All versions pinned. Resonance's WebTorrent dependency is **not** carried over (the engine covers
torrents).
