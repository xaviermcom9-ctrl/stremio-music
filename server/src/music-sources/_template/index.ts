// Starter music source. Copy it with `npm run new-source <name>` (built-in, TypeScript) or
// `docker exec -it stremio-music sm-new-source <name>` (folder plugin, JavaScript), then replace
// the example data with calls to your service through ctx.fetch. See PLUGINS.md.
//
// This example needs no network: it serves a tiny in-memory catalogue so the contract tests can
// exercise every part of the interface. Its stream URLs are placeholders and won't play.
import type { MusicMeta, MusicMetaPreview, MusicSource, MusicStream, MusicTrack } from '../sdk.js';

const ID = 'example';

interface Album {
  key: string;
  title: string;
  artist: string;
  year: number;
  genre: string;
  tracks: string[];
}

const ALBUMS: Album[] = [
  { key: 'first-light', title: 'First Light', artist: 'Example Ensemble', year: 2021, genre: 'Ambient', tracks: ['Dawn', 'Haze', 'Noon'] },
  { key: 'night-drive', title: 'Night Drive', artist: 'The Placeholders', year: 2023, genre: 'Electronic', tracks: ['Ignition', 'Overpass', 'Exit 9', 'Home'] },
];

const LICENCE = { name: 'CC BY 4.0', url: 'https://creativecommons.org/licenses/by/4.0/' };

const albumId = (a: Album) => `${ID}:album:${a.key}`;
const trackId = (a: Album, n: number) => `${ID}:track:${a.key}:${n}`;

function preview(a: Album): MusicMetaPreview {
  return {
    id: albumId(a),
    type: 'music',
    name: a.title,
    posterShape: 'square',
    releaseInfo: String(a.year),
    genres: [a.genre],
    music: { kind: 'album', artist: a.artist, trackCount: a.tracks.length, licence: LICENCE },
  };
}

function tracks(a: Album): MusicTrack[] {
  return a.tracks.map((title, i) => ({
    id: trackId(a, i + 1),
    title,
    episode: i + 1,
    season: 1,
    released: `${a.year}-01-01T00:00:00.000Z`,
    music: { artist: a.artist, album: a.title, albumId: albumId(a), duration: 180 + i * 17, licence: LICENCE },
  }));
}

const source: MusicSource = {
  manifest: {
    id: ID,
    name: 'Example',
    version: '1.0.0',
    description: 'An example source with built-in demo data. Start new sources from this one.',
    icon: 'icon.svg',
    attribution: 'Demo data, no real service',
    capabilities: { catalogs: true, search: true, meta: true, streams: true, downloadable: true, live: false },
    catalogs: [
      { id: 'albums', name: 'Example albums', kind: 'album', extra: [{ name: 'genre', options: ['Ambient', 'Electronic'] }, { name: 'skip' }] },
      { id: 'search', name: 'Search', kind: 'album', extra: [{ name: 'search', isRequired: true }] },
    ],
    settings: {
      greeting: { type: 'string', label: 'Greeting', help: 'Shown by "Test connection".', default: 'Hello' },
      token: { type: 'string', label: 'Personal token', help: 'An example of a per-user secret.', secret: true, perUser: true },
    },
    rateLimit: { requestsPerSecond: 5, burst: 10, concurrency: 2 },
    cache: { catalog: 600, meta: 3600, streams: 300 },
    allowedHosts: [],
  },

  async catalog(req) {
    let list = ALBUMS;
    if (req.genre) list = list.filter((a) => a.genre === req.genre);
    if (req.search) {
      const q = req.search.toLowerCase();
      list = list.filter((a) => `${a.title} ${a.artist} ${a.tracks.join(' ')}`.toLowerCase().includes(q));
    }
    return list.slice(req.skip ?? 0, (req.skip ?? 0) + 100).map(preview);
  },

  async meta(id) {
    const a = ALBUMS.find((x) => albumId(x) === id);
    if (!a) return null;
    const meta: MusicMeta = { ...preview(a), description: `${a.title} by ${a.artist}.`, videos: tracks(a) };
    return meta;
  },

  async streams(id) {
    const m = new RegExp(`^${ID}:track:([^:]+):(\\d+)$`).exec(id);
    const a = m && ALBUMS.find((x) => x.key === m[1]);
    if (!a || !m || Number(m[2]) < 1 || Number(m[2]) > a.tracks.length) return [];
    const stream: MusicStream = {
      url: `https://example.invalid/${a.key}/${m[2]}.mp3`,
      name: 'MP3 320',
      behaviorHints: { music: { downloadable: true, codec: 'mp3', bitrate: 320, filename: `${String(m[2]).padStart(2, '0')} - ${a.tracks[Number(m[2]) - 1]}.mp3` } },
    };
    return [stream];
  },

  async test(ctx) {
    return { ok: true, message: `${ctx.settings.greeting ?? 'Hello'}${ctx.user ? `, ${ctx.user.username}` : ''}! ${ALBUMS.length} demo albums.` };
  },
};

export default source;
