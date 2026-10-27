// MusicBrainz artist lookups for merging artists across sources (https://musicbrainz.org/doc/MusicBrainz_API).
// API rules: at most 1 request per second, and a User-Agent naming the application and a contact.
// Off unless MUSICBRAINZ_CONTACT is set. Answers (including "no confident match") are cached in
// SQLite for 30 days, so each artist costs one or two requests per month.
import type { DatabaseSync } from 'node:sqlite';
import { norm } from './match.js';

export interface MbArtist {
  id: string;
  name: string;
  /** normalised name, sort name and aliases */
  names: string[];
}

interface ApiArtist {
  id: string;
  name: string;
  score?: number;
  'sort-name'?: string;
  aliases?: { name: string; 'sort-name'?: string }[];
}

const CACHE_TTL_MS = 30 * 24 * 3600 * 1000;

const toArtist = (a: ApiArtist): MbArtist => {
  const names = new Set([norm(a.name), ...(a.aliases ?? []).map((x) => norm(x.name))]);
  // "Beatles, The" -> "the beatles"
  const sort = a['sort-name']?.replace(/^(.*), (the|a|an)$/i, '$2 $1');
  if (sort) names.add(norm(sort));
  names.delete('');
  return { id: a.id, name: a.name, names: [...names] };
};

export class MusicBrainz {
  private last = 0;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private opts: { userAgent: string; db: DatabaseSync; minIntervalMs?: number; baseUrl?: string; fetch?: typeof fetch; timeoutMs?: number },
  ) {}

  /** Serialises requests and spaces them by `minIntervalMs` (default 1100 ms). */
  private get<T>(path: string): Promise<T> {
    const run = async () => {
      const wait = this.last + (this.opts.minIntervalMs ?? 1100) - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      this.last = Date.now();
      const res = await (this.opts.fetch ?? fetch)(`${this.opts.baseUrl ?? 'https://musicbrainz.org/ws/2'}${path}`, {
        headers: { 'user-agent': this.opts.userAgent, accept: 'application/json' },
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 10_000),
      });
      if (res.status === 503) throw new Error('MusicBrainz rate limit hit (503)');
      if (!res.ok) throw new Error(`MusicBrainz HTTP ${res.status}`);
      return (await res.json()) as T;
    };
    const p = this.chain.then(run, run);
    this.chain = p.catch(() => {});
    return p as Promise<T>;
  }

  private async cached<T>(key: string, load: () => Promise<T | null>): Promise<T | null> {
    const row = this.opts.db.prepare('SELECT value, at FROM mb_cache WHERE key = ?').get(key) as { value: string; at: number } | undefined;
    if (row && Date.now() - row.at < CACHE_TTL_MS) return JSON.parse(row.value) as T | null;
    const value = await load();
    this.opts.db
      .prepare('INSERT INTO mb_cache (key, value, at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, at = excluded.at')
      .run(key, JSON.stringify(value), Date.now());
    return value;
  }

  artistById(mbid: string): Promise<MbArtist | null> {
    return this.cached(`artist:${mbid}`, async () => {
      try {
        return toArtist(await this.get<ApiArtist>(`/artist/${encodeURIComponent(mbid)}?inc=aliases&fmt=json`));
      } catch (err) {
        if (err instanceof Error && /HTTP (400|404)/.test(err.message)) return null;
        throw err;
      }
    });
  }

  /**
   * The artist with exactly this name (or alias). Null when nothing matches confidently or when
   * several artists share the name: merging the wrong "Nirvana" is worse than not merging.
   */
  artistByName(name: string): Promise<MbArtist | null> {
    const n = norm(name);
    if (!n) return Promise.resolve(null);
    return this.cached(`artist-name:${n}`, async () => {
      const q = `artist:"${name.replace(/(["\\])/g, '\\$1')}"`;
      const res = await this.get<{ artists?: ApiArtist[] }>(`/artist/?query=${encodeURIComponent(q)}&limit=10&fmt=json`);
      const hits = (res.artists ?? []).filter((a) => (a.score ?? 0) >= 90).map(toArtist).filter((a) => a.names.includes(n));
      return hits.length === 1 ? hits[0]! : null;
    });
  }
}
