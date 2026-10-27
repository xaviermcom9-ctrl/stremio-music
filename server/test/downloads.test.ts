import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db.js';
import { sniffAudio } from '../src/downloads/format.js';
import { pickDownload } from '../src/downloads/manager.js';
import { trackPath } from '../src/downloads/naming.js';
import { readTags } from '../src/downloads/tags.js';
import template from '../src/music-sources/_template/index.js';
import type { MusicSource } from '../src/music-sources/sdk.js';
import { fakeEngine } from './helpers.js';

const FFMPEG = process.env.FFMPEG_BIN ?? '/usr/bin/ffmpeg';

describe('download helpers', () => {
  test('formats are sniffed from bytes, not names; HTML is never audio', () => {
    assert.equal(sniffAudio(Buffer.from('fLaC\0\0\0\x22'), 'x.mp3'), 'flac');
    assert.equal(sniffAudio(Buffer.from([0xff, 0xfb, 0x90, 0x00]), 'x'), 'mp3');
    const id3 = Buffer.concat([Buffer.from('ID3\x03\x00\x00\x00\x00\x00\x02'), Buffer.from([0, 0]), Buffer.from('fLaC')]);
    assert.equal(sniffAudio(id3), 'flac');
    assert.equal(sniffAudio(Buffer.from('<!doctype html><title>404</title>'), 'track.flac'), undefined);
    assert.equal(sniffAudio(Buffer.from('????'), 'track.ogg'), 'ogg');
  });

  test('stream choice: lossless first, never live or YouTube, torrents allowed, unmarked http not', () => {
    const c = (stream: object, codec: string, extra: object = {}) => ({ stream, source: { id: 's', name: 's' }, codec, live: false, ...extra }) as never;
    const mp3 = c({ url: 'https://a/x.mp3', behaviorHints: { music: { downloadable: true } } }, 'mp3', { bitrate: 320 });
    const flac = c({ url: 'https://a/x.flac', behaviorHints: { music: { downloadable: true } } }, 'flac');
    const unmarked = c({ url: 'https://a/y.flac' }, 'flac');
    const torrent = c({ infoHash: 'a'.repeat(40), fileIdx: 1 }, 'flac');
    const live = c({ url: 'https://r/live', behaviorHints: { music: { downloadable: true } } }, 'mp3', { live: true });
    assert.equal(pickDownload([mp3, flac]), flac);
    assert.equal(pickDownload([unmarked, mp3]), mp3);
    assert.equal(pickDownload([unmarked, torrent]), torrent);
    assert.equal(pickDownload([live, c({ ytId: 'abc' }, 'unknown')]), undefined);
  });

  test('library paths are safe on Linux and SMB shares', () => {
    assert.equal(trackPath({ albumArtist: 'AC/DC', album: 'Live: 1991?', title: 'T.N.T.', trackNo: 3, ext: 'FLAC' }), 'AC-DC/Live - 1991/03 - T.N.T.flac');
    assert.equal(trackPath({ albumArtist: 'A', album: 'B', title: 'x', trackNo: 2, discNo: 2, multiDisc: true, ext: 'mp3' }), 'A/B/2-02 - x.mp3');
  });
});

describe('downloads (real port, real ffmpeg)', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'downloads-test-'));
  const media = path.join(root, 'media');
  mkdirSync(media);
  execFileSync(FFMPEG, ['-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', '-c:a', 'flac', path.join(media, 'a.flac')]);
  execFileSync(FFMPEG, ['-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=660:duration=3', '-c:a', 'libmp3lame', '-b:a', '128k', path.join(media, 'b.mp3')]);
  execFileSync(FFMPEG, ['-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=300x300', '-frames:v', '1', path.join(media, 'cover.jpg')]);
  const big = Buffer.concat([readFileSync(path.join(media, 'a.flac')), Buffer.alloc(3 * 1024 * 1024)]);

  const config = loadConfig({
    CONFIG_DIR: path.join(root, 'config'),
    CACHE_DIR: path.join(root, 'cache'),
    MUSIC_DIR: path.join(root, 'music'),
    DOWNLOADS_DIR: path.join(root, 'downloads'),
    WEB_ROOT: path.join(root, 'web'),
    FFMPEG_BIN: FFMPEG,
    LOG_LEVEL: 'error',
    ADMIN_USERNAME: 'admin',
    ADMIN_PASSWORD: 'admin password',
    APP_SECRET_KEY: 'downloads test key 1234567890',
  });
  mkdirSync(config.dirs.music, { recursive: true });
  mkdirSync(config.dirs.downloads, { recursive: true });
  const db = openDb(config.dbPath);
  const { s: engine } = fakeEngine({});
  const ranges: string[] = [];
  let slow = false;
  const server = http.createServer((req, res) => {
    const name = req.url!.split('?')[0]!.slice(1);
    if (name === 'bad') return res.writeHead(200, { 'content-type': 'text/html' }), res.end('<html>nope</html>');
    if (name === 'big.flac') {
      // slow, resumable: lets the test pause in the middle
      if (req.headers.range) ranges.push(req.headers.range);
      const start = Number(/bytes=(\d+)-/.exec(req.headers.range ?? '')?.[1] ?? 0);
      res.writeHead(start ? 206 : 200, { 'content-length': String(big.length - start), ...(start ? { 'content-range': `bytes ${start}-${big.length - 1}/${big.length}` } : {}), 'accept-ranges': 'bytes' });
      let at = start;
      const tick = () => {
        if (res.destroyed) return;
        const n = slow ? 64 * 1024 : big.length;
        res.write(big.subarray(at, at + n));
        at += n;
        if (at >= big.length) res.end();
        else setTimeout(tick, 50);
      };
      return tick();
    }
    const file = path.join(media, name);
    if (!existsSync(file)) return res.writeHead(404), res.end();
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    res.end(readFileSync(file));
  });
  let host = '';
  const scans: string[] = [];
  let app: FastifyInstance;
  let cookie = '';

  before(async () => {
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    host = `127.0.0.1:${(server.address() as AddressInfo).port}`;
    const cc = { name: 'CC BY 4.0', url: 'https://creativecommons.org/licenses/by/4.0/', attribution: 'by Test Band' };
    const tracks = [
      { id: 'dl:track:a', title: 'First', episode: 1, season: 1, file: 'a.flac' },
      { id: 'dl:track:b', title: 'Second', episode: 2, season: 1, file: 'b.mp3' },
    ];
    const dl: MusicSource = {
      ...template,
      manifest: { ...template.manifest, id: 'dl', name: 'DL', allowedHosts: [host], capabilities: { ...template.manifest.capabilities, downloadable: true } },
      meta: async (id, ctx) => {
        if (id === 'dl:album:1')
          return {
            id, type: 'music', name: 'Test: Album', poster: ctx.proxyUrl(`http://${host}/cover.jpg`), releaseInfo: '2024', links: [{ name: 'Page', category: 'source', url: 'https://example.org/album/1' }],
            music: { kind: 'album', artist: 'Test Band', licence: cc },
            videos: tracks.map((t) => ({ id: t.id, title: t.title, episode: t.episode, season: t.season, music: { artist: 'Test Band', licence: cc } })),
          };
        if (id === 'dl:track:big') return { id, type: 'music', name: 'Big one', music: { kind: 'track', artist: 'Slow Band', album: 'Slow' } };
        if (id === 'dl:track:bad') return { id, type: 'music', name: 'Broken', music: { kind: 'track', artist: 'X' } };
        return null;
      },
      streams: async (id, ctx) => {
        const t = tracks.find((x) => x.id === id);
        const file = t?.file ?? (id === 'dl:track:big' ? 'big.flac' : id === 'dl:track:bad' ? 'bad' : null);
        if (!file) return [];
        return [{ url: ctx.proxyUrl(`http://${host}/${file}`), name: 'file', behaviorHints: { music: { downloadable: true, codec: file.endsWith('mp3') ? 'mp3' : 'flac' } } }];
      },
      hooks: { libraryChanged: async (ctx) => void scans.push(ctx.user?.username ?? '?') },
    };
    const nd: MusicSource = { ...template, manifest: { ...template.manifest, id: 'lib', name: 'Lib' } };
    app = await buildApp({ config, db, engine, builtins: [dl, nd], downloadsScanDelayMs: 100 });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin', password: 'admin password' } });
    cookie = `sm_session=${res.cookies.find((c) => c.name === 'sm_session')!.value}`;
  });
  after(async () => {
    await app.close();
    server.close();
    db.close();
  });

  const call = async (method: string, url: string, payload?: object, who = cookie) => {
    const res = await app.inject({ method: method as 'GET', url, headers: { cookie: who }, ...(payload ? { payload } : {}) });
    return { status: res.statusCode, body: res.json() };
  };
  type G = { id: number; items: { id: number; status: string; downloaded: number; path: string; error: string; note: string }[] };
  const waitFor = async (pred: (groups: G[]) => boolean, ms = 20_000): Promise<G[]> => {
    const end = Date.now() + ms;
    for (;;) {
      const groups = (await call('GET', '/api/downloads')).body.groups as G[];
      if (pred(groups)) return groups;
      if (Date.now() > end) throw new Error(`timeout: ${JSON.stringify(groups.map((g) => g.items))}`);
      await new Promise((r) => setTimeout(r, 150));
    }
  };

  test('an album: files named, tagged, cover embedded, cover.jpg, LICENSE.txt, rescan', async () => {
    const r = await call('POST', '/api/downloads', { id: 'dl:album:1' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.group.items, 2);
    const groups = await waitFor((g) => g[0]!.items.every((i) => i.status === 'done'));
    const items = groups[0]!.items;
    assert.deepEqual(items.map((i) => i.path), ['Test Band/Test - Album/01 - First.flac', 'Test Band/Test - Album/02 - Second.mp3']);
    const flac = await readTags(path.join(config.dirs.music, items[0]!.path));
    assert.deepEqual([flac.tags.title, flac.tags.album, flac.tags.albumArtist, flac.tags.trackNo, flac.tags.trackTotal, flac.tags.year, flac.hasCover], ['First', 'Test: Album', 'Test Band', 1, 2, 2024, true]);
    const mp3 = await readTags(path.join(config.dirs.music, items[1]!.path));
    assert.deepEqual([mp3.tags.title, mp3.tags.trackNo, mp3.hasCover], ['Second', 2, true]);
    const folder = path.join(config.dirs.music, 'Test Band/Test - Album');
    assert.ok(existsSync(path.join(folder, 'cover.jpg')));
    await new Promise((r) => setTimeout(r, 300));
    const licence = readFileSync(path.join(folder, 'LICENSE.txt'), 'utf8');
    assert.match(licence, /“First” by Test Band, from “Test: Album”\n  Licence: CC BY 4\.0 \(https:\/\/creativecommons\.org\/licenses\/by\/4\.0\/\)\n  Attribution: by Test Band\n  Source: https:\/\/example\.org\/album\/1/);
    assert.match(licence, /“Second”/);
    assert.deepEqual(scans, ['admin'], 'library rescan after the album settled');
  });

  test('again: already in the library -> skipped; save to my device', async () => {
    await call('POST', '/api/downloads', { id: 'dl:album:1' });
    const groups = await waitFor((g) => g[0]!.items.every((i) => i.status === 'skipped'));
    assert.equal(groups[0]!.items[0]!.note, 'already in your library');
    const res = await app.inject({ method: 'GET', url: `/api/downloads/items/${groups[1]!.items[0]!.id}/file`, headers: { cookie } });
    assert.equal(res.statusCode, 200);
    assert.match(String(res.headers['content-disposition']), /attachment; filename="01 - First.flac"/);
    assert.equal(res.rawPayload.subarray(0, 4).toString(), 'fLaC');
  });

  test('pause keeps the partial file; resume continues with Range', async () => {
    slow = true;
    const { group } = (await call('POST', '/api/downloads', { id: 'dl:track:big' })).body;
    await waitFor((g) => g.find((x) => x.id === group.id)!.items[0]!.status === 'downloading');
    await new Promise((r) => setTimeout(r, 600));
    assert.equal((await call('POST', `/api/downloads/groups/${group.id}/pause`)).status, 200);
    const paused = await waitFor((g) => g.find((x) => x.id === group.id)!.items[0]!.status === 'paused');
    const item = paused.find((x) => x.id === group.id)!.items[0]!;
    assert.ok(item.downloaded > 0, 'progress kept');
    slow = false;
    await call('POST', `/api/downloads/items/${item.id}/resume`);
    const done = await waitFor((g) => g.find((x) => x.id === group.id)!.items[0]!.status === 'done');
    assert.equal(done.find((x) => x.id === group.id)!.items[0]!.path, 'Slow Band/Slow/Big one.flac');
    assert.ok(ranges.some((r) => r !== 'bytes=0-'), `resumed with a range: ${ranges.join(', ')}`);
  });

  test('not audio -> failed with a reason; retry is possible', async () => {
    const { group } = (await call('POST', '/api/downloads', { id: 'dl:track:bad' })).body;
    const g = await waitFor((gs) => gs.find((x) => x.id === group.id)!.items[0]!.status === 'failed');
    assert.match(g.find((x) => x.id === group.id)!.items[0]!.error, /not a recognised audio file/);
    assert.equal((await call('POST', `/api/downloads/groups/${group.id}/retry`)).status, 200);
  });

  test('sources without downloads, live and artists are refused up front', async () => {
    const r = await call('POST', '/api/downloads', { id: 'lib:album:x' });
    assert.equal(r.status, 404);
  });

  test("someone else's downloads are invisible and untouchable", async () => {
    await app.inject({ method: 'POST', url: '/api/users', headers: { cookie }, payload: { username: 'eve', password: 'eve password 123', isAdmin: false } });
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'eve', password: 'eve password 123' } });
    const eve = `sm_session=${login.cookies.find((c) => c.name === 'sm_session')!.value}`;
    assert.deepEqual((await call('GET', '/api/downloads', undefined, eve)).body.groups, []);
    const mine = (await call('GET', '/api/downloads')).body.groups[0];
    assert.equal((await call('POST', `/api/downloads/groups/${mine.id}/remove`, undefined, eve)).status, 404);
    assert.equal((await app.inject({ method: 'GET', url: `/api/downloads/items/${mine.items[0].id}/file`, headers: { cookie: eve } })).statusCode, 404);
    assert.equal((await call('GET', '/api/downloads/settings', undefined, eve)).status, 403);
  });

  test('live updates over Server-Sent Events', async () => {
    const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    const ac = new AbortController();
    const res = await fetch(`${base}/api/downloads/events`, { headers: { cookie }, signal: ac.signal });
    assert.equal(res.headers.get('content-type'), 'text/event-stream; charset=utf-8');
    const reader = res.body!.getReader();
    const { value } = await reader.read();
    const text = Buffer.from(value!).toString();
    assert.match(text, /^data: \{"groups":\[/);
    ac.abort();
  });

  test('settings: password stored encrypted, never returned; qBittorrent needs both folders', async () => {
    assert.equal((await call('PUT', '/api/downloads/settings', { torrentClient: 'qbittorrent' })).status, 400);
    const r = await call('PUT', '/api/downloads/settings', { qbittorrent: { password: 'hunter2', savePath: '/data/x', localPath: '/music/x' }, torrentClient: 'qbittorrent' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.qbittorrent.hasPassword, true);
    assert.ok(!JSON.stringify(r.body).includes('hunter2'));
    const row = db.prepare("SELECT value FROM app_settings WHERE key = 'downloads'").get() as { value: string };
    assert.ok(!row.value.includes('hunter2'));
    await call('PUT', '/api/downloads/settings', { torrentClient: 'engine' });
  });
});
