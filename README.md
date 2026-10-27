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

## Music sources

Music comes from sources, managed under **Music → Sources**. Admins see everything; other users
see only the sources that need their own login. There are three kinds:

- **Built-in:**
  - **Navidrome:** your library. The admin sets the server URL (default `http://navidrome:4533`), and
    each user enters their own Navidrome login under **Your settings**.
  - **Internet Archive:** Live Music Archive, netlabels, 78 RPM records. No account needed.
  - **Radio Browser:** internet radio. "Stations near you" defaults to Australia, which you can
    change in its settings.
  - **Jamendo:** needs a free client ID from [devportal.jamendo.com](https://devportal.jamendo.com),
    for non-commercial use only.
  - **Free Music Archive:** Creative Commons releases up to 2018, from FMA's mirror on archive.org.
    FMA's own API no longer exists.
- **Folder plugins**: drop a folder into `/config/music-sources/` and press **Reload plugins**.
  Start one with `docker exec -it stremio-music sm-new-source my-source`, and test it with
  `docker exec -it stremio-music sm-test-source /config/music-sources/my-source`.
- **Remote addons**: paste a Stremio addon manifest URL. It's used only if it declares the `music`
  type.

On the Sources page you can enable or disable each source and change its order (which sets Home
and search order). You can also edit settings, **Test connection**, and see status, errors and
logs. Writing a source is covered in [PLUGINS.md](PLUGINS.md).

**Secrets** (passwords, API keys) entered in source settings are encrypted at rest. Set the key
yourself, or a random one is created in `/config/secret.key`, next to the data:

| Variable | |
|---|---|
| `APP_SECRET_KEY` | passphrase (16+ characters) for encrypting source secrets |
| `APP_SECRET_KEY_FILE` | the same, read from a file, e.g. a Docker secret (`/run/secrets/…`) |
| `MUSIC_SOURCES_DIR` | folder plugin directory (default `/config/music-sources`) |

Changing the key makes saved secrets unreadable: they have to be entered again.

## Library

**Library** keeps, per user and on the server: **Liked songs**, saved albums, followed artists, saved
radio stations, and your **playlists** (which can mix tracks from any source). Tap a heart to like
or save; every track's **⋯** menu has *Play next*, *Add to queue*, *Add to playlist…*, *Go to album*
and *Go to artist*. Playlists are listed in the sidebar (on phones: under Library); a playlist's ⋯
menu edits its details, reorders and removes tracks, and deletes it.

**Navidrome sync** (for users who entered their Navidrome login):

- **Likes, both ways:** liking a Navidrome song, album or artist stars it in Navidrome, and stars
  made in Navidrome's own apps show up here (the Library's **Sync** button pulls them at once).
- **Playlists, one way, if you ask:** a playlist's ⋯ menu → **Sync to Navidrome** keeps a Navidrome
  playlist of the same name up to date with its *Navidrome* tracks (other sources' tracks can't be
  stored there). Stopping the sync leaves the Navidrome copy alone; deleting a synced playlist
  deletes the copy too. Navidrome's own playlists are on Home under Navidrome → Playlists.

**Artists across sources:** an artist page also looks for the artist on your other sources and
merges popular tracks and albums (with source badges); an album page shows a **Source** picker when
another source has the same album. Matching uses MusicBrainz IDs where sources provide them
(Navidrome does, from your tags), otherwise names. With `MUSICBRAINZ_CONTACT` set, the server also
asks MusicBrainz for the artist's id and aliases (so "Beatles" finds "The Beatles"): at most one
request per second, answers cached for 30 days.

| Variable | |
|---|---|
| `MUSICBRAINZ_CONTACT` | an email address or URL, sent in the User-Agent as [MusicBrainz requires](https://musicbrainz.org/doc/MusicBrainz_API/Rate_Limiting); unset = no MusicBrainz lookups |

## Playback

Music plays in the browser. For each track the server picks a stream from what your browser can
play and how it should be delivered:

- **Direct:** public files the browser can fetch itself (e.g. Internet Archive FLAC).
- **Through the server:** anything that needs credentials (Navidrome), and plain-`http` streams
  when the app is opened over HTTPS (mixed content). Seeking works, live radio streams through.
- **Converted on the server (ffmpeg → MP3):** formats your browser can't play (e.g. ALAC), and
  **Data saver**: in the now-playing view (tap the bar, or the ⌃ button), pick a maximum bitrate
  for *this device*, e.g. 96 kbit/s on your phone. Seeking a converted track restarts it at the
  new position on the server, which takes a few seconds.
- **Torrents** (from addons that return them) play through the built-in engine; an album
  torrent's audio files are listed as tracks, and only the files you play are downloaded.
- **YouTube** streams (from addons) play in YouTube's own small player in the corner, as YouTube
  requires; they are never downloaded.

Live radio has no seeking, reconnects by itself when the stream drops, and shows what's playing
when the station sends it. The queue (shuffle, repeat, volume) survives navigating around the app
and is saved for your account: open the app on another device and it offers to **continue where
you left off**. Media keys, the desktop's media controls and the phone's lock screen work through
the browser. Keyboard (in Music): Space play/pause, ←/→ seek 10 s (Shift: 30 s), Shift+M switch
mode. Plays are reported to the sources that ask for it (Navidrome scrobbles at half a track,
Radio Browser counts a station start).

## Downloads

Albums and tracks from sources that allow it (Internet Archive, Jamendo where the artist allows
it, Free Music Archive, torrents from addons) can be saved into your music library: **Download**
in an album's or a track's ⋯ menu, or **Download all** on a playlist. Your own Navidrome library
and radio are never downloaded.

- The **server** does the work: downloads carry on with the browser closed, survive restarts
  (partial files resume), and run two at a time (setting). **Downloads** shows them live, with
  pause, resume, cancel, retry, and **Save to device** for finished files.
- Files go to `/music/<Album Artist>/<Album>/<NN> - <Title>.<ext>` (`D-NN` on multi-disc albums),
  owned by `PUID:PGID`. The format is checked from the file itself; tags are written from the
  source's details (the file's own tags fill the gaps), with the cover embedded and a `cover.jpg`.
  Creative Commons music gets a `LICENSE.txt` in its album folder with the credit its licence asks
  for: keep it with the files if you share them. A file that's already there is skipped (or kept
  as "(2)", setting).
- Afterwards the server asks **Navidrome** to rescan, with the Navidrome login of the user who
  downloaded (Navidrome only lets admins start a scan; otherwise its own scan finds them later).
- Partial downloads wait in `/downloads/incoming` (or a hidden `/music/.stremio-music` folder
  when `/downloads` isn't writable).

**Torrents through qBittorrent** (optional, Downloads → Settings, admins): instead of the built-in
engine, which stops sharing once a file is done, send torrents to your qBittorrent so they keep
seeding. Only the wanted files are downloaded. qBittorrent must save into a folder both containers
see, best inside the music volume. With this repo's compose file and a media stack where
qBittorrent mounts `/srv/media` as `/data`:

| Setting | Value |
|---|---|
| Web UI address | `http://qbittorrent:8080` |
| Save folder, as qBittorrent sees it | `/data/library/music/.stremio-music-torrents` |
| The same folder, as this app sees it | `/music/.stremio-music-torrents` |

**Test connection** checks the login and the folder, and puts a `.ndignore` in it so Navidrome
doesn't list the torrent copies. Finished files are tagged into the library from there (a new
file, so seeding isn't disturbed). Torrents are added in the `stremio-music` category, tagged
`stremio-music`, and left in qBittorrent when done: its own seeding limits apply. qBittorrent 4.5
or later is needed (it must stop torrents once their file list arrives).

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
