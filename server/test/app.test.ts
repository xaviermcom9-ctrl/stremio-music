import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db.js';
import { fakeEngine, waitFor } from './helpers.js';

describe('app', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'app-test-'));
  const web = path.join(root, 'web');
  mkdirSync(path.join(web, 'abc1234def/scripts'), { recursive: true });
  writeFileSync(path.join(web, 'index.html'), '<!doctype html><title>t</title>');
  writeFileSync(path.join(web, 'abc1234def/scripts/main.js'), 'console.log(1)');
  const config = loadConfig({ CONFIG_DIR: path.join(root, 'config'), CACHE_DIR: path.join(root, 'cache'), WEB_ROOT: web, LOG_LEVEL: 'error', ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: 'admin password' });
  const db = openDb(config.dbPath);
  const { s: engine } = fakeEngine({});
  let app: FastifyInstance;
  let cookie = '';

  before(async () => {
    app = await buildApp({ config, db, engine });
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin', password: 'admin password' } });
    cookie = `sm_session=${res.cookies.find((c) => c.name === 'sm_session')!.value}`;
  });
  after(async () => {
    await engine.stop();
    await app.close();
    db.close();
  });

  test('/health is 503 while the engine is stopped, ok once running', async () => {
    let res = await app.inject('/health');
    assert.equal(res.statusCode, 503);
    assert.equal(res.json().engine.state, 'stopped');
    engine.start();
    await waitFor(engine, 'running');
    res = await app.inject('/health');
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().status, 'ok');
    assert.equal(res.json().db, 'ok');
  });

  test('proxies /engine/* to the engine and rewrites self-referencing URLs', async () => {
    const mediaURL = 'http://music.lan:8095/engine/abc/1';
    const res = await app.inject({ url: `/engine/hlsv2/probe?mediaURL=${encodeURIComponent(mediaURL)}`, headers: { host: 'music.lan:8095', cookie } });
    assert.equal(res.statusCode, 200, res.body);
    const echoed = new URL(res.json().path, 'http://x');
    assert.equal(echoed.pathname, '/hlsv2/probe');
    assert.equal(echoed.searchParams.get('mediaURL'), `${engine.url}abc/1`);
  });

  test('/engine/* is 503 while the engine is down', async () => {
    await engine.stop();
    const res = await app.inject({ url: '/engine/heartbeat', headers: { cookie } });
    assert.equal(res.statusCode, 503);
  });

  test('per-user prefs: set, read back, validated', async () => {
    const put = (key: string, payload: unknown) => app.inject({ method: 'PUT', url: `/api/me/prefs/${key}`, headers: { cookie }, payload: payload as object });
    assert.equal((await put('mode', { value: 'music' })).statusCode, 200);
    assert.equal((await put('mode', { value: 'movies' })).statusCode, 200);
    assert.equal((await put('player.volume', { value: 0.5 })).statusCode, 200);
    assert.equal((await put('Bad-Key', { value: 1 })).statusCode, 400);
    assert.equal((await put('big', { value: 'x'.repeat(20000) })).statusCode, 413);
    const res = await app.inject({ url: '/api/me/prefs', headers: { cookie } });
    assert.deepEqual(res.json(), { prefs: { mode: 'movies', 'player.volume': 0.5 } });
    assert.equal((await app.inject('/api/me/prefs')).statusCode, 401);
  });

  test('serves the UI with cache headers', async () => {
    const anon = await app.inject({ url: '/', headers: { accept: 'text/html' } });
    assert.equal(anon.statusCode, 302);
    const index = await app.inject({ url: '/', headers: { cookie } });
    assert.equal(index.statusCode, 200);
    assert.equal(index.headers['cache-control'], 'no-cache');
    const js = await app.inject({ url: '/abc1234def/scripts/main.js', headers: { cookie } });
    assert.match(String(js.headers['cache-control']), /immutable/);
  });
});
