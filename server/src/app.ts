import { accessSync, constants, existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import { registerAuth } from './auth/plugin.js';
import { AuthStore } from './auth/store.js';
import type { Config } from './config.js';
import { dbHealthy } from './db.js';
import { registerEngineProxy } from './engine/proxy.js';
import { registerPrefs } from './prefs.js';
import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { INTERNAL_HEADER, registerPlayback } from './music/playback.js';
import type { MusicSource } from './music-sources/sdk.js';
import { BUILTIN_SOURCES } from './music-sources/index.js';
import { SourceRegistry } from './music/registry.js';
import { registerMusicRoutes } from './music/routes.js';
import { registerDiscover } from './music/discover.js';
import { registerLibrary } from './music/library.js';
import { MusicBrainz } from './music/musicbrainz.js';
import { DownloadManager } from './downloads/manager.js';
import { qbittorrentFrom, registerDownloads } from './downloads/routes.js';
import { DownloadSettingsStore } from './downloads/settings.js';
import { APP_VERSION } from './music/runtime.js';
import { SecretBox } from './music/secrets.js';
import type { EngineSupervisor } from './engine/supervisor.js';

export const VERSION = '0.1.0';

export interface AppDeps {
  config: Config;
  db: DatabaseSync;
  engine: EngineSupervisor;
  /** tests: replace the built-in sources / outbound fetch */
  builtins?: MusicSource[];
  fetchImpl?: typeof fetch;
  /** tests: rescan delay after downloads */
  downloadsScanDelayMs?: number;
}

export async function buildApp({ config, db, engine, builtins, fetchImpl, downloadsScanDelayMs }: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: config.logLevel },
    // X-Forwarded-* only from configured proxies; otherwise clients could spoof their IP
    trustProxy: config.trustedProxies.length ? config.trustedProxies : false,
    // long-lived media streams must not hold up `docker stop`
    forceCloseConnections: true,
    // encrypted proxy tokens (/api/proxy/:token) are several hundred characters
    routerOptions: { maxParamLength: 4096 },
  });

  // polled by the Docker HEALTHCHECK every 30 s: keep it out of the request log
  app.addHook('onSend', async (_req, reply) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'same-origin');
    if (!reply.hasHeader('content-security-policy')) reply.header('content-security-policy', "frame-ancestors 'self'");
  });

  // a fresh key per process: ffmpeg reads media through /api/proxy over loopback with it
  const internalKey = randomBytes(24).toString('hex');

  // first: its onRequest hook guards every route registered below
  await registerAuth(app, { config, store: new AuthStore(db, config.auth.sessionTtlMs), internal: { header: INTERNAL_HEADER, key: internalKey } });

  app.get('/health', { logLevel: 'warn' }, async (_req, reply) => {
    const e = engine.status();
    const dbOk = dbHealthy(db);
    // engine "restarting"/"starting" is transient (degraded); "failed" or "stopped" is an error
    const engineOk = !config.engine.enabled || e.state === 'running';
    const engineError = config.engine.enabled && (e.state === 'failed' || e.state === 'stopped');
    const status = !dbOk || engineError ? 'error' : engineOk ? 'ok' : 'degraded';
    return reply.code(status === 'error' ? 503 : 200).send({
      status,
      version: VERSION,
      uptimeSec: Math.round(process.uptime()),
      db: dbOk ? 'ok' : 'error',
      engine: config.engine.enabled ? e : { state: 'disabled' },
    });
  });

  registerPrefs(app, db);

  mkdirSync(config.musicSourcesDir, { recursive: true });
  const box = SecretBox.load({ ...config.secrets, configDir: config.dirs.config });
  if (box.source === 'generated') app.log.warn('APP_SECRET_KEY not set: source secrets are encrypted with /config/secret.key, which sits next to the data');
  const registry = new SourceRegistry({
    db,
    box,
    builtins: builtins ?? BUILTIN_SOURCES,
    pluginDir: config.musicSourcesDir,
    userAgent: `StremioMusic/${APP_VERSION} (self-hosted)`,
    fetchImpl,
    log: { info: (m) => app.log.info(m), warn: (m) => app.log.warn(m) },
  });
  await registry.init();
  app.addHook('onClose', async () => registry.stop());
  registerMusicRoutes(app, registry, { secretKeySource: box.source }, fetchImpl);
  const musicbrainz = config.musicbrainzContact
    ? new MusicBrainz({ userAgent: `StremioMusic/${APP_VERSION} ( ${config.musicbrainzContact} )`, db, fetch: fetchImpl })
    : null;
  if (!musicbrainz) app.log.info('MUSICBRAINZ_CONTACT not set: artists are merged by name and the MBIDs sources provide');
  registerDiscover(app, registry, musicbrainz);
  registerLibrary(app, db, registry);
  const playback = registerPlayback(app, {
    registry,
    engine,
    db,
    ffmpeg: config.engine.ffmpeg,
    port: () => (app.server.address() as AddressInfo | null)?.port ?? config.port,
    internalKey,
  });

  const downloadSettings = new DownloadSettingsStore(db, box);
  const qbittorrent = qbittorrentFrom(downloadSettings, fetchImpl);
  const downloads = new DownloadManager({
    db,
    registry,
    engine,
    playback,
    musicDir: config.dirs.music,
    stagingDir: stagingDir(config.dirs),
    ffmpeg: config.engine.ffmpeg,
    self: () => `http://127.0.0.1:${(app.server.address() as AddressInfo | null)?.port ?? config.port}`,
    internal: { header: INTERNAL_HEADER, key: internalKey },
    settings: () => downloadSettings.get(),
    qbittorrent,
    log: { info: (m) => app.log.info(m), warn: (m) => app.log.warn(m) },
    scanDelayMs: downloadsScanDelayMs,
  });
  registerDownloads(app, downloads, downloadSettings, qbittorrent);
  // after listen: downloads read through our own /api/proxy over loopback
  app.addHook('onListen', async () => downloads.start());
  app.addHook('onClose', async () => downloads.close());
  await registerEngineProxy(app, engine);

  if (existsSync(config.webRoot)) {
    await app.register(fastifyStatic, {
      root: config.webRoot,
      prefix: '/',
      cacheControl: false,
      setHeaders: (reply, file) => {
        // hashed bundles (<commit>/scripts|styles|binaries) are immutable; the shell must revalidate
        const immutable = /\/[0-9a-f]{7,}[^/]*\/(scripts|styles|binaries)\//.test(file);
        reply.header('cache-control', immutable ? 'public, max-age=31536000, immutable' : 'no-cache');
      },
    });
  } else {
    app.log.warn(`web root ${config.webRoot} not found; UI not served`);
  }

  return app;
}

/**
 * Where downloads land before they're tagged and moved into the library: the /downloads volume
 * when it's writable, else a hidden folder in the library (Navidrome skips it: .ndignore).
 */
function stagingDir(dirs: Config['dirs']): string {
  try {
    accessSync(dirs.downloads, constants.W_OK);
    return path.join(dirs.downloads, 'incoming');
  } catch {
    const dir = path.join(dirs.music, '.stremio-music');
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, '.ndignore'), '');
    } catch {
      // read-only library: downloads will fail with a clear error when they try to write
    }
    return path.join(dir, 'incoming');
  }
}
