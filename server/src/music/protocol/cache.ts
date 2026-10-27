// Ported from Resonance (~/resonance/server/src/protocol/cache.ts).
import type { CacheProps } from './types.js';

/** Cache lifetime for one response, in seconds. */
export interface CachePolicy {
  maxAge: number;
  /** Serve stale while refreshing in the background for this long after expiry. */
  staleRevalidate: number;
  /** Serve stale when the addon errors for this long after expiry. */
  staleError: number;
}

/**
 * Derives the cache policy for a response. The SDK sets `cacheMaxAge`,
 * `staleRevalidate` and `staleError` in the JSON body and mirrors them into
 * `Cache-Control`; addons not built with the SDK may only send the header.
 * Body values win; the header is the fallback; `defaultTtl` applies when an
 * addon says nothing. Returns null when the response must not be cached.
 */
export function resolveCachePolicy(
  body: CacheProps | undefined,
  cacheControl: string | null,
  defaultTtl: number,
): CachePolicy | null {
  const header = parseCacheControl(cacheControl);
  if (header.noStore || header.noCache) return null;
  const pick = (bodyVal: unknown, headerVal: number | undefined, fallback: number) =>
    Number.isInteger(bodyVal) && (bodyVal as number) >= 0 ? (bodyVal as number) : (headerVal ?? fallback);
  const policy = {
    maxAge: pick(body?.cacheMaxAge, header['max-age'], defaultTtl),
    staleRevalidate: pick(body?.staleRevalidate, header['stale-while-revalidate'], 0),
    staleError: pick(body?.staleError, header['stale-if-error'], 0),
  };
  return policy.maxAge > 0 || policy.staleError > 0 ? policy : null;
}

function parseCacheControl(value: string | null) {
  const out: { noStore?: boolean; noCache?: boolean } & Record<string, number | undefined> = {};
  if (!value) return out;
  for (const part of value.split(',')) {
    const [rawKey, rawVal] = part.trim().split('=');
    const key = rawKey?.toLowerCase();
    if (!key) continue;
    if (key === 'no-store') out.noStore = true;
    else if (key === 'no-cache') out.noCache = true;
    else if (rawVal !== undefined && /^\d+$/.test(rawVal.trim())) out[key] = Number(rawVal);
  }
  return out;
}

interface Entry<T> {
  value: T;
  storedAt: number;
  policy: CachePolicy;
}

export type Lookup<T> =
  | { state: 'fresh'; value: T }
  | { state: 'revalidate'; value: T }
  | { state: 'stale-if-error'; value: T }
  | { state: 'miss' };

/** Size-bounded LRU keyed by request URL, aware of stale-while-revalidate / stale-if-error. */
export class ResponseCache {
  private entries = new Map<string, Entry<unknown>>();

  constructor(
    private maxEntries = 2000,
    private now: () => number = Date.now,
  ) {}

  get<T>(key: string): Lookup<T> {
    const e = this.entries.get(key) as Entry<T> | undefined;
    if (!e) return { state: 'miss' };
    const age = (this.now() - e.storedAt) / 1000;
    const { maxAge, staleRevalidate, staleError } = e.policy;
    // Re-insert to mark as most recently used.
    this.entries.delete(key);
    this.entries.set(key, e);
    if (age < maxAge) return { state: 'fresh', value: e.value };
    if (age < maxAge + staleRevalidate) return { state: 'revalidate', value: e.value };
    if (age < maxAge + staleError) return { state: 'stale-if-error', value: e.value };
    this.entries.delete(key);
    return { state: 'miss' };
  }

  set<T>(key: string, value: T, policy: CachePolicy): void {
    this.entries.delete(key);
    this.entries.set(key, { value, storedAt: this.now(), policy });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value as string;
      this.entries.delete(oldest);
    }
  }

  delete(key: string): void {
    this.entries.delete(key);
  }

  /** Drops every entry whose key starts with `prefix` (e.g. one addon's base URL). */
  deletePrefix(prefix: string): void {
    for (const k of this.entries.keys()) if (k.startsWith(prefix)) this.entries.delete(k);
  }

  get size() {
    return this.entries.size;
  }
}
