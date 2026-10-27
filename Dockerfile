# syntax=docker/dockerfile:1.7
# Stremio Music: stremio-web fork + Fastify backend + streaming engine, one container, one port.
# Build: docker compose build   (or: docker build -t stremio-music:local .)

ARG UBUNTU=ubuntu:26.04

# --- build toolchain: Ubuntu's own Node 22 (same runtime as the final image) -----------------
FROM ${UBUNTU} AS toolchain
RUN apt-get update \
 && apt-get install -y --no-install-recommends nodejs npm ca-certificates git \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g pnpm@11.8.0

# --- web UI (stremio-web fork) ---------------------------------------------------------------
FROM toolchain AS web
WORKDIR /src/web
COPY web/package.json web/pnpm-lock.yaml web/pnpm-workspace.yaml ./
COPY web/patches ./patches
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile
COPY web/ ./
# upstream commit + a hash of our web sources, shown as "Build Version" in Settings. It's also the
# folder name of the bundles, which are cached as immutable, so it must change with every change.
ARG WEB_COMMIT=8329565d17b75d2af8ba5822aa8059058a5d934e
RUN SRC_HASH=$(find src assets patches webpack.config.js package.json pnpm-lock.yaml manifest.json -type f -print0 \
      | sort -z | xargs -0 sha256sum | sha256sum | cut -c1-10) \
 && COMMIT_HASH="${WEB_COMMIT}-sm-${SRC_HASH}" pnpm build

# --- backend -----------------------------------------------------------------------------------
FROM toolchain AS server
WORKDIR /src/server
COPY server/package.json server/package-lock.json ./
RUN --mount=type=cache,id=npm-cache,target=/root/.npm npm ci
COPY engine/ /src/engine/
COPY server/ ./
RUN npm run build && npm test && npm prune --omit=dev

# --- runtime -----------------------------------------------------------------------------------
FROM ${UBUNTU}
RUN apt-get update \
 && apt-get install -y --no-install-recommends nodejs ffmpeg tini tzdata ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /app/engine

# (/app/engine exists first: ADD --chmod would otherwise apply 644 to the directories it creates.)
# Official Stremio streaming server, pinned. Not redistributed in git: fetched at build time.
# Licence is unclear (says MIT, no text, no public source) -> keep this image private.
ARG ENGINE_URL=https://dl.strem.io/server/v4.20.16/desktop/server.js
ARG ENGINE_SHA256=88e887f058765f0e3dbc636829e7687ab80759c392eb9a64df457c8f9fc86e28
ADD --checksum=sha256:${ENGINE_SHA256} --chmod=644 ${ENGINE_URL} /app/engine/server.js
COPY engine/bind-loopback.cjs /app/engine/

COPY --from=web /src/web/build /app/web
COPY --from=server /src/server/package.json /app/server/
COPY --from=server /src/server/node_modules /app/server/node_modules
COPY --from=server /src/server/dist/src /app/server/dist/src
COPY docker/entrypoint.sh /app/docker/entrypoint.sh
COPY docker/sm-user /usr/local/bin/sm-user

ENV PUID=1000 PGID=1000 UMASK=022 TZ=Australia/Melbourne \
    PORT=8095 ENGINE_CACHE_SIZE=10GB NODE_ENV=production
EXPOSE 8095
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8095)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

# tini -g: forward signals to the whole process group and reap zombies
ENTRYPOINT ["/usr/bin/tini", "-g", "--", "/app/docker/entrypoint.sh"]
CMD ["node", "--disable-warning=ExperimentalWarning", "/app/server/dist/src/index.js"]
