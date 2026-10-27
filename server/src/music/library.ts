// Each user's Music library, stored server-side:
//  GET    /api/library                         liked songs + saved albums/artists/stations, playlist list
//  PUT    /api/library/items                   like / save {kind, item}
//  DELETE /api/library/items?kind=&id=         unlike / unsave
//  POST   /api/library/playlists               create {name, description?, items?}
//  GET    /api/library/playlists/:id           with tracks
//  PATCH  /api/library/playlists/:id           {name?, description?, sync?}
//  DELETE /api/library/playlists/:id
//  POST   /api/library/playlists/:id/tracks    append {items}
//  DELETE /api/library/playlists/:id/tracks/:entry
//  POST   /api/library/playlists/:id/move      {entry, to}
//
// Sync with sources that have the hooks (Navidrome):
//  - likes, both ways: liking a source's item calls setLiked; a source with listLiked is the
//    authority for its own items, so the library shows exactly what it reports (stars made in
//    Navidrome's own UI appear here, unstars disappear);
//  - playlists, one way and opt-in per playlist: the playlist's tracks from that source are written
//    to a playlist of the same name there (other sources' tracks can't live in it).
// Items are stored as small meta snapshots, so the library renders without asking every source.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import type { MusicMetaPreview } from '../music-sources/sdk.js';
import type { SourceEntry, SourceRegistry } from './registry.js';

type User = { id: number; username: string };

const KINDS = ['track', 'album', 'artist', 'playlist', 'station'] as const;
type Kind = (typeof KINDS)[number];

const MAX_ITEMS = 20_000;
const MAX_PLAYLISTS = 500;
const MAX_PLAYLIST_TRACKS = 5_000;
const LIKED_TTL_MS = 60_000;

const str = (max: number) => z.string().max(max);

/** What we keep of a meta: enough to show it and play it. Unknown fields are dropped. */
export const Snapshot = z.object({
  id: z.string().min(1).max(1024),
  name: str(500),
  poster: str(4096).nullish(),
  posterShape: z.enum(['square', 'poster', 'landscape']).optional(),
  releaseInfo: str(100).nullish(),
  source: z.object({ id: str(200), name: str(200) }).optional(),
  music: z
    .object({
      kind: z.enum(KINDS).optional(),
      artist: str(500).nullish(),
      artistId: str(1024).nullish(),
      album: str(500).nullish(),
      albumId: str(1024).nullish(),
      duration: z.number().nonnegative().max(1e6).nullish(),
      live: z.boolean().optional(),
      trackCount: z.number().int().nonnegative().nullish(),
      mbid: str(64).nullish(),
    })
    .default({}),
});
export type Snapshot = z.infer<typeof Snapshot>;

const PlaylistInput = z.object({ name: z.string().trim().min(1).max(200), description: str(2000).optional(), items: z.array(Snapshot).max(MAX_PLAYLIST_TRACKS).optional() });

interface PlaylistRow {
  id: number;
  user_id: number;
  name: string;
  description: string;
  sync: number;
  remotes: string;
  sync_error: string | null;
  created_at: number;
  updated_at: number;
}

export class LibraryStore {
  constructor(private db: DatabaseSync) {}

  items(userId: number) {
    const rows = this.db.prepare('SELECT kind, item_id, data, added_at FROM library_items WHERE user_id = ? ORDER BY added_at DESC').all(userId) as {
      kind: Kind;
      item_id: string;
      data: string;
      added_at: number;
    }[];
    return rows.map((r) => ({ kind: r.kind, id: r.item_id, data: JSON.parse(r.data) as Snapshot, addedAt: r.added_at }));
  }

  save(userId: number, kind: Kind, item: Snapshot, addedAt = Date.now()): void {
    const count = (this.db.prepare('SELECT COUNT(*) AS n FROM library_items WHERE user_id = ?').get(userId) as { n: number }).n;
    if (count >= MAX_ITEMS) throw new HttpError(409, `Your library is full (${MAX_ITEMS} items).`);
    this.db
      .prepare(
        `INSERT INTO library_items (user_id, kind, item_id, data, added_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (user_id, kind, item_id) DO UPDATE SET data = excluded.data`,
      )
      .run(userId, kind, item.id, JSON.stringify(item), addedAt);
  }

  remove(userId: number, kind: Kind, id: string): boolean {
    return this.db.prepare('DELETE FROM library_items WHERE user_id = ? AND kind = ? AND item_id = ?').run(userId, kind, id).changes > 0;
  }

  /** Make the library's items of one source exactly `liked` (that source is the authority). */
  reconcile(userId: number, sourceId: string, liked: { kind: Kind; item: Snapshot }[]): void {
    const prefix = `${sourceId}:`;
    const keep = new Set(liked.map((l) => `${l.kind}\n${l.item.id}`));
    const existing = this.db
      .prepare("SELECT kind, item_id FROM library_items WHERE user_id = ? AND substr(item_id, 1, length(?)) = ?")
      .all(userId, prefix, prefix) as { kind: Kind; item_id: string }[];
    const have = new Set(existing.map((r) => `${r.kind}\n${r.item_id}`));
    this.tx(() => {
      for (const r of existing) if (!keep.has(`${r.kind}\n${r.item_id}`)) this.remove(userId, r.kind, r.item_id);
      // new stars keep the source's order (newest first in Navidrome) below everything added here
      const now = Date.now();
      liked.forEach((l, i) => {
        if (!have.has(`${l.kind}\n${l.item.id}`)) this.save(userId, l.kind, l.item, now - 1000 - i);
      });
    });
  }

  // ---------------------------------------------------------------- playlists

  playlists(userId: number) {
    const rows = this.db.prepare('SELECT * FROM playlists WHERE user_id = ? ORDER BY updated_at DESC').all(userId) as unknown as PlaylistRow[];
    return rows.map((r) => this.summary(r));
  }

  playlist(userId: number, id: number): PlaylistRow {
    const row = this.db.prepare('SELECT * FROM playlists WHERE id = ? AND user_id = ?').get(id, userId) as PlaylistRow | undefined;
    if (!row) throw new HttpError(404, 'No such playlist.');
    return row;
  }

  summary(r: PlaylistRow) {
    const stats = this.db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(json_extract(data, \'$.music.duration\')), 0) AS secs FROM playlist_tracks WHERE playlist_id = ?').get(r.id) as {
      n: number;
      secs: number;
    };
    const posters = (
      this.db
        .prepare("SELECT DISTINCT json_extract(data, '$.poster') AS p FROM playlist_tracks WHERE playlist_id = ? AND json_extract(data, '$.poster') IS NOT NULL ORDER BY position LIMIT 4")
        .all(r.id) as { p: string }[]
    ).map((x) => x.p);
    return {
      id: r.id,
      name: r.name,
      description: r.description,
      trackCount: stats.n,
      duration: stats.secs,
      posters,
      sync: r.sync === 1,
      syncedTo: Object.keys(JSON.parse(r.remotes) as Record<string, string>),
      syncError: r.sync_error,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  tracks(playlistId: number) {
    const rows = this.db.prepare('SELECT id, data, added_at FROM playlist_tracks WHERE playlist_id = ? ORDER BY position').all(playlistId) as {
      id: number;
      data: string;
      added_at: number;
    }[];
    return rows.map((r) => ({ entry: r.id, data: JSON.parse(r.data) as Snapshot, addedAt: r.added_at }));
  }

  createPlaylist(userId: number, name: string, description = ''): PlaylistRow {
    const n = (this.db.prepare('SELECT COUNT(*) AS n FROM playlists WHERE user_id = ?').get(userId) as { n: number }).n;
    if (n >= MAX_PLAYLISTS) throw new HttpError(409, `You have the maximum of ${MAX_PLAYLISTS} playlists.`);
    const now = Date.now();
    const r = this.db.prepare('INSERT INTO playlists (user_id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(userId, name, description, now, now);
    return this.playlist(userId, Number(r.lastInsertRowid));
  }

  updatePlaylist(p: PlaylistRow, patch: { name?: string; description?: string; sync?: boolean }): void {
    this.db
      .prepare('UPDATE playlists SET name = ?, description = ?, sync = ?, updated_at = ? WHERE id = ?')
      .run(patch.name ?? p.name, patch.description ?? p.description, patch.sync === undefined ? p.sync : patch.sync ? 1 : 0, Date.now(), p.id);
  }

  setSyncResult(id: number, remotes: Record<string, string>, error: string | null): void {
    this.db.prepare('UPDATE playlists SET remotes = ?, sync_error = ? WHERE id = ?').run(JSON.stringify(remotes), error, id);
  }

  deletePlaylist(id: number): void {
    this.db.prepare('DELETE FROM playlists WHERE id = ?').run(id);
  }

  addTracks(p: PlaylistRow, items: Snapshot[]): void {
    const { n, maxPos } = this.db.prepare('SELECT COUNT(*) AS n, COALESCE(MAX(position), -1) AS maxPos FROM playlist_tracks WHERE playlist_id = ?').get(p.id) as {
      n: number;
      maxPos: number;
    };
    if (n + items.length > MAX_PLAYLIST_TRACKS) throw new HttpError(409, `A playlist holds at most ${MAX_PLAYLIST_TRACKS} tracks.`);
    const now = Date.now();
    const insert = this.db.prepare('INSERT INTO playlist_tracks (playlist_id, position, item_id, data, added_at) VALUES (?, ?, ?, ?, ?)');
    this.tx(() => {
      items.forEach((it, i) => insert.run(p.id, maxPos + 1 + i, it.id, JSON.stringify(it), now));
      this.touch(p.id);
    });
  }

  removeTrack(p: PlaylistRow, entry: number): void {
    if (this.db.prepare('DELETE FROM playlist_tracks WHERE id = ? AND playlist_id = ?').run(entry, p.id).changes === 0) throw new HttpError(404, 'Not in this playlist.');
    this.touch(p.id);
  }

  moveTrack(p: PlaylistRow, entry: number, to: number): void {
    const ids = (this.db.prepare('SELECT id FROM playlist_tracks WHERE playlist_id = ? ORDER BY position').all(p.id) as { id: number }[]).map((r) => r.id);
    const from = ids.indexOf(entry);
    if (from < 0) throw new HttpError(404, 'Not in this playlist.');
    ids.splice(from, 1);
    ids.splice(Math.max(0, Math.min(to, ids.length)), 0, entry);
    const set = this.db.prepare('UPDATE playlist_tracks SET position = ? WHERE id = ?');
    this.tx(() => {
      ids.forEach((id, i) => set.run(i, id));
      this.touch(p.id);
    });
  }

  private touch(id: number): void {
    this.db.prepare('UPDATE playlists SET updated_at = ? WHERE id = ?').run(Date.now(), id);
  }

  private tx(fn: () => void): void {
    this.db.exec('BEGIN');
    try {
      fn();
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }
}

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** A source's liked items as library entries (kinds the library knows, ids of that source only). */
function toLiked(e: SourceEntry, metas: MusicMetaPreview[]): { kind: Kind; item: Snapshot }[] {
  return metas.flatMap((m) => {
    const kind = m.music?.kind;
    if (!kind || !(KINDS as readonly string[]).includes(kind) || typeof m.id !== 'string' || !m.id.startsWith(`${e.id}:`)) return [];
    const parsed = Snapshot.safeParse({ ...m, source: { id: e.id, name: e.name } });
    return parsed.success ? [{ kind: kind as Kind, item: parsed.data }] : [];
  });
}

export function registerLibrary(app: FastifyInstance, db: DatabaseSync, registry: SourceRegistry): void {
  const store = new LibraryStore(db);
  // last successful listLiked per user+source; skipped while fresh
  const likedAt = new Map<string, number>();

  const userOf = (req: FastifyRequest): User => ({ id: req.user!.id, username: req.user!.username });
  const fail = (reply: FastifyReply, err: unknown) =>
    err instanceof HttpError ? reply.code(err.status).send({ error: err.message }) : reply.code(502).send({ error: message(err) });

  const owner = (user: User, id: string) => registry.active(user).find((e) => e.runtime && id.startsWith(`${e.id}:`));

  /** Pull likes from authoritative sources; returns per-source errors (the library still shows). */
  async function syncLikes(user: User, force: boolean): Promise<{ source: { id: string; name: string }; error: string }[]> {
    const errors: { source: { id: string; name: string }; error: string }[] = [];
    await Promise.all(
      registry
        .active(user)
        .filter((e) => registry.hasHook(e, 'listLiked'))
        .map(async (e) => {
          const key = `${user.id}:${e.id}`;
          if (!force && Date.now() - (likedAt.get(key) ?? 0) < LIKED_TTL_MS) return;
          try {
            store.reconcile(user.id, e.id, toLiked(e, await registry.callHook(e, user, 'listLiked')));
            likedAt.set(key, Date.now());
          } catch (err) {
            errors.push({ source: { id: e.id, name: e.name }, error: message(err) });
          }
        }),
    );
    return errors;
  }

  /** Mirror a playlist to every source that takes playlists; records ids and the error, if any. */
  async function pushPlaylist(user: User, id: number): Promise<void> {
    const p = store.playlist(user.id, id);
    if (!p.sync) return;
    const remotes = JSON.parse(p.remotes) as Record<string, string>;
    const tracks = store.tracks(p.id);
    const errors: string[] = [];
    for (const e of registry.active(user).filter((x) => registry.hasHook(x, 'savePlaylist'))) {
      const trackIds = tracks.map((t) => t.data.id).filter((tid) => tid.startsWith(`${e.id}:`));
      if (!trackIds.length && !remotes[e.id]) continue;
      try {
        remotes[e.id] = await registry.callHook(e, user, 'savePlaylist', { remoteId: remotes[e.id], name: p.name, description: p.description, trackIds });
      } catch (err) {
        errors.push(`${e.name}: ${message(err)}`);
      }
    }
    store.setSyncResult(p.id, remotes, errors.length ? errors.join('; ') : null);
  }

  const withPlaylist = async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply, change: (p: PlaylistRow, user: User) => void | Promise<void>) => {
    const user = userOf(req);
    try {
      const p = store.playlist(user.id, Number(req.params.id));
      await change(p, user);
      await pushPlaylist(user, p.id);
      return { playlist: store.summary(store.playlist(user.id, p.id)) };
    } catch (err) {
      return fail(reply, err);
    }
  };

  app.get<{ Querystring: { refresh?: string } }>('/api/library', async (req) => {
    const user = userOf(req);
    const errors = await syncLikes(user, req.query.refresh === '1');
    return { items: store.items(user.id), playlists: store.playlists(user.id), errors };
  });

  app.put('/api/library/items', { bodyLimit: 64 * 1024 }, async (req, reply) => {
    const body = z.object({ kind: z.enum(KINDS), item: Snapshot }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid item' });
    const user = userOf(req);
    const { kind, item } = body.data;
    const e = owner(user, item.id);
    try {
      if (e && registry.hasHook(e, 'setLiked')) {
        // a source that owns its likes must take it, or the next sync would drop it again
        if (registry.hasHook(e, 'listLiked')) await registry.callHook(e, user, 'setLiked', item.id, true);
        else await registry.hook(e, user, 'setLiked', item.id, true);
      }
      store.save(user.id, kind, item);
      return { ok: true };
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.delete<{ Querystring: { kind?: string; id?: string } }>('/api/library/items', async (req, reply) => {
    const q = z.object({ kind: z.enum(KINDS), id: z.string().min(1).max(1024) }).safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: 'invalid item' });
    const user = userOf(req);
    const e = owner(user, q.data.id);
    try {
      if (e && registry.hasHook(e, 'setLiked')) {
        if (registry.hasHook(e, 'listLiked')) await registry.callHook(e, user, 'setLiked', q.data.id, false);
        else await registry.hook(e, user, 'setLiked', q.data.id, false);
      }
      store.remove(user.id, q.data.kind, q.data.id);
      return { ok: true };
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.post('/api/library/playlists', { bodyLimit: 4 * 1024 * 1024 }, async (req, reply) => {
    const body = PlaylistInput.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'Give the playlist a name.' });
    const user = userOf(req);
    try {
      const p = store.createPlaylist(user.id, body.data.name, body.data.description);
      if (body.data.items?.length) store.addTracks(p, body.data.items);
      return { playlist: store.summary(store.playlist(user.id, p.id)) };
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.get<{ Params: { id: string } }>('/api/library/playlists/:id', async (req, reply) => {
    const user = userOf(req);
    try {
      const p = store.playlist(user.id, Number(req.params.id));
      return { playlist: store.summary(p), tracks: store.tracks(p.id) };
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.patch<{ Params: { id: string } }>('/api/library/playlists/:id', async (req, reply) => {
    const body = z.object({ name: z.string().trim().min(1).max(200).optional(), description: str(2000).optional(), sync: z.boolean().optional() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid input' });
    return withPlaylist(req, reply, (p) => {
      store.updatePlaylist(p, body.data);
      // turning sync off leaves the copies on the sources alone (they're the user's data there too)
      if (body.data.sync === false) store.setSyncResult(p.id, JSON.parse(p.remotes) as Record<string, string>, null);
    });
  });

  app.delete<{ Params: { id: string } }>('/api/library/playlists/:id', async (req, reply) => {
    const user = userOf(req);
    try {
      const p = store.playlist(user.id, Number(req.params.id));
      // a synced playlist goes away on the sources too; unsynced copies are left alone
      if (p.sync) {
        for (const [sourceId, remoteId] of Object.entries(JSON.parse(p.remotes) as Record<string, string>)) {
          const e = registry.active(user).find((x) => x.id === sourceId);
          if (e && registry.hasHook(e, 'deletePlaylist')) await registry.callHook(e, user, 'deletePlaylist', remoteId).catch(() => {});
        }
      }
      store.deletePlaylist(p.id);
      return { ok: true };
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.post<{ Params: { id: string } }>('/api/library/playlists/:id/tracks', { bodyLimit: 4 * 1024 * 1024 }, async (req, reply) => {
    const body = z.object({ items: z.array(Snapshot).min(1).max(MAX_PLAYLIST_TRACKS) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid tracks' });
    return withPlaylist(req, reply, (p) => store.addTracks(p, body.data.items));
  });

  app.delete<{ Params: { id: string; entry: string } }>('/api/library/playlists/:id/tracks/:entry', async (req, reply) =>
    withPlaylist(req, reply, (p) => store.removeTrack(p, Number(req.params.entry))),
  );

  app.post<{ Params: { id: string } }>('/api/library/playlists/:id/move', async (req, reply) => {
    const body = z.object({ entry: z.number().int(), to: z.number().int().min(0) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid move' });
    return withPlaylist(req, reply, (p) => store.moveTrack(p, body.data.entry, body.data.to));
  });
}
