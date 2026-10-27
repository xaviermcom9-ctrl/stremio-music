import { existsSync } from 'node:fs';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import type { Config } from './config.js';
import { dbHealthy } from './db.js';
import { registerEngineProxy } from './engine/proxy.js';
import type { EngineSupervisor } from './engine/supervisor.js';

export const VERSION = '0.1.0';

export interface AppDeps {
  config: Config;
  db: DatabaseSync;
  engine: EngineSupervisor;
}

export async function buildApp({ config, db, engine }: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: config.logLevel },
    trustProxy: true,
    // long-lived media streams must not hold up `docker stop`
    forceCloseConnections: true,
  });

  // polled by the Docker HEALTHCHECK every 30 s: keep it out of the request log
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
