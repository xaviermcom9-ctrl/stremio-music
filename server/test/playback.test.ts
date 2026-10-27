import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db.js';
import template from '../src/music-sources/_template/index.js';
import type { MusicSource } from '../src/music-sources/sdk.js';
import { choose, normaliseCodec, type ClientCaps } from '../src/music/playback.js';
import { fakeEngine } from './helpers.js';

const BRAVE: ClientCaps = { codecs: ['mp3', 'aac', 'flac', 'vorbis', 'opus', 'wav'], hls: true, secure: false };
const src = (id: string) => ({ id, name: id }) as never;
const cand = (stream: object, codec: string, extra: object = {}) =>
  ({ stream, source: src('s'), codec, live: false, ...extra }) as Parameters<typeof choose>[0][number];
const mint = (_c: unknown, kind: string) => `api/${kind}/TOKEN`;
const eng = () => 'engine/IH/0';

describe('choosing a stream', () => {
  test('codec names from sources, Radio Browser and file names', () => {
    assert.equal(normaliseCodec('AAC+'), 'aac');
    assert.equal(normaliseCodec('MP3'), 'mp3');
    assert.equal(normaliseCodec(undefined, 'https://x/a.flac?y=1'), 'flac');
    assert.equal(normaliseCodec('ogg'), 'vorbis');
    assert.equal(normaliseCodec('hls'), 'hls');
    assert.equal(normaliseCodec(undefined, 'https://x/stream'), 'unknown');
  });

  test('best playable stream first, direct when possible', () => {
    const d = choose([cand({ url: 'https://a/x.flac' }, 'flac'), cand({ url: 'https://a/x.mp3' }, 'mp3')], BRAVE, mint, eng)!;
    assert.deepEqual([d.mode, d.url, d.seek], ['direct', 'https://a/x.flac', 'native']);
  });

  test('formats the browser cannot play are transcoded (seek by restart)', () => {
    const d = choose([cand({ url: 'https://a/x.m4a' }, 'alac')], BRAVE, mint, eng)!;
    assert.deepEqual([d.mode, d.url, d.codec, d.seek], ['transcode', 'api/transcode/TOKEN?br=320', 'mp3', 'restart']);
  });

  test('data saver: a small enough stream, else a transcode at the cap', () => {
    const caps = { ...BRAVE, maxBitrate: 128 };
    const flac = cand({ url: 'https://a/x.flac' }, 'flac');
    const mp3small = cand({ url: 'https://a/x64.mp3' }, 'mp3', { bitrate: 64 });
    assert.equal(choose([flac, mp3small], caps, mint, eng)!.url, 'https://a/x64.mp3');
    const d = choose([flac], caps, mint, eng)!;
    assert.deepEqual([d.mode, d.bitrate], ['transcode', 128]);
  });

  test('plain http on an https page goes through the proxy; private streams stay proxied', () => {
    const d = choose([cand({ url: 'http://radio/live' }, 'mp3', { live: true })], { ...BRAVE, secure: true }, mint, eng)!;
    assert.deepEqual([d.mode, d.url, d.seek, d.downloadable], ['proxy', 'api/proxy/TOKEN', 'none', false]);
    assert.equal(choose([cand({ url: 'api/proxy/OWN' }, 'flac')], BRAVE, mint, eng)!.url, 'api/proxy/OWN');
  });

  test('torrents through the engine; YouTube last', () => {
    assert.equal(choose([cand({ infoHash: 'a'.repeat(40), fileIdx: 2 }, 'flac')], BRAVE, mint, eng)!.mode, 'engine');
    const yt = choose([cand({ ytId: 'abc' }, 'unknown')], BRAVE, mint, eng)!;
    assert.deepEqual([yt.mode, yt.ytId, yt.downloadable], ['youtube', 'abc', false]);
    assert.equal(choose([], BRAVE, mint, eng), null);
  });
});

/** A tiny WAV (1 s of 440 Hz) so ffmpeg has something real to transcode. */
function wav(): Buffer {
  const rate = 8000;
  const samples = Buffer.alloc(rate * 2);
  for (let i = 0; i < rate; i++) samples.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 8000), i * 2);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + samples.length, 4);
  h.write('WAVEfmt ', 8);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(samples.length, 40);
  return Buffer.concat([h, samples]);
}

describe('playback API (real port: proxy, transcode, hooks, player state)', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'playback-test-'));
  const config = loadConfig({
    CONFIG_DIR: path.join(root, 'config'),
    CACHE_DIR: path.join(root, 'cache'),
    WEB_ROOT: path.join(root, 'web'),
    LOG_LEVEL: 'error',
    ADMIN_USERNAME: 'admin',
    ADMIN_PASSWORD: 'admin password',
    APP_SECRET_KEY: 'playback test key 1234567890',
  });
  const db = openDb(config.dbPath);
  const { s: engine } = fakeEngine({});
  const media = wav();
  let mediaHost = '';
  const seen: { auth?: string; range?: string }[] = [];
  const mediaServer = http.createServer((req, res) => {
    seen.push({ auth: req.headers.authorization, range: req.headers.range });
    if (req.headers.range) {
      res.writeHead(206, { 'content-type': 'audio/wav', 'content-range': `bytes 0-99/${media.length}`, 'content-length': '100', 'accept-ranges': 'bytes' });
      return res.end(media.subarray(0, 100));
    }
    res.writeHead(200, { 'content-type': 'audio/wav', 'content-length': String(media.length), 'accept-ranges': 'bytes' });
    res.end(media);
  });
  const scrobbled: string[] = [];
  let app: FastifyInstance;
  let base = '';
  let cookie = '';

  before(async () => {
    await new Promise<void>((r) => mediaServer.listen(0, '127.0.0.1', () => r()));
    mediaHost = `127.0.0.1:${(mediaServer.address() as AddressInfo).port}`;
    const local: MusicSource = {
      ...template,
      // the local media server is this source's own (allowed) host, like Navidrome on the Docker network
      manifest: { ...template.manifest, id: 'local', name: 'Local', allowedHosts: [mediaHost] },
      streams: async (id, ctx) => {
        if (id === 'local:track:wav') return [{ url: ctx.proxyUrl(`http://${mediaHost}/a.wav?token=SECRET`), name: 'WAV', behaviorHints: { music: { codec: 'wav' } } }];
        if (id === 'local:track:hdr') return [{ url: `http://${mediaHost}/b.wav`, behaviorHints: { proxyHeaders: { request: { authorization: 'Bearer SECRET2' } }, music: { codec: 'wav' } } }];
        return [];
      },
      hooks: { scrobble: async (id) => void scrobbled.push(id) },
    };
    // a "public" source whose stream URL points at a private address: must be refused by the proxy
    const sneaky: MusicSource = {
      ...template,
      manifest: { ...template.manifest, id: 'sneaky', name: 'Sneaky', allowedHosts: [] },
      streams: async () => [{ url: `http://${mediaHost}/a.wav`, behaviorHints: { music: { codec: 'wav', live: false } } }],
    };
    app = await buildApp({ config, db, engine, builtins: [local, sneaky] });
    await app.listen({ host: '127.0.0.1', port: 0 });
    base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin', password: 'admin password' } });
    cookie = `sm_session=${res.cookies.find((c) => c.name === 'sm_session')!.value}`;
  });
  after(async () => {
    await app.close();
    mediaServer.close();
    db.close();
  });

  const play = (id: string, caps: Partial<ClientCaps> = {}) =>
    app.inject({ method: 'POST', url: '/api/music/play', headers: { cookie }, payload: { id, caps: { ...BRAVE, ...caps } } });

  test('private stream: proxied with Range, credentials never reach the browser', async () => {
    const res = await play('local:track:hdr');
    assert.equal(res.statusCode, 200, res.body);
    assert.ok(!res.body.includes('SECRET'));
    const d = res.json();
    assert.equal(d.mode, 'proxy');
    const got = await fetch(`${base}/${d.url}`, { headers: { cookie, range: 'bytes=0-99' } });
    assert.equal(got.status, 206);
    assert.equal((await got.arrayBuffer()).byteLength, 100);
    assert.deepEqual(seen.at(-1), { auth: 'Bearer SECRET2', range: 'bytes=0-99' });
  });

  test('unsupported format: real ffmpeg transcode to MP3, through the loopback proxy', async () => {
    const d = (await play('local:track:wav', { codecs: ['mp3'] })).json();
    assert.equal(d.mode, 'transcode');
    const got = await fetch(`${base}/${d.url}`, { headers: { cookie } });
    assert.equal(got.status, 200);
    assert.equal(got.headers.get('content-type'), 'audio/mpeg');
    const buf = Buffer.from(await got.arrayBuffer());
    assert.ok(buf.length > 1000, `got ${buf.length} bytes`);
    // an MPEG audio frame sync (0xFFE) or an ID3 tag
    assert.ok(buf.subarray(0, 3).toString() === 'ID3' || (buf[0] === 0xff && (buf[1]! & 0xe0) === 0xe0));
    assert.equal((await fetch(`${base}/${d.url}`)).status, 401, 'needs a session');
  });

  test('a public-source stream pointing at a private address is refused', async () => {
    const d = (await play('sneaky:track:x', { secure: true })).json();
    assert.equal(d.mode, 'proxy');
    const got = await fetch(`${base}/${d.url}`, { headers: { cookie } });
    assert.equal(got.status, 403);
    assert.match((await got.json()).error, /private address/);
  });

  test("ffmpeg's internal key works from loopback only", async () => {
    const d = (await play('local:track:hdr')).json();
    const token = d.url.replace('api/proxy/', '');
    const fromLan = await app.inject({ url: `/api/proxy/${token}`, remoteAddress: '10.0.0.7', headers: { 'x-sm-internal': 'guess' } });
    assert.equal(fromLan.statusCode, 401);
  });

  test('played events reach the source hook (scrobble at the halfway mark)', async () => {
    const r1 = await app.inject({ method: 'POST', url: '/api/music/played', headers: { cookie }, payload: { id: 'local:track:wav', event: 'start' } });
    assert.deepEqual(r1.json().sources, [], 'non-live sources scrobble later, not at start');
    const r2 = await app.inject({ method: 'POST', url: '/api/music/played', headers: { cookie }, payload: { id: 'local:track:wav', event: 'scrobble' } });
    assert.deepEqual(r2.json().sources, ['local']);
    assert.deepEqual(scrobbled, ['local:track:wav']);
  });

  test('player state per user, for resuming on another device', async () => {
    const state = { queue: [{ id: 'local:track:wav', title: 'A' }], index: 0, position: 42.5, shuffle: false, repeat: 'off' };
    const put = await app.inject({ method: 'PUT', url: '/api/me/player', headers: { cookie }, payload: { state, device: 'Brave on Linux' } });
    assert.equal(put.statusCode, 200);
    const got = (await app.inject({ url: '/api/me/player', headers: { cookie } })).json();
    assert.deepEqual([got.state, got.device], [state, 'Brave on Linux']);
  });
});
