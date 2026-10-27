# Stremio Music

Self-hosted Stremio web UI with a Music mode, in one Docker container on one port.
Private use. See [ARCHITECTURE.md](ARCHITECTURE.md) for the design and [PROGRESS.md](PROGRESS.md)
for status. This README grows with each phase. Auth, reverse proxy, HTTPS, Tailscale and sources
come in later phases.

> **Keep the image private.** It contains Stremio's streaming server (`server.js`), which has no
> published source or licence text. Don't push the image to a public registry.

## Run

```sh
docker compose build
docker compose up -d
docker compose logs -f stremio-music
```

Open `http://<server>:8095/`. Movies & TV uses the built-in engine automatically: Settings →
Streaming shows `http://<server>:8095/engine/` as Online.

`docker-compose.yml` joins the existing `media-stack_default` network, so the app can reach
`navidrome:4533` and `qbittorrent:8080` by name. That stack must be up first (`external: true`).

### Environment

| Variable | Default | |
|---|---|---|
| `PUID` / `PGID` | `1000` / `1000` | user the app runs as; owns `/config` and `/cache` |
| `UMASK` | `022` | for files the app creates (use `002` for a group-writable `/music`) |
| `TZ` | `Australia/Melbourne` | |
| `PORT` | `8095` | port inside the container (change the `ports:` mapping instead, normally) |
| `ENGINE_CACHE_SIZE` | `10GB` | engine/torrent cache cap: `20GB`, `512MiB`, `0` (no cache), `unlimited`. Applied on every engine start, overriding the cache size picked in the Movies & TV settings page. |
| `LOG_LEVEL` | `info` | `debug` also logs the engine's own output |

### Volumes

| Path | Contents |
|---|---|
| `/config` | database (`app.db`), settings, later: user plugins, secret key. **Back this up.** |
| `/cache` | engine cache and its settings (`/cache/engine`). Safe to delete while stopped. |
| `/music` | your library, shared read-write with Navidrome (downloads land here). Never chowned; the app warns at start if it can't write. |
| `/downloads` | optional staging area |

### Health

`GET /health` returns `{status, engine: {state, pid, version, restarts, lastExit, lastError}, db}`.
It's HTTP 503 when the engine has failed or the database is unavailable. The Docker
`HEALTHCHECK` uses it, so `docker ps` shows `healthy`/`unhealthy`.

The engine is started, health-checked (every 10 s), restarted on crash (backoff 1 s → 30 s; after
5 crashes in 5 minutes the state is `failed` and it retries every minute) and stopped by the app.
`docker stop` stops it (and any ffmpeg) first, so it takes a few seconds.

## Torrent peers and VPN

**Incoming peer port: not supported by the engine.** Stremio's streaming server only makes
outgoing peer connections. Its torrent library has a `listen()` that v4.20.16 never calls, the same
as in the official desktop apps. So there's no port to open for Movies & TV or music torrents.
Streaming works over outgoing connections. For torrents you want to keep, Phase 9 can hand them to
qBittorrent, which has its own listening port (6881 in your stack).

**Behind a VPN container** (e.g. gluetun). The app joins the VPN container's network namespace, so
all engine traffic goes through the VPN. Ports are then published on the VPN container:

```yaml
services:
  vpn:
    image: qmcgaw/gluetun   # pin a version; configure your provider per its docs
    cap_add: [NET_ADMIN]
    devices: [/dev/net/tun:/dev/net/tun]
    ports:
      - "8095:8095"         # Stremio Music UI, published here instead
    networks: [media]
    # ...provider settings...

  stremio-music:
    image: stremio-music:local
    network_mode: service:vpn   # replaces ports: and networks:
    depends_on: [vpn]
    # environment / volumes as above
```

Notes:
- With `network_mode: service:vpn` the app is on the `media` network through the VPN container,
  so `navidrome` and `qbittorrent` still resolve. Allow LAN/Docker subnets in the VPN's firewall
  (gluetun: `FIREWALL_OUTBOUND_SUBNETS=172.16.0.0/12,192.168.0.0/24`).
- If the VPN container restarts, restart the app too (`docker compose up -d`) to rejoin its
  namespace.
- Only route the app through the VPN if you want *all* its traffic there (Internet Archive,
  Jamendo and Radio Browser requests too).

## Development

Node isn't needed on the host: `scripts/node` runs Node 22 + ffmpeg in an `ubuntu:26.04`
container (`docker/dev.Dockerfile`).

```sh
docker build -t stremio-music-dev:26.04 -f docker/dev.Dockerfile docker
SUBDIR=server scripts/node npm ci
SUBDIR=server scripts/node npm run build
SUBDIR=server scripts/node npm test
```

Dependencies are pinned exactly and installed with `npm install --before=<two weeks ago>`. The
exception is security fixes, which are taken immediately.
