// Backup of /config while the app runs:
//   docker exec stremio-music sm-backup [--dir /config/backups] [--keep 7]
// Writes stremio-music-<date>.tar.gz with: app.db (a consistent SQLite online backup: users,
// sessions, sources and their settings, library, playlists, downloads), secret.key (when the key
// is generated rather than given in APP_SECRET_KEY), and the folder plugins (music-sources/).
// The archive holds secrets: it's created readable by its owner only. Restore: see README.
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';
import { VERSION } from './version.js';
import { loadConfig } from './config.js';

const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const config = loadConfig();
const dir = opt('dir') ?? path.join(config.dirs.config, 'backups');
const keep = Math.max(1, Number(opt('keep') ?? 7) || 7);
const stamp = new Date().toISOString().replace(/[:]/g, '-').replace(/\..+$/, '');
// two backups in the same second must not overwrite each other
let name = `stremio-music-${stamp}.tar.gz`;
for (let i = 2; existsSync(path.join(dir, name)); i++) name = `stremio-music-${stamp}-${i}.tar.gz`;
const work = path.join(dir, `.tmp-${stamp}`);

mkdirSync(work, { recursive: true });
try {
  if (!existsSync(config.dbPath)) throw new Error(`no database at ${config.dbPath}`);
  const db = new DatabaseSync(config.dbPath, { readOnly: true });
  await backup(db, path.join(work, 'app.db'));
  db.close();
  const files = ['app.db'];
  const key = path.join(config.dirs.config, 'secret.key');
  if (existsSync(key)) {
    copyFileSync(key, path.join(work, 'secret.key'));
    files.push('secret.key');
  }
  if (existsSync(config.musicSourcesDir) && readdirSync(config.musicSourcesDir).length) {
    cpSync(config.musicSourcesDir, path.join(work, 'music-sources'), { recursive: true });
    files.push('music-sources/');
  }
  writeFileSync(path.join(work, 'backup.json'), JSON.stringify({ app: 'stremio-music', version: VERSION, createdAt: new Date().toISOString(), files }, null, 2));
  const out = path.join(dir, name);
  execFileSync('tar', ['-czf', out, '-C', work, '.']);
  chmodSync(out, 0o600);

  // keep the newest `keep` archives
  const old = readdirSync(dir)
    .filter((f) => /^stremio-music-.*\.tar\.gz$/.test(f))
    .sort()
    .reverse()
    .slice(keep);
  for (const f of old) rmSync(path.join(dir, f));

  console.log(`backup written: ${out} (${(statSync(out).size / 1024).toFixed(0)} kB): ${files.join(', ')}`);
  if (old.length) console.log(`removed ${old.length} older backup(s), keeping ${keep}`);
  if (!files.includes('secret.key')) console.log('note: the source-secret key comes from APP_SECRET_KEY(_FILE) and is not in the backup: keep it safe too');
} catch (err) {
  console.error(`backup failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
} finally {
  rmSync(work, { recursive: true, force: true });
}
