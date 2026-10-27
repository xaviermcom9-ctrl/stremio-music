// Playback: choosing a stream for the browser and delivering it.
//  POST /api/music/play        picks a stream + delivery for a track/station, given what the client can play
//  GET  /api/proxy/:token      private or mixed-content media through the backend (Range, live)
//  GET  /api/transcode/:token  ffmpeg -> MP3 when the client can't play a format, or for data saver
//  POST /api/music/played      playback events -> source hooks (scrobble / Radio Browser click)
//  GET  /api/music/torrent/:ih audio files of a torrent (multi-file albums)
//  GET/PUT /api/me/player      queue and position, per user, to resume on another device
import { spawn } from 'node:child_process';
import type { IncomingMessage } from 'node:http';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import type { EngineSupervisor } from '../engine/supervisor.js';
import type { MusicStream, SourceContext } from '../music-sources/sdk.js';
import type { ProxyToken, SourceEntry, SourceRegistry } from './registry.js';
import { APP_VERSION, hostAllowed } from './runtime.js';
import { openUpstream, UpstreamError } from './upstream.js';

/** Header carrying the per-process key with which ffmpeg reads /api/proxy over loopback. */
export const INTERNAL_HEADER = 'x-sm-internal';

const PASS_HEADERS = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'last-modified', 'etag'];
export const LOSSLESS = new Set(['flac', 'alac', 'wav']);
const MAX_TRANSCODES = 4;
export const AUDIO_EXT = /\.(mp3|flac|ogg|oga|opus|m4a|aac|wav|alac|wma|ape|wv)$/i;

export type Codec = 'mp3' | 'aac' | 'flac' | 'vorbis' | 'opus' | 'alac' | 'wav' | 'hls' | 'unknown';

/** Normalises source / Radio Browser / file-extension codec names. */
export function normaliseCodec(raw: string | undefined, urlOrName = ''): Codec {
  const c = (raw ?? '').toLowerCase().replace(/[^a-z0-9+]/g, '');
  if (c === 'mp3' || c === 'mpeg' || c === 'mpga') return 'mp3';
  if (c.startsWith('aac') || c === 'mp4a' || c === 'heaac' || c === 'm4a') return 'aac';
  if (c === 'flac') return 'flac';
  if (c === 'ogg' || c === 'vorbis' || c === 'oga') return 'vorbis';
  if (c === 'opus') return 'opus';
  if (c === 'alac') return 'alac';
  if (c === 'wav' || c === 'wave' || c === 'pcm') return 'wav';
  if (c === 'hls' || c === 'm3u8') return 'hls';
  const ext = /\.([a-z0-9]{2,5})(?:$|\?)/i.exec(urlOrName.split('#')[0]!)?.[1]?.toLowerCase();
  if (ext && ext !== raw) return normaliseCodec(ext);
  return 'unknown';
}

export interface ClientCaps {
  /** codecs <audio> can play (from canPlayType) */
  codecs: Codec[];
  /** HLS playable (natively or via hls.js) */
  hls: boolean;
  /** data saver: highest bitrate wanted, kbit/s */
  maxBitrate?: number;
  /** page served over https: plain-http media must go through the backend */
  secure: boolean;
}

export type Candidate = { stream: MusicStream; source: SourceEntry; codec: Codec; live: boolean; bitrate?: number };

export interface PlayDecision {
  mode: 'direct' | 'proxy' | 'transcode' | 'engine' | 'youtube';
  url?: string;
  ytId?: string;
  codec: Codec;
  live: boolean;
  /** native: <audio> seeks; restart: reload with ?t=seconds; none: live */
  seek: 'native' | 'restart' | 'none';
  bitrate?: number;
  downloadable: boolean;
  source: { id: string; name: string };
  stream: { name?: string; description?: string };
  /** other streams that could be tried if this one fails */
  alternatives: number;
}

const playable = (codec: Codec, caps: ClientCaps) => (codec === 'hls' ? caps.hls : codec === 'unknown' || caps.codecs.includes(codec));

/**
 * Picks a stream and how to deliver it. Order: sources by priority, each source's own order
 * (best first). Lossless when the client can play it, unless data saver caps the bitrate.
 */
export function choose(
  candidates: Candidate[],
  caps: ClientCaps,
  mint: (c: Candidate, kind: 'proxy' | 'transcode') => string,
  engineUrl: (c: Candidate) => string,
): PlayDecision | null {
  const urls = candidates.filter((c) => c.stream.url);
  const base = (c: Candidate) => ({
    codec: c.codec,
    live: c.live,
    downloadable: !!c.stream.behaviorHints?.music?.downloadable && !c.live,
    source: { id: c.source.id, name: c.source.name },
    stream: { name: c.stream.name, description: c.stream.description },
    alternatives: candidates.length - 1,
  });
  const deliver = (c: Candidate): PlayDecision => {
    const url = c.stream.url!;
    const proxied = url.startsWith('api/proxy/');
    const mixed = caps.secure && url.startsWith('http:');
    return {
      ...base(c),
      mode: proxied || mixed ? 'proxy' : 'direct',
      url: proxied ? url : mixed ? mint(c, 'proxy') : url,
      seek: c.live ? 'none' : 'native',
      bitrate: c.bitrate,
    };
  };
  const transcode = (c: Candidate, kbps: number): PlayDecision => ({
    ...base(c),
    mode: 'transcode',
    url: `${mint(c, 'transcode')}?br=${kbps}`,
    codec: 'mp3',
    seek: c.live ? 'none' : 'restart',
    bitrate: kbps,
  });

  if (caps.maxBitrate) {
    const max = caps.maxBitrate;
    const small = urls.find((c) => playable(c.codec, caps) && !LOSSLESS.has(c.codec) && c.bitrate !== undefined && c.bitrate <= max);
    if (small) return deliver(small);
    // the output is small anyway: transcode from a lossy version when there is one (less to
    // download, and MP3 seeks without reading the file from the start, unlike FLAC over HTTP)
    const input = urls.find((c) => c.codec === 'mp3') ?? urls.find((c) => !LOSSLESS.has(c.codec)) ?? urls[0];
    if (input) return transcode(input, max);
  } else {
    const native = urls.find((c) => playable(c.codec, caps));
    if (native) return deliver(native);
    if (urls[0]) return transcode(urls[0], 320);
  }
  const torrent = candidates.find((c) => c.stream.infoHash);
  if (torrent) {
    const supported = playable(torrent.codec, caps) && !caps.maxBitrate;
    return {
      ...base(torrent),
      mode: supported ? 'engine' : 'transcode',
      url: supported ? engineUrl(torrent) : `${mint(torrent, 'transcode')}?br=${caps.maxBitrate ?? 320}`,
      codec: supported ? torrent.codec : 'mp3',
      seek: supported ? 'native' : 'restart',
    };
  }
  const yt = candidates.find((c) => c.stream.ytId);
  if (yt) return { ...base(yt), mode: 'youtube', ytId: yt.stream.ytId, seek: 'native', downloadable: false };
  return null;
}

const Caps = z.object({
  codecs: z.array(z.enum(['mp3', 'aac', 'flac', 'vorbis', 'opus', 'alac', 'wav', 'hls', 'unknown'])).max(16),
  hls: z.boolean(),
  maxBitrate: z.number().int().min(32).max(512).optional(),
  secure: z.boolean(),
});

export interface PlaybackOptions {
  registry: SourceRegistry;
  engine: EngineSupervisor;
  db: DatabaseSync;
  ffmpeg: string;
  /** the backend's own port (once listening), for ffmpeg reading /api/proxy over loopback */
  port: () => number;
  internalKey: string;
}

/** What other modules (downloads) reuse: stream lookup and starting torrents in the engine. */
export interface PlaybackHelpers {
  streamCandidates(id: string, user: SourceContext['user']): Promise<Candidate[]>;
  createTorrent(infoHash: string, stream: { sources?: string[] }): Promise<{ files?: { name: string; length: number }[] } | null>;
}

export function registerPlayback(app: FastifyInstance, o: PlaybackOptions): PlaybackHelpers {
  const { registry } = o;
  const userOf = (req: FastifyRequest): SourceContext['user'] => (req.user ? { id: req.user.id, username: req.user.username } : null);
  let transcodes = 0;

  /** Which hosts a token may reach without the public-address rule. */
  function trustedHosts(t: ProxyToken, user: SourceContext['user']): (host: string) => boolean {
    const e = registry.get(t.s);
    if (!e?.runtime) return () => false;
    const allowed = e.runtime.allowedHosts(registry.settingsFor(e.id, user));
    return (host) => hostAllowed(host, allowed);
  }

  async function streamCandidates(id: string, user: SourceContext['user']): Promise<Candidate[]> {
    const owners = registry.active(user).filter((e) => registry.owns(e, 'stream', id));
    const settled = await Promise.allSettled(owners.map((e) => registry.streams(e, user, id)));
    return settled.flatMap((r, i) =>
      r.status === 'fulfilled'
        ? (r.value as MusicStream[]).map((stream) => {
            const hints = stream.behaviorHints?.music;
            const name = stream.url ?? (stream.behaviorHints?.filename as string | undefined) ?? stream.name ?? '';
            return {
              stream,
              source: owners[i]!,
              codec: normaliseCodec(hints?.codec, name),
              live: !!hints?.live || !!owners[i]!.capabilities.live,
              bitrate: typeof hints?.bitrate === 'number' ? hints.bitrate : undefined,
            };
          })
        : [],
    );
  }

  // ---------------------------------------------------------------- choose

  app.post('/api/music/play', async (req, reply) => {
    const body = z.object({ id: z.string().min(1).max(1024), caps: Caps, name: z.string().max(512).optional() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid request' });
    const { id, caps } = body.data;
    const user = userOf(req);
    // a file of a multi-file torrent (from /api/music/torrent): played through the engine as-is
    const tf = /^torrent:([0-9a-f]{40}):(\d+)$/.exec(id);
    const candidates: Candidate[] = tf
      ? [{ stream: { infoHash: tf[1], fileIdx: Number(tf[2]) }, source: { id: 'torrent', name: 'Torrent' } as SourceEntry, codec: normaliseCodec(undefined, body.data.name), live: false }]
      : await streamCandidates(id, user);
    if (candidates.length === 0) return reply.code(404).send({ error: 'no playable stream for this item' });
    const decision = choose(
      candidates,
      caps,
      (c, kind) => {
        // a stream already behind our proxy carries its own token
        const existing = c.stream.url?.startsWith('api/proxy/') ? c.stream.url.slice('api/proxy/'.length) : null;
        const token = c.stream.infoHash
          ? registry.proxyToken(c.source.id, `${c.stream.infoHash}/${c.stream.fileIdx ?? 0}`, undefined, { engine: true })
          : (existing ?? registry.proxyToken(c.source.id, c.stream.url!, undefined, { pub: true }));
        return `api/${kind}/${token}`;
      },
      (c) => {
        // start finding peers now (with the stream's trackers); the GET waits for metadata itself
        void createTorrent(c.stream.infoHash!, c.stream as { sources?: string[] });
        return `engine/${c.stream.infoHash}/${c.stream.fileIdx ?? 0}`;
      },
    );
    if (!decision) return reply.code(404).send({ error: 'no stream this browser can play' });
    return decision;
  });

  async function createTorrent(infoHash: string, stream: { sources?: string[] }): Promise<{ files?: { name: string; length: number }[] } | null> {
    const base = o.engine.url;
    if (!base) return null;
    const sources = [...(stream.sources ?? []).filter((s) => /^(tracker|dht):/.test(s)), `dht:${infoHash}`];
    try {
      const res = await fetch(new URL(`${infoHash}/create`, base), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ torrent: { infoHash }, peerSearch: { sources, min: 40, max: 200 } }),
        signal: AbortSignal.timeout(60_000),
      });
      return res.ok ? ((await res.json()) as { files?: { name: string; length: number }[] }) : null;
    } catch {
      return null;
    }
  }

  // ---------------------------------------------------------------- proxy

  app.get<{ Params: { token: string } }>('/api/proxy/:token', async (req, reply) => {
    const t = registry.openProxyToken(req.params.token);
    if (!t || t.k === 'engine') return reply.code(404).send({ error: 'invalid or expired link' });
    const e = registry.get(t.s);
    // remote addons have no allow-list: only public media of theirs goes through here
    if (!e?.enabled || (!e.runtime && !t.p)) return reply.code(404).send({ error: 'source unavailable' });
    const trusted = trustedHosts(t, userOf(req));
    if (!t.p && !trusted(new URL(t.u).host)) return reply.code(403).send({ error: 'host no longer allowed' });

    const headers: Record<string, string> = { 'user-agent': e.runtime?.manifest.userAgent ?? `StremioMusic/${APP_VERSION} (self-hosted)`, ...t.h };
    if (typeof req.headers.range === 'string') headers.range = req.headers.range;
    const abort = new AbortController();
    req.raw.on('close', () => abort.abort());
    let res: IncomingMessage;
    try {
      res = await openUpstream(t.u, { headers, trustedHost: trusted, allowPublic: !!t.p, signal: abort.signal });
    } catch (err) {
      return reply.code(err instanceof UpstreamError ? err.status : 502).send({ error: `upstream: ${err instanceof Error ? err.message : String(err)}` });
    }
    reply.code(res.statusCode ?? 502);
    for (const h of PASS_HEADERS) {
      const v = res.headers[h];
      if (typeof v === 'string') reply.header(h, v);
    }
    const live = !res.headers['content-length'] && !res.headers['content-range'];
    reply.header('cache-control', live || (res.statusCode ?? 500) >= 400 ? 'no-store' : 'private, max-age=86400');
    return reply.send(res);
  });

  // ---------------------------------------------------------------- transcode

  app.get<{ Params: { token: string }; Querystring: { br?: string; t?: string } }>('/api/transcode/:token', async (req, reply) => {
    const t = registry.openProxyToken(req.params.token);
    if (!t) return reply.code(404).send({ error: 'invalid or expired link' });
    if (transcodes >= MAX_TRANSCODES) return reply.code(503).header('retry-after', '5').send({ error: 'too many transcodes running' });
    const br = Math.min(320, Math.max(32, Number(req.query.br) || 192));
    const start = Math.max(0, Number(req.query.t) || 0);

    let input: string;
    const inputArgs: string[] = [];
    if (t.k === 'engine') {
      if (!o.engine.url) return reply.code(503).send({ error: 'engine unavailable' });
      input = new URL(t.u, o.engine.url).href;
    } else {
      // through our own proxy over loopback: same host checks, and ffmpeg can seek with Range
      input = `http://127.0.0.1:${o.port()}/api/proxy/${req.params.token}`;
      inputArgs.push('-headers', `${INTERNAL_HEADER}: ${o.internalKey}\r\n`);
    }
    const args = [
      '-hide_banner', '-loglevel', 'error', '-nostdin',
      ...(start > 0 ? ['-ss', String(start)] : []),
      ...inputArgs,
      '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5',
      '-i', input,
      '-map', '0:a:0', '-vn', '-c:a', 'libmp3lame', '-b:a', `${br}k`, '-f', 'mp3', 'pipe:1',
    ];
    const ff = spawn(o.ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    transcodes++;
    let stderr = '';
    ff.stderr.on('data', (d: Buffer) => (stderr = (stderr + d.toString()).slice(-2000)));
    const done = () => {
      if (!ff.killed && ff.exitCode === null) ff.kill('SIGKILL');
    };
    // e.g. ffmpeg missing: without this listener the error event would crash the process
    ff.on('error', (err) => {
      req.log.error({ err }, 'could not start ffmpeg');
      ff.stdout.destroy(err);
    });
    ff.on('exit', (code) => {
      transcodes--;
      if (code && code !== 255) req.log.warn({ code, stderr: stderr.trim().slice(-500) }, 'transcode failed');
    });
    req.raw.on('close', done);
    reply.header('content-type', 'audio/mpeg').header('cache-control', 'no-store').header('x-transcode-bitrate', String(br));
    return reply.send(ff.stdout);
  });

  // ---------------------------------------------------------------- events -> hooks

  app.post('/api/music/played', async (req, reply) => {
    const body = z.object({ id: z.string().min(1).max(1024), event: z.enum(['start', 'scrobble']) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid request' });
    const user = userOf(req);
    const { id, event } = body.data;
    const called: string[] = [];
    for (const e of registry.active(user).filter((x) => registry.owns(x, 'stream', id))) {
      // live sources count a play when it starts (Radio Browser's click); others scrobble at the halfway mark
      const wanted = e.capabilities.live ? 'start' : 'scrobble';
      if (event === wanted && (await registry.hook(e, user, 'scrobble', id))) called.push(e.id);
    }
    return { ok: true, sources: called };
  });

  // ---------------------------------------------------------------- torrents

  app.get<{ Params: { ih: string }; Querystring: { tr?: string | string[] } }>('/api/music/torrent/:ih', async (req, reply) => {
    const ih = req.params.ih.toLowerCase();
    if (!/^[0-9a-f]{40}$/.test(ih)) return reply.code(400).send({ error: 'invalid info hash' });
    const trackers = [req.query.tr ?? []].flat().filter((s) => /^tracker:(https?|udp):\/\//.test(s));
    const info = await createTorrent(ih, { sources: trackers });
    if (!info?.files) return reply.code(504).send({ error: 'torrent metadata not available (no peers yet?)' });
    const files = info.files
      .map((f, fileIdx) => ({ fileIdx, name: f.name, length: f.length }))
      .filter((f) => AUDIO_EXT.test(f.name))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    return { infoHash: ih, files };
  });

  // ---------------------------------------------------------------- player state (resume on another device)

  app.get('/api/me/player', async (req) => {
    const row = o.db.prepare('SELECT state, device, updated_at FROM player_state WHERE user_id = ?').get(req.user!.id) as
      | { state: string; device: string | null; updated_at: number }
      | undefined;
    return row ? { state: JSON.parse(row.state), device: row.device, updatedAt: row.updated_at } : { state: null };
  });

  app.put('/api/me/player', { bodyLimit: 1024 * 1024 }, async (req, reply) => {
    const body = z.object({ state: z.record(z.string(), z.unknown()), device: z.string().max(100).optional() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid state' });
    const json = JSON.stringify(body.data.state);
    if (json.length > 768 * 1024) return reply.code(413).send({ error: 'queue too large' });
    const now = Date.now();
    o.db
      .prepare(
        `INSERT INTO player_state (user_id, state, device, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (user_id) DO UPDATE SET state = excluded.state, device = excluded.device, updated_at = excluded.updated_at`,
      )
      .run(req.user!.id, json, body.data.device ?? null, now);
    return { ok: true, updatedAt: now };
  });

  return { streamCandidates, createTorrent };
}

export type { FastifyReply };
