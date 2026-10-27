import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db.js';
import template from '../src/music-sources/_template/index.js';
import type { MusicMeta, MusicMetaPreview, MusicSource } from '../src/music-sources/sdk.js';
import { mergeArtist } from '../src/music/discover.js';
import { albumKey, isSame, norm } from '../src/music/match.js';
import { MusicBrainz } from '../src/music/musicbrainz.js';
import { fakeEngine } from './helpers.js';

describe('matching across sources', () => {
  test('names are normalised', () => {
    assert.equal(norm('The Beatles'), norm('beatles'));
    assert.equal(norm('Sigur Rós'), norm('Sigur Ros'));
    assert.equal(norm('Simon & Garfunkel'), norm('Simon and Garfunkel'));
    assert.equal(norm('Abbey Road (Remastered)'), norm('Abbey Road'));
    assert.notEqual(norm('Beatles'), norm('Beat'));
  });

  test('MBIDs decide when both sides have one, names otherwise', () => {
    const known = { mbid: 'mb-1', names: new Set([norm('The Beatles'), norm('Fab Four')]) };
    assert.ok(isSame(known, { name: 'Beatles' }));
    assert.ok(isSame(known, { name: 'Fab Four' }));
    assert.ok(isSame(known, { name: 'Different name', mbid: 'mb-1' }));
    assert.ok(!isSame(known, { name: 'The Beatles', mbid: 'mb-2' }), 'same name, other artist');
    assert.equal(albumKey({ name: 'X', music: { mbid: 'r1' } }), 'mb:r1');
    assert.equal(albumKey({ name: 'Abbey Road' }, 'The Beatles'), albumKey({ name: 'abbey road', music: { artist: 'Beatles' } }));
  });

  test('artist merge: top tracks topped up, albums once with alternatives, same-source albums kept', () => {
    const a = { id: 'a', name: 'A' };
    const b = { id: 'b', name: 'B' };
    const album = (id: string, name: string, extra: object = {}) => ({ id, type: 'music' as const, name, music: { kind: 'album' as const, artist: 'Band', ...extra } });
    const merged = mergeArtist([
      { source: a, meta: { id: 'a:1', type: 'music', name: 'Band', music: { kind: 'artist' }, videos: [{ id: 'a:t1', title: 'Song' }], albums: [album('a:al1', 'First'), album('a:al2', 'First (Deluxe)')] } },
      { source: b, meta: { id: 'b:1', type: 'music', name: 'Band', music: { kind: 'artist' }, videos: [{ id: 'b:t1', title: 'song' }, { id: 'b:t2', title: 'Other' }], albums: [album('b:al1', 'first'), album('b:al3', 'Live')] } },
    ]);
    assert.deepEqual(merged.videos.map((v) => [v.id, v.source.id]), [['a:t1', 'a'], ['b:t2', 'b']]);
    assert.deepEqual(merged.albums.map((x) => x.id), ['a:al1', 'a:al2', 'b:al3']);
    assert.deepEqual(merged.albums[0]!.alternatives, [{ source: b, id: 'b:al1' }]);
  });
});

describe('MusicBrainz client', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'mb-test-'));
  const db = openDb(path.join(root, 'app.db'));
  after(() => db.close());
  const calls: string[] = [];
  const fake = (async (url: string, init: RequestInit) => {
    calls.push(url);
    assert.match(String((init.headers as Record<string, string>)['user-agent']), /\( me@example\.org \)$/);
    const artists = url.includes('Nirvana')
      ? [{ id: 'n1', name: 'Nirvana', score: 100 }, { id: 'n2', name: 'Nirvana', score: 100 }]
      : [{ id: 'b1', name: 'The Beatles', score: 100, 'sort-name': 'Beatles, The', aliases: [{ name: 'Fab Four' }] }, { id: 'x', name: 'Beatles Tribute', score: 95 }];
    return new Response(JSON.stringify({ artists }), { headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  const mb = new MusicBrainz({ userAgent: 'Test/1 ( me@example.org )', db, fetch: fake, minIntervalMs: 0 });

  test('exact name or alias; ambiguous names give no match; answers are cached', async () => {
    const a = await mb.artistByName('Beatles');
    assert.equal(a?.id, 'b1');
    assert.ok(a!.names.includes(norm('Fab Four')));
    assert.equal(await mb.artistByName('Nirvana'), null);
    const before = calls.length;
    assert.equal((await mb.artistByName('beatles'))?.id, 'b1');
    assert.equal(await mb.artistByName('Nirvana'), null);
    assert.equal(calls.length, before, 'served from the cache');
  });
});

describe('library API (likes, playlists, source sync, merged artists)', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'library-test-'));
  const config = loadConfig({
    CONFIG_DIR: path.join(root, 'config'),
    CACHE_DIR: path.join(root, 'cache'),
    WEB_ROOT: path.join(root, 'web'),
    LOG_LEVEL: 'error',
    ADMIN_USERNAME: 'admin',
    ADMIN_PASSWORD: 'admin password',
    APP_SECRET_KEY: 'library test key 1234567890',
  });
  const db = openDb(config.dbPath);
  const { s: engine } = fakeEngine({});
  let app: FastifyInstance;
  let cookie = '';

  // "nd": a Navidrome-like source that owns its likes and takes playlists
  const starred = new Set<string>(['nd:track:starred-elsewhere']);
  const remote = new Map<string, { name: string; tracks: string[] }>();
  let failStar = false;
  const track = (src: string, id: string, title: string): MusicMetaPreview => ({ id: `${src}:track:${id}`, type: 'music', name: title, music: { kind: 'track', artist: 'The Band', duration: 100 } });
  const searchCatalog = [{ id: 'search', name: 'Search', extra: [{ name: 'search', isRequired: true }] }];
  const nd: MusicSource = {
    ...template,
    manifest: { ...template.manifest, id: 'nd', name: 'ND', catalogs: searchCatalog },
    catalog: async () => [{ id: 'nd:artist:1', type: 'music', name: 'The Band', music: { kind: 'artist', mbid: 'mb-band' } }],
    meta: async (id) =>
      id === 'nd:artist:1'
        ? ({
            id,
            type: 'music',
            name: 'The Band',
            music: { kind: 'artist', mbid: 'mb-band' },
            videos: [{ id: 'nd:track:1', title: 'Hit' }],
            albums: [{ id: 'nd:album:1', type: 'music', name: 'Debut', music: { kind: 'album', artist: 'The Band' } }],
          } satisfies MusicMeta)
        : id === 'nd:album:1'
          ? { id, type: 'music', name: 'Debut', music: { kind: 'album', artist: 'The Band' }, videos: [{ id: 'nd:track:1', title: 'Hit' }] }
          : null,
    hooks: {
      setLiked: async (id, liked) => {
        if (failStar) throw new Error('server down');
        if (liked) starred.add(id);
        else starred.delete(id);
      },
      listLiked: async () => [...starred].map((id) => track('nd', id.split(':')[2]!, `Song ${id}`)),
      savePlaylist: async ({ remoteId, name, trackIds }) => {
        const id = remoteId ?? `r${remote.size + 1}`;
        remote.set(id, { name, tracks: trackIds });
        return id;
      },
      deletePlaylist: async (id) => void remote.delete(id),
    },
  };
  // "ia": another source with the same artist under a slightly different name, and the same album
  const ia: MusicSource = {
    ...template,
    manifest: { ...template.manifest, id: 'ia', name: 'IA', catalogs: searchCatalog },
    catalog: async (req) =>
      req.search === 'Debut'
        ? [{ id: 'ia:album:9', type: 'music', name: 'Debut', music: { kind: 'album', artist: 'Band, The' } }, { id: 'ia:album:8', type: 'music', name: 'Debut', music: { kind: 'album', artist: 'Someone else' } }]
        : [{ id: 'ia:artist:7', type: 'music', name: 'Band', music: { kind: 'artist' } }],
    meta: async (id) =>
      id === 'ia:artist:7'
        ? {
            id,
            type: 'music',
            name: 'Band',
            music: { kind: 'artist' },
            videos: [{ id: 'ia:track:5', title: 'hit' }, { id: 'ia:track:6', title: 'Live jam' }],
            albums: [
              { id: 'ia:album:9', type: 'music', name: 'Debut', music: { kind: 'album', artist: 'Band' } },
              { id: 'ia:album:10', type: 'music', name: 'Live 1999', music: { kind: 'album', artist: 'Band' } },
            ],
          }
        : null,
  };

  before(async () => {
    app = await buildApp({ config, db, engine, builtins: [nd, ia] });
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin', password: 'admin password' } });
    cookie = `sm_session=${res.cookies.find((c) => c.name === 'sm_session')!.value}`;
  });
  after(async () => {
    await app.close();
    db.close();
  });

  const call = async (method: string, url: string, payload?: object) => {
    const res = await app.inject({ method: method as 'GET', url, headers: { cookie }, ...(payload ? { payload } : {}) });
    return { status: res.statusCode, body: res.json() };
  };
  const snap = (id: string, name: string, kind = 'track') => ({ id, name, poster: `https://img/${id}`, music: { kind, artist: 'The Band', duration: 60 }, junk: 'dropped' });

  test('like and unlike: stored per user; the owning source is told', async () => {
    assert.equal((await call('PUT', '/api/library/items', { kind: 'track', item: snap('ia:track:5', 'hit') })).status, 200);
    assert.equal((await call('PUT', '/api/library/items', { kind: 'track', item: snap('nd:track:1', 'Hit') })).status, 200);
    assert.ok(starred.has('nd:track:1'));
    const lib = (await call('GET', '/api/library?refresh=1')).body;
    const ids = lib.items.map((i: { id: string }) => i.id).sort();
    assert.deepEqual(ids, ['ia:track:5', 'nd:track:1', 'nd:track:starred-elsewhere']);
    assert.equal(lib.items.find((i: { id: string }) => i.id === 'ia:track:5').data.junk, undefined, 'unknown fields dropped');
    assert.equal((await call('DELETE', '/api/library/items?kind=track&id=nd:track:1')).status, 200);
    assert.ok(!starred.has('nd:track:1'));
  });

  test('stars removed on the source disappear here; a failed star is an error, not a silent local like', async () => {
    starred.delete('nd:track:starred-elsewhere');
    const lib = (await call('GET', '/api/library?refresh=1')).body;
    assert.deepEqual(lib.items.map((i: { id: string }) => i.id), ['ia:track:5']);
    failStar = true;
    const r = await call('PUT', '/api/library/items', { kind: 'album', item: snap('nd:album:1', 'Debut', 'album') });
    failStar = false;
    assert.equal(r.status, 502);
    assert.match(r.body.error, /server down/);
    assert.equal((await call('GET', '/api/library?refresh=1')).body.items.length, 1);
  });

  test('playlists: create, add, move, remove, rename; synced to the source with its own tracks only', async () => {
    const created = (await call('POST', '/api/library/playlists', { name: 'Mix', items: [snap('nd:track:1', 'Hit'), snap('ia:track:5', 'hit')] })).body.playlist;
    assert.equal(created.trackCount, 2);
    assert.equal(created.duration, 120);
    const id = created.id;
    await call('POST', `/api/library/playlists/${id}/tracks`, { items: [snap('nd:track:2', 'Two')] });
    let p = (await call('GET', `/api/library/playlists/${id}`)).body;
    assert.deepEqual(p.tracks.map((t: { data: { id: string } }) => t.data.id), ['nd:track:1', 'ia:track:5', 'nd:track:2']);
    await call('POST', `/api/library/playlists/${id}/move`, { entry: p.tracks[2].entry, to: 0 });
    await call('DELETE', `/api/library/playlists/${id}/tracks/${p.tracks[1].entry}`);
    p = (await call('GET', `/api/library/playlists/${id}`)).body;
    assert.deepEqual(p.tracks.map((t: { data: { id: string } }) => t.data.id), ['nd:track:2', 'nd:track:1']);
    assert.equal(remote.size, 0, 'not synced until asked');

    const synced = (await call('PATCH', `/api/library/playlists/${id}`, { sync: true, name: 'Road mix' })).body.playlist;
    assert.deepEqual(synced.syncedTo, ['nd']);
    assert.equal(synced.syncError, null);
    assert.deepEqual(remote.get('r1'), { name: 'Road mix', tracks: ['nd:track:2', 'nd:track:1'] });
    await call('POST', `/api/library/playlists/${id}/tracks`, { items: [snap('ia:track:6', 'Live jam'), snap('nd:track:3', 'Three')] });
    assert.deepEqual(remote.get('r1')!.tracks, ['nd:track:2', 'nd:track:1', 'nd:track:3']);

    assert.equal((await call('DELETE', `/api/library/playlists/${id}`)).status, 200);
    assert.equal(remote.size, 0, 'synced playlist deleted on the source too');
    assert.equal((await call('GET', `/api/library/playlists/${id}`)).status, 404);
  });

  test("another user's playlist is not reachable", async () => {
    const { id } = (await call('POST', '/api/library/playlists', { name: 'Mine' })).body.playlist;
    const other = await app.inject({ method: 'POST', url: '/api/users', headers: { cookie }, payload: { username: 'bob', password: 'bob password 123', isAdmin: false } });
    assert.ok(other.statusCode < 300, other.body);
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'bob', password: 'bob password 123' } });
    const bob = `sm_session=${login.cookies.find((c) => c.name === 'sm_session')!.value}`;
    const res = await app.inject({ method: 'GET', url: `/api/library/playlists/${id}`, headers: { cookie: bob } });
    assert.equal(res.statusCode, 404);
    assert.deepEqual((await app.inject({ method: 'GET', url: '/api/library', headers: { cookie: bob } })).json().playlists, []);
  });

  test('artist page merged across sources; album source picker', async () => {
    const r = (await call('GET', `/api/music/artist?id=${encodeURIComponent('nd:artist:1')}`)).body;
    assert.deepEqual(r.sources.map((s: { id: string }) => s.id), ['nd:artist:1', 'ia:artist:7']);
    assert.deepEqual(r.meta.videos.map((v: { id: string }) => v.id), ['nd:track:1', 'ia:track:6']);
    assert.deepEqual(r.meta.albums.map((a: { id: string }) => a.id), ['nd:album:1', 'ia:album:10']);
    assert.deepEqual(r.meta.albums[0].alternatives, [{ source: { id: 'ia', name: 'IA' }, id: 'ia:album:9' }]);
    assert.equal(r.musicbrainz, 'off');

    const alt = (await call('GET', `/api/music/alternatives?id=${encodeURIComponent('nd:album:1')}`)).body;
    assert.deepEqual(alt.alternatives.map((a: { id: string }) => a.id), ['ia:album:9']);
  });
});

describe('Jamendo text', () => {
  test('HTML entities in names are decoded', async () => {
    const { unescapeHtml } = await import('../src/music-sources/jamendo/index.js');
    assert.equal(unescapeHtml('Pop &amp; Deep House'), 'Pop & Deep House');
    assert.equal(unescapeHtml('Daleka podr&oacute;ż'), 'Daleka podróż');
    assert.equal(unescapeHtml('L&#039;amore'), "L'amore");
    assert.equal(unescapeHtml('&Uuml;ber &x; &#x41;'), 'Über &x; A');
  });
});
