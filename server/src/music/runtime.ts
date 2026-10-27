// Runs one MusicSource (built-in, or a folder plugin behind its process boundary) and exposes it
// as a Stremio addon: validated manifest, rate-limited fetch for the source, response cache,
// output validation, stats and a log buffer for the Sources page.
import { z } from 'zod';
import type {
  CatalogRequest,
  Logger,
  MusicMeta,
  MusicMetaPreview,
  MusicSource,
  MusicStream,
  SourceContext,
  SourceManifest,
  SourceResponse,
  SourceTestResult,
} from '../music-sources/sdk.js';
import { ResponseCache } from './protocol/cache.js';
import { RateLimiter, RateLimitError } from './protocol/limiter.js';
import type { Manifest } from './protocol/types.js';

export const APP_VERSION = '0.1.0';
const CALL_TIMEOUT_MS = 30_000;
const FETCH_TIMEOUT_MS = 15_000;
const MAX_FETCH_BYTES = 10 * 1024 * 1024;
const LOG_LINES = 300;

const Num = z.number().finite();
const SettingField = z.object({
  type: z.enum(['string', 'url', 'number', 'boolean', 'select']),
  label: z.string().min(1),
  help: z.string().optional(),
  default: z.union([z.string(), z.number(), z.boolean()]).optional(),
  required: z.boolean().optional(),
  secret: z.boolean().optional(),
  perUser: z.boolean().optional(),
  options: z.array(z.object({ value: z.string(), label: z.string() })).optional(),
});

export const SourceManifestSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/, 'lowercase letters, digits and dashes (max 40)'),
  name: z.string().min(1).max(60),
  version: z.string().regex(/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/, 'version must be semver'),
  description: z.string().min(1).max(500),
  icon: z.string().optional(),
  attribution: z.string().optional(),
  capabilities: z.object({
    catalogs: z.boolean(),
    search: z.boolean(),
    meta: z.boolean(),
    streams: z.boolean(),
    downloadable: z.boolean(),
    live: z.boolean(),
  }),
  catalogs: z.array(
    z.object({
      id: z.string().regex(/^[a-zA-Z0-9._-]{1,64}$/),
      name: z.string().min(1),
      kind: z.enum(['artist', 'album', 'track', 'station', 'playlist']).optional(),
      extra: z.array(z.object({ name: z.string().min(1), isRequired: z.boolean().optional(), options: z.array(z.string()).optional() })).optional(),
    }),
  ),
  settings: z.record(z.string().regex(/^[a-zA-Z][a-zA-Z0-9]{0,39}$/), SettingField),
  rateLimit: z.object({ requestsPerSecond: Num.positive(), burst: z.number().int().min(1), concurrency: z.number().int().min(1).max(32) }),
  cache: z.object({ catalog: Num.min(0), meta: Num.min(0), streams: Num.min(0) }),
  userAgent: z.string().optional(),
  allowedHosts: z.array(z.string().min(1)).optional(),
});

/** Validates a source manifest; returns readable errors instead of throwing. */
export function validateSourceManifest(input: unknown): { ok: true; manifest: SourceManifest } | { ok: false; errors: string[] } {
  const r = SourceManifestSchema.safeParse(input);
  if (!r.success) return { ok: false, errors: r.error.issues.map((i) => `${i.path.join('.') || 'manifest'}: ${i.message}`) };
  const m = r.data as SourceManifest;
  const errors: string[] = [];
  const ids = new Set<string>();
  for (const c of m.catalogs) {
    if (ids.has(c.id)) errors.push(`catalogs: duplicate id "${c.id}"`);
    ids.add(c.id);
  }
  if (m.capabilities.search && !m.catalogs.some((c) => c.extra?.some((e) => e.name === 'search'))) {
    errors.push('capabilities.search is true but no catalog declares the "search" extra');
  }
  if (m.capabilities.catalogs !== m.catalogs.length > 0) errors.push('capabilities.catalogs must match whether catalogs are declared');
  if (m.capabilities.live && m.capabilities.downloadable) errors.push('a live source cannot be downloadable');
  return errors.length ? { ok: false, errors } : { ok: true, manifest: m };
}

/** The Stremio addon manifest served at /sources/<id>/manifest.json. */
export function toStremioManifest(m: SourceManifest, logoUrl?: string): Manifest {
  const prefix = [`${m.id}:`];
  const resources: Manifest['resources'] = [];
  if (m.capabilities.catalogs) resources.push('catalog');
  if (m.capabilities.meta) resources.push({ name: 'meta', types: ['music'], idPrefixes: prefix });
  if (m.capabilities.streams) resources.push({ name: 'stream', types: ['music'], idPrefixes: prefix });
  return {
    id: `stremio-music.${m.id}`,
    name: m.name,
    version: m.version,
    description: m.description,
    logo: logoUrl,
    types: ['music'],
    idPrefixes: prefix,
    resources,
    catalogs: m.catalogs.map((c) => ({ type: 'music', id: c.id, name: c.name, extra: c.extra })),
    behaviorHints: { configurable: false },
    music: { capabilities: m.capabilities, attribution: m.attribution },
  };
}

// ---- output validation (bad items are dropped and logged, so one broken item can't break a page)

const Licence = z.object({ name: z.string(), url: z.string().optional(), attribution: z.string().optional() }).passthrough();
const MusicInfo = z
  .object({ kind: z.enum(['artist', 'album', 'track', 'station', 'playlist']), licence: Licence.optional(), duration: Num.optional() })
  .passthrough();
const Preview = z
  .object({ id: z.string().min(1), type: z.literal('music'), name: z.string().min(1), poster: z.string().optional(), music: MusicInfo })
  .passthrough();
const Track = z.object({ id: z.string().min(1), title: z.string() }).passthrough();
const Meta = Preview.extend({ videos: z.array(Track).optional() });
const Stream = z
  .object({ url: z.string().optional(), infoHash: z.string().regex(/^[0-9a-fA-F]{40}$/).optional(), fileIdx: z.number().int().min(0).optional(), ytId: z.string().optional() })
  .passthrough()
  .refine((s) => [s.url, s.infoHash, s.ytId].filter(Boolean).length === 1, 'exactly one of url, infoHash, ytId');

export interface SourceStats {
  requests: number;
  errors: number;
  rateLimited: number;
  invalidItems: number;
  avgMs: number;
  lastError: { at: string; message: string } | null;
}

export interface RuntimeOptions {
  /** settings for a user (secrets decrypted, defaults applied) */
  settingsFor(user: SourceContext['user']): Record<string, string | number | boolean | undefined>;
  /** true when any setting is per-user: then cached responses are per user too */
  perUser: boolean;
  cache: ResponseCache;
  fetchImpl?: typeof fetch;
  onLog?: (line: string) => void;
}

/** Thrown for a source's own failures (vs. "not found"). */
export class SourceError extends Error {
  constructor(
    message: string,
    readonly kind: 'timeout' | 'rate-limited' | 'blocked-host' | 'invalid' | 'failed' | 'unsupported',
  ) {
    super(message);
  }
}

export class SourceRuntime {
  readonly manifest: SourceManifest;
  readonly stats: SourceStats = { requests: 0, errors: 0, rateLimited: 0, invalidItems: 0, avgMs: 0, lastError: null };
  readonly logs: string[] = [];
  private readonly limiter: RateLimiter;
  private readonly fetchImpl: typeof fetch;

  constructor(
    readonly impl: MusicSource,
    private readonly opts: RuntimeOptions,
  ) {
    this.manifest = impl.manifest;
    const { requestsPerSecond, burst, concurrency } = this.manifest.rateLimit;
    this.limiter = new RateLimiter({ ratePerSecond: requestsPerSecond, burst, maxConcurrent: concurrency, maxWaitMs: 20_000 });
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  get id(): string {
    return this.manifest.id;
  }

  log(level: string, message: string): void {
    const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${message}`;
    this.logs.push(line);
    if (this.logs.length > LOG_LINES) this.logs.splice(0, this.logs.length - LOG_LINES);
    this.opts.onLog?.(line);
  }

  private logger(): Logger {
    return {
      debug: (m) => this.log('debug', m),
      info: (m) => this.log('info', m),
      warn: (m) => this.log('warn', m),
      error: (m) => this.log('error', m),
    };
  }

  /** Hosts ctx.fetch may reach: the manifest's list plus the hosts of url-type settings. */
  allowedHosts(settings: Record<string, unknown>): string[] {
    const hosts = [...(this.manifest.allowedHosts ?? [])];
    for (const [key, field] of Object.entries(this.manifest.settings)) {
      const v = settings[key];
      if (field.type === 'url' && typeof v === 'string' && v) {
        try {
          hosts.push(new URL(v).host);
        } catch {
          // invalid URL setting: nothing to allow
        }
      }
    }
    return hosts;
  }

  context(user: SourceContext['user']): SourceContext {
    const settings = this.opts.settingsFor(user);
    const allowed = this.allowedHosts(settings);
    return {
      settings,
      user,
      log: this.logger(),
      fetch: (url, init) => this.sourceFetch(url, init, allowed),
    };
  }

  async sourceFetch(
    url: string,
    init: { method?: string; headers?: Record<string, string>; body?: string; timeoutMs?: number } = {},
    allowed: string[],
  ): Promise<SourceResponse> {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      throw new SourceError(`invalid URL: ${url}`, 'invalid');
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new SourceError(`only http(s) URLs: ${url}`, 'blocked-host');
    if (!hostAllowed(u.host, allowed)) throw new SourceError(`host not allowed: ${u.host} (add it to manifest.allowedHosts)`, 'blocked-host');
    let release: () => void;
    try {
      release = await this.limiter.acquire();
    } catch (err) {
      this.stats.rateLimited++;
      throw new SourceError(err instanceof RateLimitError ? `rate limited: ${err.message}` : String(err), 'rate-limited');
    }
    try {
      const res = await this.fetchImpl(u, {
        method: init.method ?? 'GET',
        headers: { 'user-agent': this.manifest.userAgent ?? `StremioMusic/${APP_VERSION} (self-hosted)`, ...init.headers },
        body: init.body,
        redirect: 'follow',
        signal: AbortSignal.timeout(init.timeoutMs ?? FETCH_TIMEOUT_MS),
      });
      const final = new URL(res.url || u.href);
      if (!hostAllowed(final.host, allowed)) {
        await res.body?.cancel();
        throw new SourceError(`redirected to a host that isn't allowed: ${final.host}`, 'blocked-host');
      }
      const buf = await readCapped(res, MAX_FETCH_BYTES);
      const text = buf.toString('utf8');
      return {
        ok: res.ok,
        status: res.status,
        url: final.href,
        headers: Object.fromEntries(res.headers),
        text: async () => text,
        json: async <T>() => JSON.parse(text) as T,
      };
    } catch (err) {
      if (err instanceof SourceError) throw err;
      const e = err as Error;
      if (e.name === 'TimeoutError' || e.name === 'AbortError') throw new SourceError(`timed out: ${u.host}`, 'timeout');
      throw new SourceError(`${u.host}: ${(e.cause as Error | undefined)?.message ?? e.message}`, 'failed');
    } finally {
      release();
    }
  }

  private cacheKey(user: SourceContext['user'], parts: unknown[]): string {
    return JSON.stringify([this.id, this.manifest.version, this.opts.perUser ? (user?.id ?? 0) : null, ...parts]);
  }

  /** Runs one source call with timeout, stats, cache and logging. */
  private async run<T>(what: string, user: SourceContext['user'], ttl: number, key: unknown[], fn: (ctx: SourceContext) => Promise<T>): Promise<T> {
    const ck = this.cacheKey(user, key);
    const hit = this.opts.cache.get<T>(ck);
    if (hit.state === 'fresh') return hit.value;
    const started = Date.now();
    this.stats.requests++;
    try {
      const value = await withTimeout(fn(this.context(user)), CALL_TIMEOUT_MS, what);
      if (ttl > 0) this.opts.cache.set(ck, value, { maxAge: ttl, staleRevalidate: 0, staleError: ttl * 4 });
      return value;
    } catch (err) {
      this.stats.errors++;
      const message = err instanceof Error ? err.message : String(err);
      this.stats.lastError = { at: new Date().toISOString(), message: `${what}: ${message}` };
      this.log('error', `${what} failed: ${message}`);
      if (hit.state === 'stale-if-error' || hit.state === 'revalidate') return hit.value;
      throw err instanceof SourceError ? err : new SourceError(message, err instanceof TimeoutError ? 'timeout' : 'failed');
    } finally {
      const ms = Date.now() - started;
      this.stats.avgMs = Math.round(this.stats.avgMs + (ms - this.stats.avgMs) / Math.min(this.stats.requests, 50));
    }
  }

  private keep<T>(schema: z.ZodType<T>, items: unknown, what: string): T[] {
    if (!Array.isArray(items)) throw new SourceError(`${what}: expected an array`, 'invalid');
    const out: T[] = [];
    for (const item of items) {
      const r = schema.safeParse(item);
      if (r.success && this.ownsId((r.data as { id?: string }).id)) out.push(r.data);
      else {
        this.stats.invalidItems++;
        const why = r.success ? `id must start with "${this.id}:"` : r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
        this.log('warn', `${what}: dropped invalid item (${why})`);
      }
    }
    return out;
  }

  private ownsId(id: string | undefined): boolean {
    return id === undefined || id.startsWith(`${this.id}:`);
  }

  async catalog(user: SourceContext['user'], catalogId: string, extra: Record<string, string>): Promise<MusicMetaPreview[]> {
    const def = this.manifest.catalogs.find((c) => c.id === catalogId);
    if (!def || !this.impl.catalog) throw new SourceError(`no catalog "${catalogId}"`, 'unsupported');
    const declared = new Set((def.extra ?? []).map((e) => e.name));
    const unknown = Object.keys(extra).filter((k) => !declared.has(k));
    if (unknown.length) throw new SourceError(`catalog "${catalogId}" doesn't accept: ${unknown.join(', ')}`, 'unsupported');
    const missing = (def.extra ?? []).filter((e) => e.isRequired && !extra[e.name]).map((e) => e.name);
    if (missing.length) throw new SourceError(`catalog "${catalogId}" requires: ${missing.join(', ')}`, 'unsupported');
    const skip = Number(extra.skip);
    const req: CatalogRequest = {
      catalogId,
      search: extra.search?.trim() || undefined,
      genre: extra.genre || undefined,
      skip: Number.isInteger(skip) && skip > 0 ? skip : 0,
      extra,
    };
    const items = await this.run(`catalog ${catalogId}`, user, this.manifest.cache.catalog, ['catalog', catalogId, extra], (ctx) =>
      this.impl.catalog!(req, ctx),
    );
    return this.keep(Preview, items, `catalog ${catalogId}`) as unknown as MusicMetaPreview[];
  }

  async meta(user: SourceContext['user'], id: string): Promise<MusicMeta | null> {
    if (!this.impl.meta) throw new SourceError('no meta support', 'unsupported');
    const meta = await this.run(`meta ${id}`, user, this.manifest.cache.meta, ['meta', id], (ctx) => this.impl.meta!(id, ctx));
    if (meta === null || meta === undefined) return null;
    const [ok] = this.keep(Meta, [meta], `meta ${id}`);
    if (!ok) return null;
    if (ok.videos) ok.videos = this.keep(Track, ok.videos, `meta ${id} videos`);
    return ok as unknown as MusicMeta;
  }

  async streams(user: SourceContext['user'], id: string): Promise<MusicStream[]> {
    if (!this.impl.streams) throw new SourceError('no stream support', 'unsupported');
    const streams = await this.run(`streams ${id}`, user, this.manifest.cache.streams, ['streams', id], (ctx) => this.impl.streams!(id, ctx));
    const kept = this.keep(Stream, streams, `streams ${id}`) as unknown as MusicStream[];
    return kept.map((s) => (s.infoHash ? { ...s, infoHash: s.infoHash.toLowerCase() } : s));
  }

  async test(user: SourceContext['user']): Promise<SourceTestResult> {
    const started = Date.now();
    try {
      if (this.impl.test) {
        const r = await withTimeout(this.impl.test(this.context(user)), CALL_TIMEOUT_MS, 'test');
        this.log(r.ok ? 'info' : 'warn', `test: ${r.message}`);
        return r;
      }
      const first = this.manifest.catalogs.find((c) => !(c.extra ?? []).some((e) => e.isRequired));
      if (!first) return { ok: true, message: 'Loaded (nothing to test without a feed catalog).' };
      const items = await this.catalog(user, first.id, {});
      return { ok: true, message: `${first.name}: ${items.length} items in ${Date.now() - started} ms.` };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log('warn', `test failed: ${message}`);
      return { ok: false, message };
    }
  }
}

export function hostAllowed(host: string, allowed: string[]): boolean {
  const h = host.toLowerCase();
  return allowed.some((a) => {
    const p = a.toLowerCase();
    return p.startsWith('*.') ? h.endsWith(p.slice(1)) || h === p.slice(2) : h === p;
  });
}

class TimeoutError extends Error {}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new TimeoutError(`${what} took longer than ${ms / 1000}s`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

async function readCapped(res: Response, max: number): Promise<Buffer> {
  if (Number(res.headers.get('content-length')) > max) {
    await res.body?.cancel();
    throw new SourceError(`response larger than ${max} bytes`, 'invalid');
  }
  if (!res.body) return Buffer.alloc(0);
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    size += chunk.byteLength;
    if (size > max) throw new SourceError(`response larger than ${max} bytes`, 'invalid');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export { ResponseCache };
