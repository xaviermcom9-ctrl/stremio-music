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

## Phase 2 – Container & hidden engine (done, awaiting go-ahead)

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

### Next
- User: go-ahead for Phase 3 (auth, reverse proxy/sub-path, PWA, mobile).
