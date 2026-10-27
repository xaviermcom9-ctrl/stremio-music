import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const MIGRATIONS: string[] = [
  `CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  `CREATE TABLE users (
     id INTEGER PRIMARY KEY,
     username TEXT NOT NULL UNIQUE COLLATE NOCASE,
     password_hash TEXT,            -- NULL for users managed by an authenticating proxy
     is_admin INTEGER NOT NULL DEFAULT 0,
     disabled INTEGER NOT NULL DEFAULT 0,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   );
   CREATE TABLE sessions (
     id TEXT PRIMARY KEY,           -- sha256 of the cookie token; the token itself is never stored
     user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     created_at INTEGER NOT NULL,
     expires_at INTEGER NOT NULL,
     last_seen_at INTEGER NOT NULL,
     user_agent TEXT,
     ip TEXT
   );
   CREATE INDEX sessions_user ON sessions(user_id);`,
  `CREATE TABLE user_prefs (
     user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     key TEXT NOT NULL,
     value TEXT NOT NULL,            -- JSON
     updated_at INTEGER NOT NULL,
     PRIMARY KEY (user_id, key)
   );`,
  `CREATE TABLE sources (
     id TEXT PRIMARY KEY,           -- source id (built-in/folder manifest id, or "addon-<hash>" for remote)
     kind TEXT NOT NULL CHECK (kind IN ('builtin', 'folder', 'remote')),
     url TEXT,                      -- remote: manifest URL
     enabled INTEGER NOT NULL DEFAULT 1,
     priority INTEGER NOT NULL,
     settings TEXT NOT NULL DEFAULT '{}', -- global settings JSON; secret values encrypted
     added_at INTEGER NOT NULL
   );
   CREATE TABLE source_user_settings (
     source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
     user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     settings TEXT NOT NULL,        -- per-user settings JSON; secret values encrypted
     PRIMARY KEY (source_id, user_id)
   );`,
  `CREATE TABLE player_state (
     user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
     state TEXT NOT NULL,           -- JSON: queue, position, modes; written by the last active device
     device TEXT,
     updated_at INTEGER NOT NULL
   );`,
  `CREATE TABLE library_items (
     user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     kind TEXT NOT NULL CHECK (kind IN ('track', 'album', 'artist', 'playlist', 'station')),
     item_id TEXT NOT NULL,         -- meta id ("<source>:…")
     data TEXT NOT NULL,            -- JSON meta preview snapshot (name, poster, music…)
     added_at INTEGER NOT NULL,
     PRIMARY KEY (user_id, kind, item_id)
   );
   CREATE TABLE playlists (
     id INTEGER PRIMARY KEY,
     user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     name TEXT NOT NULL,
     description TEXT NOT NULL DEFAULT '',
     sync INTEGER NOT NULL DEFAULT 0, -- mirror into sources that support playlists (Navidrome)
     remotes TEXT NOT NULL DEFAULT '{}', -- JSON {sourceId: remote playlist id}
     sync_error TEXT,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   );
   CREATE INDEX playlists_user ON playlists(user_id);
   CREATE TABLE playlist_tracks (
     id INTEGER PRIMARY KEY,
     playlist_id INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
     position INTEGER NOT NULL,
     item_id TEXT NOT NULL,
     data TEXT NOT NULL,            -- JSON track snapshot
     added_at INTEGER NOT NULL
   );
   CREATE INDEX playlist_tracks_order ON playlist_tracks(playlist_id, position);
   CREATE TABLE mb_cache (
     key TEXT PRIMARY KEY,
     value TEXT NOT NULL,           -- JSON (null = no confident match)
     at INTEGER NOT NULL
   );`,
  `CREATE TABLE download_groups (
     id INTEGER PRIMARY KEY,
     user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     kind TEXT NOT NULL CHECK (kind IN ('album', 'track', 'list')),
     title TEXT NOT NULL,
     subtitle TEXT,
     poster TEXT,
     meta_id TEXT,
     created_at INTEGER NOT NULL
   );
   CREATE INDEX download_groups_user ON download_groups(user_id);
   CREATE TABLE download_items (
     id INTEGER PRIMARY KEY,
     group_id INTEGER NOT NULL REFERENCES download_groups(id) ON DELETE CASCADE,
     position INTEGER NOT NULL,
     item_id TEXT NOT NULL,         -- track id whose streams are downloaded ("torrent:<ih>:<idx>" for torrent files)
     target TEXT NOT NULL,          -- JSON: tags, cover URL, licence, links
     status TEXT NOT NULL CHECK (status IN ('queued', 'downloading', 'paused', 'processing', 'done', 'skipped', 'failed', 'cancelled')),
     backend TEXT,                  -- http | engine | qbittorrent (once started)
     downloaded INTEGER NOT NULL DEFAULT 0,
     total INTEGER,
     error TEXT,
     note TEXT,
     path TEXT,                     -- final file, relative to /music
     attempts INTEGER NOT NULL DEFAULT 0,
     updated_at INTEGER NOT NULL
   );
   CREATE INDEX download_items_group ON download_items(group_id, position);
   CREATE INDEX download_items_status ON download_items(status);
   CREATE TABLE app_settings (
     key TEXT PRIMARY KEY,
     value TEXT NOT NULL            -- JSON; secret fields encrypted
   );`,
];

export function openDb(file: string): DatabaseSync {
  mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  migrate(db);
  return db;
}

function migrate(db: DatabaseSync): void {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number };
  for (let v = row.user_version; v < MIGRATIONS.length; v++) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[v]!);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
}

export function dbHealthy(db: DatabaseSync): boolean {
  try {
    return (db.prepare('SELECT 1 AS ok').get() as { ok: number }).ok === 1;
  } catch {
    return false;
  }
}
