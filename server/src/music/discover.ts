// Cross-source views for the Music UI:
//  GET /api/music/artist?id=        an artist page merged across sources (top tracks + albums)
//  GET /api/music/alternatives?id=  the same album on other sources (album page source picker)
// Matching uses MusicBrainz ids where the sources (or MusicBrainz lookups) provide them, otherwise
// normalised names; see match.ts.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { MusicMeta, MusicMetaPreview, MusicTrack } from '../music-sources/sdk.js';
import { albumKey, isSame, norm } from './match.js';
import type { MusicBrainz } from './musicbrainz.js';
import type { SourceEntry, SourceRegistry } from './registry.js';

type User = { id: number; username: string } | null;
type Ref = { id: string; name: string };

const SEARCH_TIMEOUT_MS = 10_000;
const TOP_TRACKS = 10;

const userOf = (req: FastifyRequest): User => (req.user ? { id: req.user.id, username: req.user.username } : null);
const ref = (e: SourceEntry): Ref => ({ id: e.id, name: e.name });

const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T> =>
  Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error('timed out')), ms).unref())]);

export interface MergedAlbum extends MusicMetaPreview {
  source: Ref;
  /** the same album on other sources */
  alternatives: { source: Ref; id: string }[];
}

/**
 * Artist pages from several sources -> one page. The primary source's top tracks come first (topped
 * up from the others), then every album once; an album found on several sources keeps the first
 * (highest priority) and lists the others as alternatives. Albums are only collapsed across
 * sources, never within one (a source's "X" and "X (Deluxe)" both stay).
 */
export function mergeArtist(parts: { source: Ref; meta: MusicMeta }[]): { videos: (MusicTrack & { source: Ref })[]; albums: MergedAlbum[] } {
  const videos: (MusicTrack & { source: Ref })[] = [];
  const titles = new Set<string>();
  for (const { source, meta } of parts) {
    for (const v of meta.videos ?? []) {
      if (videos.length >= TOP_TRACKS) break;
      const t = norm(v.title);
      if (titles.has(t)) continue;
      titles.add(t);
      videos.push({ ...v, source });
    }
  }
  const albums: MergedAlbum[] = [];
  const byKey = new Map<string, MergedAlbum>();
  for (const { source, meta } of parts) {
    for (const a of meta.albums ?? []) {
      const key = albumKey(a, meta.name);
      const first = byKey.get(key);
      if (first && first.source.id !== source.id) {
        first.alternatives.push({ source, id: a.id });
        continue;
      }
      const merged: MergedAlbum = { ...a, source, alternatives: [] };
      if (!first) byKey.set(key, merged);
      albums.push(merged);
    }
  }
  return { videos, albums };
}

export function registerDiscover(app: FastifyInstance, registry: SourceRegistry, mb: MusicBrainz | null): void {
  /** One source's search results (all its searchable catalogs), bounded in time. */
  const search = async (e: SourceEntry, user: User, q: string): Promise<MusicMetaPreview[]> => {
    const catalogs = e.catalogs.filter((c) => c.searchable);
    const settled = await Promise.allSettled(catalogs.map((c) => withTimeout(registry.catalog(e, user, c.id, { search: q }), SEARCH_TIMEOUT_MS)));
    return settled.flatMap((r) => (r.status === 'fulfilled' ? (r.value as unknown as MusicMetaPreview[]) : []));
  };

  const kindOf = (m: { music?: { kind?: string }; videos?: unknown[] }) => m.music?.kind ?? (m.videos?.length ? 'album' : 'track');

  const primary = async (user: User, id: string) => {
    for (const e of registry.active(user).filter((x) => registry.owns(x, 'meta', id))) {
      const meta = (await registry.meta(e, user, id).catch(() => null)) as MusicMeta | null;
      if (meta) return { e, meta };
    }
    return null;
  };

  app.get<{ Querystring: { id?: string } }>('/api/music/artist', async (req, reply) => {
    const id = req.query.id;
    if (!id) return reply.code(400).send({ error: 'missing id' });
    const user = userOf(req);
    const found = await primary(user, id);
    if (!found) return reply.code(404).send({ error: 'not found' });
    const { e: owner, meta } = found;
    if (kindOf(meta) !== 'artist') return reply.code(400).send({ error: 'not an artist' });

    const known = { mbid: meta.music?.mbid, names: new Set([norm(meta.name)]) };
    let mbNote: string | undefined;
    if (mb) {
      try {
        const a = known.mbid ? await mb.artistById(known.mbid) : await mb.artistByName(meta.name);
        if (a) {
          known.mbid ??= a.id;
          a.names.forEach((n) => known.names.add(n));
        }
      } catch (err) {
        mbNote = `MusicBrainz: ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    const others = registry.active(user).filter((x) => x.id !== owner.id && x.catalogs.some((c) => c.searchable) && !x.capabilities.live);
    const matches = await Promise.all(
      others.map(async (e) => {
        const hit = (await search(e, user, meta.name)).find((m) => kindOf(m) === 'artist' && isSame(known, { mbid: m.music?.mbid, name: m.name }));
        if (!hit) return null;
        const full = (await withTimeout(registry.meta(e, user, hit.id), SEARCH_TIMEOUT_MS).catch(() => null)) as MusicMeta | null;
        return full ? { source: ref(e), meta: full } : null;
      }),
    );
    const parts = [{ source: ref(owner), meta }, ...matches.filter((m): m is NonNullable<typeof m> => m !== null)];
    const merged = mergeArtist(parts);
    return {
      source: ref(owner),
      meta: { ...meta, music: { ...meta.music, kind: 'artist', mbid: known.mbid }, videos: merged.videos, albums: merged.albums },
      sources: parts.map((p) => ({ source: p.source, id: p.meta.id })),
      musicbrainz: mb ? (mbNote ?? 'on') : 'off',
    };
  });

  app.get<{ Querystring: { id?: string } }>('/api/music/alternatives', async (req, reply) => {
    const id = req.query.id;
    if (!id) return reply.code(400).send({ error: 'missing id' });
    const user = userOf(req);
    const found = await primary(user, id);
    if (!found) return reply.code(404).send({ error: 'not found' });
    const { e: owner, meta } = found;
    if (kindOf(meta) !== 'album') return { alternatives: [] };
    // same release MBID when both have one, else same artist + title
    const sameAlbum = (m: MusicMetaPreview) =>
      meta.music?.mbid && m.music?.mbid
        ? meta.music.mbid === m.music.mbid
        : albumKey({ name: m.name, music: { artist: m.music?.artist } }) === albumKey({ name: meta.name, music: { artist: meta.music?.artist } });
    const others = registry.active(user).filter((x) => x.id !== owner.id && x.catalogs.some((c) => c.searchable) && !x.capabilities.live);
    const results = await Promise.all(
      others.map(async (e) => {
        const hits = (await search(e, user, meta.name)).filter((m) => kindOf(m) === 'album' && sameAlbum(m));
        return hits.slice(0, 3).map((m) => ({
          source: ref(e),
          id: m.id,
          name: m.name,
          artist: m.music?.artist ?? null,
          releaseInfo: m.releaseInfo ?? null,
          trackCount: m.music?.trackCount ?? null,
          licence: m.music?.licence?.name ?? null,
        }));
      }),
    );
    return { alternatives: results.flat() };
  });
}
