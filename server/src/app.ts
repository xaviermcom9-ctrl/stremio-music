import { existsSync } from 'node:fs';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import { registerAuth } from './auth/plugin.js';
import { AuthStore } from './auth/store.js';
import type { Config } from './config.js';
import { dbHealthy } from './db.js';
import { registerEngineProxy } from './engine/proxy.js';
import { registerPrefs } from './prefs.js';
import { mkdirSync } from 'node:fs';
import type { MusicSource } from './music-sources/sdk.js';
import { BUILTIN_SOURCES } from './music-sources/index.js';
import { SourceRegistry } from './music/registry.js';
import { registerMusicRoutes } from './music/routes.js';
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
}

export async function buildApp({ config, db, engine, builtins, fetchImpl }: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: config.logLevel },
    // X-Forwarded-* only from configured proxies; otherwise clients could spoof their IP
    trustProxy: config.trustedProxies.length ? config.trustedProxies : false,
    // long-lived media streams must not hold up `docker stop`
    forceCloseConnections: true,
  });

  // polled by the Docker HEALTHCHECK every 30 s: keep it out of the request log
  app.addHook('onSend', async (_req, reply) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'same-origin');
    if (!reply.hasHeader('content-security-policy')) reply.header('content-security-policy', "frame-ancestors 'self'");
  });

  // first: its onRequest hook guards every route registered below
  await registerAuth(app, { config, store: new AuthStore(db, config.auth.sessionTtlMs) });

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
  registerMusicRoutes(app, registry, { secretKeySource: box.source });
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
