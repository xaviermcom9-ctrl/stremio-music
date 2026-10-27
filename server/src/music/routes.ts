// HTTP for music sources:
//  /sources/<id>/…        built-in and folder sources as Stremio addons (protocol endpoints)
//  /api/sources/…         Sources page (admin; per-user settings for everyone)
//  /api/music/…           what the Music UI uses: one API across all active sources
import { createReadStream } from 'node:fs';
import { parse as parseQs } from 'node:querystring';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { readNowPlaying, type NowPlaying } from './icy.js';
import { classifyMeta } from './protocol/content-types.js';
import { APP_VERSION, SourceError, toStremioManifest } from './runtime.js';
import type { SourceEntry, SourceRegistry } from './registry.js';

const userOf = (req: FastifyRequest) => (req.user ? { id: req.user.id, username: req.user.username } : null);
const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

function errorStatus(err: unknown): number {
  if (err instanceof SourceError) return err.kind === 'unsupported' ? 404 : err.kind === 'rate-limited' ? 429 : err.kind === 'timeout' ? 504 : 502;
  return 502;
}

/** Stremio extra path segment: "genre=Rock&skip=100" (querystring-encoded). */
function parseExtra(segment: string | undefined): Record<string, string> {
  if (!segment) return {};
  const q = parseQs(segment);
  return Object.fromEntries(Object.entries(q).flatMap(([k, v]) => (typeof v === 'string' ? [[k, v]] : Array.isArray(v) ? [[k, v[0]!]] : [])));
}

const sourceRef = (e: SourceEntry) => ({ id: e.id, name: e.name });

export function registerMusicRoutes(
  app: FastifyInstance,
  registry: SourceRegistry,
  info: { secretKeySource: string },
  fetchImpl?: typeof fetch,
  opts: { allowPrivateStreams?: boolean } = {},
): void {
  const nowPlayingCache = new Map<string, { at: number; value: NowPlaying }>();
  const requireAdmin = async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.user?.isAdmin) return reply.code(403).send({ error: 'admin only' });
  };
  const fail = (reply: FastifyReply, err: unknown) => reply.code(errorStatus(err)).send({ error: message(err) });

  // ------------------------------------------------------------ Stremio addon protocol

  app.get<{ Params: { id: string } }>('/sources/:id/icon', async (req, reply) => {
    const file = registry.iconPath(req.params.id);
    if (!file) return reply.code(404).send({ error: 'no icon' });
    const type = file.endsWith('.svg') ? 'image/svg+xml' : file.endsWith('.png') ? 'image/png' : 'application/octet-stream';
    return reply.type(type).header('cache-control', 'public, max-age=86400').header('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'").send(createReadStream(file));
  });

  app.get<{ Params: { id: string; '*': string } }>('/sources/:id/*', async (req, reply) => {
    const e = registry.get(req.params.id);
    if (!e?.runtime || !e.enabled) return reply.code(404).send({ error: 'no such source' });
    const rest = req.params['*'];
    if (rest === 'manifest.json') {
      return toStremioManifest(e.runtime.manifest, registry.iconPath(e.id) ? 'icon' : undefined);
    }
    const m = /^(catalog|meta|stream)\/music\/([^/]+?)(?:\/([^/]+?))?\.json$/.exec(rest);
    if (!m) return reply.code(404).send({ error: 'not found' });
    const [, resource, rawId, rawExtra] = m;
    const id = decodeURIComponent(rawId!);
    const user = userOf(req);
    const cache = e.runtime.manifest.cache;
    try {
      if (resource === 'catalog') {
        const metas = await registry.catalog(e, user, id, parseExtra(rawExtra && decodeURIComponent(rawExtra)));
        return { metas, cacheMaxAge: cache.catalog };
      }
      if (resource === 'meta') return { meta: await registry.meta(e, user, id), cacheMaxAge: cache.meta };
      return { streams: await registry.streams(e, user, id), cacheMaxAge: cache.streams };
    } catch (err) {
      return fail(reply, err);
    }
  });

  // ------------------------------------------------------------ Sources page

  app.get('/api/sources', async (req) => {
    const admin = !!req.user?.isAdmin;
    const user = userOf(req);
    const sources = registry
      .list()
      .filter((e) => admin || (e.enabled && Object.values(e.settingsSchema).some((f) => f.perUser)))
      .map((e) => registry.describe(e, user, admin));
    return {
      sources,
      pluginErrors: admin ? registry.folderErrors : [],
      secretKey: admin ? info.secretKeySource : undefined,
    };
  });

  app.post('/api/sources', { preHandler: requireAdmin }, async (req, reply) => {
    const body = z.object({ url: z.string().min(1).max(2048) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'Paste an addon manifest URL.' });
    try {
      const e = await registry.addRemote(body.data.url);
      return { source: registry.describe(e, userOf(req), true) };
    } catch (err) {
      return reply.code(400).send({ error: message(err) });
    }
  });

  app.delete<{ Params: { id: string } }>('/api/sources/:id', { preHandler: requireAdmin }, async (req, reply) => {
    try {
      registry.removeRemote(req.params.id);
      return { ok: true };
    } catch (err) {
      return reply.code(400).send({ error: message(err) });
    }
  });

  app.patch<{ Params: { id: string } }>('/api/sources/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const body = z.object({ enabled: z.boolean().optional(), settings: z.record(z.string(), z.unknown()).optional() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'Invalid input.' });
    try {
      if (body.data.settings) registry.setGlobalSettings(req.params.id, body.data.settings);
      if (body.data.enabled !== undefined) registry.setEnabled(req.params.id, body.data.enabled);
      return { source: registry.describe(registry.require(req.params.id), userOf(req), true) };
    } catch (err) {
      return reply.code(400).send({ error: message(err) });
    }
  });

  app.put('/api/sources/order', { preHandler: requireAdmin }, async (req, reply) => {
    const body = z.object({ ids: z.array(z.string()) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'Invalid input.' });
    try {
      registry.setOrder(body.data.ids);
      return { ok: true };
    } catch (err) {
      return reply.code(400).send({ error: message(err) });
    }
  });

  app.post<{ Params: { id: string } }>('/api/sources/:id/test', async (req, reply) => {
    const e = registry.get(req.params.id);
    if (!e || (!req.user?.isAdmin && !e.enabled)) return reply.code(404).send({ error: 'no such source' });
    return registry.test(e, userOf(req));
  });

  app.post<{ Params: { id: string } }>('/api/sources/:id/refresh', { preHandler: requireAdmin }, async (req, reply) => {
    try {
      await registry.refresh(req.params.id);
      return { source: registry.describe(registry.require(req.params.id), userOf(req), true) };
    } catch (err) {
      return reply.code(400).send({ error: message(err) });
    }
  });

  app.get<{ Params: { id: string } }>('/api/sources/:id/logs', { preHandler: requireAdmin }, async (req, reply) => {
    const e = registry.get(req.params.id);
    if (!e) return reply.code(404).send({ error: 'no such source' });
    return { lines: registry.logs(e) };
  });

  app.post('/api/sources/reload', { preHandler: requireAdmin }, async () => registry.reloadFolderPlugins());

  app.put<{ Params: { id: string } }>('/api/me/sources/:id/settings', async (req, reply) => {
    const body = z.record(z.string(), z.unknown()).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'Invalid input.' });
    try {
      registry.setUserSettings(req.params.id, req.user!.id, body.data);
      return { source: registry.describe(registry.require(req.params.id), userOf(req), !!req.user?.isAdmin) };
    } catch (err) {
      return reply.code(400).send({ error: message(err) });
    }
  });

  // ------------------------------------------------------------ Music UI API (aggregated)

  app.get('/api/music/sources', async (req) => ({
    sources: registry.active(userOf(req)).map((e) => {
      const d = registry.describe(e, userOf(req), false);
      return {
        id: d.id,
        name: d.name,
        icon: d.icon,
        kind: d.kind,
        capabilities: d.capabilities,
        attribution: d.attribution,
        catalogs: d.catalogs,
        // library sync (Navidrome): likes both ways, playlists copied to the source
        sync: { likes: registry.hasHook(e, 'listLiked'), playlists: registry.hasHook(e, 'savePlaylist') },
      };
    }),
  }));

  app.get<{ Params: { source: string; catalog: string }; Querystring: Record<string, string> }>(
    '/api/music/catalog/:source/:catalog',
    async (req, reply) => {
      const e = registry.active(userOf(req)).find((x) => x.id === req.params.source);
      if (!e) return reply.code(404).send({ error: 'no such source' });
      try {
        const metas = await registry.catalog(e, userOf(req), req.params.catalog, req.query);
        return { source: sourceRef(e), metas: metas.map((m) => withKind(m)) };
      } catch (err) {
        return fail(reply, err);
      }
    },
  );

  app.get<{ Querystring: { q?: string } }>('/api/music/search', async (req, reply) => {
    const q = req.query.q?.trim();
    if (!q) return reply.code(400).send({ error: 'missing q' });
    const user = userOf(req);
    const targets = registry.active(user).flatMap((e) => e.catalogs.filter((c) => c.searchable).map((c) => ({ e, c })));
    const settled = await Promise.allSettled(targets.map(({ e, c }) => registry.catalog(e, user, c.id, { search: q })));
    const results: unknown[] = [];
    const errors: unknown[] = [];
    settled.forEach((r, i) => {
      const { e, c } = targets[i]!;
      if (r.status === 'fulfilled') results.push({ source: sourceRef(e), catalog: { id: c.id, name: c.name, kind: c.kind ?? null }, metas: r.value.map(withKind) });
      else errors.push({ source: sourceRef(e), catalog: c.id, error: message(r.reason) });
    });
    return { query: q, results, errors };
  });

  app.get<{ Querystring: { id?: string } }>('/api/music/meta', async (req, reply) => {
    const id = req.query.id;
    if (!id) return reply.code(400).send({ error: 'missing id' });
    const user = userOf(req);
    const errors: unknown[] = [];
    for (const e of registry.active(user).filter((x) => registry.owns(x, 'meta', id))) {
      try {
        const meta = await registry.meta(e, user, id);
        if (meta) return { source: sourceRef(e), meta: withKind(meta as never) };
      } catch (err) {
        errors.push({ source: sourceRef(e), error: message(err) });
      }
    }
    return reply.code(404).send({ error: 'not found', errors });
  });

  // what a live station is playing (ICY metadata, read server-side; cached 15 s per station)
  app.get<{ Querystring: { id?: string } }>('/api/music/nowplaying', async (req, reply) => {
    const id = req.query.id;
    if (!id) return reply.code(400).send({ error: 'missing id' });
    const hit = nowPlayingCache.get(id);
    if (hit && Date.now() - hit.at < 15_000) return hit.value;
    const user = userOf(req);
    const owner = registry.active(user).find((e) => registry.owns(e, 'stream', id));
    if (!owner) return reply.code(404).send({ error: 'no source for this id' });
    const streams = (await registry.streams(owner, user, id).catch(() => [])) as { url?: string; behaviorHints?: { music?: { live?: boolean; codec?: string } } }[];
    const live = streams.find((s) => s.url && /^https?:/.test(s.url) && s.behaviorHints?.music?.live && s.behaviorHints.music.codec !== 'hls');
    if (!live) return { title: null };
    try {
      const value = await readNowPlaying(live.url!, { userAgent: `StremioMusic/${APP_VERSION}`, allowPrivate: opts.allowPrivateStreams });
      nowPlayingCache.set(id, { at: Date.now(), value });
      if (nowPlayingCache.size > 500) nowPlayingCache.delete(nowPlayingCache.keys().next().value!);
      return value;
    } catch (err) {
      return { title: null, error: message(err) };
    }
  });

  app.get<{ Querystring: { id?: string } }>('/api/music/streams', async (req, reply) => {
    const id = req.query.id;
    if (!id) return reply.code(400).send({ error: 'missing id' });
    const user = userOf(req);
    const owners = registry.active(user).filter((x) => registry.owns(x, 'stream', id));
    const settled = await Promise.allSettled(owners.map((e) => registry.streams(e, user, id)));
    const streams: unknown[] = [];
    const errors: unknown[] = [];
    settled.forEach((r, i) => {
      if (r.status === 'fulfilled') streams.push(...(r.value as object[]).map((s) => ({ ...playOnly(forBrowser(s)), source: sourceRef(owners[i]!) })));
      else errors.push({ source: sourceRef(owners[i]!), error: message(r.reason) });
    });
    return { streams, errors };
  });
}

/**
 * YouTube streams from remote addons are play-only: never offered for download (brief).
 */
function playOnly(stream: object): object {
  const s = stream as { ytId?: string; behaviorHints?: { music?: object; [k: string]: unknown } };
  if (!s.ytId) return stream;
  return { ...s, behaviorHints: { ...s.behaviorHints, music: { ...s.behaviorHints?.music, downloadable: false, playOnly: true } } };
}

/**
 * Request headers a source needs for a stream (auth tokens…) stay on the server: the browser only
 * learns that the stream must go through the backend's proxy (Phase 7).
 */
function forBrowser(stream: object): object {
  const s = stream as { behaviorHints?: { proxyHeaders?: unknown; [k: string]: unknown } };
  if (!s.behaviorHints?.proxyHeaders) return stream;
  const { proxyHeaders: _hidden, ...hints } = s.behaviorHints;
  return { ...s, behaviorHints: { ...hints, music: { ...(hints.music as object), needsProxy: true } } };
}

/** Third-party addons may not set `music.kind`; derive it so the UI can group results. */
function withKind<T extends object>(m: T): T {
  const music = ((m as { music?: unknown }).music ?? {}) as Record<string, unknown>;
  if (music.kind) return m;
  return { ...m, music: { ...music, kind: classifyMeta(m as never) } };
}
