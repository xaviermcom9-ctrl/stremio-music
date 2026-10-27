import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import Fastify, { type FastifyInstance, type LightMyRequestResponse } from 'fastify';
import { AUTH_REQUIRED_HEADER, registerAuth, relativeTo, safeNext, SESSION_COOKIE } from '../src/auth/plugin.js';
import { hashPassword, verifyPassword } from '../src/auth/password.js';
import { AuthStore } from '../src/auth/store.js';
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db.js';

const ADMIN = { username: 'admin', password: 'correct horse battery' };

async function makeApp(env: Record<string, string> = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'auth-test-'));
  const config = loadConfig({
    CONFIG_DIR: dir,
    ADMIN_USERNAME: ADMIN.username,
    ADMIN_PASSWORD: ADMIN.password,
    ...env,
  });
  const db = openDb(config.dbPath);
  const store = new AuthStore(db, config.auth.sessionTtlMs);
  const app = Fastify({ trustProxy: config.trustedProxies.length ? config.trustedProxies : false });
  const { setupCode } = await registerAuth(app, { config, store });
  app.get('/', async () => 'app shell');
  app.get('/engine/heartbeat', async () => ({ ok: true }));
  app.get('/api/private', async (req) => ({ user: req.user?.username }));
  app.post('/api/private', async () => ({ ok: true }));
  await app.ready();
  return { app, store, db, setupCode };
}

const sessionCookie = (res: LightMyRequestResponse) => res.cookies.find((c) => c.name === SESSION_COOKIE);

async function login(app: FastifyInstance, creds = ADMIN): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: creds });
  assert.equal(res.statusCode, 200, res.body);
  return sessionCookie(res)!.value;
}

const withSession = (token: string) => ({ cookie: `${SESSION_COOKIE}=${token}` });

describe('passwords', () => {
  test('scrypt hash round-trip', async () => {
    const h = await hashPassword('hunter2hunter2');
    assert.match(h, /^scrypt\$32768\$8\$1\$/);
    assert.equal(await verifyPassword('hunter2hunter2', h), true);
    assert.equal(await verifyPassword('hunter2hunter3', h), false);
  });
});

describe('helpers', () => {
  test('relativeTo works at any depth (sub-path safe)', () => {
    const req = (url: string) => ({ url }) as Parameters<typeof relativeTo>[0];
    assert.equal(relativeTo(req('/'), 'login'), './login');
    assert.equal(relativeTo(req('/account?x=1'), 'login'), './login');
    assert.equal(relativeTo(req('/engine/abc/0'), 'login'), '../../login');
  });
  test('safeNext only allows app-relative paths', () => {
    assert.equal(safeNext('/account'), '/account');
    assert.equal(safeNext('//evil.com'), '/');
    assert.equal(safeNext('/\\evil.com'), '/');
    assert.equal(safeNext('https://evil.com'), '/');
  });
});

describe('local auth', () => {
  test('anonymous: pages redirect to login, API calls get 401', async () => {
    const { app } = await makeApp();
    let res = await app.inject({ url: '/', headers: { accept: 'text/html' } });
    assert.equal(res.statusCode, 302);
    assert.equal(res.headers.location, './login?next=%2F');
    res = await app.inject({ url: '/api/private' });
    assert.equal(res.statusCode, 401);
    assert.equal(res.headers[AUTH_REQUIRED_HEADER], '1');
    res = await app.inject({ url: '/engine/heartbeat' });
    assert.equal(res.statusCode, 401);
  });

  test('public paths stay public', async () => {
    const { app } = await makeApp();
    for (const url of ['/login', '/auth/auth.js', '/auth/auth.css', '/api/auth/state']) {
      const res = await app.inject({ url });
      assert.equal(res.statusCode, 200, url);
    }
    const state = (await app.inject('/api/auth/state')).json();
    assert.deepEqual(state, { mode: 'local', setupRequired: false, user: null });
    const page = await app.inject('/login');
    assert.match(String(page.headers['content-security-policy']), /script-src 'self'/);
  });

  test('login sets a secure-by-default session cookie and grants access', async () => {
    const { app } = await makeApp();
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: ADMIN });
    const c = sessionCookie(res)!;
    assert.equal(c.httpOnly, true);
    assert.equal(c.sameSite, 'Lax');
    assert.equal(c.path, '/');
    assert.ok(c.expires! > new Date(Date.now() + 29 * 86400e3));
    const me = await app.inject({ url: '/api/private', headers: withSession(c.value) });
    assert.deepEqual(me.json(), { user: 'admin' });
  });

  test('wrong password and unknown user give the same answer', async () => {
    const { app } = await makeApp();
    const a = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin', password: 'nope-nope' } });
    const b = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'ghost', password: 'nope-nope' } });
    assert.equal(a.statusCode, 401);
    assert.deepEqual(a.json(), b.json());
  });

  test('locks a username after 5 failures', async () => {
    const { app } = await makeApp();
    for (let i = 0; i < 5; i++) {
      await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin', password: 'wrong-' + i } });
    }
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: ADMIN });
    assert.equal(res.statusCode, 429);
  });

  test('rate-limits login attempts per IP', async () => {
    const { app } = await makeApp();
    const codes: number[] = [];
    for (let i = 0; i < 11; i++) {
      const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: `u${i}`, password: 'whatever1' } });
      codes.push(res.statusCode);
    }
    assert.equal(codes.at(-1), 429);
  });

  test('logout ends the session', async () => {
    const { app } = await makeApp();
    const token = await login(app);
    await app.inject({ method: 'POST', url: '/api/auth/logout', headers: withSession(token) });
    const res = await app.inject({ url: '/api/private', headers: withSession(token) });
    assert.equal(res.statusCode, 401);
  });

  test('cross-origin writes are refused', async () => {
    const { app } = await makeApp();
    const token = await login(app);
    const evil = await app.inject({ method: 'POST', url: '/api/private', headers: { ...withSession(token), origin: 'http://evil.example', host: 'music.lan:8095' } });
    assert.equal(evil.statusCode, 403);
    const site = await app.inject({ method: 'POST', url: '/api/private', headers: { ...withSession(token), 'sec-fetch-site': 'cross-site' } });
    assert.equal(site.statusCode, 403);
    const ok = await app.inject({ method: 'POST', url: '/api/private', headers: { ...withSession(token), origin: 'http://music.lan:8095', host: 'music.lan:8095' } });
    assert.equal(ok.statusCode, 200);
  });

  test('changing the password signs out other sessions', async () => {
    const { app } = await makeApp();
    const phone = await login(app);
    const laptop = await login(app);
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/password',
      headers: withSession(laptop),
      payload: { current: ADMIN.password, password: 'a brand new password' },
    });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal((await app.inject({ url: '/api/private', headers: withSession(laptop) })).statusCode, 200);
    assert.equal((await app.inject({ url: '/api/private', headers: withSession(phone) })).statusCode, 401);
  });

  test('expired sessions are rejected', async () => {
    const { app, store, db } = await makeApp();
    const user = store.findUser('admin')!;
    let now = Date.now();
    const short = new AuthStore(db, 1000, () => now);
    const s = short.createSession(user.id, {});
    now += 2000;
    assert.equal(short.getSession(s.token), null);
    assert.equal((await app.inject({ url: '/api/private', headers: withSession(s.token) })).statusCode, 401);
  });

  test('user admin: only admins, and never remove the last admin', async () => {
    const { app } = await makeApp();
    const admin = await login(app);
    const created = await app.inject({ method: 'POST', url: '/api/users', headers: withSession(admin), payload: { username: 'bob', password: 'bobs password' } });
    assert.equal(created.statusCode, 200, created.body);
    const bob = await login(app, { username: 'bob', password: 'bobs password' });
    assert.equal((await app.inject({ url: '/api/users', headers: withSession(bob) })).statusCode, 403);
    const adminId = (await app.inject({ url: '/api/auth/state', headers: withSession(admin) })).json().user.id;
    const demote = await app.inject({ method: 'PATCH', url: `/api/users/${adminId}`, headers: withSession(admin), payload: { isAdmin: false } });
    assert.equal(demote.statusCode, 409);
    const bobId = created.json().user.id;
    await app.inject({ method: 'PATCH', url: `/api/users/${bobId}`, headers: withSession(admin), payload: { disabled: true } });
    assert.equal((await app.inject({ url: '/api/private', headers: withSession(bob) })).statusCode, 401);
  });

  test('cookies are Secure behind an HTTPS proxy, scoped to its sub-path', async () => {
    const { app } = await makeApp({ TRUSTED_PROXIES: '127.0.0.1' });
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: ADMIN,
      headers: { 'x-forwarded-proto': 'https', 'x-forwarded-prefix': '/stremio' },
    });
    const c = sessionCookie(res)!;
    assert.equal(c.secure, true);
    assert.equal(c.path, '/stremio/');
  });

  test('X-Forwarded-* from untrusted clients is ignored', async () => {
    const { app } = await makeApp();
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: ADMIN, headers: { 'x-forwarded-proto': 'https', 'x-forwarded-prefix': '/x' } });
    const c = sessionCookie(res)!;
    assert.equal(c.secure, undefined);
    assert.equal(c.path, '/');
  });
});

describe('first-run setup', () => {
  test('needs the logged setup code, creates an admin once', async () => {
    const { app, setupCode } = await makeApp({ ADMIN_USERNAME: '', ADMIN_PASSWORD: '' });
    assert.match(setupCode!, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    const nav = await app.inject({ url: '/', headers: { accept: 'text/html' } });
    assert.equal(nav.headers.location, './setup');
    const bad = await app.inject({ method: 'POST', url: '/api/auth/setup', payload: { code: 'AAAA-AAAA', username: 'me', password: 'long enough pw' } });
    assert.equal(bad.statusCode, 401);
    const weak = await app.inject({ method: 'POST', url: '/api/auth/setup', payload: { code: setupCode, username: 'me', password: 'short' } });
    assert.equal(weak.statusCode, 400);
    const ok = await app.inject({ method: 'POST', url: '/api/auth/setup', payload: { code: setupCode!.toLowerCase(), username: 'me', password: 'long enough pw' } });
    assert.equal(ok.statusCode, 200, ok.body);
    assert.equal(ok.json().user.isAdmin, true);
    assert.ok(sessionCookie(ok));
    const again = await app.inject({ method: 'POST', url: '/api/auth/setup', payload: { code: setupCode, username: 'x', password: 'long enough pw' } });
    assert.equal(again.statusCode, 409);
  });
});

describe('proxy auth mode', () => {
  test('refuses to start without TRUSTED_PROXIES', () => {
    assert.throws(() => loadConfig({ AUTH_MODE: 'proxy' }), /TRUSTED_PROXIES/);
  });

  test('trusts the user header only from the proxy', async () => {
    const { app, store } = await makeApp({ AUTH_MODE: 'proxy', TRUSTED_PROXIES: '172.16.0.0/12' });
    const direct = await app.inject({ url: '/api/private', remoteAddress: '192.168.0.50', headers: { 'remote-user': 'admin' } });
    assert.equal(direct.statusCode, 403);
    const viaProxy = await app.inject({ url: '/api/private', remoteAddress: '172.18.0.5', headers: { 'remote-user': 'alice' } });
    assert.deepEqual(viaProxy.json(), { user: 'alice' });
    assert.equal(store.findUser('alice')!.isAdmin, true, 'first proxy user becomes admin');
    await app.inject({ url: '/api/private', remoteAddress: '172.18.0.5', headers: { 'remote-user': 'bob' } });
    assert.equal(store.findUser('bob')!.isAdmin, false);
    const noHeader = await app.inject({ url: '/api/private', remoteAddress: '172.18.0.5' });
    assert.equal(noHeader.statusCode, 401);
    const health = await app.inject({ url: '/health', remoteAddress: '192.168.0.50' });
    assert.notEqual(health.statusCode, 403);
  });
});
