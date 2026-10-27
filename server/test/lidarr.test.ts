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
import { statusOf } from '../src/lidarr/routes.js';
import template from '../src/music-sources/_template/index.js';
import type { MusicSource } from '../src/music-sources/sdk.js';
import { fakeEngine } from './helpers.js';

const RG1 = '11111111-1111-4111-8111-111111111111';
const RG2 = '22222222-2222-4222-8222-222222222222';

describe('Lidarr status', () => {
  const album = (o: object = {}) => ({ title: 'A', foreignAlbumId: RG1, monitored: true, artist: { artistName: 'X', foreignArtistId: 'x' }, ...o });
  test('available, downloading with progress, importing, warning, searching, wanted, removed', () => {
    const now = 1_000_000_000;
    assert.equal(statusOf(album({ statistics: { trackFileCount: 10, trackCount: 10, totalTrackCount: 10, percentOfTracks: 100, sizeOnDisk: 1 } }), undefined, 0, now).status, 'available');
    const d = statusOf(album(), { albumId: 1, size: 100, sizeleft: 25, status: 'downloading' }, 0, now);
    assert.deepEqual([d.status, (d as { progress: number }).progress], ['downloading', 0.75]);
    assert.equal(statusOf(album(), { size: 1, sizeleft: 0, status: 'completed', trackedDownloadState: 'importPending' }, 0, now).status, 'importing');
    const w = statusOf(album(), { size: 1, sizeleft: 0, status: 'completed', trackedDownloadStatus: 'warning', statusMessages: [{ messages: ['No files found are eligible for import'] }] }, 0, now);
    assert.deepEqual([w.status, w.detail], ['warning', 'No files found are eligible for import']);
    assert.equal(statusOf(album(), undefined, now - 1000, now).status, 'searching');
    assert.equal(statusOf(album(), undefined, now - 10 * 60_000, now).status, 'wanted');
    assert.equal(statusOf(album({ monitored: false }), undefined, 0, now).status, 'unmonitored');
    assert.equal(statusOf(null, undefined, 0, now).status, 'removed');
  });
});

describe('Lidarr requests (fake Lidarr + Prowlarr)', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'lidarr-test-'));
  const config = loadConfig({
    CONFIG_DIR: path.join(root, 'config'),
    CACHE_DIR: path.join(root, 'cache'),
    MUSIC_DIR: path.join(root, 'music'),
    WEB_ROOT: path.join(root, 'web'),
    LOG_LEVEL: 'error',
    ADMIN_USERNAME: 'admin',
    ADMIN_PASSWORD: 'admin password',
    APP_SECRET_KEY: 'lidarr test key 1234567890',
  });
  const db = openDb(config.dbPath);
  const { s: engine } = fakeEngine({});

  // fake Lidarr state: RG2's artist is already in Lidarr (album id 7, unmonitored); RG1 is new
  const albums = new Map<number, { id: number; title: string; foreignAlbumId: string; monitored: boolean; statistics: object; artist: object }>([
    [7, { id: 7, title: 'Known', foreignAlbumId: RG2, monitored: false, statistics: { trackFileCount: 0, trackCount: 9, totalTrackCount: 9, percentOfTracks: 0, sizeOnDisk: 0 }, artist: { artistName: 'Old Band', foreignArtistId: 'ob' } }],
  ]);
  let queue: object[] = [];
  const calls: { method: string; path: string; body?: Record<string, unknown> }[] = [];
  const keys: string[] = [];
  const lookup = (rg: string) => {
    const lib = [...albums.values()].find((a) => a.foreignAlbumId === rg);
    if (lib) return { ...lib, remoteCover: 'https://img/known.jpg', releaseDate: '1999-01-01T00:00:00Z', albumType: 'Album' };
    return { title: 'New One', foreignAlbumId: RG1, monitored: false, albumType: 'Album', secondaryTypes: ['Live'], releaseDate: '2024-05-01T00:00:00Z', remoteCover: 'https://img/new.jpg', artist: { artistName: 'New Band', foreignArtistId: 'nb' } };
  };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      keys.push(String(req.headers['x-api-key']));
      const url = new URL(req.url!, 'http://x');
      const p = url.pathname.replace('/api/v1/', '');
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : undefined;
      calls.push({ method: req.method!, path: p, body });
      const send = (code: number, data: unknown) => (res.writeHead(code, { 'content-type': 'application/json' }), res.end(JSON.stringify(data)));
      if (req.headers['x-api-key'] !== 'LKEY' && req.headers['x-api-key'] !== 'PKEY') return send(401, { message: 'Unauthorized' });
      const prowl = req.headers['x-api-key'] === 'PKEY';
      if (p === 'system/status') return send(200, { version: prowl ? '2.6.5' : '3.1.0', appName: prowl ? 'Prowlarr' : 'Lidarr' });
      if (prowl) {
        if (p === 'indexer') return send(200, [{ id: 1, name: 'Good', enable: true, protocol: 'torrent' }, { id: 2, name: 'Flaky', enable: true, protocol: 'torrent' }]);
        if (p === 'indexerstatus') return send(200, [{ indexerId: 2, disabledTill: new Date(Date.now() + 3600_000).toISOString() }]);
        if (p === 'applications') return send(200, [{ id: 1, name: 'Lidarr', implementation: 'Lidarr', syncLevel: 'fullSync' }]);
        if (p === 'command') return send(201, { name: body?.name, status: 'queued' });
      }
      if (p === 'rootfolder') return send(200, [{ id: 1, path: '/music', freeSpace: 5e11 }]);
      if (p === 'qualityprofile') return send(200, [{ id: 2, name: 'Lossless' }]);
      if (p === 'metadataprofile') return send(200, [{ id: 1, name: 'Standard' }]);
      if (p === 'album/lookup') {
        const term = url.searchParams.get('term')!;
        if (term === 'broken') return send(200, { message: 'metadata server error' });
        return send(200, term.startsWith('lidarr:') ? [lookup(term.slice(7))] : [lookup(RG1), lookup(RG2)]);
      }
      if (p === 'album' && req.method === 'POST') {
        const a = { id: 8, title: String(body!.title), foreignAlbumId: String(body!.foreignAlbumId), monitored: true, statistics: { trackFileCount: 0, trackCount: 11, totalTrackCount: 11, percentOfTracks: 0, sizeOnDisk: 0 }, artist: body!.artist as object };
        albums.set(8, a);
        return send(201, a);
      }
      const m = /^album\/(\d+)$/.exec(p);
      if (m) return albums.has(Number(m[1])) ? send(200, albums.get(Number(m[1]))) : send(404, { message: 'Not found' });
      if (p === 'album/monitor') {
        for (const id of body!.albumIds as number[]) albums.get(id)!.monitored = Boolean(body!.monitored);
        return send(202, {});
      }
      if (p === 'command') return send(201, { name: body?.name, status: 'started' });
      if (p === 'queue') return send(200, { records: queue });
      send(404, { message: `no route ${p}` });
    });
  });
  const rescans: string[] = [];
  let app: FastifyInstance;
  let admin = '';
  let bob = '';
  let base = '';

  before(async () => {
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const lib: MusicSource = { ...template, manifest: { ...template.manifest, id: 'lib', name: 'Lib' }, hooks: { libraryChanged: async (ctx) => void rescans.push(ctx.user!.username) } };
    app = await buildApp({ config, db, engine, builtins: [lib] });
    const login = async (u: string, p: string) => `sm_session=${(await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: u, password: p } })).cookies.find((c) => c.name === 'sm_session')!.value}`;
    admin = await login('admin', 'admin password');
    await app.inject({ method: 'POST', url: '/api/users', headers: { cookie: admin }, payload: { username: 'bob', password: 'bob password 123', isAdmin: false } });
    bob = await login('bob', 'bob password 123');
  });
  after(async () => {
    await app.close();
    server.close();
    db.close();
  });

  const call = async (method: string, url: string, payload?: object, cookie = admin) => {
    const res = await app.inject({ method: method as 'GET', url, headers: { cookie }, ...(payload ? { payload } : {}) });
    return { status: res.statusCode, body: res.json(), raw: res.body };
  };

  test('not set up: status says so, requests are refused', async () => {
    assert.deepEqual((await call('GET', '/api/lidarr/status')).body, { enabled: false, canRequest: false });
    assert.equal((await call('GET', '/api/lidarr/search?q=x')).status, 409);
  });

  test('settings: test lists folders/profiles and Prowlarr health; keys are stored encrypted and never returned', async () => {
    await call('PUT', '/api/lidarr/settings', { lidarr: { url: base, apiKey: 'LKEY' }, prowlarr: { url: base, apiKey: 'PKEY' } });
    const t = (await call('POST', '/api/lidarr/settings/test')).body;
    assert.equal(t.lidarr.ok, true, JSON.stringify(t));
    assert.deepEqual([t.lidarr.rootFolders[0].path, t.lidarr.qualityProfiles[0].name, t.lidarr.metadataProfiles[0].name], ['/music', 'Lossless', 'Standard']);
    assert.deepEqual([t.prowlarr.indexers.total, t.prowlarr.indexers.failing, t.prowlarr.lidarrApp.syncLevel], [2, ['Flaky'], 'fullSync']);
    const s = await call('PUT', '/api/lidarr/settings', { lidarr: { rootFolderPath: '/music', qualityProfileId: 2, metadataProfileId: 1 } });
    assert.equal(s.body.ready, true);
    assert.equal(s.body.lidarr.hasApiKey, true);
    assert.ok(!s.raw.includes('LKEY') && !s.raw.includes('PKEY'));
    const row = db.prepare("SELECT value FROM app_settings WHERE key = 'lidarr'").get() as { value: string };
    assert.ok(!row.value.includes('LKEY') && !row.value.includes('PKEY'));
    assert.equal((await call('POST', '/api/lidarr/prowlarr/sync')).status, 200);
    assert.equal(calls.at(-1)!.body!.name, 'ApplicationIndexerSync');
    assert.equal((await call('GET', '/api/lidarr/settings', undefined, bob)).status, 403);
  });

  test('search shows library state; a failing metadata search is a clear error', async () => {
    const r = (await call('GET', '/api/lidarr/search?q=band', undefined, bob)).body;
    assert.deepEqual(
      r.albums.map((a: { title: string; year: number; type: string; inLidarr: unknown }) => [a.title, a.year, a.type, a.inLidarr]),
      [['New One', 2024, 'Album · Live', null], ['Known', 1999, 'Album', { monitored: false, percent: 0 }]],
    );
    const bad = await call('GET', '/api/lidarr/search?q=broken', undefined, bob);
    assert.equal(bad.status, 502);
    assert.match(bad.body.error, /metadata server/);
  });

  test('requesting a new album adds its artist with only that album monitored, and searches', async () => {
    const r = await call('POST', '/api/lidarr/requests', { foreignAlbumId: RG1 }, bob);
    assert.equal(r.status, 200, r.raw);
    const post = calls.find((c) => c.method === 'POST' && c.path === 'album')!;
    const artist = post.body!.artist as { rootFolderPath: string; qualityProfileId: number; metadataProfileId: number; monitorNewItems: string; addOptions: { monitor: string; albumsToMonitor: string[] } };
    assert.deepEqual([artist.rootFolderPath, artist.qualityProfileId, artist.metadataProfileId, artist.monitorNewItems], ['/music', 2, 1, 'none']);
    assert.deepEqual(artist.addOptions, { monitor: 'none', albumsToMonitor: [RG1], searchForMissingAlbums: false });
    assert.deepEqual(post.body!.addOptions, { searchForNewAlbum: true });
  });

  test('requesting an album Lidarr already has: monitored, then searched', async () => {
    const before = calls.length;
    assert.equal((await call('POST', '/api/lidarr/requests', { foreignAlbumId: RG2 })).status, 200);
    const mine = calls.slice(before);
    assert.ok(mine.some((c) => c.path === 'album/monitor' && (c.body!.albumIds as number[])[0] === 7));
    assert.ok(mine.some((c) => c.path === 'command' && c.body!.name === 'AlbumSearch'));
    assert.ok(!mine.some((c) => c.method === 'POST' && c.path === 'album'));
  });

  test('requests list: live status from the queue; arrival triggers the requester’s rescan once; users see their own', async () => {
    queue = [{ albumId: 8, size: 200, sizeleft: 50, status: 'downloading' }];
    let bobs = (await call('GET', '/api/lidarr/requests', undefined, bob)).body.requests;
    assert.deepEqual(bobs.map((r: { title: string; status: string; progress: number }) => [r.title, r.status, r.progress]), [['New One', 'downloading', 0.75]]);
    const all = (await call('GET', '/api/lidarr/requests')).body.requests;
    assert.deepEqual(all.map((r: { requestedBy: string }) => r.requestedBy).sort(), ['admin', 'bob']);

    queue = [];
    albums.get(8)!.statistics = { trackFileCount: 11, trackCount: 11, totalTrackCount: 11, percentOfTracks: 100, sizeOnDisk: 1 };
    bobs = (await call('GET', '/api/lidarr/requests', undefined, bob)).body.requests;
    assert.equal(bobs[0].status, 'available');
    await call('GET', '/api/lidarr/requests', undefined, bob);
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(rescans, ['bob'], 'one rescan for the requester');

    const adminsOwn = all.find((r: { requestedBy: string }) => r.requestedBy === 'admin');
    assert.equal((await call('DELETE', `/api/lidarr/requests/${adminsOwn.id}`, undefined, bob)).status, 404);
    assert.equal((await call('DELETE', `/api/lidarr/requests/${bobs[0].id}`, undefined, bob)).status, 200);
  });

  test('admins can keep requests to themselves', async () => {
    await call('PUT', '/api/lidarr/settings', { allowUsers: false });
    assert.deepEqual((await call('GET', '/api/lidarr/status', undefined, bob)).body, { enabled: true, canRequest: false });
    assert.equal((await call('POST', '/api/lidarr/requests', { foreignAlbumId: RG1 }, bob)).status, 403);
    assert.ok(keys.every((k) => k === 'LKEY' || k === 'PKEY'));
  });
});
