# Stremio Music – progress

Project brief: Stremio web fork + Music mode, single Docker container (phases 1–10).
Upstream studied at: stremio-web 8329565 (2026-10-26), stremio-core 0293018,
stremio-shell c3a8bcb, stremio-shell-ng c6aae4e, stremio-addon-sdk ec4e0a4.

## Phase 1 – Recon & architecture (done)

### Done: code recon
- **stremio-web**: GPL-2.0, React 18 + webpack, pnpm 11, Node >= 22. State layer comes from
  the npm package `@stremio/stremio-core-web` 0.65.1 (prebuilt WASM, no Rust build needed).
  - Default engine URL `http://127.0.0.1:11470/` in `src/common/CONSTANTS.js`
    (`DEFAULT_STREAMING_SERVER_URL`).
  - `?streamingServerUrl=<url>` query param (`src/App/SearchParamsHandler.js`) adds/selects a
    server URL. shell-ng passes the URL this way (`constants.rs:web_endpoint_with_streaming_server`).
  - Upstream Dockerfile: `pnpm i --frozen-lockfile && pnpm build` -> `build/`, served statically.
  - GPL-2.0: no obligation for private use; publishing the image publicly requires publishing
    the fork's source.
- **Official engine supervision**
  - Qt shell (`main.qml`, `stremioprocess.cpp`): `node server.js`, reads stdout for
    `EngineFS server started at <url>` -> that URL is the server address. On crash: event +
    error dialog (max 5), restart after a 10 s timer; "fastReload" for intentional restarts.
    server.js pinned via `server-url.txt` (https://dl.strem.io/server/v4.20.16/desktop/server.js).
  - shell-ng (`stremio_server/process.rs`, `job.rs`): same readiness line, 30 s startup timeout
    (kill + retry), Windows Job Object KILL_ON_JOB_CLOSE so ffmpeg descendants die with the shell.
    Container equivalent: tini + process-group kill.
- **server.js v4.20.16**: 6.6 MB webpack bundle. Embedded package.json: `stremio-server`,
  author Smart Code LTD, `license: "MIT"` – but no licence text is shipped and source isn't
  public (private git deps). **Flagged as ambiguous**: download at image build (pinned version +
  sha256), never commit/redistribute; private image only.
  Env: APP_PATH, FFMPEG_BIN, FFPROBE_BIN, NO_CORS, CASTING_DISABLED, DISABLE_CACHING.
  Endpoints seen: /create, /hlsv2/, /probe, /subtitles.vtt, /transcode, /settings, /stats.json,
  /casting, /network-info, /device-info, /heartbeat, /{infoHash}/{fileIdx}.
  Known quirk (from ~/stremio-docker = tsaridas/stremio-docker, MIT): cache always under
  ~/.stremio-server regardless of APP_PATH.
- **Recommendation: Option A** (official server.js). Movies & TV parity needs its HLS
  transcoding/probe/subtitle/settings endpoints; Option B would be a large reimplementation.
  Music torrents can also use `/{infoHash}/{fileIdx}` -> one torrent engine, one cache cap.

### Decisions
- Reuse ~/resonance code (approved by user): port server modules (protocol client, playback/
  transcode/FLAC seek, downloads pipeline, Navidrome/qBittorrent/MusicBrainz clients) into the new
  Fastify backend; rewrite its reference-addon sources as `MusicSource` plugins; music UI rebuilt in
  React inside the stremio-web fork. Only copy what's needed; ~/resonance itself left untouched.
- Project location: /home/xavier/stremio-music.

### Decisions (2026-10-27, user)
- Engine: **Option A** (official server.js v4.20.16, private image only).
- External port: **8095**.
- SQLite: **node:sqlite** (built-in).
- Backend deps approved: fastify, @fastify/static, @fastify/http-proxy, @fastify/cookie,
  @fastify/rate-limit, zod, music-metadata.
- Music sources server-side, separate from stremio-core's addon collection (recommended; user
  did not object).

### Done: run + verify (2026-10-27)
- Snap blocker fixed (native Claude Code, apt Docker 29.9.2). Note: Docker shows 0 containers –
  media-stack (navidrome, qbittorrent…) and resonance are currently NOT running (images still present).
- server.js v4.20.16 on ubuntu:26.04 with distro Node 22.22.1 + ffmpeg 8.0.1: starts, endpoints 200,
  software HLS transcode (HEVC→H.264 segments) works. HW-accel probes fail cleanly (no GPU).
- Engine binds all interfaces (`server.listen(11470)`, HTTPS 12470, no host option) ->
  `engine/bind-loopback.cjs` preload forces 127.0.0.1; verified via /proc/net/tcp.
  Pin recorded in `engine/server.version`.
- Upstream stremio-web built with its own Dockerfile; served behind nginx with engine at `/engine/`
  (same origin): board + detail pages load, Settings→Streaming shows `/engine/` Online (v4.20.16).
  Relative asset paths + hash router -> sub-path works.
- Playback NOT verified: headless Chrome can't decode the HEVC sample and stremio-video plays
  pasted URLs directly. Needs a real-browser check by the user.
- ARCHITECTURE.md written (engine, container, supervision, single origin, auth, plugin system).

## Phase 2 – Container & hidden engine (done)

Built + running: `docker compose up -d` -> http://192.168.0.13:8095 (healthy).
- `web/` = upstream stremio-web 8329565 snapshot + patches (web/PATCHES.md): same-origin engine URL
  as default (fresh profiles switch silently from core's 127.0.0.1 default), stremio-video relative
  engine paths (pnpm patch), COMMIT_HASH from env.
- `server/` = Fastify backend (TS, node:test): engine supervisor (readiness line + /heartbeat, 30 s
  startup timeout, heartbeat 10 s / 3 misses, backoff 1→30 s, 5 crashes/5 min -> failed + 60 s
  retry, process-group stop with SIGKILL escalation, crash log tail), `/engine/*` proxy (dynamic
  upstream, self-URL rewrite to loopback, 503 when down), `/health`, static UI, node:sqlite at
  /config/app.db with migrations. 16 tests, run inside `docker build`.
- Dockerfile: ubuntu:26.04 toolchain/web/server/runtime stages; runtime = nodejs ffmpeg tini tzdata;
  server.js via `ADD --checksum`; tini -g; entrypoint chowns /config,/cache (and an empty root-owned
  /downloads), never /music; drops to PUID:PGID with setpriv; HEALTHCHECK on /health. Image 1.08 GB.
- docker-compose.yml joins `media-stack_default`; README covers env, volumes, health, VPN
  (network_mode: service:vpn) and why there's no incoming peer port.
- Deps: fastify 5.12.7 (security fix, newer than the 2-week rule), @fastify/static 10.1.6,
  @fastify/http-proxy 11.6.4, zod 4.6.7; dev: typescript 7.0.2, @types/node 22.20.5. npm audit: 0.

Verified in the container (2026-10-27): only :8095 public, engine on 127.0.0.1:11470/12470; runs as
1000:1000; engine settings cacheRoot=/cache/engine, cacheSize=10 GB; HLS transcode through the proxy
with a public self-referencing mediaURL (probe/master/variant/init/segment all 200); SIGKILL of the
engine -> back in ~1 s; `docker stop` 0.15 s, exit 0; headless Chrome: no modal on a fresh profile,
engine auto-selected + Online, Server Version 4.20.16, cache 9.32 GiB.

Not verified: Navidrome/qBittorrent by name (media-stack is down); real-browser video playback.

### Notes / follow-ups
- The core's built-in `http://127.0.0.1:11470/` entry still shows in Settings → Streaming; picking it
  breaks playback (upstream behaviour, harmless).
- `/health` must stay unauthenticated in Phase 3 (Docker HEALTHCHECK).
- Phase 3 must keep auth on `/engine/*` compatible with the engine's own loopback fetches
  (they bypass the proxy, so fine) and handle external players/casting (signed URLs).

## Phase 3 – Access, auth & web app (done)

User note (2026-10-27): the **Ubuntu laptop is the main client**; phone secondary. Test desktop first.

- Auth (`server/src/auth/`): local accounts (scrypt N=2^15) + sessions in SQLite (cookie token, only
  its sha256 stored; HttpOnly, SameSite=Lax, Secure over HTTPS, path = X-Forwarded-Prefix; 30 days
  sliding). Login rate limit 10/15 min/IP (@fastify/rate-limit) + 5-failure username lockout;
  same reply for unknown user/wrong password (dummy hash for timing). Origin/Sec-Fetch-Site check
  on unsafe methods. First admin via one-time setup code in the log, or ADMIN_USERNAME/PASSWORD(_FILE).
  Pages: /login, /setup, /account (password change, sign out, admin user management), strict CSP.
  `sm-user` CLI via docker exec. `AUTH_MODE=proxy` (Remote-User header, only from TRUSTED_PROXIES,
  refuses to start without it; direct connections 403). trustProxy now only TRUSTED_PROXIES
  (was `true` → spoofable IPs).
- Guard: navigations → relative redirect to login (sub-path safe); others 401 + `x-auth-required`.
  Public: /health, login/setup, auth assets, manifest, favicons/images/fonts.
- Web: `src/sm/authGuard.js` (fetch 401 → login?next=…), SW precache excludes HTML, manifest renamed.
- README: sign-in, users, auth env, Caddy/Nginx/Traefik (root + sub-path), proxy auth, Tailscale,
  PWA install on Ubuntu (Chromium-based; Firefox on Linux can't install), LAN flag workaround.
- Deps added: @fastify/cookie 11.1.3, @fastify/rate-limit 11.2.1. npm audit 0. 35 tests.

Verified (throwaway instance + Caddy `tls internal` at /stremio/, headless Chrome, 412px phone and
1440px desktop): setup with wrong/right code; app + engine work after setup; account page adds a
user; sign-out → engine 401; HTTPS sub-path: redirect to /stremio/login?next=%2F, cookie
Secure/HttpOnly/Lax/path=/stremio/, engine at https://…/stremio/engine/ Online; SW active at
/stremio/ scope caching 75 shell assets, no HTML/api/engine; reload after logout → login page;
session loss mid-use → fetch guard → login. (SW registration needs a trusted cert: with Caddy's
internal CA untrusted Chrome refuses; worked with the CA accepted.)

Not done / notes:
- Your instance is fresh: create the admin with the setup code from `docker logs stremio-music`
  (a new code is printed on every start until an account exists).

GitHub: private repo https://github.com/xaviermcom9-ctrl/stremio-music (gh logged in on the server).
User's own admin account created via setup (2026-10-27). Browser: Brave on the Ubuntu laptop.

## Phase 4 – Tab switch (done)

- `web/src/sm/ModeSwitch`: "Movies & TV | Music" segmented control (tablist, arrow keys; icons only
  under 800px). Shown in upstream's top bar (main tabs) and in the Music top bar.
- `web/src/music/`: Music route tree at `#/music/*` (view 1, board stays cached underneath): own
  layout (top bar, sidebar → bottom tab bar ≤640px), placeholder pages Home/Search/Library/Radio/
  Downloads/Sources (admin only), account menu (Account, Movies & TV settings, Sign out), own icons
  (note, radio, sources) where Stremio's set has none.
- Last mode per user, server-side (`user_prefs` table, `GET /api/me/prefs`, `PUT /api/me/prefs/:key`):
  `ModeTracker` saves mode changes; a fresh open on the default page restores Music; deep links win.
  Each mode remembers its last page (switching back returns there).
- Shift+M toggles (in upstream shortcuts.json, so it's listed in the Ctrl+/ help).
- Upstream profile menu: "Account · <user>" and "Sign out of Stremio Music" (separate from Stremio.com).
- Upstream patches: 5 files, ~30 lines (web/PATCHES.md). 36 backend tests.

Verified (headless Chrome, 1440px laptop first, 412px Android): switch + navigation, Shift+M both
ways returning to the previous page (radio ↔ discover), saved mode, fresh open → #/music, deep link
#/library not overridden (and saves movies), both menus, admin-only Sources, shortcut in help,
phone bottom tab bar, no horizontal scroll, no console errors (only upstream view-transition notices).

Fix after deploy (user didn't see Phase 4): the bundle folder was `<upstream commit>-sm` for every
build while `<folder>/scripts|styles` are served immutable for a year, so browsers kept old JS.
Dockerfile now appends a hash of the web sources (`…-sm-<hash>`), so every change gets new URLs.

Notes: fresh profiles get upstream's seasonal "event" modal (upstream behaviour). Six bottom tabs
truncate "Downloads" on narrow phones (admins only); revisit in Phase 8.

## Phase 5 – Source plugin system (done)

Backend (`server/src/music/`, `server/src/music-sources/`):
- `music-sources/sdk.ts`: the `MusicSource` interface (manifest, catalog/meta/streams/test, hooks,
  settings schema, ctx). Types only; shipped as `sdk.d.ts` to folder plugins.
- `music/protocol/`: Resonance's protocol client ported (manifest validation, request URLs, cache,
  limiter, HTTP addon client); only `"music"` addons are used (brief).
- `music/runtime.ts`: SourceRuntime: manifest validation (zod), Stremio manifest, ctx.fetch (rate
  limit, UA, 15 s timeout, 10 MB cap, host allow-list incl. redirects), response cache, output
  validation (bad items dropped + logged), stats, log ring, per-call 30 s timeout.
- `music/folder.ts` + `plugin-host.ts`: folder plugins in their own process with Node's permission
  model (read own folder only; no writes/child processes/workers/addons; no env; 128 MB); fetch and
  logs relayed to the parent; crash restart (3 per 5 min). JS only: Ubuntu's Node has no TS support.
- `music/registry.ts`: built-in + folder + remote sources; enabled/priority in SQLite (`sources`),
  settings global/per-user (`source_user_settings`), secrets AES-256-GCM (`secrets.ts`,
  APP_SECRET_KEY / _FILE, else /config/secret.key + UI warning).
- `music/routes.ts`: `/sources/<id>/…` (Stremio addon endpoints, signed-in), `/api/sources…`
  (admin: list, add URL, remove, enable, settings, order, test, refresh, logs, reload plugins;
  users: own per-user settings), `/api/music/…` (sources, catalog, search, meta, streams;
  allSettled, per-source errors; proxyHeaders stripped → `needsProxy`).
- `_template` (demo data, offline) + `npm run new-source <name>` (built-in TS, registered) /
  `--folder` (JS plugin) + container commands `sm-new-source`, `sm-test-source`.
- Contract tests `npm run test:sources` (fixtures.json, offline) run in docker build for built-ins,
  the template, and the template as a sandboxed folder plugin. 52 unit/integration tests.
Web: Music → Sources page (admin: add addon URL, reload plugins, plugin load errors, cards with
enable switch, ↑↓ order, settings form from schema with masked secrets, test, logs + stats, remove;
users: their per-user settings only). Sources nav item now visible to all users (deviation from
"Sources (admin)": per-user logins need a place).
Docs: PLUGINS.md; README "Music sources"; ARCHITECTURE notes.

Verified (throwaway instance + local mock addon; laptop then phone): sm-new-source in the container
(files owned by PUID), sm-test-source 9/9, Reload plugins loads it and lists a broken plugin's
error, movies-only addon rejected, music addon added, settings save (secret shows "Saved", never
returned by the API, encrypted in SQLite), Test connection uses settings + user, logs, reorder,
disable removes it from /api/music/sources, non-admin sees only per-user sources, phone layout OK,
sandbox blocks reading /etc/hostname (unit test).

Notes: no built-in sources yet (Phase 6), so the Sources page starts empty. Built-in sources
need recorded fixtures.json to pass the contract in the build.

## Phase 6 – Built-in sources (done)

Media stack started by Claude on user request (2026-10-27): navidrome, lidarr, prowlarr, qbittorrent,
nzbget all up; names resolve from the app container. User's Navidrome: 0.64.2, one account
("admin", password unknown to Claude), 2 tracks. Untouched: development used a throwaway Navidrome
(`server/scripts/dev/navidrome-fixture.sh`, generated FLAC/MP3 library).

Framework additions:
- `ctx.proxyUrl(url, {headers})` + streams with `proxyHeaders` -> `api/proxy/<AES-GCM token>` (source,
  URL, headers, 7-day expiry); `/api/proxy/:token` re-checks enabled source + host allow-list (also
  after redirects), forwards Range, streams the body, aborts upstream on disconnect. Fastify
  maxParamLength raised to 4096 (tokens are long; default 100 made every proxy URL 404).
- Contract tests: `ignoreParams`, `--record <id>` with `SOURCE_SETTINGS` (secrets scrubbed to
  "FIXTURE"), fake proxy URLs; artist metas no longer need streams.
- `src/net.ts`: Node's 250 ms happy-eyeballs attempt timeout made every request to Europe fail from
  Melbourne (IPv4 timed out, IPv6 unroutable in Docker) -> 2.5 s everywhere (backend, CLI, contract
  runner, engine via --network-family-autoselection-attempt-timeout).
- `/api/music/nowplaying?id=` reads ICY StreamTitle server-side (`music/icy.ts`); refuses private/
  loopback/link-local addresses on every hop with DNS pinned (SSRF: station URLs are public data).
- ytId streams from remote addons are marked play-only, not downloadable.
- SDK: `albums` on artist metas.

Sources (all pass the contract live and offline from fixtures; 57 unit/integration tests):
1. **Navidrome** ✅ Subsonic token auth, server URL global (default http://navidrome:4533), login per
   user. Catalogs: recently added, most played, starred, random, artists, playlists, by genre, search3.
   Meta: album/artist(albums + top songs or newest albums' tracks)/playlist/track. Streams: original +
   MP3 320 transcode, via proxy (covers too). Hooks: star/unstar, scrobble. Verified e2e against the
   throwaway server: covers image/jpeg, audio 206 FLAC with Range, no credentials in browser
   responses, tampered token 404, star/scrobble visible in Navidrome, wrong password message.
   Not downloadable (it's your own library). Playlist write-back not done (Phase 8 decision).
2. **Internet Archive** ✅ catalogs: popular this week, LMA recent, LMA bands (band -> shows),
   netlabels (+genre), 78 RPM (georgeblood, audio only), search across music collections. Best
   format per track FLAC > VBR MP3 > other (alternatives offered). stream_only/access-restricted
   items (e.g. GD soundboards): private files skipped, not downloadable. Licence from licenseurl
   (CC parsed), else rights text, else item page link. Fixtures 743 KB (IA lists every derivative).
3. **Jamendo** ✅ (client ID from the user 2026-10-27; stored encrypted in the user's instance via a
   script inside the container; never in git: recorded with SOURCE_SETTINGS, scrubbed). v3.0 API per
   current docs + terms (non-commercial; credit + link each item; minimal caching; downloads only
   where audiodownload_allowed). Storage URLs carry no credentials -> direct (not proxied).
   Quirks handled: /tracks lags new releases (track ids from albums carry `@album`, streams fall back
   to /albums/tracks); id lookups intermittently return empty (~1 in 3) -> retried twice.
4. **Free Music Archive** ✅ option A (user): archive.org `freemusicarchive` mirror via the shared
   archive.org factory (`internet-archive/archive.ts`, IA refactored onto it, its fixtures unchanged).
   Catalogs: most downloaded, remix-friendly (no ND), latest in the archive (2018), search. Licence +
   link/attribution to the original FMA page. No genres in the mirror's metadata.
5. **Radio Browser** ✅ server discovery via all.api.radio-browser.info (or fixed server), own UA,
   click reporting via scrobble hook, catalogs: stations near you (default AU, setting), top voted,
   trending, by genre, search; live, no download. Verified live: AU stations, now-playing titles.

FMA report (user chose A): official API gone (/api and /api/get/* -> 404, no replacement documented); the live
site (Tribe of Noise) is HTML only -> scraping, fragile and needs a ToS review; archive.org has a
`freemusicarchive` mirror: 16,797 releases added 2011-2018 (frozen), ~half with a CC licence URL,
same stable API as the Internet Archive source. Recommendation: FMA via the archive.org mirror.

UI parts of the Radio brief (LIVE badge, no seek, Radio page) come with the player/UI (Phases 7-8).

User's instance: all five built-ins registered and active except Navidrome (needs the user's own
Navidrome login under Sources -> Navidrome -> Your settings).

## Phase 7 – Playback (done, awaiting go-ahead)

Server (`server/src/music/playback.ts`, `upstream.ts`):
- `POST /api/music/play`: stream + delivery choice from client caps (direct / proxy / transcode /
  engine / youtube); data saver prefers a small lossy stream, else transcodes from the lossy version.
- `/api/proxy/:token` rebuilt on Node http(s): allowed hosts may be private; public tokens (radio,
  mixed content, remote addons) public-only with pinned DNS + IP-literal check on every hop
  (a test caught Node skipping `lookup` for IP literals: fixed). Keep-alive + redirect cache.
- `/api/transcode/:token`: ffmpeg -> MP3 via loopback proxy (internal key, loopback only), `t` seek,
  max 4 concurrent; ffmpeg spawn errors handled (would have crashed the process).
- `/api/music/played` -> scrobble hooks (non-live at 50 %, live at start); `/api/music/torrent/:ih`
  (audio files only); `torrent:<ih>:<idx>` ids play through the engine; `player_state` table +
  `GET/PUT /api/me/player`. 68 server tests incl. real ffmpeg transcode (ffmpeg added to build stage).
Web (`web/src/music/player`, `components`, `pages/Pages.js`):
- Player store: one `<audio>`, queue/shuffle/repeat/volume, live reconnect (backoff 1-30 s), hls.js
  (declared: same tarball stremio-video uses), Media Session, ICY now-playing polling, data saver
  per device, local + server snapshots, "Continue where you left off on <device>?".
- YouTube via the official IFrame player, visible 200x200 (ToS), play-only.
- Player bar (desktop) / compact bar (phone), now-playing view, queue panel; Space/←/→ in Music.
- Functional browse pages (Phase 8 polishes): Home rows by source priority, item pages (album,
  artist, playlist, station, track, licence/attribution, torrent albums), Radio (rows + genres,
  LIVE), Search (grouped by kind, source badges).
- Fixed: Sources page CSS leaked global `input`/`select` rules into the whole app.

Verified in real Chrome (headless, proprietary codecs) against a throwaway instance with all five
sources + throwaway Navidrome + a local torrent swarm (scratch-only WebTorrent seeder + tracker +
mock addon): IA FLAC direct (advancing), next/seek (ArrowRight +10 s), queue, data saver -> server
MP3 96 resuming mid-track, AU radio (AAC+, LIVE, ICY title), mixed content (https page -> proxied
live AAC), Navidrome via proxy, Jamendo direct, torrent album -> audio files as tracks -> FLAC via
engine, resume banner on a second (phone) device, Media Session metadata, no console errors.
Measured: data-saver seek 6-9 s (was 22-40 s before keep-alive + redirect cache + lossy input);
Jamendo's CDN is slow to start from Melbourne (~10 s), not a bug.

Not done / notes:
- Live reconnect and the YouTube embed are implemented but not exercised end-to-end (no reliable way
  to drop a live stream or reach YouTube deterministically in the test setup).
- Seeking in a converted track restarts ffmpeg (seconds); a server-side transcode cache would make
  it instant (possible later).
- Browse pages are functional, not final: Phase 8 brings the full layout, library, artist merging.

## Phase 8 – Music UI (done, awaiting go-ahead)

Server:
- Library (`music/library.ts`, schema version 6): liked songs + saved albums/artists/stations/playlists
  (snapshots), playlists with entries (add, remove, move, rename, describe), per-user, limits
  (20k items, 500 playlists, 5k tracks each). `GET/PUT/DELETE /api/library…`.
- Navidrome sync (decided here, see README): likes both ways (new hooks `listLiked`; the source is the
  authority for its own items; a failed star refuses the like), playlists one way and opt-in per
  playlist (`savePlaylist`/`deletePlaylist`; Navidrome tracks only; POST form body for long lists;
  re-creates a playlist deleted in Navidrome). SDK + PLUGINS.md updated.
- Cross-source: `/api/music/artist` merges an artist across sources (MBIDs where known, else
  normalised names/aliases; same-source albums never collapsed), `/api/music/alternatives` for the
  album source picker. MusicBrainz lookups (artist by id/name + aliases, 1 req/s, 30-day SQLite
  cache, ambiguous names = no match) only with `MUSICBRAINZ_CONTACT` set (API rules need a contact).
- `/api/music/sources` reports `sync: {likes, playlists}` per source.
- Fixes found while testing: Jamendo names were HTML-escaped (`podr&oacute;ż`) -> decoded; Jamendo
  album track durations were strings (no times shown) -> numbers, and the contract now checks that
  track durations are numbers. Fastify `maxParamLength` deprecation -> `routerOptions`.
- 78 unit/integration tests (10 new), contract 54.
Web:
- Layout: sidebar = nav + Playlists (Liked songs + yours, "+" new); phones: 5 bottom tabs (Sources
  moved to the account menu: fixes the truncated "Downloads" from Phase 4).
- Home: greeting, library shortcut tiles, then rows grouped by source (header with icon) in priority
  order; radio gets one row + "All radio".
- Search: Artists / Albums / Tracks / Stations / Playlists, source badges, query kept in the URL.
- Album page: cover, Play/Shuffle, save, ⋯, track list with likes and per-track menus, licence line,
  **Source** picker when other sources have the album. Track rows: tap to play; ⋯ = Play next, Add
  to queue, Add to playlist…, Go to album/artist.
- Artist page: source's page at once, then the merged one (badges per source, Popular top 5/10,
  Albums with source badges).
- Library (filters, sort, Sync), Liked songs, playlist pages (edit, sync to Navidrome, move up/down,
  remove, delete with confirmation), saved stations shelf on Radio, hearts in the player bar and
  now-playing view (+ its ⋯ menu), toasts, playlist picker dialog.

Verified against a throwaway instance + throwaway Navidrome (with a "Marcus Scriptor – Songs of Tao"
album added to match a real Jamendo artist), real Chrome, laptop 1440px then Android phone 412px:
like -> star in Navidrome, star/unstar in Navidrome -> library, synced playlist in Navidrome with
only its Navidrome tracks (description, removal, deletion followed); artist page merged Navidrome +
Jamendo with "Songs of Tao" once and the Jamendo copy as alternative; album picker switches to the
Jamendo copy; mixed playlist plays, move up, bar heart state; Library/Liked/Radio stations/Home
tiles; phone: 5 tabs, nothing truncated, no horizontal scroll, Sources in the account menu, row
menus, tap-to-play, now-playing like + menu; no console errors.

Not done / notes:
- MusicBrainz lookups are tested with a fake server only: no contact is configured (asking the user).
- Merging depends on other sources' search returning artists: Jamendo and Navidrome do; Internet
  Archive/FMA search returns releases, so they add nothing to merged artist pages (their albums
  still show up in the album source picker).
- Reordering is Move up/down in the track menu (no drag and drop yet).
- Emulating a phone needs a mobile User-Agent: upstream blanks the viewport meta on desktop UAs.

## Phase 9 – Downloads (done, awaiting go-ahead)

Server (`server/src/downloads/`, schema version 7; dependency `music-metadata` 12.2.0, MIT, as approved):
- Queue per track, grouped (album / track / list); SQLite state, restart-safe (re-queued; HTTP and
  engine downloads resume with Range). Concurrency setting (default 2).
- Enqueue: album/playlist meta (all tracks, tags from the meta), track (with the album it came from),
  torrent albums (files listed via the engine), or a list (your playlists / Liked songs). Refused up
  front: sources without downloads (Navidrome: "your own library already"), live radio, artists.
- Transfer: http(s) via our loopback proxy (same SSRF rules as playback), torrents via the engine, or
  qBittorrent (optional): magnet stopped at metadata, only wanted files, `useDownloadPath=false`,
  one add per torrent, waits for the file at the mapped path, keeps seeding. Best stream first,
  falls back to the next downloadable one; errors name the source ("Jamendo: the server answered
  HTTP 500").
- Process: format sniffed from bytes, tags (source metadata wins for title/album/numbering; file tags
  fill gaps and keep MusicBrainz ids), cover embedded (existing embedded covers kept), cover.jpg,
  `/music/Album Artist/Album/NN - Title.ext` (safe names), files owned by PUID:PGID (process user),
  skip or "(2)" when the file exists. LICENSE.txt per album folder for CC tracks. Navidrome
  `startScan` via a new `libraryChanged` hook, 15 s after the last download.
- API + SSE live updates; pause/resume/cancel/retry per item or group; remove from list; save to
  device (Content-Disposition); admin settings (qBittorrent password encrypted; Test connection
  checks login + folder and writes `.ndignore`).
- Fixes found while testing: Jamendo list endpoints also return intermittent empty "success" pages
  (Popular tracks was empty and got cached) -> first pages retried like id lookups.
- 89 server tests (11 new: real ffmpeg tagging, cover, LICENSE, rescan hook, skip, pause/resume
  with Range, not-audio failure, isolation between users, SSE, settings secrecy).
Web: "Download" in track menus (sources that allow it), "Download album/track" on item pages,
"Download all" on playlists and Liked songs; Downloads page (live via EventSource, group + item
progress, actions, save to device, admin settings panel); badge with the number in progress.

Verified on a throwaway instance (own /music, /downloads), throwaway Navidrome on the same folder,
local torrent swarm, throwaway qBittorrent 5.2.4 (same folder mounted as /data/library/music):
IA 78 RPM FLAC, Jamendo CC FLAC (tags, cover, LICENSE.txt), FMA MP3 (+LICENSE.txt), seeded torrent
album via the engine, then via qBittorrent (skip, then "(2)"; torrent kept seeding in the hidden
folder), a broken Jamendo file failing with a clear message, 52 MB LMA FLAC paused at 2.5 MB and
resumed, Navidrome scan started (15 songs, 7 folders: torrent folder ignored), restart re-queued
pending items. Real Chrome laptop + phone: menus (none on Navidrome), toasts, live page, pause/resume
from the UI, save to device, settings, 5 tabs + badge, no console errors.

Not done / notes:
- Navidrome's `startScan` needs a Navidrome admin login; non-admin users rely on Navidrome's own scan.
- Jamendo only allows downloads per track where the artist permits it; popular albums often don't.
- Internet Archive titles are whatever the uploader tagged (some are file names).
- The qBittorrent integration was tested against a throwaway 5.2.4, not your instance (no login).

## Phase 10 – Deploy & docs (done)

- Version 1.0.0 (`server/src/version.ts`: /health, User-Agent, backups, image label). OCI labels with
  version + git revision (`REVISION=$(git rev-parse --short HEAD) docker compose build`).
- Pinned: Ubuntu base by digest (update procedure in README), server.js by URL + sha256, npm/pnpm by
  lockfiles (exact versions). Compose: `STREMIO_MUSIC_IMAGE` for a private registry; `.env.example`.
- `sm-backup` (`server/src/backup.ts`): SQLite online backup + secret.key + folder plugins into
  `/config/backups/stremio-music-<date>.tar.gz` (0600, keeps 7, no overwrite within a second);
  restore documented (and tested).
- README rewritten: install, full environment table, volumes, health, sign-in, proxies/HTTPS,
  Tailscale, PWA, sources (three ways), connecting Navidrome, library, playback, downloads,
  connecting qBittorrent (incl. its temporary password), updating + pinning + registry,
  backup/restore + cron, troubleshooting, VPN, uninstall, development.

Tested on this host (Ubuntu Server 26.04.1 LTS, Docker 29.9.2, Compose 5.6.1):
- Fresh deploy with the compose file (own name/port/folders): healthy in 6 s, setup code in the log,
  admin created with it, volumes owned by PUID:PGID.
- Upgrade from the Phase 8 image (built from a5f8835) on the same volumes: schema 6 -> 7, users,
  sessions, playlist, saved album, folder plugin, global setting and an encrypted per-user secret
  all intact (secret decrypts), new Downloads API working.
- Backup while running -> restore into a new folder per README -> same data, secret decrypts.
- `docker restart`: serving again ~1 s later. Engine SIGKILL: /health "degraded"/"restarting", back to
  "ok"/"running" within 3 s (restarts: 1), container stayed healthy.
- `docker stop` with the engine and an ffmpeg transcode streaming: 171 ms, exit code 0, nothing left.

### Status
All ten phases done. Possible later work (not requested): drag-and-drop playlist ordering, a
transcode cache for instant seeking in converted tracks, MusicBrainz lookups (set
MUSICBRAINZ_CONTACT).
