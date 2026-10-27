import { randomInt, timingSafeEqual } from 'node:crypto';
import { BlockList, isIP } from 'node:net';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Config } from '../config.js';
import { AUTH_CSS, AUTH_JS, accountPage, loginPage, setupPage } from './pages.js';
import { passwordProblem, USERNAME_RE } from './password.js';
import type { AuthStore, User } from './store.js';

declare module 'fastify' {
  interface FastifyRequest {
    user: User | null;
    sessionId: string | null;
  }
}

export const SESSION_COOKIE = 'sm_session';
/** set on 401s so the UI's fetch guard knows to send the user to the login page */
export const AUTH_REQUIRED_HEADER = 'x-auth-required';

/** reachable without logging in */
const PUBLIC_EXACT = new Set(['/health', '/login', '/setup', '/manifest.json', '/api/auth/state', '/api/auth/login', '/api/auth/setup']);
// PWA icons and fonts used by the login page; nothing private lives under these
const PUBLIC_PREFIXES = ['/auth/', '/favicons/', '/images/', '/fonts/'];

const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const LOCKOUT_FAILURES = 5;
const LOCKOUT_WINDOW_MS = 15 * 60 * 1000;

export function makeBlockList(entries: string[]): BlockList {
  const bl = new BlockList();
  for (const e of entries) {
    const [addr, bits] = e.split('/');
    const type = isIP(addr!) === 6 ? 'ipv6' : 'ipv4';
    if (!isIP(addr!)) throw new Error(`TRUSTED_PROXIES: invalid address "${e}"`);
    if (bits !== undefined) bl.addSubnet(addr!, Number(bits), type);
    else bl.addAddress(addr!, type);
  }
  return bl;
}

function addressMatches(bl: BlockList, address: string | undefined): boolean {
  if (!address) return false;
  const v4mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (v4mapped) return bl.check(v4mapped[1]!, 'ipv4');
  return bl.check(address, isIP(address) === 6 ? 'ipv6' : 'ipv4');
}

/** Relative URL from the request's path to an app-root path, so redirects work under any sub-path. */
export function relativeTo(req: FastifyRequest, target: string): string {
  const path = req.url.split('?')[0]!;
  const depth = path.split('/').length - 2;
  return (depth > 0 ? '../'.repeat(depth) : './') + target;
}

export function safeNext(next: unknown): string {
  return typeof next === 'string' && /^\/(?![/\\])[^\\\s]*$/.test(next) && next.length < 2048 ? next : '/';
}

function isNavigation(req: FastifyRequest): boolean {
  return req.method === 'GET' && (req.headers['sec-fetch-mode'] === 'navigate' || String(req.headers.accept ?? '').includes('text/html'));
}

function generateSetupCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const pick = () => Array.from({ length: 4 }, () => alphabet[randomInt(alphabet.length)]).join('');
  return `${pick()}-${pick()}`;
}

const Credentials = z.object({ username: z.string().min(1).max(64), password: z.string().min(1).max(256) });
const NewUser = z.object({
  username: z.string().regex(USERNAME_RE, 'Letters, digits and . _ @ - only (max 64).'),
  password: z.string(),
  isAdmin: z.boolean().default(false),
});

export interface AuthOptions {
  config: Config;
  store: AuthStore;
}

export async function registerAuth(app: FastifyInstance, { config, store }: AuthOptions): Promise<{ setupCode: string | null }> {
  const { auth } = config;
  const trusted = makeBlockList(config.trustedProxies);
  const fromTrustedProxy = (req: FastifyRequest) => addressMatches(trusted, req.socket.remoteAddress);
  const failures = new Map<string, { count: number; first: number }>();

  // first admin: from env, else a one-time setup code printed to the log
  let setupCode: string | null = null;
  if (auth.mode === 'local' && store.countUsers() === 0) {
    if (auth.adminUsername && auth.adminPassword) {
      const problem = passwordProblem(auth.adminPassword);
      if (problem) throw new Error(`ADMIN_PASSWORD: ${problem}`);
      await store.createUser(auth.adminUsername, auth.adminPassword, true);
      app.log.info({ username: auth.adminUsername }, 'created admin account from ADMIN_USERNAME/ADMIN_PASSWORD');
    } else {
      setupCode = generateSetupCode();
      app.log.warn(`No accounts yet. Open <this app>/setup and enter the setup code ${setupCode} to create the admin account.`);
    }
  }
  const setupRequired = () => setupCode !== null && store.countUsers() === 0;

  await app.register(cookie);
  await app.register(rateLimit, { global: false });
  app.decorateRequest('user', null);
  app.decorateRequest('sessionId', null);

  function cookiePath(req: FastifyRequest): string {
    const prefix = req.headers['x-forwarded-prefix'];
    if (typeof prefix === 'string' && fromTrustedProxy(req) && /^\/[^;,\s]*$/.test(prefix)) {
      return prefix.endsWith('/') ? prefix : `${prefix}/`;
    }
    return '/';
  }

  function setSessionCookie(req: FastifyRequest, reply: FastifyReply, token: string, expiresAt: number): void {
    reply.setCookie(SESSION_COOKIE, token, {
      path: cookiePath(req),
      httpOnly: true,
      sameSite: 'lax',
      secure: auth.cookieSecure === 'auto' ? req.protocol === 'https' : auth.cookieSecure === 'true',
      expires: new Date(expiresAt),
    });
  }

  async function proxyUser(req: FastifyRequest): Promise<User | null> {
    const raw = req.headers[auth.proxyUserHeader];
    const name = (Array.isArray(raw) ? raw[0] : raw)?.trim();
    if (!name || !USERNAME_RE.test(name)) return null;
    const existing = store.findUser(name);
    const wantAdmin = auth.proxyAdminUsers.includes(name.toLowerCase());
    if (existing) {
      if (wantAdmin && !existing.isAdmin) store.updateUser(existing.id, { isAdmin: true });
      return existing.disabled ? null : (store.getUser(existing.id) ?? null);
    }
    // with no PROXY_ADMIN_USERS, the first user the proxy sends becomes admin
    const isAdmin = wantAdmin || (auth.proxyAdminUsers.length === 0 && store.countUsers() === 0);
    app.log.info({ username: name, isAdmin }, 'created account for proxy-authenticated user');
    return store.createUser(name, null, isAdmin);
  }

  app.addHook('onRequest', async (req, reply) => {
    const path = req.url.split('?')[0]!;

    // CSRF: state-changing requests must come from our own pages
    if (UNSAFE.has(req.method)) {
      const origin = req.headers.origin;
      if (origin) {
        let host: string | null = null;
        try {
          host = new URL(origin).host.toLowerCase();
        } catch {
          // fall through: invalid Origin
        }
        const own = [req.headers.host, fromTrustedProxy(req) ? req.headers['x-forwarded-host'] : undefined]
          .flatMap((h) => (typeof h === 'string' ? h.split(',') : []))
          .map((h) => h.trim().toLowerCase());
        if (!host || !own.includes(host)) return reply.code(403).send({ error: 'cross-origin request refused' });
      } else if (req.headers['sec-fetch-site'] === 'cross-site') {
        return reply.code(403).send({ error: 'cross-origin request refused' });
      }
    }

    if (auth.mode === 'proxy') {
      if (path === '/health') return;
      if (!fromTrustedProxy(req)) {
        return reply.code(403).send({ error: 'direct access refused: this instance only accepts requests from its reverse proxy' });
      }
      req.user = await proxyUser(req);
      if (!req.user) return reply.code(401).header(AUTH_REQUIRED_HEADER, '1').send({ error: 'no user from the reverse proxy' });
      return;
    }

    const token = req.cookies[SESSION_COOKIE];
    if (token) {
      const session = store.getSession(token);
      if (session) {
        req.user = session.user;
        req.sessionId = session.id;
        if (session.refreshed) setSessionCookie(req, reply, token, session.expiresAt);
      } else {
        reply.clearCookie(SESSION_COOKIE, { path: cookiePath(req) });
      }
    }

    if (req.user || PUBLIC_EXACT.has(path) || PUBLIC_PREFIXES.some((p) => path.startsWith(p))) return;

    if (isNavigation(req)) {
      if (setupRequired()) return reply.redirect(relativeTo(req, 'setup'));
      return reply.redirect(`${relativeTo(req, 'login')}?next=${encodeURIComponent(req.url)}`);
    }
    return reply.code(401).header(AUTH_REQUIRED_HEADER, '1').send({ error: 'login required' });
  });

  const requireAdmin = async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.user?.isAdmin) return reply.code(403).send({ error: 'admin only' });
  };

  const page = (reply: FastifyReply, html: string) =>
    reply
      .type('text/html; charset=utf-8')
      .header('cache-control', 'no-store')
      .header(
        'content-security-policy',
        "default-src 'none'; style-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self'; font-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
      )
      .send(html);

  app.get('/auth/auth.css', async (_req, reply) => reply.type('text/css').header('cache-control', 'no-cache').send(AUTH_CSS));
  app.get('/auth/auth.js', async (_req, reply) => reply.type('text/javascript').header('cache-control', 'no-cache').send(AUTH_JS));

  app.get('/login', async (req, reply) => {
    if (auth.mode === 'proxy' || req.user) return reply.redirect('./');
    if (setupRequired()) return reply.redirect('./setup');
    return page(reply, loginPage());
  });

  app.get('/setup', async (req, reply) => {
    if (!setupRequired()) return reply.redirect('./login');
    return page(reply, setupPage());
  });

  app.get('/account', async (req, reply) => page(reply, accountPage(auth.mode)));

  app.get('/api/auth/state', async (req) => ({
    mode: auth.mode,
    setupRequired: setupRequired(),
    user: req.user,
  }));

  const loginLimit = { config: { rateLimit: { max: 10, timeWindow: '15 minutes' } } };

  app.post('/api/auth/login', loginLimit, async (req, reply) => {
    if (auth.mode !== 'local') return reply.code(404).send({ error: 'not available' });
    const body = Credentials.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'Enter a username and password.' });
    const key = body.data.username.toLowerCase();
    const now = Date.now();
    const f = failures.get(key);
    if (f && now - f.first < LOCKOUT_WINDOW_MS && f.count >= LOCKOUT_FAILURES) {
      return reply.code(429).send({ error: 'Too many failed attempts. Try again in 15 minutes.' });
    }
    const user = await store.checkPassword(body.data.username, body.data.password);
    if (!user) {
      const entry = f && now - f.first < LOCKOUT_WINDOW_MS ? f : { count: 0, first: now };
      entry.count++;
      failures.set(key, entry);
      req.log.warn({ username: body.data.username, ip: req.ip }, 'failed login');
      return reply.code(401).send({ error: 'Wrong username or password.' });
    }
    failures.delete(key);
    const session = store.createSession(user.id, { userAgent: req.headers['user-agent'], ip: req.ip });
    setSessionCookie(req, reply, session.token, session.expiresAt);
    req.log.info({ username: user.username, ip: req.ip }, 'login');
    return { ok: true, user };
  });

  app.post('/api/auth/setup', loginLimit, async (req, reply) => {
    if (!setupRequired() || !setupCode) return reply.code(409).send({ error: 'Setup is already complete.' });
    const body = NewUser.extend({ code: z.string() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.issues[0]?.message ?? 'Invalid input.' });
    const given = Buffer.from(body.data.code.trim().toUpperCase());
    const expected = Buffer.from(setupCode);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      req.log.warn({ ip: req.ip }, 'wrong setup code');
      return reply.code(401).send({ error: 'Wrong setup code. It is printed in the container log.' });
    }
    const problem = passwordProblem(body.data.password);
    if (problem) return reply.code(400).send({ error: problem });
    const user = await store.createUser(body.data.username, body.data.password, true);
    setupCode = null;
    const session = store.createSession(user.id, { userAgent: req.headers['user-agent'], ip: req.ip });
    setSessionCookie(req, reply, session.token, session.expiresAt);
    app.log.info({ username: user.username }, 'admin account created via setup');
    return { ok: true, user };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    if (req.sessionId) store.deleteSession(req.sessionId);
    reply.clearCookie(SESSION_COOKIE, { path: cookiePath(req) });
    return { ok: true };
  });

  app.post('/api/auth/password', loginLimit, async (req, reply) => {
    if (auth.mode !== 'local' || !req.user) return reply.code(404).send({ error: 'not available' });
    const body = z.object({ current: z.string(), password: z.string() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'Invalid input.' });
    if (!(await store.checkPassword(req.user.username, body.data.current))) {
      return reply.code(401).send({ error: 'Current password is wrong.' });
    }
    const problem = passwordProblem(body.data.password);
    if (problem) return reply.code(400).send({ error: problem });
    await store.setPassword(req.user.id, body.data.password, req.sessionId ?? undefined);
    return { ok: true };
  });

  app.get('/api/users', { preHandler: requireAdmin }, async () => ({ users: store.listUsers() }));

  app.post('/api/users', { preHandler: requireAdmin }, async (req, reply) => {
    const body = NewUser.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.issues[0]?.message ?? 'Invalid input.' });
    if (store.findUser(body.data.username)) return reply.code(409).send({ error: 'That username is taken.' });
    let password: string | null = body.data.password;
    if (auth.mode === 'proxy') password = null;
    else {
      const problem = passwordProblem(body.data.password);
      if (problem) return reply.code(400).send({ error: problem });
    }
    return { user: await store.createUser(body.data.username, password, body.data.isAdmin) };
  });

  app.patch<{ Params: { id: string } }>('/api/users/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const target = store.getUser(Number(req.params.id));
    if (!target) return reply.code(404).send({ error: 'No such user.' });
    const body = z.object({ isAdmin: z.boolean().optional(), disabled: z.boolean().optional(), password: z.string().optional() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'Invalid input.' });
    const { isAdmin, disabled, password } = body.data;
    const losesAdmin = target.isAdmin && !target.disabled && (isAdmin === false || disabled === true);
    if (losesAdmin && store.countActiveAdmins() <= 1) return reply.code(409).send({ error: 'There must be at least one admin.' });
    if (password !== undefined) {
      if (auth.mode !== 'local') return reply.code(400).send({ error: 'Passwords are managed by the reverse proxy.' });
      const problem = passwordProblem(password);
      if (problem) return reply.code(400).send({ error: problem });
      await store.setPassword(target.id, password);
    }
    store.updateUser(target.id, { isAdmin, disabled });
    return { user: store.getUser(target.id) };
  });

  app.delete<{ Params: { id: string } }>('/api/users/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const target = store.getUser(Number(req.params.id));
    if (!target) return reply.code(404).send({ error: 'No such user.' });
    if (target.id === req.user!.id) return reply.code(409).send({ error: "You can't delete your own account." });
    if (target.isAdmin && !target.disabled && store.countActiveAdmins() <= 1) return reply.code(409).send({ error: 'There must be at least one admin.' });
    store.deleteUser(target.id);
    return { ok: true };
  });

  const purge = setInterval(() => store.purgeExpiredSessions(), 6 * 3600 * 1000);
  purge.unref();
  app.addHook('onClose', async () => clearInterval(purge));

  return { setupCode };
}
