// The music source plugin SDK: everything a source implements and receives. Types only, so this
// file also ships as `sdk.d.ts` next to folder plugins for editor completion (see PLUGINS.md).
//
// A source maps some music service onto the Stremio addon protocol. The backend serves every
// source as a Stremio addon (/sources/<id>/manifest.json) and the Music UI only speaks that
// protocol, so built-in sources, folder plugins and remote addons all look the same to it.

/** What kind of thing a meta item is (Stremio meta `type` is always "music"). */
export type MusicKind = 'artist' | 'album' | 'track' | 'station' | 'playlist';

export interface Licence {
  /** e.g. "CC BY-SA 4.0", "Public Domain", "All rights reserved" */
  name: string;
  url?: string;
  /** attribution line to show, e.g. "“Song” by Artist (Jamendo), CC BY 4.0" */
  attribution?: string;
}

/** Music-specific fields on a meta item. Extra fields are allowed by the Stremio protocol. */
export interface MusicInfo {
  kind: MusicKind;
  artist?: string;
  /** another meta id of this source, for linking to the artist page */
  artistId?: string;
  album?: string;
  albumId?: string;
  /** MusicBrainz id (artist, release or recording), used to merge the same item across sources */
  mbid?: string;
  /** seconds */
  duration?: number;
  licence?: Licence;
  /** true for radio stations / live streams */
  live?: boolean;
  /** number of tracks, for album/playlist previews */
  trackCount?: number;
}

/** A track inside an album/playlist/artist meta: a Stremio "video". */
export interface MusicTrack {
  /** unique within the source; streams are requested with this id */
  id: string;
  title: string;
  /** track number */
  episode?: number;
  /** disc number */
  season?: number;
  /** ISO date */
  released?: string;
  thumbnail?: string;
  music?: Omit<MusicInfo, 'kind'> & { kind?: 'track' };
}

/** Catalog item. `id` must start with "<source id>:". */
export interface MusicMetaPreview {
  id: string;
  type: 'music';
  name: string;
  poster?: string;
  posterShape?: 'square' | 'poster' | 'landscape';
  description?: string;
  releaseInfo?: string;
  genres?: string[];
  music: MusicInfo;
}

/** Full meta: album/playlist/artist with `videos` = tracks; a track or station has none. */
export interface MusicMeta extends MusicMetaPreview {
  background?: string;
  logo?: string;
  videos?: MusicTrack[];
  links?: { name: string; category: string; url: string }[];
}

/** A playable stream. Exactly one of url / infoHash / ytId. */
export interface MusicStream {
  url?: string;
  infoHash?: string;
  fileIdx?: number;
  ytId?: string;
  /** short label, e.g. "FLAC" or "MP3 320" */
  name?: string;
  description?: string;
  behaviorHints?: {
    /** HTTP headers the backend must send when fetching `url` (never exposed to the browser) */
    proxyHeaders?: { request?: Record<string, string> };
    music?: {
      downloadable?: boolean;
      live?: boolean;
      codec?: string;
      /** kbit/s */
      bitrate?: number;
      filename?: string;
    };
    [k: string]: unknown;
  };
}

export interface CatalogExtraDef {
  name: 'search' | 'genre' | 'skip' | (string & {});
  isRequired?: boolean;
  options?: string[];
}

export interface CatalogDef {
  /** unique within the source */
  id: string;
  name: string;
  /** what the catalog lists, for the UI's grouping */
  kind?: MusicKind;
  extra?: CatalogExtraDef[];
}

export interface SettingField {
  type: 'string' | 'url' | 'number' | 'boolean' | 'select';
  label: string;
  help?: string;
  default?: string | number | boolean;
  required?: boolean;
  /** stored encrypted, never sent back to the browser */
  secret?: boolean;
  /** each app user has their own value (e.g. a Navidrome login); otherwise one value set by the admin */
  perUser?: boolean;
  options?: { value: string; label: string }[];
}

export type SettingsSchema = Record<string, SettingField>;

export interface SourceManifest {
  /** [a-z0-9-], unique; prefixes every meta id: "<id>:…" */
  id: string;
  name: string;
  version: string;
  description: string;
  /** file name inside the source folder (svg/png), or an https URL */
  icon?: string;
  /** e.g. "Data from radio-browser.info" — shown on the Sources page */
  attribution?: string;
  capabilities: {
    catalogs: boolean;
    search: boolean;
    meta: boolean;
    streams: boolean;
    /** streams may be saved to the music library */
    downloadable: boolean;
    /** live streams (radio): no seek, no download */
    live: boolean;
  };
  catalogs: CatalogDef[];
  settings: SettingsSchema;
  /** outbound requests made through ctx.fetch */
  rateLimit: { requestsPerSecond: number; burst: number; concurrency: number };
  /** response cache lifetimes in seconds */
  cache: { catalog: number; meta: number; streams: number };
  /** User-Agent for ctx.fetch; default "StremioMusic/<version> (self-hosted)" */
  userAgent?: string;
  /** hosts ctx.fetch may call (exact host or "*.example.org"); settings of type "url" are added automatically */
  allowedHosts?: string[];
}

export interface CatalogRequest {
  catalogId: string;
  search?: string;
  genre?: string;
  skip?: number;
  /** any other declared extra */
  extra: Record<string, string>;
}

export interface Logger {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface SourceContext {
  /** this source's settings for the current user (secrets decrypted), with defaults applied */
  settings: Record<string, string | number | boolean | undefined>;
  /** the app user making the request; null for background work */
  user: { id: number; username: string } | null;
  /** fetch() with the source's rate limit, User-Agent, timeout and host allow-list applied */
  fetch(url: string, init?: { method?: string; headers?: Record<string, string>; body?: string; timeoutMs?: number }): Promise<SourceResponse>;
  log: Logger;
}

/** A buffered response (also works across the folder-plugin process boundary). */
export interface SourceResponse {
  ok: boolean;
  status: number;
  url: string;
  headers: Record<string, string>;
  text(): Promise<string>;
  json<T = unknown>(): Promise<T>;
}

export interface SourceTestResult {
  ok: boolean;
  message: string;
}

/** Optional integrations (e.g. Navidrome scrobbling, stars, playlists). */
export interface SourceHooks {
  scrobble(trackId: string, ctx: SourceContext): Promise<void>;
  setLiked(id: string, liked: boolean, ctx: SourceContext): Promise<void>;
}

export interface MusicSource {
  manifest: SourceManifest;
  catalog?(req: CatalogRequest, ctx: SourceContext): Promise<MusicMetaPreview[]>;
  meta?(id: string, ctx: SourceContext): Promise<MusicMeta | null>;
  /** id is a meta id (track/station) or a track id from an album's `videos` */
  streams?(id: string, ctx: SourceContext): Promise<MusicStream[]>;
  /** "Test connection" on the Sources page; should make one cheap real request */
  test?(ctx: SourceContext): Promise<SourceTestResult>;
  hooks?: Partial<SourceHooks>;
}
