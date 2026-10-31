# Stremio Music

Self-hosted Stremio web UI with a **Music mode**, in one Docker container on one port: Movies & TV
is upstream stremio-web with its streaming engine built in; Music plays your Navidrome library,
Internet Archive, Jamendo, Free Music Archive, internet radio and Stremio music addons, with a
library, playlists and server-side downloads into your music folder.

Meant for personal, self-hosted use: you build and run your own copy on your own server
([Install](#install)). Design: [ARCHITECTURE.md](ARCHITECTURE.md). Writing music sources:
[PLUGINS.md](PLUGINS.md). History: [PROGRESS.md](PROGRESS.md).

> **Don't publish the built image.** The source code here is public, but the image you build
> contains Stremio's streaming server (`server.js`), which has no published source or licence
> text, so it may not be redistributed. The build downloads it from Stremio for you. Build the
> image yourself, and push it only to a private registry of your own, never to Docker Hub or
> another public registry.

**Contents:** [Install](#install) · [Configuration](#configuration) · [Sign-in and users](#sign-in-and-users) ·
[Reverse proxy and HTTPS](#reverse-proxy-https-and-sub-paths) · [Tailscale](#remote-access-with-tailscale) ·
[Installing the app (PWA)](#installing-the-app-pwa) · [Music sources](#music-sources) ·
[Connecting Navidrome](#connecting-navidrome) · [Library](#library) · [Playback](#playback) ·
[Downloads](#downloads) · [Connecting qBittorrent](#connecting-qbittorrent) ·
[Requests with Lidarr](#album-requests-with-lidarr-and-prowlarr) · [Updating](#updating) ·
[Backup and restore](#backup-and-restore) · [Troubleshooting](#troubleshooting) ·
[Torrent peers and VPN](#torrent-peers-and-vpn) · [Uninstall](#uninstall) · [Development](#development)

## Install

A step-by-step setup on a fresh Linux server. If you already run Docker, skip to
[step 2](#2-get-the-code).

**You need:**
- An x86_64 server running Ubuntu Server (built and tested on 26.04.1 LTS) or Debian, with a user
  that can run `sudo`. Other distributions work too; only step 1 differs.
- Docker Engine with the Compose v2 and Buildx plugins (tested with Docker 29.9, Compose 5.6).
  Step 1 installs them.
- Internet access during the build (it downloads Ubuntu packages, npm packages and Stremio's
  streaming server), and enough disk for the image, the build cache and the 10 GB engine cache
  (`df -h /` to check).
- Optional: [Navidrome](https://www.navidrome.org/) for your own music library, qBittorrent,
  Lidarr and Prowlarr. The app works without them (Internet Archive, Jamendo, radio and Movies & TV
  need nothing else).

### 1. Install Docker and Docker Compose

These are Docker's official packages. Ubuntu's own `docker.io` / `docker-compose` packages are
often too old for this build (it needs BuildKit through the Buildx plugin), so remove them first:

```sh
for pkg in docker.io docker-doc docker-compose docker-compose-v2 podman-docker containerd runc; do
  sudo apt-get remove -y $pkg
done
```

Add Docker's apt repository:

```sh
sudo apt-get update
sudo apt-get install -y ca-certificates curl git
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] \
https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "${UBUNTU_CODENAME:-$VERSION_CODENAME}") stable" \
  | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt-get update
```

On **Debian**, replace both `linux/ubuntu` with `linux/debian` and use `$VERSION_CODENAME`. For
other distributions see [docs.docker.com/engine/install](https://docs.docker.com/engine/install/).

Install Docker Engine, Compose and Buildx, and start Docker now and on every boot:

```sh
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo systemctl enable --now docker
```

Let your user run `docker` without `sudo` (this gives that user root-equivalent access to the
server, so only do it for your own admin account), then **log out and back in** so it takes effect:

```sh
sudo usermod -aG docker $USER
```

Check that everything works:

```sh
docker --version              # Docker version 29.x
docker compose version        # Docker Compose version v2.x or later (note: no hyphen)
docker buildx version
docker run --rm hello-world   # prints "Hello from Docker!"
```

If `docker` says *permission denied … docker.sock*, you haven't logged out and back in yet (or run
`newgrp docker` in the current shell).

### 2. Get the code

```sh
git clone https://github.com/fipity/stremio-music.git ~/stremio-music
cd ~/stremio-music
```

All the following commands run in `~/stremio-music`.

### 3. Choose your music folder and user

The app writes downloads into your music library, so it must run as a user that can write there.
Pick the folder (Navidrome's music folder if you use Navidrome) and look at who owns it:

```sh
sudo mkdir -p /srv/media/library/music          # only if it doesn't exist yet
stat -c '%u:%g %U:%G' /srv/media/library/music  # e.g. "1000:1000 xavier:xavier"
id                                              # your own uid/gid, e.g. uid=1000 gid=1000
```

The numbers (e.g. `1000:1000`) are your `PUID` and `PGID`. If the folder is owned by `root`, give
it to your user: `sudo chown -R $USER:$USER /srv/media/library/music` and use your own `id`. If
Navidrome runs as a different user, use Navidrome's `PUID`/`PGID` instead so both can read the
files.

### 4. Configure `.env`

```sh
cp .env.example .env
nano .env
```

Set at least:

```ini
PUID=1000                 # from step 3
PGID=1000                 # from step 3
TZ=Europe/London          # your time zone: `timedatectl list-timezones` lists them
ENGINE_CACHE_SIZE=10GB    # disk the Movies & TV torrent cache may use
```

Everything else is optional; [Configuration](#configuration) lists all settings.

### 5. Adjust `docker-compose.yml`

```sh
nano docker-compose.yml
```

**a. Your music folder.** Change the left side of this line to the folder from step 3 (keep
`:/music` on the right):

```yaml
      - /srv/media/library/music:/music
```

**b. Network: pick one of the two cases.**

- **You already run Navidrome/qBittorrent/Lidarr in a Docker Compose stack.** The app joins that
  stack's network so it reaches them by container name (`http://navidrome:4533`). Find the
  network's name and put it under `networks: media: name:` at the bottom of the file (the default
  is `media-stack_default`, for a stack in a folder called `media-stack`):

  ```sh
  docker network ls          # e.g. "media-stack_default"
  ```

  That stack must be running before you start the app.

- **No other stack (or Navidrome isn't in Docker).** Delete the two `networks:` parts: the
  `networks:` / `- media` lines inside the service, and the whole `networks:` block at the end of
  the file. You then connect to Navidrome etc. by the server's address (e.g.
  `http://192.168.1.10:4533`) instead of a container name.

**c. Port (optional).** The app is served on port `8095`. If that port is taken, change the left
number only, e.g. `"8100:8095"`. To keep it off the network entirely (only reachable through
Tailscale or a reverse proxy on the same server), use `"127.0.0.1:8095:8095"`.

Check the file is valid:

```sh
docker compose config --quiet && echo OK
```

### 6. Build and start

```sh
REVISION=$(git rev-parse --short HEAD) docker compose build     # ~5 min; runs all tests
docker compose up -d
```

The build downloads Stremio's `server.js` (pinned version and checksum), Ubuntu packages, and the
npm/pnpm dependencies (exact versions from the lockfiles). It runs the server tests and the source
contract tests: a failing test fails the build.

Check that it's running (it takes a few seconds to become `healthy`):

```sh
docker compose ps                                     # STATUS: Up … (healthy)
curl -s http://localhost:8095/health                  # {"status":"ok",…}
```

### 7. Create the admin account

Get the one-time setup code from the log:

```sh
docker logs stremio-music 2>&1 | grep "setup code"
```

Find your server's address (`hostname -I`, the first one, e.g. `192.168.1.10`) and open
`http://<server>:8095/` in a browser on the same network. It goes to the setup page: enter the
code and choose the admin's username and password. Add more users later at `<app>/account`
([Sign-in and users](#sign-in-and-users)).

Can't reach the page from another computer?
- `ss -tlnp | grep 8095` on the server should show Docker listening.
- Docker's published ports bypass `ufw`, so `ufw` isn't usually the cause, but a cloud provider's
  firewall / security group is: allow TCP 8095 there.
- Don't expose port 8095 to the internet directly. For access from outside your home, use
  [Tailscale](#remote-access-with-tailscale) or an HTTPS [reverse proxy](#reverse-proxy-https-and-sub-paths).

### 8. Set it up

1. **Movies & TV** works straight away with the built-in engine: Settings → Streaming should show
   the `…/engine/` entry as *Online*.
2. **Navidrome:** Music → Sources → Navidrome. The admin sets the **Server URL** once
   (`http://navidrome:4533` on a shared network, else `http://<server>:4533`); every user then
   enters their own Navidrome login. Details: [Connecting Navidrome](#connecting-navidrome).
3. **Other sources:** look through **Music → Sources** and turn on what you want
   ([Music sources](#music-sources)). Jamendo needs a free client ID.
4. **Optional:** [qBittorrent](#connecting-qbittorrent) for torrent downloads,
   [Lidarr and Prowlarr](#album-requests-with-lidarr-and-prowlarr) for album requests,
   [HTTPS / remote access](#remote-access-with-tailscale), and
   [installing it as an app](#installing-the-app-pwa) on your laptop or phone.
5. **Backups:** everything that matters is in `./config`. Make a backup with
   `docker exec stremio-music sm-backup` ([Backup and restore](#backup-and-restore)).

The container restarts on its own after a reboot or crash (`restart: unless-stopped`). To update
later, see [Updating](#updating); if something doesn't work, [Troubleshooting](#troubleshooting).

### Command reference

```sh
docker compose ps                       # status
docker logs stremio-music --tail 100    # recent log (-f to follow)
docker compose restart                  # restart
docker compose down                     # stop and remove the container (data in ./config stays)
docker compose up -d                    # start again / apply changes to .env or the compose file
```

## Configuration

### Environment

| Variable | Default | |
|---|---|---|
| `PUID` / `PGID` | `1000` / `1000` | user the app runs as; owns `/config`, `/cache` and the files it writes to `/music` (use Navidrome's user) |
| `UMASK` | `022` | for files the app creates (`002` for a group-writable library) |
| `TZ` | `Australia/Melbourne` | |
| `PORT` | `8095` | port inside the container (change the `ports:` mapping instead, normally) |
| `LOG_LEVEL` | `info` | `debug` also logs the engine's own output |
| `ENGINE_CACHE_SIZE` | `10GB` | engine/torrent cache cap: `20GB`, `512MiB`, `0` (no cache), `unlimited`. Applied on every engine start, overriding the Movies & TV settings page |
| `AUTH_MODE` | `local` | `local` = built-in accounts; `proxy` = trust a user header from your authenticating reverse proxy ([below](#letting-the-proxy-do-the-sign-in-auth_modeproxy)) |
| `TRUSTED_PROXIES` | *(none)* | comma-separated IPs/CIDRs of your reverse proxy; only these may set `X-Forwarded-*`. Empty when clients connect directly |
| `ADMIN_USERNAME`, `ADMIN_PASSWORD` / `ADMIN_PASSWORD_FILE` | | create the first admin instead of using the setup code (ignored once an account exists) |
| `SESSION_TTL_DAYS` | `30` | sign-in lifetime, extended while you use the app |
| `COOKIE_SECURE` | `auto` | `true`/`false` to force the cookie's `Secure` flag |
| `PROXY_USER_HEADER` | `Remote-User` | `proxy` mode: header carrying the user name |
| `PROXY_ADMIN_USERS` | *(none)* | `proxy` mode: comma-separated admins; if empty, the first user seen becomes admin |
| `APP_SECRET_KEY` / `APP_SECRET_KEY_FILE` | *(generated)* | passphrase (16+ characters) for encrypting source passwords and API keys; else a random key in `/config/secret.key` |
| `MUSIC_SOURCES_DIR` | `/config/music-sources` | folder plugins |
| `MUSICBRAINZ_CONTACT` | *(none)* | email or URL for MusicBrainz's User-Agent rule; unset = no MusicBrainz lookups ([Library](#library)) |
| `STREMIO_MUSIC_IMAGE` | `stremio-music:local` | compose only: image to run ([Updating](#updating)) |

### Volumes

| Path | Contents |
|---|---|
| `/config` | database (`app.db`: users, sessions, sources and their settings, library, downloads), `secret.key`, folder plugins, backups. **Back this up.** |
| `/cache` | engine cache and its settings (`/cache/engine`). Safe to delete while stopped. |
| `/music` | your library, shared read-write with Navidrome: downloads land here. Never chowned; the app warns at start if `PUID:PGID` can't write it. |
| `/downloads` | staging for downloads (`/downloads/incoming`); without it, a hidden `/music/.stremio-music` folder |

### Health

`GET /health` (no sign-in) returns `{status, version, engine: {state, pid, version, restarts,
lastExit, lastError}, db}`, HTTP 503 when the engine has failed or the database is unavailable.
The image's `HEALTHCHECK` uses it every 30 s, so `docker ps` shows `healthy`/`unhealthy`.

The app starts the engine, checks it every 10 s, restarts it on crash (backoff 1 s → 30 s; after
5 crashes in 5 minutes it's `failed` and retried every minute) and stops it. `docker stop` stops
the engine and any ffmpeg first and exits within a second or two.

## Sign-in and users

Everything except `/health`, the login page and the PWA manifest/icons requires signing in.

**First start:** the log prints a one-time setup code (`docker logs stremio-music 2>&1 | grep "setup
code"`), printed again on every start until an account exists. Open the app, enter it, create the
admin. Or set `ADMIN_USERNAME` + `ADMIN_PASSWORD` (`ADMIN_PASSWORD_FILE` for a Docker secret).

**More users / password changes:** `<app>/account` (change your password, sign out; admins also
add, disable and delete users and reset passwords), also in the Music account menu. From the shell:

```sh
docker exec -it stremio-music sm-user list
docker exec -it stremio-music sm-user add alice [--admin]
docker exec -it stremio-music sm-user passwd alice        # e.g. a forgotten admin password
docker exec -it stremio-music sm-user admin alice on|off
docker exec -it stremio-music sm-user disable|enable|delete alice
```

Each user has their own library, playlists, downloads, play queue and source logins (e.g.
Navidrome). Details:
- Passwords are hashed with scrypt. Sessions are random tokens in an HttpOnly, SameSite=Lax cookie
  (only a hash is stored). Changing a password signs out your other devices.
- Login is rate-limited (10 attempts per 15 min per client IP); a username is locked for 15
  minutes after 5 wrong passwords.
- Requests that change things must come from the app's own origin (CSRF protection).
- The cookie is `Secure` automatically when the request arrived over HTTPS through a trusted proxy.

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
video, music and the Downloads page's live updates are streamed through it.

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
*Cast, save and share* → *Install page as app*). It then gets its own window and launcher entry,
and media keys work through the desktop's media controls. **Firefox on Linux can't install web
apps**, though the app works fine in a normal Firefox tab. On Android use **Add to Home Screen** /
**Install app**.

No HTTPS yet and only using it on the LAN? Chromium-based browsers can treat this one address as
secure: open `brave://flags/#unsafely-treat-insecure-origin-as-secure` (Chrome: `chrome://flags/…`),
add `http://<server>:8095`, enable, relaunch. That's for your own laptop only; HTTPS (proxy or
Tailscale) is the proper fix. The service worker caches only the UI shell (scripts, styles, fonts,
images) so the app opens fast. Pages, your data, the API and streams always come from the server,
and signing in is always checked there.

### Brave

Works with Shields on: the app only talks to its own origin, except Movies & TV's normal calls to
Stremio's own services and addons. Casting from Movies & TV needs Brave's *Media Router* setting
(Settings → Extensions), which is off by default. If you use *Forget me when I close this site* or
clear cookies on exit, you'll have to sign in each time; add the app as an exception.

## Music sources

Music comes from sources, managed under **Music → Sources** (on phones: account menu → Music
sources). Admins see everything; other users see only the sources that need their own login.
There are three ways to add one:

1. **Built-in** (already there, enable/disable as you like):
   - **Navidrome:** your library ([connect it](#connecting-navidrome)).
   - **Internet Archive:** Live Music Archive, netlabels, 78 RPM records. No account needed.
   - **Radio Browser:** internet radio. "Stations near you" defaults to Australia (its settings).
   - **Jamendo:** needs a free client ID from [devportal.jamendo.com](https://devportal.jamendo.com)
     (sign up, create an app), non-commercial use only: paste it in Jamendo's settings.
   - **Free Music Archive:** Creative Commons releases up to 2018, from FMA's mirror on
     archive.org (FMA's own API no longer exists).
2. **Folder plugins:** a folder in `/config/music-sources/`, loaded at start or with **Reload
   plugins**. Each runs in its own sandboxed process. Start one from the template and test it:
   ```sh
   docker exec -it stremio-music sm-new-source my-source        # writes /config/music-sources/my-source
   docker exec -it stremio-music sm-test-source /config/music-sources/my-source
   ```
   Load errors show on the Sources page instead of breaking anything. [PLUGINS.md](PLUGINS.md)
   explains the interface.
3. **Remote addons:** paste a Stremio addon manifest URL under **Add a source**. It's used only if it
   declares the `music` type. Addons may return torrents (played through the engine, downloadable)
   or YouTube links (play-only).

On the Sources page you can enable or disable each source and change its order (which sets the
Home and search order), edit settings, **Test connection**, and see status, errors and logs.
Passwords and API keys in source settings are encrypted with `APP_SECRET_KEY` (or the generated
`/config/secret.key`); changing the key means entering them again.

### Connecting Navidrome

1. **Admin, once:** Sources → Navidrome → *Settings*: **Server URL** as this container sees it,
   `http://navidrome:4533` on the shared Docker network (the default). Save.
2. **Every user:** Sources → Navidrome → *Your settings*: your **Navidrome username and password**
   (each app user maps to their own Navidrome account, so stars, playlists and play counts are
   theirs). **Test connection** says e.g. "Connected to navidrome 0.64.2 as alice".
3. Navidrome rows appear on Home; likes sync with Navidrome stars; playlists can sync to Navidrome
   ([Library](#library)). Streams and covers go through the server, so the password never reaches
   the browser.
4. Downloads land in the folder Navidrome reads. To have Navidrome rescan right after, the user who
   downloads needs a Navidrome **admin** login; otherwise Navidrome's own scan finds the files later.

## Library

**Library** keeps, per user and on the server: **Liked songs**, saved albums, followed artists,
saved radio stations, and your **playlists** (which can mix tracks from any source). Tap a heart to
like or save; every track's **⋯** menu has *Play next*, *Add to queue*, *Add to playlist…*, *Go to
album*, *Go to artist* and, where allowed, *Download*. Playlists are listed in the sidebar (on
phones: under Library); a playlist's ⋯ menu edits its details, reorders and removes tracks,
downloads it, and deletes it.

**Import a playlist** (e.g. from Spotify): Library → **Import**, then a file or pasted text:

- a **CSV export**, e.g. from [Exportify](https://exportify.app) (sign in with Spotify, *Export*
  next to a playlist): the fastest way for a few playlists;
- **Spotify's own data export** (spotify.com → Account → Privacy → *Download your data*, can take
  a few days): `Playlist1.json` holds all your playlists, pick one at a time;
- or one **`Artist - Title`** per line.

Each track is looked up on your sources in priority order (your Navidrome library first), by
artist and title ("- Remastered 2011" and the like ignored, closest length when known), and the
playlist is created from what was found. Tracks that weren't found are listed afterwards, with
**Find in Lidarr** when Lidarr is connected. How well it finds things depends on each source's
search: your own library matches reliably; Jamendo's search sometimes ranks the right song too
low to be found. (Reading playlists straight from Spotify's API would need Spotify Premium, a
Spotify developer app and an HTTPS address, and only works for playlists you own.)

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
- If the best stream fails, the next downloadable one is tried; errors name the source (e.g.
  "Jamendo: the server answered HTTP 500": a broken file on their side, retry later).

Admins find the settings under Downloads → **Settings**: existing files (skip / keep both),
downloads at the same time, the Navidrome rescan, and the torrent client.

### Connecting qBittorrent

Optional. Instead of the built-in engine, which stops sharing once a file is done, torrents can go
to your qBittorrent (4.5 or later), which downloads only the wanted files and keeps seeding.

1. **qBittorrent's login.** Open its web UI (`http://<server>:8080`). Never set a password? The
   linuxserver/official images print a temporary one on each start:
   `docker logs qbittorrent 2>&1 | grep -i "temporary password"`. Sign in as `admin` with it, then
   set your own under **Tools → Options → WebUI → Authentication** and **Save** (the temporary one
   changes on every restart).
2. **A folder both containers see**, best inside the music volume. With this compose file and a
   media stack where qBittorrent mounts `/srv/media` as `/data`:

   | Setting (Downloads → Settings → qBittorrent) | Value |
   |---|---|
   | Web UI address | `http://qbittorrent:8080` |
   | Username / Password | your qBittorrent login |
   | Category | `stremio-music` |
   | Save folder, as qBittorrent sees it | `/data/library/music/.stremio-music-torrents` |
   | The same folder, as this app sees it | `/music/.stremio-music-torrents` |

3. **Test connection**, then **Save**. The test checks the login and the folder, and puts a
   `.ndignore` in it so Navidrome doesn't list the torrent copies.

Torrents are added in that category, tagged `stremio-music`, with every file but the wanted ones
switched off. Finished files are tagged into the library from that folder (as new files, so seeding
isn't disturbed) and the torrents stay in qBittorrent under its own seeding limits.

## Album requests with Lidarr and Prowlarr

For albums that aren't in your library (or any source here), ask your **Lidarr**: Downloads →
**Requests (Lidarr)**, or **Find in Lidarr** in an album's or artist's ⋯ menu, or the *Ask Lidarr*
link under search results. Search Lidarr's catalogue (MusicBrainz), press **Request**, and Lidarr
does the rest with its own setup: its automatic search over the indexers **Prowlarr** gives it, your
quality profile and download client, then the import into its root folder. With that folder being
the library Navidrome reads, the album shows up in Music; the app asks Navidrome to rescan when a
request arrives.

- A new artist is added to Lidarr with **only the requested album** monitored (no other albums,
  no future releases); for an artist Lidarr already has, the album is switched to monitored.
- The Requests list shows each request live: searching, wanted (no release found yet: Lidarr
  keeps looking on its schedule), downloading with progress, importing, needs attention (Lidarr's
  message), in your library. **Search again** and **Remove** (from this list; Lidarr keeps it).
- Admins see everyone's requests, and can keep requesting to admins only.
- Picking individual releases stays in Lidarr's own UI.

**Connecting** (admins, Requests (Lidarr) → **Lidarr settings**):

1. **Lidarr:** address `http://lidarr:8686` (on the shared Docker network) and its **API key**
   (Lidarr → Settings → General → Security). **Test connection**, then pick the **root folder** for
   new artists (the library folder Navidrome reads, e.g. `/data/library/music` as Lidarr sees it),
   the **quality profile** and the **metadata profile**.
2. **Prowlarr (optional):** address `http://prowlarr:9696` and its API key. The test shows how many
   indexers are enabled or failing and whether Prowlarr feeds Lidarr (if not: Prowlarr → Settings →
   Apps → add Lidarr). **Sync indexers to Lidarr** pushes Prowlarr's indexers to Lidarr now.
3. **Save.** Both API keys are stored encrypted and never shown again.

## Updating

```sh
cd ~/stremio-music
docker exec stremio-music sm-backup                 # a backup first (see below)
git pull
REVISION=$(git rev-parse --short HEAD) docker compose build
docker compose up -d                                # recreates the container; ~1 s of downtime
docker inspect -f '{{.State.Health.Status}}' stremio-music
```

Everything in `/config` carries over: the database is migrated forward automatically on start
(users, sessions, sources and settings, folder plugins, library, downloads in progress). There is
no downgrade: to go back, run the older image with a backup taken before the update. Open browsers
pick up the new UI on their next load (each build has new asset URLs).

What's pinned, and how to move it:
- **Ubuntu base image:** by digest in the `Dockerfile` (`ARG UBUNTU=…@sha256:…`), so rebuilds are
  identical. For Ubuntu's security updates (Node, ffmpeg, OpenSSL come from Ubuntu), take the
  current one now and then: `docker compose build --pull --build-arg UBUNTU=ubuntu:26.04`, or put
  the new digest (`docker image inspect ubuntu:26.04 --format '{{index .RepoDigests 0}}'`) in the
  `Dockerfile`.
- **Stremio's streaming server:** `ENGINE_URL` and `ENGINE_SHA256` in the `Dockerfile`
  (`engine/server.version` records it). A new version needs both changed; check Movies & TV
  playback afterwards.
- **npm / pnpm dependencies:** exact versions in `server/package-lock.json` and
  `web/pnpm-lock.yaml`, installed with `npm ci` / `pnpm install --frozen-lockfile`.

**Your own registry** (optional, e.g. to run the image on another host). Push only to a private
registry, never a public one (see the note at the top):

```sh
docker tag stremio-music:local registry.lan:5000/stremio-music:1.0.0
docker push registry.lan:5000/stremio-music:1.0.0
# on the other host, in .env: STREMIO_MUSIC_IMAGE=registry.lan:5000/stremio-music:1.0.0
docker compose pull && docker compose up -d --no-build
```

## Backup and restore

`/config` is everything that matters: accounts, source settings and secrets, folder plugins, your
library and playlists. `/cache` can be rebuilt; `/music` is your library (back it up your own way).

**Backup while it runs:**

```sh
docker exec stremio-music sm-backup
# backup written: /config/backups/stremio-music-2026-10-28T09-30-00.tar.gz (180 kB): app.db, secret.key, music-sources/
```

It makes a consistent copy of the database (SQLite online backup, safe during use), plus
`secret.key` and the folder plugins, and keeps the newest 7 (`--keep 14`, `--dir /some/where`).
The archive contains secrets, so it's readable by its owner only; copy `config/backups/` off the
server. If you set `APP_SECRET_KEY`, keep that value too: it isn't in the backup, and without it
saved source passwords must be entered again. For a daily backup, a host crontab line:

```cron
30 3 * * * docker exec stremio-music sm-backup >/dev/null
```

**Restore** (into the same or a new install):

```sh
cd ~/stremio-music
docker compose stop stremio-music
mv config config.before-restore
mkdir config
tar -xzf config.before-restore/backups/stremio-music-<date>.tar.gz -C config
cp -a config.before-restore/backups config/      # keep your older backups
docker compose start stremio-music
```

Run `tar` as the user from `PUID` (or let the container fix ownership on start). Downloads that
were in progress when the backup was taken start again from the beginning. Restoring an older
backup into a newer version is fine (it is migrated); the reverse is not.

**Cold copy instead:** `docker compose stop && tar -czf config-$(date +%F).tar.gz config && docker
compose start` is equally valid, with a few seconds of downtime.

## Troubleshooting

- **First look:** `docker logs stremio-music --tail 100`, and `curl -s http://<server>:8095/health`.
  `LOG_LEVEL=debug` adds the engine's own output.
- **`unhealthy` / engine `failed`:** `/health` shows `engine.lastError`. The app retries every
  minute; `docker compose restart` starts over. Check that nothing else uses the container's ports
  and that `/cache` is writable.
- **No setup code / locked out:** the code is printed on every start until an account exists
  (`docker logs stremio-music 2>&1 | grep "setup code"`). Forgot the admin password:
  `docker exec -it stremio-music sm-user passwd <name>`.
- **Sign-in loops behind a proxy:** `TRUSTED_PROXIES` must contain the proxy's address as the app
  sees it, the proxy must send `X-Forwarded-Proto` (and `X-Forwarded-Prefix` on a sub-path). Over
  plain HTTP don't set `COOKIE_SECURE=true`.
- **Movies & TV says the streaming server is offline:** Settings → Streaming must use the
  `…/engine/` entry, not Stremio's default `http://127.0.0.1:11470/`.
- **Old UI after an update:** reload once more (the service worker swaps in the new shell); still
  old, clear the site's data in the browser.
- **Can't install the app:** needs HTTPS (proxy or Tailscale) or the browser flag in
  [Installing the app](#installing-the-app-pwa). Firefox on Linux can't install web apps.
- **Navidrome: "wrong username or password" / can't connect:** the Server URL is as seen from the
  container (`http://navidrome:4533` on the shared network, not `localhost`). LDAP/external-auth
  Navidrome accounts can't use Subsonic token logins.
- **A source shows nothing:** Sources → its card shows the last error and logs; **Test
  connection**. Jamendo needs its client ID.
- **A track won't play:** the now-playing view shows the stream and any error. Unsupported formats
  are converted automatically; on HTTPS, plain-`http` radio goes through the server.
- **Downloads fail with a permission error:** `PUID:PGID` must be able to write the `/music`
  folder (the start log warns if not). `chown`/`chmod` the host folder, or set `PUID`/`PGID` to
  the folder's owner (usually the same user as Navidrome).
- **Downloads don't show in Navidrome:** the rescan needs a Navidrome admin login for the user who
  downloaded; otherwise wait for Navidrome's scan. Files are in `/music/<Artist>/<Album>/`.
- **Lidarr:** "rejected the API key" = wrong key; "not reachable" = wrong address (use the
  container name on the shared network); "metadata server didn't answer" = Lidarr's own
  catalogue service had a hiccup, search again. A request stuck on *Wanted* means no indexer had a
  matching release: check Prowlarr's indexers and Lidarr's quality profile, or **Search again**
  later.
- **qBittorrent:** "login failed" = wrong login (try it in the web UI); "login banned" = too many
  attempts (restart qBittorrent or wait); "isn't a writable folder here" = the two folder settings
  don't point at the same place.

## Torrent peers and VPN

**Incoming peer port: not supported by the engine.** Stremio's streaming server only makes
outgoing peer connections. Its torrent library has a `listen()` that v4.20.16 never calls, the same
as in the official desktop apps. So there's no port to open for Movies & TV or music torrents.
Streaming works over outgoing connections. For torrents you want to keep seeding, use
[qBittorrent](#connecting-qbittorrent), which has its own listening port.

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

## Uninstall

```sh
cd ~/stremio-music
docker exec stremio-music sm-backup && cp config/backups/*.tar.gz ~/   # if you might come back
docker compose down                       # stops and removes the container
docker image rm stremio-music:local       # and docker builder prune for the build cache
rm -rf config cache downloads             # your accounts, settings, library and cache: gone
```

`/music` is left as it is: downloaded albums stay in your library (with their `LICENSE.txt`
files). Remove the hidden `.stremio-music` and `.stremio-music-torrents` folders in it if they
exist. In qBittorrent, the `stremio-music` category/tag lists the torrents it added. In Navidrome,
stars and synced playlists remain yours. Installed app windows (PWA) are removed from the
browser's app menu (*Uninstall*).

## Development

Node isn't needed on the host: `scripts/node` runs Node 22 + ffmpeg in an `ubuntu:26.04`
container (`docker/dev.Dockerfile`).

```sh
docker build -t stremio-music-dev:26.04 -f docker/dev.Dockerfile docker
SUBDIR=server scripts/node npm ci
SUBDIR=server scripts/node npm run build
SUBDIR=server scripts/node npm test               # unit + integration
SUBDIR=server scripts/node npm run test:sources   # source contract tests
```

Dependencies are pinned exactly and installed with `npm install --before=<two weeks ago>`. The
exception is security fixes, which are taken immediately. Upstream changes to stremio-web are
listed in [web/PATCHES.md](web/PATCHES.md).
