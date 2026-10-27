// Jamendo: independent music under Creative Commons. Needs a free client ID from
// https://devportal.jamendo.com (the API is free for non-commercial use). Per Jamendo's API terms,
// every item credits the artist and Jamendo and links to its Jamendo page, caching is kept to
// what the app needs, and downloads are offered only where Jamendo allows them.
// API: https://developer.jamendo.com/v3.0
import { ccLicenceName } from '../common/licence.js';
import type { Licence, MusicMeta, MusicMetaPreview, MusicSource, MusicStream, MusicTrack, SourceContext } from '../sdk.js';

const ID = 'jamendo';
const API = 'https://api.jamendo.com/v3.0';
const LIMIT = 50;

/** Jamendo's main genre tags. */
const TAGS = ['rock', 'pop', 'electronic', 'hiphop', 'jazz', 'classical', 'metal', 'ambient', 'folk', 'reggae', 'blues', 'lounge', 'soundtrack', 'world', 'country', 'punk', 'funk', 'latin'];

interface Track {
  id: string;
  name: string;
  duration?: number;
  position?: number;
  releasedate?: string;
  artist_id?: string;
  artist_name?: string;
  album_id?: string;
  album_name?: string;
  image?: string;
  album_image?: string;
  audio?: string;
  audiodownload?: string;
  audiodownload_allowed?: boolean;
  license_ccurl?: string;
  shareurl?: string;
  musicinfo?: { tags?: { genres?: string[] } };
}
interface Album {
  id: string;
  name: string;
  releasedate?: string;
  artist_id?: string;
  artist_name?: string;
  image?: string;
  shareurl?: string;
  tracks?: Track[];
}
interface Artist {
  id: string;
  name: string;
  image?: string;
  shareurl?: string;
  website?: string;
  albums?: Album[];
}

async function api<T>(ctx: SourceContext, path: string, params: Record<string, string | number | undefined>): Promise<T[]> {
  const clientId = ctx.settings.clientId;
  if (!clientId) throw new Error('set your Jamendo client ID (free at devportal.jamendo.com)');
  const q = new URLSearchParams({ client_id: String(clientId), format: 'json' });
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') q.set(k, String(v));
  const res = await ctx.fetch(`${API}/${path}/?${q}`);
  if (!res.ok) throw new Error(`Jamendo ${path}: HTTP ${res.status}`);
  const body = await res.json<{ headers: { status: string; code: number; error_message?: string }; results: T[] }>();
  if (body.headers.status !== 'success') {
    throw new Error(body.headers.code === 5 ? 'Jamendo rejected the client ID' : `Jamendo: ${body.headers.error_message || `error ${body.headers.code}`}`);
  }
  return body.results;
}

const albumId = (id: string) => `${ID}:album:${id}`;
const artistId = (id: string) => `${ID}:artist:${id}`;
const trackId = (id: string) => `${ID}:track:${id}`;
const year = (date?: string) => (date && /^\d{4}/.test(date) ? date.slice(0, 4) : undefined);

function licence(t: Pick<Track, 'license_ccurl' | 'name' | 'artist_name'>): Licence | undefined {
  if (!t.license_ccurl) return undefined;
  const name = ccLicenceName(t.license_ccurl);
  return { name, url: t.license_ccurl, attribution: `“${t.name}” by ${t.artist_name ?? 'unknown artist'} (Jamendo), ${name}` };
}

const jamendoLink = (url?: string) => (url ? [{ name: 'Jamendo', category: 'source', url }] : undefined);

function albumPreview(a: Album): MusicMetaPreview {
  return {
    id: albumId(a.id),
    type: 'music',
    name: a.name,
    poster: a.image || undefined,
    posterShape: 'square',
    releaseInfo: year(a.releasedate),
    music: { kind: 'album', artist: a.artist_name, artistId: a.artist_id ? artistId(a.artist_id) : undefined },
  };
}

function artistPreview(a: Artist): MusicMetaPreview {
  return { id: artistId(a.id), type: 'music', name: a.name, poster: a.image || undefined, posterShape: 'square', music: { kind: 'artist' } };
}

function trackPreview(t: Track): MusicMetaPreview {
  return {
    id: trackId(t.id),
    type: 'music',
    name: t.name,
    poster: t.image || t.album_image || undefined,
    posterShape: 'square',
    releaseInfo: year(t.releasedate),
    genres: t.musicinfo?.tags?.genres,
    music: {
      kind: 'track',
      artist: t.artist_name,
      artistId: t.artist_id ? artistId(t.artist_id) : undefined,
      album: t.album_name || undefined,
      albumId: t.album_id ? albumId(t.album_id) : undefined,
      duration: t.duration,
      licence: licence(t),
    },
  };
}

function track(t: Track, album: Partial<Album>, n: number): MusicTrack {
  const artist = t.artist_name ?? album.artist_name;
  return {
    id: trackId(t.id),
    title: t.name,
    episode: Number(t.position) || n,
    season: 1,
    released: t.releasedate ?? album.releasedate,
    music: {
      artist,
      artistId: (t.artist_id ?? album.artist_id) ? artistId((t.artist_id ?? album.artist_id)!) : undefined,
      album: t.album_name ?? album.name,
      albumId: (t.album_id ?? album.id) ? albumId((t.album_id ?? album.id)!) : undefined,
      duration: t.duration,
      licence: licence({ ...t, artist_name: artist }),
    },
  };
}

function parseId(id: string): { kind: string; jid: string } | null {
  const m = new RegExp(`^${ID}:(album|artist|track):(\\d+)$`).exec(id);
  return m ? { kind: m[1]!, jid: m[2]! } : null;
}

const source: MusicSource = {
  manifest: {
    id: ID,
    name: 'Jamendo',
    version: '1.0.0',
    description: 'Independent music under Creative Commons licences from jamendo.com. Needs a free Jamendo client ID (non-commercial use).',
    icon: 'icon.svg',
    attribution: 'Music from Jamendo (jamendo.com); each track under its Creative Commons licence',
    capabilities: { catalogs: true, search: true, meta: true, streams: true, downloadable: true, live: false },
    catalogs: [
      { id: 'popular-week', name: 'Popular this week', kind: 'album', extra: [{ name: 'skip' }] },
      { id: 'new', name: 'New releases', kind: 'album', extra: [{ name: 'skip' }] },
      { id: 'popular', name: 'Most popular albums', kind: 'album', extra: [{ name: 'skip' }] },
      { id: 'tracks', name: 'Popular tracks', kind: 'track', extra: [{ name: 'genre', options: TAGS }, { name: 'skip' }] },
      { id: 'artists', name: 'Popular artists', kind: 'artist', extra: [{ name: 'skip' }] },
      { id: 'search', name: 'Search', extra: [{ name: 'search', isRequired: true }] },
    ],
    settings: {
      clientId: { type: 'string', label: 'Client ID', secret: true, required: true, help: 'Free from devportal.jamendo.com (sign up, create an app). Non-commercial use only.' },
    },
    // no published numbers; Jamendo may limit callers, so stay modest
    rateLimit: { requestsPerSecond: 2, burst: 5, concurrency: 2 },
    // the API terms allow caching only as far as the app needs it
    cache: { catalog: 900, meta: 3600, streams: 1800 },
    allowedHosts: ['api.jamendo.com', '*.jamendo.com'],
  },

  async catalog(req, ctx) {
    const offset = req.skip ?? 0;
    const albums = (order: string) => api<Album>(ctx, 'albums', { order, limit: LIMIT, offset, imagesize: 600 }).then((r) => r.map(albumPreview));
    switch (req.catalogId) {
      case 'popular-week':
        return albums('popularity_week');
      case 'new':
        return albums('releasedate_desc');
      case 'popular':
        return albums('popularity_total');
      case 'tracks': {
        const r = await api<Track>(ctx, 'tracks', { order: 'popularity_week', tags: req.genre, limit: LIMIT, offset, imagesize: 600, include: 'musicinfo' });
        return r.map(trackPreview);
      }
      case 'artists': {
        const r = await api<Artist>(ctx, 'artists', { order: 'popularity_week', hasimage: 'true', limit: LIMIT, offset, imagesize: 600 });
        return r.map(artistPreview);
      }
      case 'search': {
        const term = req.search ?? '';
        const [artists, albumsFound, tracks] = await Promise.all([
          api<Artist>(ctx, 'artists', { namesearch: term, limit: 10, imagesize: 600 }),
          api<Album>(ctx, 'albums', { namesearch: term, limit: 20, imagesize: 600 }),
          api<Track>(ctx, 'tracks', { search: term, boost: 'popularity_total', limit: 20, imagesize: 600 }),
        ]);
        return [...artists.map(artistPreview), ...albumsFound.map(albumPreview), ...tracks.map(trackPreview)];
      }
      default:
        return [];
    }
  },

  async meta(id, ctx) {
    const p = parseId(id);
    if (!p) return null;
    if (p.kind === 'album') {
      const [album] = await api<Album>(ctx, 'albums/tracks', { id: p.jid, imagesize: 600 });
      if (!album) return null;
      const [info] = await api<Album>(ctx, 'albums', { id: p.jid, imagesize: 600 });
      const videos = (album.tracks ?? []).map((t, i) => track(t, album, i + 1));
      const meta: MusicMeta = {
        ...albumPreview({ ...album, ...info }),
        videos,
        music: { kind: 'album', artist: album.artist_name, artistId: album.artist_id ? artistId(album.artist_id) : undefined, trackCount: videos.length, licence: videos[0]?.music?.licence },
        links: jamendoLink(info?.shareurl),
      };
      return meta;
    }
    if (p.kind === 'artist') {
      const [artist] = await api<Artist>(ctx, 'artists/albums', { id: p.jid, imagesize: 600 });
      if (!artist) return null;
      const top = await api<Track>(ctx, 'tracks', { artist_id: p.jid, order: 'popularity_total', limit: 10, imagesize: 600 });
      const [info] = await api<Artist>(ctx, 'artists', { id: p.jid, imagesize: 600 });
      const meta: MusicMeta = {
        ...artistPreview({ ...artist, ...info }),
        videos: top.map((t, i) => ({ ...track(t, {}, i + 1), episode: i + 1 })),
        albums: (artist.albums ?? []).map((a) => albumPreview({ ...a, artist_id: artist.id, artist_name: artist.name })),
        links: jamendoLink(info?.shareurl),
      };
      return meta;
    }
    const [t] = await api<Track>(ctx, 'tracks', { id: p.jid, imagesize: 600, include: 'musicinfo' });
    return t ? { ...trackPreview(t), links: jamendoLink(t.shareurl) } : null;
  },

  async streams(id, ctx) {
    const p = parseId(id);
    if (!p || p.kind !== 'track') return [];
    // audio: stream in the best format the API serves (VBR MP3); audiodownload: FLAC where allowed
    const [t] = await api<Track>(ctx, 'tracks', { id: p.jid, audioformat: 'mp32', audiodlformat: 'flac' });
    if (!t?.audio) return [];
    const allowed = t.audiodownload_allowed === true && !!t.audiodownload;
    const base = t.name.replace(/[/\\?%*:|"<>]/g, '-');
    // the URLs carry the client ID, so the browser gets them through the backend's proxy
    const out: MusicStream[] = [
      { url: ctx.proxyUrl(t.audio), name: 'MP3 VBR', behaviorHints: { music: { codec: 'mp3', downloadable: false } } },
    ];
    if (allowed) {
      out.push({
        url: ctx.proxyUrl(t.audiodownload!),
        name: 'FLAC',
        description: 'Download allowed by the artist',
        behaviorHints: { music: { codec: 'flac', downloadable: true, filename: `${String(t.position ?? 1).padStart(2, '0')} - ${base}.flac` } },
      });
    }
    return out;
  },

  async test(ctx) {
    try {
      const r = await api<Track>(ctx, 'tracks', { limit: 1, order: 'popularity_week' });
      return { ok: true, message: `Jamendo API works (top track this week: “${r[0]?.name ?? '—'}”).` };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  },
};

export default source;
