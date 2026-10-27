// Radio Browser (radio-browser.info): a community database of internet radio stations. Following its
// API guidelines: find an API server through the official server list (or use a fixed one), send an
// identifying User-Agent, and report a "click" when a user starts playing a station (scrobble hook).
// API: https://api.radio-browser.info/
import type { MusicMeta, MusicMetaPreview, MusicSource, MusicStream, SourceContext } from '../sdk.js';

const ID = 'radio-browser';
const SERVER_LIST = 'https://all.api.radio-browser.info/json/servers';
const LIMIT = 60;
const TAGS = ['pop', 'rock', 'news', 'jazz', 'classical', 'dance', 'electronic', 'hits', '80s', '90s', 'talk', 'chillout', 'ambient', 'hiphop', 'metal', 'oldies', 'country', 'reggae', 'blues', 'folk', 'indie', 'soul'];
const COUNTRIES = ['AU', 'NZ', 'GB', 'IE', 'US', 'CA', 'DE', 'FR', 'NL', 'ES', 'IT', 'SE', 'NO', 'JP', 'BR'];

interface Station {
  stationuuid: string;
  name: string;
  url?: string;
  url_resolved?: string;
  homepage?: string;
  favicon?: string;
  tags?: string;
  country?: string;
  countrycode?: string;
  language?: string;
  codec?: string;
  bitrate?: number;
  hls?: number;
  lastcheckok?: number;
  votes?: number;
}

let discovered: { host: string; at: number } | null = null;

/** The API host: the configured one, else a random server from the official list (refreshed hourly). */
async function apiBase(ctx: SourceContext): Promise<string> {
  const fixed = String(ctx.settings.server ?? '').replace(/\/+$/, '');
  if (fixed) return fixed;
  if (discovered && Date.now() - discovered.at < 3600_000) return `https://${discovered.host}`;
  const res = await ctx.fetch(SERVER_LIST);
  const servers = res.ok ? await res.json<{ name: string }[]>() : [];
  const names = [...new Set(servers.map((s) => s.name).filter((n) => /\.api\.radio-browser\.info$/.test(n)))];
  if (names.length === 0) throw new Error('Radio Browser: no API servers found');
  discovered = { host: names[Math.floor(Math.random() * names.length)]!, at: Date.now() };
  ctx.log.info(`using API server ${discovered.host}`);
  return `https://${discovered.host}`;
}

async function api<T>(ctx: SourceContext, path: string, params: Record<string, string | number | boolean | undefined> = {}): Promise<T> {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') q.set(k, String(v));
  const res = await ctx.fetch(`${await apiBase(ctx)}${path}${q.size ? `?${q}` : ''}`);
  if (!res.ok) throw new Error(`Radio Browser ${path}: HTTP ${res.status}`);
  return res.json<T>();
}

const stationId = (uuid: string) => `${ID}:station:${uuid}`;

function preview(s: Station): MusicMetaPreview {
  const quality = [s.codec, s.bitrate ? `${s.bitrate} kbit/s` : ''].filter(Boolean).join(' ');
  return {
    id: stationId(s.stationuuid),
    type: 'music',
    name: s.name.trim(),
    poster: s.favicon || undefined,
    posterShape: 'square',
    description: [s.country, quality].filter(Boolean).join(' · ') || undefined,
    genres: (s.tags ?? '').split(',').map((t) => t.trim()).filter(Boolean).slice(0, 5),
    music: { kind: 'station', live: true },
  };
}

const list = (ctx: SourceContext, params: Record<string, string | number | boolean | undefined>, skip = 0) =>
  api<Station[]>(ctx, '/json/stations/search', { hidebroken: true, limit: LIMIT, offset: skip, ...params }).then((r) => r.map(preview));

function parseId(id: string): string | null {
  const m = new RegExp(`^${ID}:station:([0-9a-f-]{36})$`).exec(id);
  return m ? m[1]! : null;
}

async function station(ctx: SourceContext, uuid: string): Promise<Station | null> {
  const [s] = await api<Station[]>(ctx, `/json/stations/byuuid/${uuid}`);
  return s ?? null;
}

const source: MusicSource = {
  manifest: {
    id: ID,
    name: 'Radio Browser',
    version: '1.0.0',
    description: 'Thousands of internet radio stations from the community-run radio-browser.info directory.',
    icon: 'icon.svg',
    attribution: 'Station directory by radio-browser.info',
    capabilities: { catalogs: true, search: true, meta: true, streams: true, downloadable: false, live: true },
    catalogs: [
      { id: 'country', name: 'Stations near you', kind: 'station', extra: [{ name: 'country', options: COUNTRIES }, { name: 'skip' }] },
      { id: 'topvote', name: 'Top voted stations', kind: 'station', extra: [{ name: 'skip' }] },
      { id: 'trending', name: 'Trending stations', kind: 'station', extra: [{ name: 'skip' }] },
      { id: 'tag', name: 'Stations by genre', kind: 'station', extra: [{ name: 'genre', isRequired: true, options: TAGS }, { name: 'skip' }] },
      { id: 'search', name: 'Search stations', kind: 'station', extra: [{ name: 'search', isRequired: true }] },
    ],
    settings: {
      country: { type: 'string', label: 'Default country', default: 'AU', help: 'Two-letter country code for "Stations near you", e.g. AU, NZ, GB.' },
      server: { type: 'url', label: 'API server', help: 'Leave empty to pick one automatically from the official server list.' },
    },
    // a volunteer-run service: be gentle
    rateLimit: { requestsPerSecond: 2, burst: 5, concurrency: 2 },
    cache: { catalog: 1800, meta: 3600, streams: 600 },
    userAgent: 'StremioMusic/0.1.0',
    allowedHosts: ['all.api.radio-browser.info', '*.api.radio-browser.info'],
  },

  async catalog(req, ctx) {
    const skip = req.skip ?? 0;
    switch (req.catalogId) {
      case 'country': {
        const code = String(req.extra.country || ctx.settings.country || 'AU').toUpperCase().slice(0, 2);
        return list(ctx, { countrycode: code, order: 'votes', reverse: true }, skip);
      }
      case 'topvote':
        return list(ctx, { order: 'votes', reverse: true }, skip);
      case 'trending':
        return list(ctx, { order: 'clicktrend', reverse: true }, skip);
      case 'tag':
        return list(ctx, { tag: req.genre, tagExact: true, order: 'votes', reverse: true }, skip);
      case 'search':
        return list(ctx, { name: req.search, order: 'votes', reverse: true }, skip);
      default:
        return [];
    }
  },

  async meta(id, ctx) {
    const uuid = parseId(id);
    const s = uuid ? await station(ctx, uuid) : null;
    if (!s) return null;
    const meta: MusicMeta = {
      ...preview(s),
      links: s.homepage ? [{ name: 'Website', category: 'source', url: s.homepage }] : undefined,
    };
    return meta;
  },

  async streams(id, ctx) {
    const uuid = parseId(id);
    const s = uuid ? await station(ctx, uuid) : null;
    const url = s?.url_resolved || s?.url;
    if (!s || !url || !/^https?:\/\//i.test(url)) return [];
    const codec = s.hls ? 'hls' : (s.codec ?? 'unknown').toLowerCase().replace('+', 'plus');
    const stream: MusicStream = {
      url,
      name: [s.codec, s.bitrate ? `${s.bitrate}` : ''].filter(Boolean).join(' ') || 'Live',
      description: s.lastcheckok === 0 ? 'Failed its last availability check' : undefined,
      behaviorHints: { music: { live: true, downloadable: false, codec, bitrate: s.bitrate || undefined } },
    };
    return [stream];
  },

  async test(ctx) {
    try {
      const stats = await api<{ stations?: number }>(ctx, '/json/stats');
      return { ok: true, message: `Radio Browser works (${stats.stations ?? '?'} stations).` };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  },

  hooks: {
    // Radio Browser asks clients to count a click when a user starts playing a station
    async scrobble(id, ctx) {
      const uuid = parseId(id);
      if (uuid) await api(ctx, `/json/url/${uuid}`);
    },
  },
};

export default source;
