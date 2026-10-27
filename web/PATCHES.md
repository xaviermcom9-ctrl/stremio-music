# stremio-music changes to upstream stremio-web

Upstream: https://github.com/Stremio/stremio-web @ `8329565` (5.0.0-beta.43), imported with
`git archive` into `web/`. Every change to upstream files is listed here and tagged
`stremio-music:` in a comment, so upstream bumps are a reviewable merge.

| File | Change | Why |
|---|---|---|
| `src/common/CONSTANTS.js` | `DEFAULT_STREAMING_SERVER_URL` = `<document.baseURI>engine/`; adds `CORE_DEFAULT_STREAMING_SERVER_URL` | the engine is proxied same-origin by the backend |
| `src/App/SearchParamsHandler.js` | with no `?streamingServerUrl=`, a profile on core's default `http://127.0.0.1:11470/` is switched to the same-origin engine (silently, it's in the defaults set) | stremio-core (WASM) hardcodes the loopback default |
| `patches/@stremio__stremio-video.patch` + `pnpm-workspace.yaml` `patchedDependencies` | engine endpoints resolved relative to the server URL (`'hlsv2/…'` instead of `'/hlsv2/…'`) | `url.resolve(base, '/x')` drops the `/engine/` path, which breaks transcoding, subtitles, `/proxy` and torrent creation under a sub-path |
| `webpack.config.js` | `COMMIT_HASH` from env if set, else `git rev-parse HEAD` | `web/` is built in Docker without a `.git` |
| `src/index.js` + new `src/sm/authGuard.js` | wraps `fetch`: a same-origin 401 with `x-auth-required: 1` sends the user to `login?next=…` | the session can expire while the app is open |
| `webpack.config.js` (GenerateSW) | `exclude` adds `/\.html$/` | the service worker caches the UI shell only; `index.html` always comes from the server so logged-out visitors get the login page |
| `manifest.json` | `name`/`description` changed (icons, scope, start_url unchanged and relative) | tell the installed PWA apart from official Stremio |
