# Stremio Music

Self-hosted Stremio web UI with a Music mode, in one Docker container on one port.
Private use. See [ARCHITECTURE.md](ARCHITECTURE.md) for the design and [PROGRESS.md](PROGRESS.md)
for status. This README grows with each phase; sources and music come in later phases.

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

## Sign-in and users

Everything except `/health`, the login page and the PWA manifest/icons requires signing in.

**First start:** the container log prints a one-time setup code:

```sh
docker logs stremio-music 2>&1 | grep "setup code"
```

Open the app; it redirects to the setup page, where you enter the code and create the admin
account. Alternatively, set `ADMIN_USERNAME` + `ADMIN_PASSWORD` (or `ADMIN_PASSWORD_FILE` for a
Docker secret) to create the admin at first start. These are ignored once any account exists.

**More users / password changes:** open `<app>/account` (change your password, sign out; admins
also add, disable and delete users and reset passwords). From the shell:

```sh
docker exec -it stremio-music sm-user list
docker exec -it stremio-music sm-user add alice [--admin]
docker exec -it stremio-music sm-user passwd alice        # e.g. a forgotten admin password
docker exec -it stremio-music sm-user admin alice on|off
docker exec -it stremio-music sm-user disable|enable|delete alice
```

Details:
- Passwords are hashed with scrypt in `/config/app.db`. Sessions are random tokens in an HttpOnly,
  SameSite=Lax cookie (only a hash is stored), 30 days, extended while you use the app
  (`SESSION_TTL_DAYS`). Changing a password signs out your other devices.
- Login is rate-limited (10 attempts per 15 min per client IP). A username is also locked for 15
  minutes after 5 wrong passwords.
- Requests that change things must come from the app's own origin (CSRF protection).
- The cookie is `Secure` automatically when the request arrived over HTTPS through a trusted proxy.
  Force it with `COOKIE_SECURE=true|false`.

### Auth environment

| Variable | Default | |
|---|---|---|
| `AUTH_MODE` | `local` | `local` = built-in accounts; `proxy` = trust a user header from your authenticating reverse proxy (below) |
| `TRUSTED_PROXIES` | *(none)* | comma-separated IPs/CIDRs of your reverse proxy. Only these may set `X-Forwarded-For/-Proto/-Host/-Prefix`; leave empty when clients connect directly. |
| `ADMIN_USERNAME`, `ADMIN_PASSWORD` / `ADMIN_PASSWORD_FILE` | | create the first admin instead of using the setup code |
| `SESSION_TTL_DAYS` | `30` | |
| `COOKIE_SECURE` | `auto` | |
| `PROXY_USER_HEADER` | `Remote-User` | `proxy` mode: header carrying the user name |
| `PROXY_ADMIN_USERS` | *(none)* | `proxy` mode: comma-separated admins. If empty, the first user seen becomes admin. |

## Reverse proxy, HTTPS and sub-paths

Plain `http://<server>:8095` works on the LAN, but **installing the app (PWA) and its service
worker need a secure context**: HTTPS, or `localhost`. Put it behind a reverse proxy with TLS, or
use Tailscale (next section). The app works at the root of a host (`https://music.example.com/`)
or under a sub-path (`https://media.example.com/stremio/`). It uses relative URLs throughout, so
the proxy only has to strip the prefix.

Always set `TRUSTED_PROXIES` to the proxy's address. On the shared Docker network
(`media-stack_default` = `172.18.0.0/16`) that's `TRUSTED_PROXIES=172.18.0.0/16`. A proxy running on
the host reaches the container from the network gateway (`172.18.0.1`).

The proxy must pass the original `Host` (or `X-Forwarded-Host`) and `X-Forwarded-Proto`, and for a
sub-path `X-Forwarded-Prefix` (used to scope the cookie). Keep buffering off and timeouts long:
video and music are streamed through it.

**Caddy** (TLS automatic):

```caddyfile
music.example.com {
	reverse_proxy stremio-music:8095
}

# or under a sub-path
media.example.com {
	redir /stremio /stremio/
	handle_path /stremio/* {
		reverse_proxy stremio-music:8095 {
			header_up X-Forwarded-Prefix /stremio
		}
	}
}
```

**Nginx:**

```nginx
location = /stremio { return 301 /stremio/; }
location /stremio/ {
    proxy_pass http://stremio-music:8095/;     # trailing slash strips /stremio
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-Host $host;
    proxy_set_header X-Forwarded-Prefix /stremio;
    proxy_buffering off;
    proxy_request_buffering off;
    proxy_read_timeout 1h;
    client_max_body_size 0;
}
```

**Traefik** (labels on the `stremio-music` service; StripPrefix sets `X-Forwarded-Prefix` itself):

```yaml
labels:
  - traefik.enable=true
  - traefik.http.routers.stremio-music.rule=Host(`media.example.com`) && PathPrefix(`/stremio`)
  - traefik.http.routers.stremio-music.entrypoints=websecure
  - traefik.http.routers.stremio-music.tls.certresolver=letsencrypt
  - traefik.http.routers.stremio-music.middlewares=sm-slash,sm-strip
  - traefik.http.middlewares.sm-slash.redirectregex.regex=^(https?://[^/]+/stremio)$$
  - traefik.http.middlewares.sm-slash.redirectregex.replacement=$${1}/
  - traefik.http.middlewares.sm-strip.stripprefix.prefixes=/stremio
  - traefik.http.services.stremio-music.loadbalancer.server.port=8095
```

For a root host, drop the `PathPrefix` and both middlewares.

### Letting the proxy do the sign-in (`AUTH_MODE=proxy`)

If your proxy already authenticates (Authelia, Authentik, oauth2-proxy, Caddy `forward_auth`,
Traefik ForwardAuth…), set `AUTH_MODE=proxy` and `TRUSTED_PROXIES`. The proxy must send the
signed-in user's name in `Remote-User` (or `PROXY_USER_HEADER`). Accounts are created on first
sight. **Only use this behind such a proxy**: the app then refuses every connection that doesn't
come from `TRUSTED_PROXIES` (except `/health`), and it won't start without that setting, because
anyone who can reach port 8095 directly could otherwise claim to be any user. Don't publish port
8095 on the host in this mode; let only the proxy reach it over the Docker network.

## Remote access with Tailscale

Instead of opening ports, reach the app over your tailnet. `tailscale serve` on the host gives it
an HTTPS address with a valid certificate (`https://<host>.<tailnet>.ts.net`), which also makes
the PWA installable on your phone:

```sh
sudo tailscale serve --bg http://127.0.0.1:8095
```

Then set `TRUSTED_PROXIES=172.18.0.1` (`tailscale serve` connects through the Docker gateway) and
`COOKIE_SECURE=true`, and keep using the app's own sign-in. Only devices on your tailnet can reach
it. (Tailscale also passes `Tailscale-User-Login`, so `AUTH_MODE=proxy` with
`PROXY_USER_HEADER=Tailscale-User-Login` is possible, but then the LAN port must not be reachable
by anything else; the built-in login is the simpler choice.)

## Installing the app (PWA)

Over HTTPS, open the app and install it: on an **Ubuntu laptop** use Brave, Chrome, Chromium or
Edge (the install icon at the right of the address bar, or the menu → *Install Stremio Music…* /
*Cast, save and share* → *Install page as app*). It
then gets its own window and launcher entry, and media keys work through the desktop's media
controls. **Firefox on Linux can't install web apps**, though the app works fine in a normal
Firefox tab. On Android use **Add to Home Screen** / **Install app**.

No HTTPS yet and only using it on the LAN? Chromium-based browsers can treat this one address as
secure: open `brave://flags/#unsafely-treat-insecure-origin-as-secure` (Chrome:
`chrome://flags/…`), add `http://<server>:8095`, enable, relaunch. That's for your own laptop only; HTTPS (proxy or Tailscale) is the proper fix. The service
worker caches only the UI shell (scripts, styles, fonts, images) so the app opens fast. Pages,
your data, the API and streams always come from the server, and signing in is always checked
there.

### Brave

Works with Shields on: the app only talks to its own origin, except Movies & TV's normal calls to
Stremio's own services and addons. Casting from Movies & TV needs Brave's *Media Router* setting
(Settings → Extensions), which is off by default. If you use *Forget me when I close this site* or
clear cookies on exit, you'll have to sign in each time; add the app as an exception.

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
