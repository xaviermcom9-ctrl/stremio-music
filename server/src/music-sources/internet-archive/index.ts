// Internet Archive (archive.org): Live Music Archive, netlabels, 78 RPM records and more. No API
// key. advancedsearch for lists, the metadata API for items. Items in the "stream_only" collection
// (e.g. Grateful Dead soundboards) have private lossless files and are never offered for download.
// APIs: https://archive.org/advancedsearch.php, https://archive.org/developers/md-read.html
import { ccLicenceName } from '../common/licence.js';
import type { Licence, MusicMeta, MusicMetaPreview, MusicSource, MusicStream, MusicTrack, SourceContext } from '../sdk.js';

const ID = 'internet-archive';
const BASE = 'https://archive.org';
const ROWS = 50;
/** music collections searched and used for "popular" (not audiobooks, podcasts or radio shows) */
const MUSIC_COLLECTIONS = '(etree OR netlabels OR georgeblood OR audio_music)';

/** Preferred order for picking a track's stream (brief: FLAC > VBR MP3 > other). */
const FORMATS: { format: string; codec: string; label: string }[] = [
  { format: 'Flac', codec: 'flac', label: 'FLAC' },
  { format: '24bit Flac', codec: 'flac', label: 'FLAC 24-bit' },
  { format: 'VBR MP3', codec: 'mp3', label: 'MP3 VBR' },
  { format: '320Kbps MP3', codec: 'mp3', label: 'MP3 320' },
  { format: '256Kbps MP3', codec: 'mp3', label: 'MP3 256' },
  { format: '192Kbps MP3', codec: 'mp3', label: 'MP3 192' },
  { format: '128Kbps MP3', codec: 'mp3', label: 'MP3 128' },
  { format: 'Ogg Vorbis', codec: 'ogg', label: 'Ogg Vorbis' },
  { format: '64Kbps MP3', codec: 'mp3', label: 'MP3 64' },
  { format: 'Apple Lossless Audio', codec: 'alac', label: 'ALAC' },
  { format: 'WAVE', codec: 'wav', label: 'WAV' },
];
const AUDIO_FORMATS = new Set(FORMATS.map((f) => f.format));

interface Doc {
  identifier: string;
  title?: string;
  creator?: string | string[];
  date?: string;
  year?: string | number;
  licenseurl?: string;
  mediatype?: string;
  subject?: string | string[];
}

interface IAFile {
  name: string;
  format?: string;
  source?: string;
  original?: string;
  title?: string;
  track?: string;
  length?: string;
  creator?: string;
  album?: string;
  private?: string;
  size?: string;
}

interface Metadata {
  metadata?: {
    identifier: string;
    title?: string | string[];
    creator?: string | string[];
    date?: string;
    year?: string;
    licenseurl?: string;
    rights?: string | string[];
    collection?: string | string[];
    mediatype?: string;
    description?: string | string[];
    subject?: string | string[];
    'access-restricted-item'?: string;
    venue?: string;
    coverage?: string;
  };
  files?: IAFile[];
  is_dark?: boolean;
}

const first = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);
const list = (v: string | string[] | undefined): string[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
const itemId = (identifier: string) => `${ID}:item:${identifier}`;
const bandId = (identifier: string) => `${ID}:band:${identifier}`;
const trackId = (identifier: string, file: string) => `${ID}:track:${identifier}/${file}`;
const cover = (identifier: string) => `${BASE}/services/img/${encodeURIComponent(identifier)}`;
const detailsUrl = (identifier: string) => `${BASE}/details/${encodeURIComponent(identifier)}`;
const downloadUrl = (identifier: string, file: string) => `${BASE}/download/${encodeURIComponent(identifier)}/${file.split('/').map(encodeURIComponent).join('/')}`;

function year(d: Doc | NonNullable<Metadata['metadata']>): string | undefined {
  const y = String(d.year ?? d.date ?? '').slice(0, 4);
  return /^\d{4}$/.test(y) ? y : undefined;
}

function licence(meta: { identifier: string; licenseurl?: string; rights?: string | string[] }): Licence {
  if (meta.licenseurl) return { name: ccLicenceName(meta.licenseurl), url: meta.licenseurl, attribution: `Internet Archive: ${detailsUrl(meta.identifier)}` };
  const rights = first(meta.rights)?.replace(/<[^>]+>/g, '').trim();
  if (rights) return { name: rights.length > 120 ? `${rights.slice(0, 117)}…` : rights, url: detailsUrl(meta.identifier) };
  return { name: 'Rights: see the item page', url: detailsUrl(meta.identifier) };
}

function preview(d: Doc): MusicMetaPreview {
  const isBand = d.mediatype === 'collection';
  return {
    id: isBand ? bandId(d.identifier) : itemId(d.identifier),
    type: 'music',
    name: d.title ?? d.identifier,
    poster: cover(d.identifier),
    posterShape: 'square',
    releaseInfo: isBand ? undefined : year(d),
    genres: list(d.subject).slice(0, 3),
    music: isBand
      ? { kind: 'artist' }
      : { kind: 'album', artist: first(d.creator), licence: licence({ identifier: d.identifier, licenseurl: d.licenseurl }) },
  };
}

async function search(ctx: SourceContext, q: string, sort: string, skip = 0): Promise<MusicMetaPreview[]> {
  const params = new URLSearchParams({ q, rows: String(ROWS), page: String(Math.floor(skip / ROWS) + 1), output: 'json' });
  for (const f of ['identifier', 'title', 'creator', 'date', 'year', 'licenseurl', 'mediatype', 'subject']) params.append('fl[]', f);
  params.append('sort[]', sort);
  const res = await ctx.fetch(`${BASE}/advancedsearch.php?${params}`);
  if (!res.ok) throw new Error(`Internet Archive search: HTTP ${res.status}`);
  const body = await res.json<{ response?: { docs?: Doc[] } }>();
  return (body.response?.docs ?? []).map(preview);
}

async function metadata(ctx: SourceContext, identifier: string): Promise<Metadata | null> {
  const res = await ctx.fetch(`${BASE}/metadata/${encodeURIComponent(identifier)}`);
  if (!res.ok) throw new Error(`Internet Archive metadata: HTTP ${res.status}`);
  const body = await res.json<Metadata>();
  return body.metadata && !body.is_dark ? body : null;
}

/** seconds from "462.4" or "07:42" / "1:02:03" */
function seconds(length: string | undefined): number | undefined {
  if (!length) return undefined;
  if (/^\d+(\.\d+)?$/.test(length)) return Math.round(Number(length));
  const parts = length.split(':').map(Number);
  if (parts.some((p) => !Number.isFinite(p))) return undefined;
  return parts.reduce((acc, p) => acc * 60 + p, 0);
}

interface TrackGroup {
  /** the file all versions derive from (stable track id) */
  key: string;
  files: IAFile[];
  info: IAFile;
}

/** Groups an item's audio files by original, keeping only files that can be fetched. */
function trackGroups(md: Metadata): TrackGroup[] {
  const audio = (md.files ?? []).filter((f) => f.format && AUDIO_FORMATS.has(f.format));
  const groups = new Map<string, IAFile[]>();
  for (const f of audio) {
    const key = f.source === 'derivative' && f.original ? f.original : f.name;
    groups.set(key, [...(groups.get(key) ?? []), f]);
  }
  const out: TrackGroup[] = [];
  for (const [key, files] of groups) {
    const usable = files.filter((f) => f.private !== 'true');
    if (usable.length === 0) continue;
    // titles and track numbers usually sit on the original, sometimes only on the MP3
    const info = files.find((f) => f.name === key && f.title) ?? files.find((f) => f.title) ?? files[0]!;
    out.push({ key, files: usable, info });
  }
  const trackNo = (g: TrackGroup) => parseInt(String(g.info.track ?? g.files.find((f) => f.track)?.track ?? ''), 10);
  return out.sort((a, b) => (trackNo(a) || 1e9) - (trackNo(b) || 1e9) || a.key.localeCompare(b.key));
}

const streamOnly = (md: Metadata) =>
  list(md.metadata?.collection).includes('stream_only') || md.metadata?.['access-restricted-item'] === 'true';

const source: MusicSource = {
  manifest: {
    id: ID,
    name: 'Internet Archive',
    version: '1.0.0',
    description: 'Live concert recordings (Live Music Archive), netlabel releases, 78 RPM records and more from archive.org. No account needed.',
    icon: 'icon.svg',
    attribution: 'Music from the Internet Archive (archive.org); rights and licences per item',
    capabilities: { catalogs: true, search: true, meta: true, streams: true, downloadable: true, live: false },
    catalogs: [
      { id: 'popular', name: 'Popular this week', kind: 'album', extra: [{ name: 'skip' }] },
      { id: 'lma-recent', name: 'Live Music Archive: recently added', kind: 'album', extra: [{ name: 'skip' }] },
      { id: 'lma-bands', name: 'Live Music Archive: bands', kind: 'artist', extra: [{ name: 'skip' }] },
      { id: 'netlabels', name: 'Netlabel releases', kind: 'album', extra: [{ name: 'genre' }, { name: 'skip' }] },
      { id: '78rpm', name: '78 RPM records', kind: 'album', extra: [{ name: 'skip' }] },
      { id: 'search', name: 'Search', extra: [{ name: 'search', isRequired: true }, { name: 'skip' }] },
    ],
    settings: {},
    // archive.org asks for reasonable request rates
    rateLimit: { requestsPerSecond: 3, burst: 6, concurrency: 3 },
    cache: { catalog: 1800, meta: 86_400, streams: 86_400 },
    userAgent: 'StremioMusic/0.1.0 (self-hosted music player)',
    allowedHosts: ['archive.org', '*.archive.org'],
  },

  async catalog(req, ctx) {
    const skip = req.skip ?? 0;
    switch (req.catalogId) {
      case 'popular':
        return search(ctx, `collection:${MUSIC_COLLECTIONS} AND mediatype:(audio OR etree)`, 'week desc', skip);
      case 'lma-recent':
        return search(ctx, 'collection:etree AND mediatype:etree', 'publicdate desc', skip);
      case 'lma-bands':
        return search(ctx, 'collection:etree AND mediatype:collection', 'downloads desc', skip);
      case 'netlabels': {
        const genre = req.genre ? ` AND subject:(${quote(req.genre)})` : '';
        return search(ctx, `collection:netlabels AND mediatype:audio${genre}`, 'downloads desc', skip);
      }
      case '78rpm':
        return search(ctx, 'collection:georgeblood AND mediatype:audio', 'downloads desc', skip);
      case 'search': {
        const term = quote(req.search ?? '');
        return search(ctx, `(title:(${term}) OR creator:(${term})) AND collection:${MUSIC_COLLECTIONS} AND mediatype:(audio OR etree OR collection)`, 'downloads desc', skip);
      }
      default:
        return [];
    }
  },

  async meta(id, ctx) {
    const band = new RegExp(`^${ID}:band:(.+)$`).exec(id);
    if (band) {
      const md = await metadata(ctx, band[1]!);
      if (!md?.metadata) return null;
      const shows = await search(ctx, `collection:${band[1]} AND mediatype:etree`, 'date desc');
      const meta: MusicMeta = {
        id,
        type: 'music',
        name: first(md.metadata.title) ?? band[1]!,
        poster: cover(band[1]!),
        posterShape: 'square',
        description: first(md.metadata.description)?.replace(/<[^>]+>/g, '').slice(0, 1000),
        music: { kind: 'artist' },
        albums: shows,
      };
      return meta;
    }
    const item = new RegExp(`^${ID}:item:(.+)$`).exec(id);
    if (!item) return null;
    const md = await metadata(ctx, item[1]!);
    if (!md?.metadata) return null;
    const m = md.metadata;
    const lic = licence(m);
    const artist = first(m.creator);
    const videos: MusicTrack[] = trackGroups(md).map((g, i) => ({
      id: trackId(m.identifier, g.key),
      title: g.info.title ?? g.key.replace(/\.[^.]+$/, '').replace(/^.*\//, ''),
      episode: parseInt(String(g.info.track ?? ''), 10) || i + 1,
      season: 1,
      music: { artist: g.info.creator ?? artist, album: first(m.title), albumId: id, duration: seconds(g.info.length ?? g.files.find((f) => f.length)?.length), licence: lic },
    }));
    const where = [m.venue, m.coverage].filter(Boolean).join(', ');
    const meta: MusicMeta = {
      id,
      type: 'music',
      name: first(m.title) ?? m.identifier,
      poster: cover(m.identifier),
      posterShape: 'square',
      releaseInfo: year(m),
      genres: list(m.subject).slice(0, 5),
      description: [where, first(m.description)?.replace(/<[^>]+>/g, '').slice(0, 1500)].filter(Boolean).join('\n\n') || undefined,
      music: { kind: 'album', artist, licence: lic, trackCount: videos.length },
      videos,
      links: [{ name: 'archive.org', category: 'source', url: detailsUrl(m.identifier) }],
    };
    return meta;
  },

  async streams(id, ctx) {
    const m = new RegExp(`^${ID}:track:([^/]+)/(.+)$`).exec(id);
    if (!m) return [];
    const md = await metadata(ctx, m[1]!);
    if (!md) return [];
    const group = trackGroups(md).find((g) => g.key === m[2]);
    if (!group) return [];
    const downloadable = !streamOnly(md);
    return FORMATS.flatMap((fmt) => {
      const f = group.files.find((x) => x.format === fmt.format);
      if (!f) return [];
      const stream: MusicStream = {
        url: downloadUrl(m[1]!, f.name),
        name: fmt.label,
        description: downloadable ? undefined : 'Streaming only (the archive does not allow downloading this recording)',
        behaviorHints: { music: { codec: fmt.codec, downloadable, filename: f.name.replace(/^.*\//, '') } },
      };
      return [stream];
    });
  },

  async test(ctx) {
    const items = await search(ctx, 'collection:etree AND mediatype:etree', 'publicdate desc');
    return { ok: items.length > 0, message: items.length ? `archive.org search works (${items[0]!.name}).` : 'archive.org search returned nothing.' };
  },
};

/** Escapes a user term for the Lucene-style query. */
function quote(term: string): string {
  return term.replace(/[\\+\-!():^[\]"{}~*?|&/]/g, ' ').trim().split(/\s+/).filter(Boolean).join(' AND ') || '""';
}

export default source;
