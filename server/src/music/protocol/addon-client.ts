// Ported from Resonance (~/resonance/server/src/protocol/addon-client.ts).
import { createHash } from 'node:crypto';
import { resolveCachePolicy, type ResponseCache } from './cache.js';
import { isSupported, normalizeManifestUrl, validateManifest } from './manifest.js';
import { RateLimiter, RateLimitError } from './limiter.js';
import { addonBaseUrl, resourceUrl } from './request.js';
import type {
  CacheProps,
  CatalogResponse,
  ExtraArgs,
  Manifest,
  Meta,
  MetaPreview,
  MetaResponse,
  Stream,
  StreamResponse,
} from './types.js';

export type AddonErrorKind = 'timeout' | 'network' | 'http' | 'not-found' | 'invalid' | 'unsupported' | 'not-loaded' | 'rate-limited';

export class AddonError extends Error {
  constructor(
    public kind: AddonErrorKind,
    message: string,
    public status?: number,
  ) {
    super(message);
    this.name = 'AddonError';
  }
}

export interface AddonClientOptions {
  timeoutMs: number;
  /** Fallback TTLs (seconds) when an addon sends no cache hints. */
  defaultTtl: { manifest: number; catalog: number; meta: number; stream: number };
  /** Max wait before retrying a failed manifest load on demand; retries back off from 2s up to this. */
  retryAfterMs: number;
  /** Largest response body accepted from an addon, in bytes. */
  maxResponseBytes: number;
  userAgent: string;
  /** Outbound limits per addon. */
  rateLimit?: { ratePerSecond: number; burst: number; maxConcurrent: number; maxWaitMs: number };
  fetch?: typeof fetch;
  now?: () => number;
}

export type AddonState = 'pending' | 'ok' | 'error';

export interface AddonStatus {
  key: string;
  url: string;
  state: AddonState;
  error?: string;
  warnings: string[];
  loadedAt?: number;
  manifest?: Manifest;
}

/** Client for a single addon over the HTTP transport. */
export class AddonClient {
  readonly key: string;
  readonly url: string;
  private base: string;
  private state: AddonState = 'pending';
  private manifestValue?: Manifest;
  private error?: string;
  private warnings: string[] = [];
  private loadedAt?: number;
  private lastAttempt = 0;
  private failures = 0;
  private loading?: Promise<void>;
  private inflight = new Map<string, Promise<unknown>>();
  private fetchImpl: typeof fetch;
  private now: () => number;
  private limiter?: RateLimiter;

  constructor(
    rawUrl: string,
    private cache: ResponseCache,
    private opts: AddonClientOptions,
  ) {
    this.url = normalizeManifestUrl(rawUrl);
    this.base = addonBaseUrl(this.url);
    // Stable across restarts and independent of whether the manifest loads.
    this.key = createHash('sha1').update(this.url).digest('hex').slice(0, 10);
    this.fetchImpl = opts.fetch ?? fetch;
    this.now = opts.now ?? Date.now;
    if (opts.rateLimit) this.limiter = new RateLimiter(opts.rateLimit);
  }

  get manifest(): Manifest | undefined {
    return this.manifestValue;
  }

  get name(): string {
    return this.manifestValue?.name ?? new URL(this.url).host;
  }

  status(): AddonStatus {
    return {
      key: this.key,
      url: this.url,
      state: this.state,
      error: this.error,
      warnings: this.warnings,
      loadedAt: this.loadedAt,
      manifest: this.manifestValue,
    };
  }

  /** Fetches and validates manifest.json. Concurrent calls share one request. */
  load(force = false): Promise<void> {
    if (force) this.cache.delete(this.url);
    this.loading ??= this.doLoad().finally(() => (this.loading = undefined));
    return this.loading;
  }

  private async doLoad() {
    this.lastAttempt = this.now();
    try {
      const raw = await this.cachedGet<unknown>(this.url, this.opts.defaultTtl.manifest, (body) => {
        const v = validateManifest(body);
        if (!v.valid) throw new AddonError('invalid', `invalid manifest: ${v.errors.join('; ')}`);
        return v;
      });
      const v = raw as ReturnType<typeof validateManifest>;
      const previous = this.manifestValue;
      this.manifestValue = v.manifest;
      this.warnings = v.warnings;
      this.state = 'ok';
      this.error = undefined;
      this.loadedAt = this.now();
      this.failures = 0;
      // A new addon version may change ids or content; drop its cached resources.
      if (previous && previous.version !== v.manifest!.version) this.cache.deletePrefix(this.base);
    } catch (err) {
      this.error = errorMessage(err);
      this.failures++;
      // Keep serving a previously loaded manifest if a refresh fails.
      if (!this.manifestValue) this.state = 'error';
    }
  }

  /** Loads the manifest lazily; a failed load is retried with exponential backoff capped at `retryAfterMs`. */
  async ready(): Promise<Manifest> {
    const backoff = Math.min(this.opts.retryAfterMs, 2000 * 2 ** Math.max(0, this.failures - 1));
    if (!this.manifestValue && (this.state === 'pending' || this.now() - this.lastAttempt >= backoff)) await this.load();
    if (!this.manifestValue) throw new AddonError('not-loaded', this.error ?? 'manifest not loaded');
    return this.manifestValue;
  }

  supports(resource: string, type: string, id: string): boolean {
    return !!this.manifestValue && isSupported(this.manifestValue, resource, type, id);
  }

  async catalog(type: string, id: string, extra?: ExtraArgs): Promise<MetaPreview[]> {
    await this.requireSupport('catalog', type, id);
    const url = resourceUrl(this.url, 'catalog', type, id, extra);
    return this.cachedGet(url, this.opts.defaultTtl.catalog, (b) => parseCatalog(b));
  }

  async meta(type: string, id: string): Promise<Meta | null> {
    await this.requireSupport('meta', type, id);
    const url = resourceUrl(this.url, 'meta', type, id);
    return this.cachedGet(url, this.opts.defaultTtl.meta, (b) => parseMeta(b));
  }

  async streams(type: string, id: string): Promise<Stream[]> {
    await this.requireSupport('stream', type, id);
    const url = resourceUrl(this.url, 'stream', type, id);
    return this.cachedGet(url, this.opts.defaultTtl.stream, (b) => parseStreams(b));
  }

  private async requireSupport(resource: string, type: string, id: string) {
    const manifest = await this.ready();
    if (!isSupported(manifest, resource, type, id))
      throw new AddonError('unsupported', `${manifest.name} does not provide ${resource}/${type}/${id}`);
  }

  /**
   * GET with caching. `parse` validates and shapes the body; it runs before
   * caching so invalid responses are never stored. Honors stale-while-revalidate
   * (return stale, refresh in background) and stale-if-error.
   */
  private async cachedGet<T>(url: string, defaultTtl: number, parse: (body: unknown) => T): Promise<T> {
    const hit = this.cache.get<T>(url);
    if (hit.state === 'fresh') return hit.value;
    if (hit.state === 'revalidate') {
      this.fetchAndStore(url, defaultTtl, parse).catch(() => {});
      return hit.value;
    }
    try {
      return await this.fetchAndStore(url, defaultTtl, parse);
    } catch (err) {
      if (hit.state === 'stale-if-error' && !(err instanceof AddonError && err.kind === 'not-found')) return hit.value;
      throw err;
    }
  }

  private fetchAndStore<T>(url: string, defaultTtl: number, parse: (body: unknown) => T): Promise<T> {
    const existing = this.inflight.get(url) as Promise<T> | undefined;
    if (existing) return existing;
    const p = (async () => {
      const { body, cacheControl } = await this.fetchJson(url);
      const value = parse(body);
      const policy = resolveCachePolicy(body as CacheProps, cacheControl, defaultTtl);
      if (policy) this.cache.set(url, value, policy);
      return value;
    })().finally(() => this.inflight.delete(url));
    this.inflight.set(url, p);
    return p;
  }

  private async fetchJson(url: string): Promise<{ body: unknown; cacheControl: string | null }> {
    let release: (() => void) | undefined;
    try {
      release = await this.limiter?.acquire();
    } catch (err) {
      if (err instanceof RateLimitError) throw new AddonError('rate-limited', `rate limited: ${err.message}`);
      throw err;
    }
    try {
      return await this.fetchJsonUnlimited(url);
    } finally {
      release?.();
    }
  }

  private async fetchJsonUnlimited(url: string): Promise<{ body: unknown; cacheControl: string | null }> {
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        signal: AbortSignal.timeout(this.opts.timeoutMs),
        headers: { accept: 'application/json', 'user-agent': this.opts.userAgent },
        redirect: 'follow',
      });
    } catch (err) {
      const e = err as Error;
      if (e.name === 'TimeoutError' || e.name === 'AbortError')
        throw new AddonError('timeout', `timed out after ${this.opts.timeoutMs}ms`);
      throw new AddonError('network', (e.cause as Error | undefined)?.message ?? e.message);
    }
    if (res.status === 404) {
      await res.body?.cancel();
      throw new AddonError('not-found', 'not found', 404);
    }
    if (!res.ok) {
      await res.body?.cancel();
      throw new AddonError('http', `HTTP ${res.status}`, res.status);
    }
    const text = await readLimited(res, this.opts.maxResponseBytes, this.opts.timeoutMs);
    try {
      return { body: JSON.parse(text), cacheControl: res.headers.get('cache-control') };
    } catch {
      throw new AddonError('invalid', 'response is not valid JSON');
    }
  }
}

async function readLimited(res: Response, maxBytes: number, timeoutMs: number): Promise<string> {
  const declared = Number(res.headers.get('content-length'));
  if (declared > maxBytes) {
    await res.body?.cancel();
    throw new AddonError('invalid', `response too large (${declared} bytes)`);
  }
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const timer = setTimeout(() => reader.cancel().catch(() => {}), timeoutMs);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new AddonError('invalid', `response too large (> ${maxBytes} bytes)`);
      }
      chunks.push(value);
    }
  } catch (err) {
    if (err instanceof AddonError) throw err;
    throw new AddonError('timeout', `body read failed or timed out: ${errorMessage(err)}`);
  } finally {
    clearTimeout(timer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Keeps preview items that have the fields the docs mark required (poster is often omitted, so it is not enforced). */
export function parseCatalog(body: unknown): MetaPreview[] {
  if (!isObj(body) || !Array.isArray(body.metas)) throw new AddonError('invalid', 'catalog response has no metas array');
  return body.metas.filter(
    (m): m is MetaPreview => isObj(m) && typeof m.id === 'string' && typeof m.type === 'string' && typeof m.name === 'string',
  );
}

/** `{ meta: {} }` (as in the SDK example) or `{ meta: null }` means "no meta". */
export function parseMeta(body: unknown): Meta | null {
  if (!isObj(body) || !('meta' in body)) throw new AddonError('invalid', 'meta response has no meta property');
  const m = body.meta;
  if (!isObj(m) || typeof m.id !== 'string') return null;
  if (typeof m.type !== 'string' || typeof m.name !== 'string')
    throw new AddonError('invalid', 'meta object is missing type or name');
  const videos = Array.isArray(m.videos)
    ? m.videos.filter((v) => isObj(v) && typeof v.id === 'string')
    : undefined;
  return { ...(m as unknown as Meta), videos: videos as Meta['videos'] };
}

const STREAM_SOURCES = ['url', 'ytId', 'infoHash', 'externalUrl'] as const;

/** Keeps streams that point somewhere; normalizes infoHash to lowercase hex. */
export function parseStreams(body: unknown): Stream[] {
  if (!isObj(body) || !Array.isArray(body.streams)) throw new AddonError('invalid', 'stream response has no streams array');
  return body.streams
    .filter((s): s is Stream => isObj(s) && STREAM_SOURCES.some((k) => typeof s[k] === 'string' && s[k] !== ''))
    .map((s) => (s.infoHash ? { ...s, infoHash: s.infoHash.toLowerCase() } : s));
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
