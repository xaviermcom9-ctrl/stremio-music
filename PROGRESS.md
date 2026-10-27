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

## Phase 6 – Built-in sources (in progress: waiting on the user for Jamendo key + FMA choice)

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
3. **Jamendo** ⏸ implemented from the current v3.0 docs (verified, incl. API terms: non-commercial,
   attribute + link each item, minimal caching, downloads only where allowed); stream URLs carry the
   client ID -> proxied. NOT registered yet: needs the user's free client ID to record fixtures.
4. **Free Music Archive** ⏸ investigated, waiting for the user's choice (see report below).
5. **Radio Browser** ✅ server discovery via all.api.radio-browser.info (or fixed server), own UA,
   click reporting via scrobble hook, catalogs: stations near you (default AU, setting), top voted,
   trending, by genre, search; live, no download. Verified live: AU stations, now-playing titles.

FMA report: official API gone (/api and /api/get/* -> 404, no replacement documented); the live
site (Tribe of Noise) is HTML only -> scraping, fragile and needs a ToS review; archive.org has a
`freemusicarchive` mirror: 16,797 releases added 2011-2018 (frozen), ~half with a CC licence URL,
same stable API as the Internet Archive source. Recommendation: FMA via the archive.org mirror.

UI parts of the Radio brief (LIVE badge, no seek, Radio page) come with the player/UI (Phases 7-8).

### Next
- User: Jamendo client ID (to record fixtures + enable), FMA choice; then Phase 7.
