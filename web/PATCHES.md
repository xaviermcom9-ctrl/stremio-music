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
