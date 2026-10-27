// Small per-user preferences (last mode, later: data saver, volume…), shared across devices.
import type { FastifyInstance } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';

const KEY_RE = /^[a-z][a-zA-Z0-9.]{0,63}$/;
const MAX_VALUE_BYTES = 16 * 1024;
const MAX_KEYS = 100;

export function registerPrefs(app: FastifyInstance, db: DatabaseSync): void {
  app.get('/api/me/prefs', async (req) => {
    const rows = db.prepare('SELECT key, value FROM user_prefs WHERE user_id = ?').all(req.user!.id) as { key: string; value: string }[];
    return { prefs: Object.fromEntries(rows.map((r) => [r.key, JSON.parse(r.value)])) };
  });

  app.put<{ Params: { key: string }; Body: { value?: unknown } }>('/api/me/prefs/:key', async (req, reply) => {
    const { key } = req.params;
    if (!KEY_RE.test(key)) return reply.code(400).send({ error: 'invalid key' });
    if (!req.body || !('value' in req.body)) return reply.code(400).send({ error: 'body must be {"value": …}' });
    const value = JSON.stringify(req.body.value ?? null);
    if (Buffer.byteLength(value) > MAX_VALUE_BYTES) return reply.code(413).send({ error: 'value too large' });
    const userId = req.user!.id;
    const exists = db.prepare('SELECT 1 FROM user_prefs WHERE user_id = ? AND key = ?').get(userId, key);
    if (!exists && (db.prepare('SELECT COUNT(*) AS n FROM user_prefs WHERE user_id = ?').get(userId) as { n: number }).n >= MAX_KEYS) {
      return reply.code(409).send({ error: 'too many preferences' });
    }
    db.prepare(
      `INSERT INTO user_prefs (user_id, key, value, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (user_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    ).run(userId, key, value, Date.now());
    return { ok: true };
  });
}
