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
import type { MusicMetaPreview, MusicSource } from '../src/music-sources/sdk.js';
import { bestMatch, coreTitle, parseCsv, parseImport } from '../src/music/import.js';
import { fakeEngine } from './helpers.js';

describe('playlist files', () => {
  test('CSV with quotes, commas and newlines inside fields', () => {
    assert.deepEqual(parseCsv('a,"b, c","d ""e"""\r\n1,"two\nlines",3\n'), [['a', 'b, c', 'd "e"'], ['1', 'two\nlines', '3']]);
  });

  test('Exportify-style CSV: names, first artist, album, duration in ms', () => {
    const csv = '"Track URI","Track Name","Album Name","Artist Name(s)","Release Date","Duration (ms)"\n' +
      '"spotify:track:1","Song One","Album, Deluxe","Simon & Garfunkel","1970","185000"\n' +
      '"spotify:track:2","Song Two - Remastered 2011","Other","Main Artist, Guest","2001","241000"\n';
    assert.deepEqual(parseImport(csv, 'road_trip.csv'), [
      { name: 'road trip', tracks: [
        { title: 'Song One', artist: 'Simon & Garfunkel', album: 'Album, Deluxe', duration: 185 },
        { title: 'Song Two - Remastered 2011', artist: 'Main Artist', album: 'Other', duration: 241 },
      ] },
    ]);
  });

  test('Spotify data export JSON: every playlist with tracks; podcasts skipped', () => {
    const json = JSON.stringify({ playlists: [
      { name: 'Chill', items: [{ track: { trackName: 'A', artistName: 'X', albumName: 'Y' } }, { track: null, episode: { episodeName: 'pod' } }] },
      { name: 'Empty', items: [] },
      { name: 'Drive', items: [{ track: { trackName: 'B', artistName: 'Z', albumName: '' } }] },
    ] });
    assert.deepEqual(parseImport(json, 'Playlist1.json').map((p) => [p.name, p.tracks.length]), [['Chill', 1], ['Drive', 1]]);
  });

  test('plain "Artist - Title" lines; numbering ignored; nothing usable is an error', () => {
    assert.deepEqual(parseImport('1. Portishead - Roads\n\n2) Massive Attack – Teardrop\nnot a track line'), [{ name: 'Imported playlist', tracks: [{ artist: 'Portishead', title: 'Roads' }, { artist: 'Massive Attack', title: 'Teardrop' }] }]);
    assert.throws(() => parseImport('hello\nworld'), /Artist - Title/);
  });

  test('matching: versions ignored, artist must agree, closest duration, other recordings refused', () => {
    assert.equal(coreTitle('Roads - Remastered 2011'), coreTitle('Roads'));
    assert.equal(coreTitle('Song (feat. Someone)'), coreTitle('Song'));
    const c = (id: string, name: string, artist: string, duration?: number) => ({ id, type: 'music', name, music: { kind: 'track', artist, duration } }) as MusicMetaPreview;
    const cands = [c('1', 'Roads', 'Other Band', 300), c('2', 'Roads (Live)', 'Portishead', 420), c('3', 'Roads', 'Portishead', 305), c('4', 'Roads', 'Portishead', 330)];
    assert.equal(bestMatch({ title: 'Roads', artist: 'Portishead', duration: 304 }, cands)?.id, '3');
    assert.equal(bestMatch({ title: 'Roads', artist: 'Portishead' }, cands)?.id, '2');
    assert.equal(bestMatch({ title: 'Roads', artist: 'Portishead', duration: 600 }, cands), undefined);
    assert.equal(bestMatch({ title: 'Roads', artist: 'Nobody' }, cands), undefined);
  });
});

describe('import API', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'import-test-'));
  const config = loadConfig({ CONFIG_DIR: path.join(root, 'config'), CACHE_DIR: path.join(root, 'cache'), WEB_ROOT: path.join(root, 'web'), LOG_LEVEL: 'error', ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: 'admin password', APP_SECRET_KEY: 'import test key 1234567890' });
  const db = openDb(config.dbPath);
  const { s: engine } = fakeEngine({});
  let app: FastifyInstance;
  let cookie = '';
  const searchCatalog = [{ id: 'search', name: 'Search', extra: [{ name: 'search', isRequired: true }] }];
  const track = (src: string, id: string, name: string, artist: string) => ({ id: `${src}:track:${id}`, type: 'music' as const, name, music: { kind: 'track' as const, artist, duration: 200 } });
  // "mine" (first priority) has one song; "web" has another; neither has the third
  const mine: MusicSource = { ...template, manifest: { ...template.manifest, id: 'mine', name: 'Mine', catalogs: searchCatalog }, catalog: async (r) => (r.search?.includes('Roads') ? [track('mine', '1', 'Roads', 'Portishead')] : []) };
  // "web" searches names only, like Jamendo: "Massive Attack Teardrop" finds nothing, "Teardrop" does
  const web: MusicSource = { ...template, manifest: { ...template.manifest, id: 'web', name: 'Web', catalogs: searchCatalog }, catalog: async (r) => (r.search?.includes('Roads') ? [track('web', '9', 'Roads', 'Portishead')] : r.search === 'Teardrop' ? [track('web', '2', 'Teardrop', 'Massive Attack')] : []) };

  before(async () => {
    app = await buildApp({ config, db, engine, builtins: [mine, web] });
    cookie = `sm_session=${(await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin', password: 'admin password' } })).cookies.find((c) => c.name === 'sm_session')!.value}`;
  });
  after(async () => {
    await app.close();
    db.close();
  });

  test('parse, import, poll: playlist created in order, first source by priority wins, missing listed', async () => {
    const parsed = await app.inject({ method: 'POST', url: '/api/library/import/parse', headers: { cookie }, payload: { text: 'Portishead - Roads\nMassive Attack - Teardrop\nNobody - Nothing', filename: 'Mix.txt' } });
    const { playlists } = parsed.json();
    assert.equal(playlists[0].name, 'Mix');
    const started = await app.inject({ method: 'POST', url: '/api/library/import', headers: { cookie }, payload: { name: 'Mix', tracks: playlists[0].tracks, link: 'https://open.spotify.com/playlist/abc' } });
    assert.equal(started.statusCode, 200, started.body);
    let job = started.json().job;
    for (let i = 0; i < 50 && job.state === 'running'; i++) {
      await new Promise((r) => setTimeout(r, 50));
      job = (await app.inject({ method: 'GET', url: `/api/library/import/${job.id}`, headers: { cookie } })).json().job;
    }
    assert.deepEqual([job.state, job.matched, job.total, job.bySource], ['done', 2, 3, { Mine: 1, Web: 1 }]);
    assert.deepEqual(job.missing, [{ artist: 'Nobody', title: 'Nothing' }]);
    const p = (await app.inject({ method: 'GET', url: `/api/library/playlists/${job.playlistId}`, headers: { cookie } })).json();
    assert.deepEqual(p.tracks.map((t: { data: { id: string } }) => t.data.id), ['mine:track:1', 'web:track:2']);
    assert.equal(p.playlist.description, 'Imported from https://open.spotify.com/playlist/abc');
  });
});
