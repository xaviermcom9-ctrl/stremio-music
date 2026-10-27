// All music sources in one ordered list: built-in plugins, folder plugins and remote addons.
// Each is enabled/disabled and ordered by the admin; settings are global or per user.
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { CatalogDef, MusicSource, SettingsSchema, SourceContext, SourceManifest } from '../music-sources/sdk.js';
import { FolderPlugin, scanPluginDir } from './folder.js';
import { AddonClient, AddonError } from './protocol/addon-client.js';
import { ResponseCache } from './protocol/cache.js';
import { MUSIC_TYPE } from './protocol/content-types.js';
import { normalizeManifestUrl } from './protocol/manifest.js';
import type { Manifest, MetaPreview } from './protocol/types.js';
import { SourceRuntime, validateSourceManifest } from './runtime.js';
import type { SecretBox } from './secrets.js';
import { applyInput, mask, missingRequired, resolve, type StoredSettings } from './settings.js';

export type SourceKind = 'builtin' | 'folder' | 'remote';
export type SourceState = 'ok' | 'needs-setup' | 'error' | 'disabled';

export interface SourceEntry {
  id: string;
  kind: SourceKind;
  enabled: boolean;
  priority: number;
  name: string;
  description: string;
  version: string;
  icon: string | null;
  attribution: string | null;
  capabilities: SourceManifest['capabilities'];
  catalogs: (CatalogDef & { searchable: boolean; feed: boolean })[];
  settingsSchema: SettingsSchema;
  /** remote: manifest URL; folder: plugin directory */
  location: string | null;
  error: string | null;
  warnings: string[];
  runtime?: SourceRuntime;
  client?: AddonClient;
  folder?: FolderPlugin;
}

export interface LoadError {
  location: string;
  error: string;
  at: string;
}

interface Row {
  id: string;
  kind: SourceKind;
  url: string | null;
  enabled: number;
  priority: number;
  settings: string;
}

type User = SourceContext['user'];

export interface RegistryOptions {
  db: DatabaseSync;
  box: SecretBox;
  builtins: MusicSource[];
  /** /config/music-sources */
  pluginDir: string;
  userAgent: string;
  fetchImpl?: typeof fetch;
  log?: { info(m: string): void; warn(m: string): void };
}

const NO_CAPS: SourceManifest['capabilities'] = { catalogs: true, search: false, meta: false, streams: false, downloadable: false, live: false };

export class SourceRegistry {
  readonly cache = new ResponseCache(5000);
  private entries = new Map<string, SourceEntry>();
  /** folder plugins that failed to load (no id known), shown on the Sources page */
  folderErrors: LoadError[] = [];

  constructor(private readonly o: RegistryOptions) {}

  // ---------------------------------------------------------------- loading

  async init(): Promise<void> {
    for (const impl of this.o.builtins) {
      const v = validateSourceManifest(impl.manifest);
      if (!v.ok) throw new Error(`built-in source ${String((impl.manifest as { id?: string })?.id)}: ${v.errors.join('; ')}`);
      this.addRuntime('builtin', impl, null);
    }
    await this.loadFolderPlugins();
    for (const row of this.rows().filter((r) => r.kind === 'remote')) await this.loadRemote(row.id, row.url!);
    this.syncRows();
  }

  /** Stops all folder plugins and loads /config/music-sources again. */
  async reloadFolderPlugins(): Promise<{ loaded: string[]; errors: LoadError[] }> {
    for (const e of [...this.entries.values()].filter((e) => e.kind === 'folder')) {
      e.folder?.stop();
      this.entries.delete(e.id);
    }
    this.cache.deletePrefix('');
    const loaded = await this.loadFolderPlugins();
    this.syncRows();
    return { loaded, errors: this.folderErrors };
  }

  private async loadFolderPlugins(): Promise<string[]> {
    this.folderErrors = [];
    const loaded: string[] = [];
    for (const c of scanPluginDir(this.o.pluginDir)) {
      let entry: SourceEntry | undefined;
      const plugin = new FolderPlugin(c.dir, (level, message) => entry?.runtime?.log(level, message));
      try {
        const manifest = await plugin.start();
        if (this.entries.has(manifest.id)) throw new Error(`id "${manifest.id}" is already used by another source`);
        entry = this.addRuntime('folder', plugin.asSource(), c.dir);
        entry.folder = plugin;
        loaded.push(manifest.id);
        this.o.log?.info(`music source plugin loaded: ${manifest.id} (${c.dir})`);
      } catch (err) {
        plugin.stop();
        const error = err instanceof Error ? err.message : String(err);
        this.folderErrors.push({ location: c.dir, error, at: new Date().toISOString() });
        this.o.log?.warn(`music source plugin ${c.dir} failed to load: ${error}`);
      }
    }
    return loaded;
  }

  private addRuntime(kind: 'builtin' | 'folder', impl: MusicSource, location: string | null): SourceEntry {
    const m = impl.manifest;
    const perUser = Object.values(m.settings).some((f) => f.perUser);
    const runtime = new SourceRuntime(impl, {
      perUser,
      cache: this.cache,
      fetchImpl: this.o.fetchImpl,
      settingsFor: (user) => this.settingsFor(m.id, user),
      makeProxyUrl: (url, headers) => this.proxyUrl(m.id, url, headers),
    });
    const entry: SourceEntry = {
      id: m.id,
      kind,
      enabled: true,
      priority: 0,
      name: m.name,
      description: m.description,
      version: m.version,
      icon: m.icon ?? null,
      attribution: m.attribution ?? null,
      capabilities: m.capabilities,
      catalogs: m.catalogs.map((c) => ({ ...c, searchable: !!c.extra?.some((e) => e.name === 'search'), feed: !c.extra?.some((e) => e.isRequired) })),
      settingsSchema: m.settings,
      location,
      error: null,
      warnings: [],
      runtime,
    };
    this.entries.set(m.id, entry);
    return entry;
  }

  private async loadRemote(id: string, url: string): Promise<SourceEntry> {
    const client = new AddonClient(url, this.cache, {
      timeoutMs: 15_000,
      defaultTtl: { manifest: 3600, catalog: 600, meta: 3600, stream: 300 },
      retryAfterMs: 60_000,
      maxResponseBytes: 5 * 1024 * 1024,
      userAgent: this.o.userAgent,
      rateLimit: { ratePerSecond: 5, burst: 10, maxConcurrent: 4, maxWaitMs: 15_000 },
      fetch: this.o.fetchImpl,
    });
    await client.load();
    const entry: SourceEntry = {
      id,
      kind: 'remote',
      enabled: true,
      priority: 0,
      name: client.name,
      description: '',
      version: '',
      icon: null,
      attribution: null,
      capabilities: NO_CAPS,
      catalogs: [],
      settingsSchema: {},
      location: client.url,
      error: null,
      warnings: [],
      client,
    };
    this.refreshRemote(entry);
    this.entries.set(id, entry);
    return entry;
  }

  private refreshRemote(entry: SourceEntry): void {
    const s = entry.client!.status();
    const m = s.manifest;
    entry.error = s.state === 'error' ? (s.error ?? 'failed to load') : null;
    entry.warnings = s.warnings;
    if (!m) return;
    entry.name = m.name;
    entry.description = m.description ?? '';
    entry.version = m.version;
    entry.icon = typeof m.logo === 'string' ? m.logo : null;
    const has = (r: string) => m.resources.some((x) => x === r || (typeof x === 'object' && x.name === r));
    const catalogs = m.catalogs.filter((c) => c.type === MUSIC_TYPE);
    entry.catalogs = catalogs.map((c) => ({
      id: c.id,
      name: c.name ?? c.id,
      extra: c.extra,
      searchable: !!c.extra?.some((e) => e.name === 'search'),
      feed: !c.extra?.some((e) => e.isRequired),
    }));
    entry.capabilities = {
      catalogs: catalogs.length > 0,
      search: entry.catalogs.some((c) => c.searchable),
      meta: has('meta'),
      streams: has('stream'),
      downloadable: false,
      live: false,
    };
    if (!m.types.includes(MUSIC_TYPE)) entry.error = `this addon doesn't declare the "music" type`;
  }

  // ---------------------------------------------------------------- persistence

  private rows(): Row[] {
    return this.o.db.prepare('SELECT * FROM sources ORDER BY priority, id').all() as unknown as Row[];
  }

  /** Makes sure every loaded source has a row (new ones go last) and copies enabled/priority back. */
  private syncRows(): void {
    const rows = new Map(this.rows().map((r) => [r.id, r]));
    let next = Math.max(0, ...[...rows.values()].map((r) => r.priority + 1));
    for (const e of this.entries.values()) {
      let row = rows.get(e.id);
      if (!row) {
        this.o.db
          .prepare('INSERT INTO sources (id, kind, url, enabled, priority, settings, added_at) VALUES (?, ?, ?, 1, ?, ?, ?)')
          .run(e.id, e.kind, e.kind === 'remote' ? e.location : null, next, '{}', Date.now());
        row = { id: e.id, kind: e.kind, url: e.location, enabled: 1, priority: next++, settings: '{}' };
      } else if (row.kind !== e.kind) {
        this.o.db.prepare('UPDATE sources SET kind = ? WHERE id = ?').run(e.kind, e.id);
      }
      e.enabled = row.enabled === 1;
      e.priority = row.priority;
    }
  }

  private globalSettings(id: string): StoredSettings {
    const row = this.o.db.prepare('SELECT settings FROM sources WHERE id = ?').get(id) as { settings: string } | undefined;
    return row ? (JSON.parse(row.settings) as StoredSettings) : {};
  }

  private userSettings(id: string, userId: number | undefined): StoredSettings {
    if (userId === undefined) return {};
    const row = this.o.db.prepare('SELECT settings FROM source_user_settings WHERE source_id = ? AND user_id = ?').get(id, userId) as
      | { settings: string }
      | undefined;
    return row ? (JSON.parse(row.settings) as StoredSettings) : {};
  }

  settingsFor(id: string, user: User): Record<string, string | number | boolean | undefined> {
    const e = this.entries.get(id);
    if (!e) return {};
    return resolve(e.settingsSchema, this.globalSettings(id), this.userSettings(id, user?.id), this.o.box);
  }

  // ---------------------------------------------------------------- queries

  get(id: string): SourceEntry | undefined {
    return this.entries.get(id);
  }

  /** All sources, by priority. */
  list(): SourceEntry[] {
    return [...this.entries.values()].sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
  }

  state(e: SourceEntry, user: User): SourceState {
    if (!e.enabled) return 'disabled';
    if (e.error) return 'error';
    if (e.runtime && missingRequired(e.settingsSchema, this.settingsFor(e.id, user)).length) return 'needs-setup';
    return 'ok';
  }

  /** Sources the Music UI uses for this user: enabled, loaded, configured. */
  active(user: User): SourceEntry[] {
    return this.list().filter((e) => this.state(e, user) === 'ok');
  }

  /** Admin view (everything) or user view (per-user fields only). */
  describe(e: SourceEntry, user: User, admin: boolean) {
    const rt = e.runtime;
    return {
      id: e.id,
      kind: e.kind,
      enabled: e.enabled,
      priority: e.priority,
      state: this.state(e, user),
      name: e.name,
      description: e.description,
      version: e.version,
      icon: e.icon ? (/^https?:\/\//.test(e.icon) ? e.icon : `sources/${e.id}/icon`) : null,
      attribution: e.attribution,
      capabilities: e.capabilities,
      catalogs: e.catalogs.map((c) => ({ id: c.id, name: c.name, kind: c.kind ?? null, searchable: c.searchable, feed: c.feed })),
      location: admin ? e.location : null,
      error: e.error ?? (rt?.stats.lastError?.message ?? null),
      warnings: e.warnings,
      missing: rt ? missingRequired(e.settingsSchema, this.settingsFor(e.id, user)) : [],
      settings: {
        schema: e.settingsSchema,
        global: admin ? mask(e.settingsSchema, this.globalSettings(e.id), 'global') : undefined,
        user: mask(e.settingsSchema, this.userSettings(e.id, user?.id), 'user'),
      },
      stats: admin ? (rt?.stats ?? null) : undefined,
      manifestUrl: e.kind === 'remote' ? e.location : `sources/${e.id}/manifest.json`,
    };
  }

  // ---------------------------------------------------------------- admin changes

  setEnabled(id: string, enabled: boolean): void {
    this.require(id).enabled = enabled;
    this.o.db.prepare('UPDATE sources SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id);
  }

  setOrder(ids: string[]): void {
    const known = this.list().map((e) => e.id);
    if (ids.length !== known.length || !ids.every((id) => known.includes(id))) throw new Error('order must list every source exactly once');
    const stmt = this.o.db.prepare('UPDATE sources SET priority = ? WHERE id = ?');
    ids.forEach((id, i) => {
      stmt.run(i, id);
      this.entries.get(id)!.priority = i;
    });
  }

  setGlobalSettings(id: string, input: Record<string, unknown>): void {
    const e = this.require(id);
    const next = applyInput(e.settingsSchema, 'global', this.globalSettings(id), input, this.o.box);
    this.o.db.prepare('UPDATE sources SET settings = ? WHERE id = ?').run(JSON.stringify(next), id);
    this.cache.deletePrefix(JSON.stringify([id]).slice(0, -1));
  }

  setUserSettings(id: string, userId: number, input: Record<string, unknown>): void {
    const e = this.require(id);
    const next = applyInput(e.settingsSchema, 'user', this.userSettings(id, userId), input, this.o.box);
    this.o.db
      .prepare(
        `INSERT INTO source_user_settings (source_id, user_id, settings) VALUES (?, ?, ?)
         ON CONFLICT (source_id, user_id) DO UPDATE SET settings = excluded.settings`,
      )
      .run(id, userId, JSON.stringify(next));
    this.cache.deletePrefix(JSON.stringify([id]).slice(0, -1));
  }

  async addRemote(rawUrl: string): Promise<SourceEntry> {
    const url = normalizeManifestUrl(rawUrl);
    const id = `addon-${createHash('sha1').update(url).digest('hex').slice(0, 10)}`;
    if (this.entries.has(id)) throw new Error('that addon is already added');
    const entry = await this.loadRemote(id, url);
    const m = entry.client!.manifest;
    if (!m) {
      this.entries.delete(id);
      throw new Error(`couldn't load the manifest: ${entry.error ?? 'unknown error'}`);
    }
    if (!m.types.includes(MUSIC_TYPE)) {
      this.entries.delete(id);
      throw new Error(`"${m.name}" doesn't declare the "music" type, so it isn't a music source`);
    }
    this.syncRows();
    return entry;
  }

  removeRemote(id: string): void {
    const e = this.require(id);
    if (e.kind !== 'remote') throw new Error('only addons added by URL can be removed; disable others instead');
    this.entries.delete(id);
    this.o.db.prepare('DELETE FROM sources WHERE id = ?').run(id);
  }

  async refresh(id: string): Promise<void> {
    const e = this.require(id);
    if (e.client) {
      await e.client.load(true);
      this.refreshRemote(e);
    }
  }

  require(id: string): SourceEntry {
    const e = this.entries.get(id);
    if (!e) throw new Error(`no source "${id}"`);
    return e;
  }

  /** App-relative URL the browser can use for a private upstream URL (see /api/proxy). */
  proxyUrl(sourceId: string, url: string, headers?: Record<string, string>, opts: { pub?: boolean } = {}): string {
    return `api/proxy/${this.proxyToken(sourceId, url, headers, opts)}`;
  }

  proxyToken(sourceId: string, url: string, headers?: Record<string, string>, opts: { pub?: boolean; engine?: boolean } = {}): string {
    const t: ProxyToken = { s: sourceId, u: url, h: headers, e: Date.now() + PROXY_TOKEN_TTL_MS };
    if (opts.pub) t.p = 1;
    if (opts.engine) t.k = 'engine';
    return this.o.box.seal(t);
  }

  openProxyToken(token: string): ProxyToken | null {
    try {
      const t = this.o.box.open<ProxyToken>(token);
      return t.e > Date.now() ? t : null;
    } catch {
      return null;
    }
  }

  iconPath(id: string): string | null {
    const e = this.entries.get(id);
    if (!e?.icon || /^https?:\/\//.test(e.icon)) return null;
    const base = e.kind === 'folder' ? e.location! : path.join(BUILTIN_DIR, e.id);
    const file = path.resolve(base, e.icon);
    return file.startsWith(path.resolve(base) + path.sep) && existsSync(file) ? file : null;
  }

  // ---------------------------------------------------------------- resource calls (one source)

  async catalog(e: SourceEntry, user: User, catalogId: string, extra: Record<string, string>): Promise<MetaPreview[]> {
    if (e.runtime) return (await e.runtime.catalog(user, catalogId, extra)) as unknown as MetaPreview[];
    return e.client!.catalog(MUSIC_TYPE, catalogId, extra);
  }

  async meta(e: SourceEntry, user: User, id: string) {
    if (e.runtime) return e.runtime.meta(user, id);
    try {
      return await e.client!.meta(MUSIC_TYPE, id);
    } catch (err) {
      if (err instanceof AddonError && err.kind === 'not-found') return null;
      throw err;
    }
  }

  async streams(e: SourceEntry, user: User, id: string) {
    if (e.runtime) return e.runtime.streams(user, id);
    try {
      return await e.client!.streams(MUSIC_TYPE, id);
    } catch (err) {
      if (err instanceof AddonError && err.kind === 'not-found') return [];
      throw err;
    }
  }

  /** Does this source handle meta/streams for this id? */
  owns(e: SourceEntry, resource: 'meta' | 'stream', id: string): boolean {
    if (e.runtime) return id.startsWith(`${e.id}:`) && (resource === 'meta' ? e.capabilities.meta : e.capabilities.streams);
    return e.client!.supports(resource, MUSIC_TYPE, id);
  }

  async test(e: SourceEntry, user: User): Promise<{ ok: boolean; message: string }> {
    if (e.runtime) return e.runtime.test(user);
    await e.client!.load(true);
    this.refreshRemote(e);
    if (e.error) return { ok: false, message: e.error };
    const feed = e.catalogs.find((c) => c.feed);
    if (!feed) return { ok: true, message: `Manifest loaded (${e.name} ${e.version}).` };
    try {
      const items = await e.client!.catalog(MUSIC_TYPE, feed.id, {});
      return { ok: true, message: `${feed.name}: ${items.length} items.` };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Calls an optional source hook as this user; failures are logged on the source, never thrown. */
  async hook(e: SourceEntry, user: User, name: 'scrobble' | 'setLiked', ...args: unknown[]): Promise<boolean> {
    const fn = e.runtime?.impl.hooks?.[name] as ((...a: unknown[]) => Promise<void>) | undefined;
    if (!fn) return false;
    try {
      await fn(...args, e.runtime!.context(user));
      return true;
    } catch (err) {
      e.runtime!.log('warn', `${name} hook failed: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  logs(e: SourceEntry): string[] {
    if (e.runtime) return e.runtime.logs;
    const s = e.client!.status();
    return [
      `manifest ${s.state}${s.loadedAt ? ` (loaded ${new Date(s.loadedAt).toISOString()})` : ''}${s.error ? `: ${s.error}` : ''}`,
      ...s.warnings.map((w) => `warning: ${w}`),
    ];
  }

  stop(): void {
    for (const e of this.entries.values()) e.folder?.stop();
  }
}

export interface ProxyToken {
  /** source id */
  s: string;
  /** upstream URL */
  u: string;
  /** request headers */
  h?: Record<string, string>;
  /** expiry (ms epoch) */
  e: number;
  /** public media from any host (e.g. a radio station): allowed only at public addresses */
  p?: 1;
  /** `u` is a path on the streaming engine (torrent file), for the transcoder */
  k?: 'engine';
}

/** Proxy URLs end up in cached catalogs and in saved queues, so they live a while. */
const PROXY_TOKEN_TTL_MS = 7 * 24 * 3600 * 1000;

/** Built-in sources live in server/src/music-sources/<id>/ (icons are read from there). */
export const BUILTIN_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../music-sources');

export type { Manifest };
