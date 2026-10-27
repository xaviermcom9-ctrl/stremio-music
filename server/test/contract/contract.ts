// The contract every music source must pass (built-in or folder plugin): `npm run test:sources`.
// Calls go through SourceRuntime, exactly as the server makes them. Outbound requests are answered
// from the source's recorded fixtures.json, so the suite runs offline and in `docker build`.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import type { MusicMeta, MusicSource, SourceContext } from '../../src/music-sources/sdk.js';
import { validateManifest } from '../../src/music/protocol/manifest.js';
import { ResponseCache, SourceRuntime, toStremioManifest, validateSourceManifest } from '../../src/music/runtime.js';

export interface Fixtures {
  /** settings to run with (in addition to defaults) */
  settings?: Record<string, string | number | boolean>;
  /** query parameters left out of the keys below (random salts, tokens…) */
  ignoreParams?: string[];
  /** "GET https://host/path?query" -> response */
  responses?: Record<string, { status?: number; headers?: Record<string, string>; body: unknown }>;
}

/** The fixture key for a request: method + URL without the ignored query parameters. */
export function fixtureKey(method: string | undefined, url: string, ignore: string[] = []): string {
  const u = new URL(url);
  for (const p of ignore) u.searchParams.delete(p);
  return `${(method ?? 'GET').toUpperCase()} ${u.href}`;
}

export function loadFixtures(dir: string | null): Fixtures {
  const file = dir && path.join(dir, 'fixtures.json');
  return file && existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Fixtures) : {};
}

/** fetch() that only answers from fixtures and records what was asked. */
export function fixtureFetch(fixtures: Fixtures, missed: string[]): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const key = fixtureKey(init?.method, url, fixtures.ignoreParams);
    const hit = fixtures.responses?.[key];
    if (!hit) {
      missed.push(key);
      throw new Error(`no fixture for ${key}`);
    }
    const body = typeof hit.body === 'string' ? hit.body : JSON.stringify(hit.body);
    const res = new Response(body, { status: hit.status ?? 200, headers: hit.headers ?? { 'content-type': 'application/json' } });
    Object.defineProperty(res, 'url', { value: url });
    return res;
  }) as typeof fetch;
}

/**
 * Real fetch that records every response into `fixtures` (for `test:sources -- --record <id>`).
 * Only text responses are recorded; sources should use ctx.proxyUrl for media.
 */
export function recordingFetch(fixtures: Fixtures): typeof fetch {
  fixtures.responses ??= {};
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const res = await fetch(input as string, init);
    const url = res.url || String(input);
    const text = await res.text();
    const type = res.headers.get('content-type') ?? '';
    let body: unknown = text;
    if (type.includes('json')) {
      try {
        body = JSON.parse(text);
      } catch {
        // keep as text
      }
    }
    fixtures.responses![fixtureKey(init?.method, String(input instanceof Request ? input.url : input), fixtures.ignoreParams)] = {
      status: res.status,
      headers: { 'content-type': type || 'text/plain' },
      body,
    };
    const copy = new Response(text, { status: res.status, headers: res.headers });
    Object.defineProperty(copy, 'url', { value: url });
    return copy;
  }) as typeof fetch;
}

const USER: SourceContext['user'] = { id: 1, username: 'contract' };

/** Registers the contract suite for one source. `dir` locates fixtures.json. */
export function contractSuite(
  label: string,
  load: () => Promise<{ impl: MusicSource; dir: string | null; close?: () => void }>,
  opts: { record?: boolean } = {},
): void {
  describe(`source contract: ${label}`, () => {
    let rt: SourceRuntime;
    let impl: MusicSource;
    const missed: string[] = [];
    let close: (() => void) | undefined;
    let fixtures: Fixtures = {};
    let dir: string | null = null;
    let secrets: string[] = [];

    test('loads and has a valid manifest', async () => {
      const loaded = await load();
      impl = loaded.impl;
      close = loaded.close;
      const v = validateSourceManifest(impl.manifest);
      assert.ok(v.ok, v.ok ? '' : v.errors.join('\n'));
      dir = loaded.dir;
      fixtures = loadFixtures(loaded.dir);
      if (opts.record) fixtures.responses = {};
      const defaults = Object.fromEntries(Object.entries(impl.manifest.settings).map(([k, f]) => [k, f.default]));
      // recording with real credentials: SOURCE_SETTINGS='{"clientId":"…"}' (never written to fixtures)
      const live = opts.record && process.env.SOURCE_SETTINGS ? (JSON.parse(process.env.SOURCE_SETTINGS) as Record<string, string>) : {};
      secrets = Object.entries(live)
        .filter(([k]) => impl.manifest.settings[k]?.secret)
        .map(([, v]) => String(v))
        .filter((v) => v.length >= 4);
      rt = new SourceRuntime(impl, {
        perUser: false,
        cache: new ResponseCache(100),
        fetchImpl: opts.record ? recordingFetch(fixtures) : fixtureFetch(fixtures, missed),
        settingsFor: () => ({ ...defaults, ...fixtures.settings, ...live }),
        makeProxyUrl: (url) => `api/proxy/test-${Buffer.from(url).toString('base64url').slice(0, 24)}`,
      });
    });

    test('serves a valid Stremio addon manifest of type "music"', () => {
      const m = toStremioManifest(impl.manifest);
      const v = validateManifest(m);
      assert.ok(v.valid, v.errors.join('\n'));
      assert.deepEqual(m.types, ['music']);
      for (const c of m.catalogs) assert.equal(c.type, 'music');
    });

    test('implements what its capabilities promise', () => {
      const caps = impl.manifest.capabilities;
      if (caps.catalogs) assert.equal(typeof impl.catalog, 'function', 'capabilities.catalogs needs catalog()');
      if (caps.meta) assert.equal(typeof impl.meta, 'function', 'capabilities.meta needs meta()');
      if (caps.streams) assert.equal(typeof impl.streams, 'function', 'capabilities.streams needs streams()');
    });

    const metas: MusicMeta[] = [];

    test('feed catalogs return valid items with prefixed ids', async () => {
      const feeds = impl.manifest.catalogs.filter((c) => !c.extra?.some((e) => e.isRequired));
      let total = 0;
      for (const c of feeds) {
        const items = await rt.catalog(USER, c.id, {});
        assert.equal(rt.stats.invalidItems, 0, `catalog ${c.id} returned invalid items:\n${rt.logs.join('\n')}`);
        for (const item of items) {
          assert.ok(item.id.startsWith(`${impl.manifest.id}:`), `id ${item.id} must start with "${impl.manifest.id}:"`);
          if (c.kind) assert.equal(item.music.kind, c.kind, `catalog ${c.id} declares kind ${c.kind}`);
        }
        total += items.length;
        if (items[0] && impl.meta) {
          const meta = await rt.meta(USER, items[0].id);
          assert.ok(meta, `meta for ${items[0].id} (first item of ${c.id}) returned null`);
          metas.push(meta);
        }
      }
      if (feeds.length) assert.ok(total > 0, 'every feed catalog was empty; fixtures should include at least one item');
    });

    test('search finds something', async (t) => {
      if (!impl.manifest.capabilities.search) return t.skip('no search');
      const searchable = impl.manifest.catalogs.filter((c) => c.extra?.some((e) => e.name === 'search'));
      const term = (metas[0]?.name ?? 'a').split(/\s+/)[0]!;
      for (const c of searchable) {
        const items = await rt.catalog(USER, c.id, { search: term });
        assert.equal(rt.stats.invalidItems, 0, rt.logs.join('\n'));
        assert.ok(Array.isArray(items));
      }
    });

    test('meta round-trips: ids, kind, tracks', async () => {
      for (const meta of metas) {
        assert.ok(meta.id.startsWith(`${impl.manifest.id}:`));
        assert.equal(meta.type, 'music');
        if (meta.videos) {
          const ids = meta.videos.map((v) => v.id);
          assert.equal(new Set(ids).size, ids.length, `duplicate track ids in ${meta.id}`);
          for (const id of ids) assert.ok(id.startsWith(`${impl.manifest.id}:`), `track id ${id} must be prefixed`);
        }
      }
      if (impl.meta) assert.equal(await rt.meta(USER, `${impl.manifest.id}:does-not-exist`), null, 'unknown ids must return null');
    });

    test('streams are valid and match the capabilities', async (t) => {
      const caps = impl.manifest.capabilities;
      if (!caps.streams) return t.skip('no streams');
      // a track to play: an album's first track, or a track/station meta itself (artists have no streams)
      const targets = metas
        .flatMap((m) => (m.videos?.length ? [m.videos[0]!.id] : m.music.kind === 'track' || m.music.kind === 'station' ? [m.id] : []))
        .slice(0, 3);
      assert.ok(targets.length > 0, 'no track to request streams for');
      for (const id of targets) {
        const streams = await rt.streams(USER, id);
        assert.equal(rt.stats.invalidItems, 0, rt.logs.join('\n'));
        assert.ok(streams.length > 0, `no streams for ${id}`);
        for (const s of streams) {
          const hints = s.behaviorHints?.music;
          if (hints?.downloadable) assert.ok(caps.downloadable, 'stream marked downloadable but the source is not');
          if (hints?.live) {
            assert.ok(caps.live, 'stream marked live but the source is not');
            assert.ok(!hints.downloadable, 'live streams cannot be downloadable');
          }
          if (s.url) assert.match(s.url, /^(https?:\/\/|api\/proxy\/)/, 'stream url must be http(s) or a proxy URL');
        }
      }
      assert.deepEqual(await rt.streams(USER, `${impl.manifest.id}:does-not-exist`), [], 'unknown ids must return []');
    });

    test('test() reports a result', async () => {
      const r = await rt.test(USER);
      assert.equal(typeof r.ok, 'boolean');
      assert.equal(typeof r.message, 'string');
      assert.ok(r.ok, `test() failed: ${r.message}`);
    });

    test('made no requests without fixtures', () => {
      close?.();
      if (opts.record && dir) {
        // secrets can be echoed back in responses (e.g. in media URLs): never write them to git
        let json = JSON.stringify(fixtures, null, 2) + '\n';
        for (const s of secrets) json = json.split(s).join('FIXTURE');
        writeFileSync(path.join(dir, 'fixtures.json'), json);
        console.log(`recorded ${Object.keys(fixtures.responses ?? {}).length} responses into ${path.join(dir, 'fixtures.json')}`);
      }
      assert.deepEqual(missed, [], 'record these in fixtures.json');
    });
  });
}
