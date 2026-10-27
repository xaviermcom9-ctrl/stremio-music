import { createHash, randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { hashPassword, verifyDummy, verifyPassword } from './password.js';

export interface User {
  id: number;
  username: string;
  isAdmin: boolean;
  disabled: boolean;
  hasPassword: boolean;
  createdAt: number;
}

interface UserRow {
  id: number;
  username: string;
  password_hash: string | null;
  is_admin: number;
  disabled: number;
  created_at: number;
}

const toUser = (r: UserRow): User => ({
  id: r.id,
  username: r.username,
  isAdmin: r.is_admin === 1,
  disabled: r.disabled === 1,
  hasPassword: r.password_hash !== null,
  createdAt: r.created_at,
});

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/** Refresh a session's expiry at most this often, so every HLS segment isn't a DB write. */
const TOUCH_INTERVAL_MS = 60 * 60 * 1000;

export class AuthStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly sessionTtlMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  countUsers(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n;
  }

  listUsers(): User[] {
    return (this.db.prepare('SELECT * FROM users ORDER BY username').all() as unknown as UserRow[]).map(toUser);
  }

  getUser(id: number): User | null {
    const row = this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
    return row ? toUser(row) : null;
  }

  findUser(username: string): User | null {
    const row = this.db.prepare('SELECT * FROM users WHERE username = ?').get(username) as UserRow | undefined;
    return row ? toUser(row) : null;
  }

  async createUser(username: string, password: string | null, isAdmin: boolean): Promise<User> {
    const hash = password === null ? null : await hashPassword(password);
    const t = this.now();
    const r = this.db
      .prepare('INSERT INTO users (username, password_hash, is_admin, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run(username, hash, isAdmin ? 1 : 0, t, t);
    return this.getUser(Number(r.lastInsertRowid))!;
  }

  async setPassword(userId: number, password: string, keepSessionId?: string): Promise<void> {
    const hash = await hashPassword(password);
    this.db.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?').run(hash, this.now(), userId);
    // a password change signs out every other device
    if (keepSessionId) this.db.prepare('DELETE FROM sessions WHERE user_id = ? AND id != ?').run(userId, keepSessionId);
    else this.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
  }

  updateUser(userId: number, changes: { isAdmin?: boolean; disabled?: boolean }): void {
    if (changes.isAdmin !== undefined) this.db.prepare('UPDATE users SET is_admin = ?, updated_at = ? WHERE id = ?').run(changes.isAdmin ? 1 : 0, this.now(), userId);
    if (changes.disabled !== undefined) {
      this.db.prepare('UPDATE users SET disabled = ?, updated_at = ? WHERE id = ?').run(changes.disabled ? 1 : 0, this.now(), userId);
      if (changes.disabled) this.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
    }
  }

  deleteUser(userId: number): void {
    this.db.prepare('DELETE FROM users WHERE id = ?').run(userId);
  }

  countActiveAdmins(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM users WHERE is_admin = 1 AND disabled = 0').get() as { n: number }).n;
  }

  /** null for unknown user, wrong password, no password (proxy user) or disabled account */
  async checkPassword(username: string, password: string): Promise<User | null> {
    const row = this.db.prepare('SELECT * FROM users WHERE username = ?').get(username) as UserRow | undefined;
    if (!row || row.password_hash === null) return verifyDummy(password).then(() => null);
    const ok = await verifyPassword(password, row.password_hash);
    return ok && row.disabled === 0 ? toUser(row) : null;
  }

  /** returns the cookie token; only its hash is stored */
  createSession(userId: number, meta: { userAgent?: string; ip?: string }): { token: string; id: string; expiresAt: number } {
    const token = randomBytes(32).toString('base64url');
    const id = sha256(token);
    const t = this.now();
    const expiresAt = t + this.sessionTtlMs;
    this.db
      .prepare('INSERT INTO sessions (id, user_id, created_at, expires_at, last_seen_at, user_agent, ip) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, userId, t, expiresAt, t, meta.userAgent?.slice(0, 256) ?? null, meta.ip ?? null);
    return { token, id, expiresAt };
  }

  /** Validates a cookie token, sliding the expiry. Returns null if unknown, expired or user disabled. */
  getSession(token: string): { id: string; user: User; expiresAt: number; refreshed: boolean } | null {
    const id = sha256(token);
    const row = this.db
      .prepare(
        `SELECT s.expires_at, s.last_seen_at, u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?`,
      )
      .get(id) as (UserRow & { expires_at: number; last_seen_at: number }) | undefined;
    if (!row) return null;
    const t = this.now();
    if (row.expires_at <= t || row.disabled === 1) {
      this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
      return null;
    }
    let expiresAt = row.expires_at;
    const refreshed = t - row.last_seen_at > TOUCH_INTERVAL_MS;
    if (refreshed) {
      expiresAt = t + this.sessionTtlMs;
      this.db.prepare('UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?').run(t, expiresAt, id);
    }
    return { id, user: toUser(row), expiresAt, refreshed };
  }

  deleteSession(id: string): void {
    this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
  }

  purgeExpiredSessions(): number {
    return Number(this.db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(this.now()).changes);
  }
}
