import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db.js';
import template from '../src/music-sources/_template/index.js';
import type { MusicSource } from '../src/music-sources/sdk.js';
import { ResponseCache, SourceRuntime, hostAllowed, validateSourceManifest } from '../src/music/runtime.js';
import { SecretBox } from '../src/music/secrets.js';
import { applyInput, mask, resolve } from '../src/music/settings.js';
import { fakeEngine } from './helpers.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE_JS_DIR = path.resolve(here, '../src/music-sources/_template');

describe('secrets and settings', () => {
  const box = SecretBox.fromPassphrase('a test passphrase that is long', 'env');
  const schema = template.manifest.settings;

  test('AES-GCM round trip, tamper-evident', () => {
    const enc = box.encrypt('hunter2');
    assert.match(enc, /^enc:v1:/);
    assert.equal(box.decrypt(enc), 'hunter2');
    const other = SecretBox.fromPassphrase('a different passphrase!!', 'env');
    assert.throws(() => other.decrypt(enc));
  });

  test('secrets are encrypted at rest, masked for the browser, decrypted for the source', () => {
    const userStored = applyInput(schema, 'user', {}, { token: 's3cret' }, box);
    assert.ok(SecretBox.isEncrypted(userStored.token));
    assert.deepEqual(mask(schema, userStored, 'user'), { token: { secret: true, set: true } });
    assert.equal(resolve(schema, {}, userStored, box).token, 's3cret');
    // sending the masked value back keeps it; "" clears it
    assert.deepEqual(applyInput(schema, 'user', userStored, { token: { secret: true, set: true } }, box), userStored);
    assert.deepEqual(applyInput(schema, 'user', userStored, { token: '' }, box), {});
  });

  test('scope and types are enforced; defaults apply', () => {
    assert.throws(() => applyInput(schema, 'user', {}, { greeting: 'x' }, box), /unknown setting/);
    assert.throws(() => applyInput(schema, 'global', {}, { nope: 1 }, box), /unknown setting/);
    assert.equal(resolve(schema, {}, {}, box).greeting, 'Hello');
    const urlSchema = { server: { type: 'url', label: 'Server' } } as const;
    assert.equal(applyInput(urlSchema, 'global', {}, { server: 'http://navidrome:4533/ ' }, box).server, 'http://navidrome:4533');
    assert.throws(() => applyInput(urlSchema, 'global', {}, { server: 'ftp://x' }, box), /http/);
  });
});

describe('source manifest validation', () => {
  test('the template is valid', () => {
    assert.ok(validateSourceManifest(template.manifest).ok);
  });
  test('reports readable errors', () => {
    const bad = { ...template.manifest, id: 'Bad ID', capabilities: { ...template.manifest.capabilities, live: true } };
    const v = validateSourceManifest(bad);
    assert.ok(!v.ok);
    assert.match(v.errors.join('\n'), /^id:/m);
    const v2 = validateSourceManifest({ ...template.manifest, capabilities: { ...template.manifest.capabilities, live: true } });
    assert.ok(!v2.ok && /live source cannot be downloadable/.test(v2.errors.join()));
  });
});

describe('SourceRuntime', () => {
  const runtime = (impl: MusicSource, fetchImpl?: typeof fetch) =>
    new SourceRuntime(impl, { perUser: false, cache: new ResponseCache(100), settingsFor: () => ({}), fetchImpl });

  test('host allow-list', () => {
    assert.ok(hostAllowed('api.example.org', ['*.example.org']));
    assert.ok(hostAllowed('example.org', ['*.example.org']));
    assert.ok(!hostAllowed('evil.org', ['*.example.org']));
    assert.ok(!hostAllowed('example.org.evil.com', ['example.org']));
  });

  test('ctx.fetch refuses hosts the source did not declare, sends its User-Agent', async () => {
    let seenUA = '';
    const fakeFetch = (async (_u: URL, init: RequestInit) => {
      seenUA = (init.headers as Record<string, string>)['user-agent']!;
      return new Response('{"ok":1}');
    }) as unknown as typeof fetch;
    const impl: MusicSource = { ...template, manifest: { ...template.manifest, allowedHosts: ['api.example.org'] } };
    const rt = runtime(impl, fakeFetch);
    const ctx = rt.context(null);
    await assert.rejects(ctx.fetch('https://elsewhere.org/x'), /host not allowed/);
    const res = await ctx.fetch('https://api.example.org/x');
    assert.deepEqual(await res.json(), { ok: 1 });
    assert.match(seenUA, /^StremioMusic\//);
  });

  test('drops invalid items and wrong-prefix ids, caches results', async () => {
    let calls = 0;
    const impl: MusicSource = {
      ...template,
      catalog: async () => {
        calls++;
        return [
          { id: 'example:ok', type: 'music', name: 'Fine', music: { kind: 'album' } },
          { id: 'other:x', type: 'music', name: 'Wrong prefix', music: { kind: 'album' } },
          { id: 'example:bad', type: 'music', music: { kind: 'album' } } as never,
        ];
      },
    };
    const rt = runtime(impl);
    const items = await rt.catalog(null, 'albums', {});
    assert.deepEqual(items.map((i) => i.id), ['example:ok']);
    assert.equal(rt.stats.invalidItems, 2);
    await rt.catalog(null, 'albums', {});
    assert.equal(calls, 1, 'second call served from cache');
    await assert.rejects(rt.catalog(null, 'albums', { bogus: '1' }), /doesn't accept/);
    await assert.rejects(rt.catalog(null, 'search', {}), /requires: search/);
  });
});

describe('sources API (built-in, folder plugins, remote addons)', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sources-test-'));
  const pluginDir = path.join(root, 'config', 'music-sources');
  const config = loadConfig({
    CONFIG_DIR: path.join(root, 'config'),
    CACHE_DIR: path.join(root, 'cache'),
    WEB_ROOT: path.join(root, 'web'),
    LOG_LEVEL: 'error',
    ADMIN_USERNAME: 'admin',
    ADMIN_PASSWORD: 'admin password',
    APP_SECRET_KEY: 'test key for the sources suite',
  });
  const db = openDb(config.dbPath);
  const { s: engine } = fakeEngine({});
  const remoteManifest = {
    id: 'org.remote.music',
    name: 'Remote Music',
    version: '1.2.0',
    description: 'remote',
    types: ['music'],
    resources: ['catalog', 'meta', 'stream'],
    idPrefixes: ['rm:'],
    catalogs: [{ type: 'music', id: 'top', name: 'Top' }, { type: 'music', id: 'find', name: 'Find', extra: [{ name: 'search', isRequired: true }] }],
  };
  const remote: Record<string, unknown> = {
    'https://addons.test/music/manifest.json': remoteManifest,
    'https://addons.test/music/catalog/music/top.json': { metas: [{ id: 'rm:1', type: 'music', name: 'Remote Album', videos: [] }] },
    'https://addons.test/music/catalog/music/find/search=Remote.json': { metas: [{ id: 'rm:1', type: 'music', name: 'Remote Album' }] },
    'https://addons.test/music/meta/music/rm%3A1.json': { meta: { id: 'rm:1', type: 'music', name: 'Remote Album', videos: [{ id: 'rm:1:1', title: 'T' }] } },
    'https://addons.test/music/stream/music/rm%3A1%3A1.json': { streams: [{ url: 'https://cdn.test/1.mp3', behaviorHints: { proxyHeaders: { request: { authorization: 'Bearer x' } } } }, { ytId: 'abc123' }] },
    'https://addons.test/movies/manifest.json': { ...remoteManifest, id: 'org.movies', name: 'Movies', types: ['movie'], catalogs: [] },
  };
  const seenRanges: string[] = [];
  const fakeFetch = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith('https://media.example.org/')) {
      // private media for the proxy test: echoes the auth header it got
      const headers = new Headers(init?.headers);
      seenRanges.push(headers.get('range') ?? '');
      const res = new Response(`audio for ${headers.get('authorization')}`, {
        status: headers.get('range') ? 206 : 200,
        headers: { 'content-type': 'audio/flac', 'content-range': 'bytes 0-9/100', 'accept-ranges': 'bytes' },
      });
      Object.defineProperty(res, 'url', { value: url });
      return res;
    }
    if (!(url in remote)) return new Response('not found', { status: 404 });
    const res = new Response(JSON.stringify(remote[url]), { headers: { 'content-type': 'application/json' } });
    Object.defineProperty(res, 'url', { value: url });
    return res;
  }) as typeof fetch;

  let app: FastifyInstance;
  let admin = '';
  let bob = '';

  const login = async (username: string, password: string) => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password } });
    return `sm_session=${res.cookies.find((c) => c.name === 'sm_session')!.value}`;
  };
  const as = (cookie: string, method: string, url: string, payload?: object) =>
    app.inject({ method: method as 'GET', url, headers: { cookie }, payload });

  before(async () => {
    // one working folder plugin (the compiled template, renamed) and one broken one
    mkdirSync(path.join(pluginDir, 'demo'), { recursive: true });
    const js = readFileSync(path.join(TEMPLATE_JS_DIR, 'index.js'), 'utf8').replace("const ID = 'example';", "const ID = 'demo';").replace("name: 'Example',", "name: 'Demo plugin',");
    writeFileSync(path.join(pluginDir, 'demo', 'index.js'), js);
    cpSync(path.join(TEMPLATE_JS_DIR, 'icon.svg'), path.join(pluginDir, 'demo', 'icon.svg'));
    mkdirSync(path.join(pluginDir, 'broken'));
    writeFileSync(path.join(pluginDir, 'broken', 'index.js'), "export default { manifest: { id: 'BROKEN' } };");
    mkdirSync(path.join(pluginDir, 'snoop'));
    writeFileSync(
      path.join(pluginDir, 'snoop', 'index.js'),
      "import { readFileSync } from 'node:fs';\nlet secret = 'blocked';\ntry { secret = readFileSync('/etc/hostname', 'utf8'); } catch (e) { secret = 'blocked:' + e.code; }\nexport default { manifest: { id: secret } };",
    );

    app = await buildApp({ config, db, engine, builtins: [template], fetchImpl: fakeFetch });
    admin = await login('admin', 'admin password');
    await as(admin, 'POST', '/api/users', { username: 'bob', password: 'bobs password' });
    bob = await login('bob', 'bobs password');
  });
  after(async () => {
    await app.close();
    db.close();
  });

  test('lists built-in and folder sources; reports broken plugins without crashing', async () => {
    const res = (await as(admin, 'GET', '/api/sources')).json();
    assert.deepEqual(res.sources.map((s: { id: string; kind: string }) => `${s.kind}:${s.id}`), ['builtin:example', 'folder:demo']);
    assert.equal(res.secretKey, 'env');
    const errors = res.pluginErrors.map((e: { location: string; error: string }) => `${path.basename(e.location)}: ${e.error}`).join('\n');
    assert.match(errors, /broken: invalid manifest/);
    assert.match(errors, /snoop: invalid manifest \(id "blocked:ERR_ACCESS_DENIED"\)/, 'the sandbox stopped the plugin reading /etc/hostname');
  });

  test('folder plugin works through its sandboxed process', async () => {
    const cat = (await as(admin, 'GET', '/api/music/catalog/demo/albums')).json();
    assert.equal(cat.metas[0].id, 'demo:album:first-light');
    const t = (await as(admin, 'POST', '/api/sources/demo/test')).json();
    assert.deepEqual(t.ok, true);
    const icon = await as(admin, 'GET', '/sources/demo/icon');
    assert.equal(icon.headers['content-type'], 'image/svg+xml');
  });

  test('built-in sources are served as Stremio addons', async () => {
    const manifest = (await as(admin, 'GET', '/sources/example/manifest.json')).json();
    assert.equal(manifest.id, 'stremio-music.example');
    assert.deepEqual(manifest.types, ['music']);
    const cat = (await as(admin, 'GET', '/sources/example/catalog/music/albums/genre=Ambient.json')).json();
    assert.deepEqual(cat.metas.map((m: { name: string }) => m.name), ['First Light']);
    const meta = (await as(admin, 'GET', `/sources/example/meta/music/${encodeURIComponent('example:album:night-drive')}.json`)).json();
    assert.equal(meta.meta.videos.length, 4);
    assert.equal((await app.inject('/sources/example/manifest.json')).statusCode, 401, 'requires sign-in');
  });

  test('admin settings: secrets masked; users set only their own per-user fields', async () => {
    let r = await as(admin, 'PATCH', '/api/sources/example', { settings: { greeting: 'Kia ora' } });
    assert.equal(r.statusCode, 200, r.body);
    r = await as(bob, 'PUT', '/api/me/sources/example/settings', { token: 'bob-token' });
    assert.equal(r.statusCode, 200, r.body);
    assert.deepEqual(r.json().source.settings.user, { token: { secret: true, set: true } });
    assert.equal(r.json().source.settings.global, undefined, 'users never see global settings');
    assert.equal((await as(bob, 'PUT', '/api/me/sources/example/settings', { greeting: 'x' })).statusCode, 400);
    assert.equal((await as(bob, 'PATCH', '/api/sources/example', { enabled: false })).statusCode, 403);
    const t = (await as(bob, 'POST', '/api/sources/example/test')).json();
    assert.match(t.message, /^Kia ora, bob!/);
    const stored = db.prepare('SELECT settings FROM source_user_settings').get() as { settings: string };
    assert.ok(!stored.settings.includes('bob-token'), 'secret encrypted in the database');
  });

  test('remote addons: added by URL only when they declare "music"', async () => {
    const bad = await as(admin, 'POST', '/api/sources', { url: 'https://addons.test/movies/manifest.json' });
    assert.equal(bad.statusCode, 400);
    assert.match(bad.json().error, /doesn't declare the "music" type/);
    const ok = await as(admin, 'POST', '/api/sources', { url: 'stremio://addons.test/music/manifest.json' });
    assert.equal(ok.statusCode, 200, ok.body);
    assert.equal(ok.json().source.name, 'Remote Music');
    assert.equal((await as(admin, 'POST', '/api/sources', { url: 'https://addons.test/music/manifest.json' })).statusCode, 400, 'no duplicates');
  });

  test('music API aggregates active sources in priority order', async () => {
    const list = (await as(bob, 'GET', '/api/music/sources')).json();
    assert.deepEqual(list.sources.map((s: { id: string }) => s.id).slice(0, 2), ['example', 'demo']);
    const search = (await as(bob, 'GET', '/api/music/search?q=Remote')).json();
    assert.ok(search.results.some((r: { source: { name: string } }) => r.source.name === 'Remote Music'));
    const meta = (await as(bob, 'GET', '/api/music/meta?id=rm:1')).json();
    assert.equal(meta.meta.music.kind, 'album', 'kind derived for third-party metas');
    const streams = (await as(bob, 'GET', '/api/music/streams?id=rm:1:1')).json();
    assert.equal(streams.streams[0].behaviorHints.proxyHeaders, undefined, 'source headers never reach the browser');
    assert.equal(streams.streams[0].behaviorHints.music.needsProxy, true);
    assert.deepEqual(streams.streams[1].behaviorHints.music, { downloadable: false, playOnly: true }, 'YouTube streams are play-only');
    const tracks = (await as(bob, 'GET', `/api/music/streams?id=${encodeURIComponent('example:track:first-light:2')}`)).json();
    assert.equal(tracks.streams[0].source.id, 'example');
  });

  test('disable, reorder, remove', async () => {
    const ids = (await as(admin, 'GET', '/api/sources')).json().sources.map((s: { id: string }) => s.id);
    const reversed = [...ids].reverse();
    assert.equal((await as(admin, 'PUT', '/api/sources/order', { ids: reversed })).statusCode, 200);
    await as(admin, 'PATCH', '/api/sources/demo', { enabled: false });
    const active = (await as(bob, 'GET', '/api/music/sources')).json().sources.map((s: { id: string }) => s.id);
    assert.deepEqual(active, reversed.filter((id: string) => id !== 'demo'));
    assert.equal((await as(admin, 'DELETE', '/api/sources/example')).statusCode, 400, 'built-ins can only be disabled');
    const remoteId = ids.find((id: string) => id.startsWith('addon-'));
    assert.equal((await as(admin, 'DELETE', `/api/sources/${remoteId}`)).statusCode, 200);
  });

  test('reload picks up new folder plugins', async () => {
    mkdirSync(path.join(pluginDir, 'later'));
    const js = readFileSync(path.join(TEMPLATE_JS_DIR, 'index.js'), 'utf8').replace("const ID = 'example';", "const ID = 'later';");
    writeFileSync(path.join(pluginDir, 'later', 'index.js'), js);
    const r = (await as(admin, 'POST', '/api/sources/reload')).json();
    assert.deepEqual(r.loaded.sort(), ['demo', 'later']);
  });
});
