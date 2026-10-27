// Album requests through your Lidarr (with Prowlarr's indexers). The app asks Lidarr for an album;
// Lidarr's automatic search and your indexers, quality profile and download client do the rest, and
// Lidarr imports it into its root folder (the library Navidrome reads). Picking individual releases
// stays in Lidarr's own UI.
//  GET  /api/lidarr/status                 {enabled, canRequest} for the UI
//  GET  /api/lidarr/search?q=              albums from Lidarr's metadata (MusicBrainz), with library state
//  GET  /api/lidarr/requests               your requests (admins: everyone's) with live status
//  POST /api/lidarr/requests               {foreignAlbumId}: add/monitor in Lidarr and search
//  POST /api/lidarr/requests/:id/search    search again
//  DELETE /api/lidarr/requests/:id         remove from the list (Lidarr keeps the album)
//  GET/PUT /api/lidarr/settings, POST /api/lidarr/settings/test, POST /api/lidarr/prowlarr/sync   (admin)
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { norm } from '../music/match.js';
import type { SourceRegistry } from '../music/registry.js';
import { ArrError, Lidarr, Prowlarr, type LidarrAlbum, type LidarrQueueItem } from './client.js';
import type { LidarrSettingsStore } from './settings.js';

type Status = 'wanted' | 'searching' | 'downloading' | 'importing' | 'warning' | 'partial' | 'available' | 'unmonitored' | 'removed';

interface RequestRow {
  id: number;
  user_id: number;
  foreign_album_id: string;
  lidarr_album_id: number | null;
  title: string;
  artist: string;
  year: number | null;
  cover: string | null;
  status: Status;
  requested_at: number;
  updated_at: number;
}

const POLL_MS = 120_000;
const SEARCHING_MS = 120_000;
const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Library state of a Lidarr album + its queue entry -> one status for the UI. */
export function statusOf(album: LidarrAlbum | null, queue: LidarrQueueItem | undefined, requestedAt: number, now = Date.now()) {
  if (!album) return { status: 'removed' as Status, detail: 'No longer in Lidarr' };
  const st = album.statistics;
  if (st && st.trackFileCount > 0 && st.percentOfTracks >= 100) return { status: 'available' as Status, detail: `${st.trackFileCount} tracks in your library` };
  if (queue) {
    const progress = queue.size ? Math.max(0, Math.min(1, 1 - queue.sizeleft / queue.size)) : 0;
    const msgs = (queue.statusMessages ?? []).flatMap((m) => m.messages ?? []).concat(queue.errorMessage ? [queue.errorMessage] : []);
    if (queue.trackedDownloadStatus === 'warning' || queue.trackedDownloadStatus === 'error') {
      return { status: 'warning' as Status, detail: msgs[0] ?? 'Lidarr needs attention for this download', progress };
    }
    if (queue.trackedDownloadState === 'importPending' || queue.trackedDownloadState === 'importing') return { status: 'importing' as Status, detail: 'Importing into the library', progress: 1 };
    return { status: 'downloading' as Status, detail: queue.status === 'queued' ? 'Queued in the download client' : 'Downloading', progress };
  }
  if (st && st.trackFileCount > 0) return { status: 'partial' as Status, detail: `${st.trackFileCount} of ${st.trackCount || '?'} tracks so far` };
  if (!album.monitored) return { status: 'unmonitored' as Status, detail: 'Not monitored in Lidarr any more' };
  if (now - requestedAt < SEARCHING_MS) return { status: 'searching' as Status, detail: 'Lidarr is searching your indexers' };
  return { status: 'wanted' as Status, detail: 'No release found yet; Lidarr keeps looking' };
}

const coverOf = (a: LidarrAlbum) => a.remoteCover ?? a.images?.find((i) => i.coverType === 'cover')?.remoteUrl ?? null;
// Lidarr dates unknown releases 0001-01-01
const yearOf = (a: LidarrAlbum) => {
  const y = Number.parseInt(a.releaseDate ?? '', 10);
  return y >= 1800 ? y : null;
};

export function registerLidarr(app: FastifyInstance, db: DatabaseSync, settings: LidarrSettingsStore, registry: SourceRegistry, fetchImpl?: typeof fetch): { stop(): void } {
  const lidarr = () => {
    const s = settings.get().lidarr;
    return s.url && s.apiKey ? new Lidarr({ url: s.url, apiKey: s.apiKey, fetch: fetchImpl }) : null;
  };
  const prowlarr = () => {
    const s = settings.get().prowlarr;
    return s.url && s.apiKey ? new Prowlarr({ url: s.url, apiKey: s.apiKey, fetch: fetchImpl }) : null;
  };
  const canRequest = (req: FastifyRequest) => settings.ready() && (!!req.user?.isAdmin || settings.get().allowUsers);
  const requireAdmin = async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.user?.isAdmin) return reply.code(403).send({ error: 'admin only' });
  };
  const requireRequester = async (req: FastifyRequest, reply: FastifyReply) => {
    if (!settings.ready()) return reply.code(409).send({ error: 'Lidarr isn’t set up yet (Downloads → Requests → Settings).' });
    if (!canRequest(req)) return reply.code(403).send({ error: 'Only admins can request albums here.' });
  };
  // Lidarr/Prowlarr problems are upstream failures for the browser
  const fail = (reply: FastifyReply, err: unknown) => reply.code(502).send({ error: message(err) });

  /** Current status of these requests (one queue call, one album call each). */
  async function withStatus(rows: RequestRow[]) {
    const l = lidarr();
    if (!l || !rows.length) return rows.map((r) => ({ row: r, status: r.status, detail: null as string | null, progress: undefined as number | undefined }));
    const queue = await l.queue().catch(() => [] as LidarrQueueItem[]);
    return Promise.all(
      rows.map(async (r) => {
        let album: LidarrAlbum | null = null;
        if (r.lidarr_album_id) {
          album = await l.album(r.lidarr_album_id).catch((err) => {
            if (err instanceof ArrError && err.status === 404) return null;
            throw err;
          });
        }
        const s = statusOf(album, queue.find((q) => q.albumId === r.lidarr_album_id), r.requested_at);
        return { row: r, status: s.status, detail: s.detail, progress: 'progress' in s ? s.progress : undefined };
      }),
    );
  }

  /** Remember the latest status; an album that just arrived makes the requester's sources rescan (Navidrome). */
  function record(results: Awaited<ReturnType<typeof withStatus>>) {
    const now = Date.now();
    for (const { row, status } of results) {
      if (status === row.status) continue;
      db.prepare('UPDATE lidarr_requests SET status = ?, updated_at = ? WHERE id = ?').run(status, now, row.id);
      if (status === 'available') {
        const user = db.prepare('SELECT id, username FROM users WHERE id = ?').get(row.user_id) as { id: number; username: string } | undefined;
        if (!user) continue;
        for (const e of registry.active(user).filter((x) => registry.hasHook(x, 'libraryChanged'))) {
          registry.callHook(e, user, 'libraryChanged').catch((err) => app.log.warn(`${e.name}: rescan after Lidarr import failed: ${message(err)}`));
        }
        app.log.info(`Lidarr: “${row.title}” by ${row.artist} is in the library`);
      }
    }
  }

  // background: follow open requests so arrivals trigger a rescan even when nobody looks
  const timer = setInterval(() => {
    if (!settings.ready()) return;
    const open = db.prepare("SELECT * FROM lidarr_requests WHERE status NOT IN ('available', 'removed')").all() as unknown as RequestRow[];
    if (open.length) withStatus(open).then(record).catch((err) => app.log.warn(`Lidarr status poll: ${message(err)}`));
  }, POLL_MS);
  timer.unref();

  app.get('/api/lidarr/status', async (req) => ({ enabled: settings.ready(), canRequest: canRequest(req) }));

  app.get<{ Querystring: { q?: string } }>('/api/lidarr/search', { preHandler: requireRequester }, async (req, reply) => {
    const q = req.query.q?.trim();
    if (!q) return reply.code(400).send({ error: 'missing q' });
    try {
      // Lidarr ranks tributes and remixes high: albums whose artist and title are in the query first
      const nq = norm(q);
      const score = (a: LidarrAlbum) => (nq.includes(norm(a.artist.artistName)) ? 2 : 0) + (nq.includes(norm(a.title)) ? 1 : 0);
      const albums = (await lidarr()!.lookupAlbums(q)).map((a, i) => ({ a, i })).sort((x, y) => score(y.a) - score(x.a) || x.i - y.i).map((x) => x.a);
      const mine = new Set((db.prepare('SELECT foreign_album_id FROM lidarr_requests WHERE user_id = ?').all(req.user!.id) as { foreign_album_id: string }[]).map((r) => r.foreign_album_id));
      return {
        albums: albums.slice(0, 30).map((a) => ({
          foreignAlbumId: a.foreignAlbumId,
          title: a.title,
          artist: a.artist.artistName,
          year: yearOf(a),
          type: [a.albumType, ...(a.secondaryTypes ?? [])].filter(Boolean).join(' · '),
          cover: coverOf(a),
          inLidarr: a.id ? { monitored: a.monitored, percent: a.statistics?.percentOfTracks ?? 0 } : null,
          requested: mine.has(a.foreignAlbumId),
        })),
      };
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.get('/api/lidarr/requests', async (req, reply) => {
    const admin = !!req.user?.isAdmin;
    const rows = (admin
      ? db.prepare('SELECT * FROM lidarr_requests ORDER BY requested_at DESC').all()
      : db.prepare('SELECT * FROM lidarr_requests WHERE user_id = ? ORDER BY requested_at DESC').all(req.user!.id)) as unknown as RequestRow[];
    const names = new Map((db.prepare('SELECT id, username FROM users').all() as { id: number; username: string }[]).map((u) => [u.id, u.username]));
    try {
      const results = await withStatus(rows);
      record(results);
      return {
        requests: results.map(({ row, status, detail, progress }) => ({
          id: row.id,
          title: row.title,
          artist: row.artist,
          year: row.year,
          cover: row.cover,
          status,
          detail,
          progress,
          requestedAt: row.requested_at,
          requestedBy: admin ? names.get(row.user_id) ?? null : undefined,
          mine: row.user_id === req.user!.id,
        })),
      };
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.post('/api/lidarr/requests', { preHandler: requireRequester }, async (req, reply) => {
    const body = z.object({ foreignAlbumId: z.string().regex(/^[0-9a-f-]{36}$/i) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid album' });
    const l = lidarr()!;
    const s = settings.get().lidarr;
    try {
      const [album] = await l.lookupAlbums(`lidarr:${body.data.foreignAlbumId}`);
      if (!album) return reply.code(404).send({ error: 'Lidarr doesn’t know this album.' });
      let id = album.id;
      let note: string;
      if (id) {
        // already in Lidarr (its artist is): make sure it's wanted, then search
        if (!album.monitored) await l.monitor([id], true);
        const full = await l.album(id);
        if (full.statistics && full.statistics.trackFileCount > 0 && full.statistics.percentOfTracks >= 100) note = 'Already in your library.';
        else {
          await l.search([id]);
          note = 'Lidarr is searching for it.';
        }
      } else {
        const added = await l.addAlbum(album, { rootFolderPath: s.rootFolderPath, qualityProfileId: s.qualityProfileId, metadataProfileId: s.metadataProfileId });
        id = added.id;
        note = `Added ${album.artist.artistName} to Lidarr (only this album monitored); searching.`;
      }
      const now = Date.now();
      db.prepare(
        `INSERT INTO lidarr_requests (user_id, foreign_album_id, lidarr_album_id, title, artist, year, cover, status, requested_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'searching', ?, ?)
         ON CONFLICT (user_id, foreign_album_id) DO UPDATE SET lidarr_album_id = excluded.lidarr_album_id, status = 'searching', requested_at = excluded.requested_at, updated_at = excluded.updated_at`,
      ).run(req.user!.id, album.foreignAlbumId, id ?? null, album.title, album.artist.artistName, yearOf(album), coverOf(album), now, now);
      app.log.info(`Lidarr: ${req.user!.username} requested “${album.title}” by ${album.artist.artistName}`);
      return { ok: true, note };
    } catch (err) {
      return fail(reply, err);
    }
  });

  /** A request this user may act on: their own, or anyone's for admins. */
  const own = (req: FastifyRequest<{ Params: { id: string } }>) => {
    const r = db.prepare('SELECT * FROM lidarr_requests WHERE id = ?').get(Number(req.params.id)) as RequestRow | undefined;
    return r && (req.user!.isAdmin || r.user_id === req.user!.id) ? r : undefined;
  };

  app.post<{ Params: { id: string } }>('/api/lidarr/requests/:id/search', { preHandler: requireRequester }, async (req, reply) => {
    const r = own(req);
    if (!r?.lidarr_album_id) return reply.code(404).send({ error: 'no such request' });
    try {
      await lidarr()!.monitor([r.lidarr_album_id], true);
      await lidarr()!.search([r.lidarr_album_id]);
      db.prepare("UPDATE lidarr_requests SET requested_at = ?, status = 'searching' WHERE id = ?").run(Date.now(), r.id);
      return { ok: true };
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.delete<{ Params: { id: string } }>('/api/lidarr/requests/:id', async (req, reply) => {
    const r = own(req);
    if (!r) return reply.code(404).send({ error: 'no such request' });
    db.prepare('DELETE FROM lidarr_requests WHERE id = ?').run(r.id);
    return { ok: true };
  });

  // ---------------------------------------------------------------- settings (admin)

  app.get('/api/lidarr/settings', { preHandler: requireAdmin }, async () => settings.public());

  app.put('/api/lidarr/settings', { preHandler: requireAdmin }, async (req, reply) => {
    try {
      settings.set(req.body);
      return settings.public();
    } catch (err) {
      return reply.code(400).send({ error: err instanceof z.ZodError ? 'invalid settings' : message(err) });
    }
  });

  /** Checks both apps; returns Lidarr's folders and profiles for the settings form, and Prowlarr's indexer health. */
  app.post('/api/lidarr/settings/test', { preHandler: requireAdmin }, async () => {
    const out: Record<string, unknown> = {};
    const l = lidarr();
    if (!l) out.lidarr = { ok: false, message: 'Enter Lidarr’s address and API key (Lidarr → Settings → General → Security).' };
    else {
      try {
        const [st, rootFolders, qualityProfiles, metadataProfiles] = await Promise.all([l.status(), l.rootFolders(), l.qualityProfiles(), l.metadataProfiles()]);
        out.lidarr = {
          ok: true,
          message: `Connected to Lidarr ${st.version}.${rootFolders.length ? '' : ' It has no root folder yet: add your music folder in Lidarr → Settings → Media Management.'}`,
          rootFolders: rootFolders.map((r) => ({ path: r.path, freeSpace: r.freeSpace ?? null })),
          qualityProfiles: qualityProfiles.map((p) => ({ id: p.id, name: p.name })),
          metadataProfiles: metadataProfiles.map((p) => ({ id: p.id, name: p.name })),
        };
      } catch (err) {
        out.lidarr = { ok: false, message: message(err) };
      }
    }
    const p = prowlarr();
    if (!p) out.prowlarr = { ok: false, message: 'Optional: Prowlarr’s address and API key, to see its indexers here.' };
    else {
      try {
        const [st, indexers, status, apps] = await Promise.all([p.status(), p.indexers(), p.indexerStatus(), p.applications()]);
        const failing = new Set(status.filter((s) => s.disabledTill && Date.parse(s.disabledTill) > Date.now()).map((s) => s.indexerId));
        const lidarrApp = apps.find((a) => a.implementation === 'Lidarr');
        out.prowlarr = {
          ok: true,
          message: `Connected to Prowlarr ${st.version}.`,
          indexers: { total: indexers.length, enabled: indexers.filter((i) => i.enable).length, failing: indexers.filter((i) => failing.has(i.id)).map((i) => i.name) },
          lidarrApp: lidarrApp ? { name: lidarrApp.name, syncLevel: lidarrApp.syncLevel } : null,
        };
      } catch (err) {
        out.prowlarr = { ok: false, message: message(err) };
      }
    }
    return out;
  });

  app.post('/api/lidarr/prowlarr/sync', { preHandler: requireAdmin }, async (_req, reply) => {
    const p = prowlarr();
    if (!p) return reply.code(409).send({ error: 'Prowlarr isn’t set up.' });
    try {
      await p.syncIndexers();
      return { ok: true };
    } catch (err) {
      return fail(reply, err);
    }
  });

  return { stop: () => clearInterval(timer) };
}
