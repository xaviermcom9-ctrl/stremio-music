// Same-origin reverse proxy: <app>/engine/* -> the engine on 127.0.0.1.
import httpProxy from '@fastify/http-proxy';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { EngineSupervisor } from './supervisor.js';

export const ENGINE_PREFIX = '/engine';

/**
 * The UI hands the engine URLs of the engine itself, e.g. hlsv2/probe?mediaURL=<public>/engine/<infoHash>/0.
 * The engine (ffmpeg) fetches those itself, so a public URL would leave the container and come back
 * through the reverse proxy and auth. Point such values at the engine's loopback address instead.
 * Matches absolute URLs on the request's own host whose path contains /engine/.
 */
export function rewriteEngineUrls(search: string, publicHosts: string[], engineUrl: string): string {
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  let changed = false;
  for (const [key, value] of [...params]) {
    const rewritten = toLoopback(value, publicHosts, engineUrl);
    if (rewritten !== null) {
      params.set(key, rewritten);
      changed = true;
    }
  }
  const out = changed ? params.toString() : search.replace(/^\?/, '');
  return out;
}

function toLoopback(value: string, publicHosts: string[], engineUrl: string): string | null {
  if (!/^https?:\/\//i.test(value)) return null;
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    return null;
  }
  if (!publicHosts.includes(u.host.toLowerCase())) return null;
  const i = u.pathname.indexOf(`${ENGINE_PREFIX}/`);
  if (i === -1) return null;
  return new URL(u.pathname.slice(i + ENGINE_PREFIX.length + 1) + u.search, engineUrl).href;
}

function publicHosts(req: Pick<FastifyRequest, 'headers'>): string[] {
  const hosts = [req.headers.host, req.headers['x-forwarded-host']]
    .flatMap((h) => (Array.isArray(h) ? h : h ? h.split(',') : []))
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  return [...new Set(hosts)];
}

export async function registerEngineProxy(app: FastifyInstance, engine: EngineSupervisor): Promise<void> {
  const fallback = 'http://127.0.0.1:11470';

  await app.register(httpProxy, {
    // empty upstream + getUpstream: the engine's port is only known once it's running
    upstream: '',
    prefix: ENGINE_PREFIX,
    rewritePrefix: '',
    // torrents can stall while buffering and HLS segments take time to transcode
    undici: { connections: 128, pipelining: 1, bodyTimeout: 0, headersTimeout: 120_000 },
    preHandler: async (_req, reply) => {
      if (!engine.url) {
        return reply.code(503).header('retry-after', '5').send({ error: 'engine unavailable', state: engine.state });
      }
    },
    replyOptions: {
      getUpstream: () => (engine.url ?? `${fallback}/`).replace(/\/$/, ''),
      queryString: (search, reqUrl, req) => {
        const query = search || (reqUrl.includes('?') ? reqUrl.slice(reqUrl.indexOf('?')) : '');
        return rewriteEngineUrls(query, publicHosts(req), engine.url ?? `${fallback}/`);
      },
    },
  });
}
