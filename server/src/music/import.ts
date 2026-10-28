// Playlist import (e.g. from Spotify): a file or pasted text -> tracks -> matched against your
// sources -> a playlist of yours.
//  POST /api/library/import/parse   {text, filename?}  -> {playlists: [{name, tracks}]}   (preview)
//  POST /api/library/import         {name, tracks, link?} -> {job}   (matching runs in the background)
//  GET  /api/library/import/:job    progress, then the created playlist and what wasn't found
// Formats: Spotify's "Download your data" JSON (Playlist1.json), CSV exports (Exportify and
// similar: columns "Track Name", "Artist Name(s)", "Album Name", "Duration (ms)"), and plain
// "Artist - Title" lines. Matching: each source in priority order (Navidrome first by default),
// same artist + same title (versions like "- Remastered 2011" ignored), closest duration.
import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import type { MusicMetaPreview } from '../music-sources/sdk.js';
import { LibraryStore, Snapshot } from './library.js';
import { norm } from './match.js';
import type { SourceEntry, SourceRegistry } from './registry.js';

export interface ImportTrack {
  title: string;
  artist: string;
  album?: string;
  /** seconds */
  duration?: number;
}

const MAX_TRACKS = 2000;

// ---------------------------------------------------------------- parsing

/** RFC 4180-ish CSV: quoted fields, doubled quotes, commas/newlines inside quotes. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      if (row.some((f) => f !== '')) rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f !== '')) rows.push(row);
  return rows;
}

/** Several artists ("A, B" or "A;B"): the first one is the main artist. */
// ("&" stays: "Simon & Garfunkel" is one artist)
const firstArtist = (s: string) => s.split(/\s*[;,]\s*|\s+(?:feat|ft)\.?\s+/i)[0]!.trim() || s.trim();

export function parseImport(text: string, filename = ''): { name: string; tracks: ImportTrack[] }[] {
  const base = filename.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim() || 'Imported playlist';
  const t = text.replace(/^﻿/, '').trim();
  if (!t) return [];

  // Spotify "Download your data": {"playlists":[{"name", "items":[{"track":{"trackName","artistName","albumName"}}]}]}
  if (t.startsWith('{') || t.startsWith('[')) {
    let data: unknown;
    try {
      data = JSON.parse(t);
    } catch {
      throw new Error('This looks like JSON but can’t be read.');
    }
    const lists = (Array.isArray(data) ? data : ((data as { playlists?: unknown[] }).playlists ?? [data])) as {
      name?: string;
      items?: { track?: { trackName?: string; artistName?: string; albumName?: string } | null }[];
    }[];
    const out = lists
      .map((p) => ({
        name: p.name?.trim() || base,
        tracks: (p.items ?? [])
          .map((i) => i.track)
          .filter((x): x is { trackName: string; artistName: string; albumName?: string } => !!x?.trackName && !!x.artistName)
          .map((x) => ({ title: x.trackName, artist: firstArtist(x.artistName), album: x.albumName || undefined })),
      }))
      .filter((p) => p.tracks.length);
    if (!out.length) throw new Error('No playlists with tracks found in this file (Spotify’s export: use Playlist1.json).');
    return out;
  }

  // CSV with a header row naming the columns
  const firstLine = t.split(/\r?\n/, 1)[0]!.toLowerCase();
  if (firstLine.includes(',') && /track|title|song/.test(firstLine) && firstLine.includes('artist')) {
    const [header, ...rows] = parseCsv(t);
    const h = header!.map((c) => c.toLowerCase().trim());
    // patterns in order of preference: "Track Name" before any other column mentioning "track" (e.g. "Track URI")
    const col = (...names: RegExp[]) => {
      for (const n of names) {
        const i = h.findIndex((c) => n.test(c));
        if (i >= 0) return i;
      }
      return -1;
    };
    const ti = col(/^track name$/, /^title$/, /^name$/, /^song$/, /track|title|song/);
    const ai = col(/^artist name\(s\)$/, /^artist(s)?$/, /artist/);
    const al = col(/^album name$/, /^album$/);
    const du = col(/duration \(ms\)/, /^duration/);
    if (ti < 0 || ai < 0) throw new Error('The CSV needs a track/title column and an artist column.');
    const tracks = rows
      .filter((r) => r[ti]?.trim() && r[ai]?.trim())
      .map((r) => {
        const d = du >= 0 ? Number(r[du]) : NaN;
        return {
          title: r[ti]!.trim(),
          artist: firstArtist(r[ai]!),
          album: al >= 0 && r[al]?.trim() ? r[al]!.trim() : undefined,
          // "Duration (ms)" in Exportify; plain seconds or m:ss elsewhere
          duration: Number.isFinite(d) && d > 0 ? (h[du]!.includes('ms') ? Math.round(d / 1000) : d) : undefined,
        };
      });
    return tracks.length ? [{ name: base, tracks }] : [];
  }

  // plain text: "Artist - Title" per line (also – and —), numbering and blank lines ignored
  const tracks = t
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*\d+[.)]\s*/, '').trim())
    .filter(Boolean)
    .flatMap((l) => {
      const m = /^(.+?)\s+[-–—]\s+(.+)$/.exec(l);
      return m ? [{ artist: firstArtist(m[1]!), title: m[2]!.trim() }] : [];
    });
  if (!tracks.length) throw new Error('Nothing to import: use one “Artist - Title” per line, a CSV export, or Spotify’s Playlist1.json.');
  return [{ name: base, tracks }];
}

// ---------------------------------------------------------------- matching

/** "Song - Remastered 2011", "Song (feat. X)", "Song - Live" -> "song" */
export const coreTitle = (s: string) => norm(s.split(/\s+[-–—]\s+/)[0]!.replace(/\b(feat|ft|with)\.?\s.*$/i, ''));

/** Best candidate: same artist, same title; closest duration when both are known. */
export function bestMatch(want: ImportTrack, candidates: MusicMetaPreview[]): MusicMetaPreview | undefined {
  const t = coreTitle(want.title);
  const a = norm(want.artist);
  const ok = candidates.filter((c) => {
    if ((c.music?.kind ?? 'track') !== 'track' || c.music?.live) return false;
    const ca = norm(c.music?.artist);
    return coreTitle(c.name) === t && ca !== '' && (ca === a || ca.includes(a) || a.includes(ca));
  });
  if (!want.duration) return ok[0];
  const dist = (c: MusicMetaPreview) => (c.music?.duration ? Math.abs(c.music.duration - want.duration!) : 30);
  const best = [...ok].sort((x, y) => dist(x) - dist(y))[0];
  // a big gap means another recording (live version, edit…)
  return best && dist(best) <= 30 ? best : undefined;
}

interface Job {
  id: string;
  userId: number;
  name: string;
  total: number;
  done: number;
  matched: number;
  state: 'running' | 'done' | 'failed';
  playlistId?: number;
  missing: ImportTrack[];
  bySource: Record<string, number>;
  error?: string;
  startedAt: number;
}

export function registerImport(app: FastifyInstance, db: DatabaseSync, registry: SourceRegistry): void {
  const store = new LibraryStore(db);
  const jobs = new Map<string, Job>();

  const Track = z.object({ title: z.string().min(1).max(500), artist: z.string().min(1).max(500), album: z.string().max(500).optional(), duration: z.number().positive().max(36000).optional() });

  app.post('/api/library/import/parse', { bodyLimit: 20 * 1024 * 1024 }, async (req, reply) => {
    const body = z.object({ text: z.string().max(20 * 1024 * 1024), filename: z.string().max(300).optional() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid input' });
    try {
      const playlists = parseImport(body.data.text, body.data.filename);
      return { playlists: playlists.map((p) => ({ name: p.name, tracks: p.tracks.slice(0, MAX_TRACKS) })) };
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/library/import', { bodyLimit: 4 * 1024 * 1024 }, async (req, reply) => {
    const body = z.object({ name: z.string().trim().min(1).max(200), tracks: z.array(Track).min(1).max(MAX_TRACKS), link: z.string().url().max(500).optional() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid playlist' });
    const user = { id: req.user!.id, username: req.user!.username };
    if ([...jobs.values()].some((j) => j.userId === user.id && j.state === 'running')) return reply.code(409).send({ error: 'An import is already running.' });
    const job: Job = { id: randomBytes(8).toString('hex'), userId: user.id, name: body.data.name, total: body.data.tracks.length, done: 0, matched: 0, state: 'running', missing: [], bySource: {}, startedAt: Date.now() };
    jobs.set(job.id, job);
    void run(job, user, body.data.tracks, body.data.link).catch((err) => {
      job.state = 'failed';
      job.error = err instanceof Error ? err.message : String(err);
    });
    return { job: view(job) };
  });

  app.get<{ Params: { job: string } }>('/api/library/import/:job', async (req, reply) => {
    const job = jobs.get(req.params.job);
    if (!job || job.userId !== req.user!.id) return reply.code(404).send({ error: 'no such import' });
    return { job: view(job) };
  });

  const view = (j: Job) => ({ id: j.id, name: j.name, total: j.total, done: j.done, matched: j.matched, state: j.state, playlistId: j.playlistId ?? null, missing: j.state === 'running' ? [] : j.missing, bySource: j.bySource, error: j.error ?? null });

  async function search(e: SourceEntry, user: { id: number; username: string }, q: string): Promise<MusicMetaPreview[]> {
    const catalogs = e.catalogs.filter((c) => c.searchable);
    const settled = await Promise.allSettled(catalogs.map((c) => registry.catalog(e, user, c.id, { search: q })));
    return settled.flatMap((r) => (r.status === 'fulfilled' ? (r.value as unknown as MusicMetaPreview[]) : []));
  }

  async function run(job: Job, user: { id: number; username: string }, tracks: ImportTrack[], link?: string) {
    const sources = registry.active(user).filter((e) => !e.capabilities.live && e.catalogs.some((c) => c.searchable));
    const found: (Snapshot | null)[] = new Array(tracks.length).fill(null);
    // a few at a time: sources have their own rate limits on top
    let next = 0;
    await Promise.all(
      Array.from({ length: 4 }, async () => {
        while (next < tracks.length) {
          const i = next++;
          const t = tracks[i]!;
          const title = t.title.split(/\s+[-–—]\s+/)[0]!;
          for (const e of sources) {
            // "artist title" first; some sources (Jamendo) only search names, so then the title alone
            const hit =
              bestMatch(t, await search(e, user, `${t.artist} ${title}`).catch(() => [])) ??
              bestMatch(t, await search(e, user, title).catch(() => []));
            if (hit) {
              const parsed = Snapshot.safeParse({ ...hit, source: { id: e.id, name: e.name }, music: { ...hit.music, kind: 'track' } });
              if (parsed.success) {
                found[i] = parsed.data;
                job.bySource[e.name] = (job.bySource[e.name] ?? 0) + 1;
                break;
              }
            }
          }
          if (found[i]) job.matched++;
          else job.missing.push(t);
          job.done++;
        }
      }),
    );
    const playlist = store.createPlaylist(user.id, job.name, link ? `Imported from ${link}` : `Imported ${new Date().toISOString().slice(0, 10)}`);
    const items = found.filter((x): x is Snapshot => x !== null);
    if (items.length) store.addTracks(playlist, items);
    // missing tracks in the order of the original playlist
    job.missing = tracks.filter((t) => job.missing.includes(t));
    job.playlistId = playlist.id;
    job.state = 'done';
    // finished jobs are kept for an hour
    setTimeout(() => jobs.delete(job.id), 3600_000).unref();
  }
}
