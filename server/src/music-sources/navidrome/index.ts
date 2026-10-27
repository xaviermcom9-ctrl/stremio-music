// Navidrome (or any Subsonic/OpenSubsonic server). The admin sets the server URL; every app user
// enters their own login, so stars, playlists and play counts are theirs. Auth is Subsonic's
// token scheme (md5(password + salt), new salt per request): the password never travels, but the
// token is replayable, so stream and cover URLs go through ctx.proxyUrl and never reach the browser.
// API: https://www.subsonic.org/pages/api.jsp, https://opensubsonic.netlify.app/
import { createHash, randomBytes } from 'node:crypto';
import type { MusicMeta, MusicMetaPreview, MusicSource, MusicStream, MusicTrack, SourceContext } from '../sdk.js';

const ID = 'navidrome';
const API_VERSION = '1.16.1';
const CLIENT = 'stremio-music';
const PAGE = 50;

interface SubsonicError {
  code: number;
  message: string;
}

/** Subsonic error codes worth telling the user about. */
const ERRORS: Record<number, string> = {
  10: 'missing parameter',
  20: 'client too old for this server',
  30: 'server too old for this client',
  40: 'wrong username or password',
  41: 'token authentication not supported (LDAP account?)',
  50: 'not allowed for this user',
  70: 'not found',
};

class NotFound extends Error {}

function auth(ctx: SourceContext): URLSearchParams {
  const { username, password } = ctx.settings;
  if (!username || !password) throw new Error('enter your Navidrome username and password under Sources → Navidrome → Your settings');
  const salt = randomBytes(6).toString('hex');
  return new URLSearchParams({
    u: String(username),
    t: createHash('md5').update(String(password) + salt).digest('hex'),
    s: salt,
    v: API_VERSION,
    c: CLIENT,
    f: 'json',
  });
}

type Params = Record<string, string | number | string[] | undefined>;

function query(ctx: SourceContext, params: Params): URLSearchParams {
  const q = auth(ctx);
  for (const [k, v] of Object.entries(params)) {
    if (Array.isArray(v)) v.forEach((x) => q.append(k, x));
    else if (v !== undefined && v !== '') q.set(k, String(v));
  }
  return q;
}

function endpoint(ctx: SourceContext, name: string, params: Params = {}): string {
  const server = String(ctx.settings.server ?? '').replace(/\/+$/, '');
  if (!server) throw new Error('set the Navidrome server URL');
  return `${server}/rest/${name}.view?${query(ctx, params)}`;
}

/** `post`: parameters go in a form body (long song lists would overflow a URL). */
async function api<T = Record<string, unknown>>(ctx: SourceContext, name: string, params: Params = {}, post = false): Promise<T> {
  const res = post
    ? await ctx.fetch(endpoint(ctx, name), { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: query(ctx, params).toString() })
    : await ctx.fetch(endpoint(ctx, name, params));
  if (!res.ok) throw new Error(`Navidrome ${name}: HTTP ${res.status}`);
  const body = (await res.json<{ 'subsonic-response'?: Record<string, unknown> & { status: string; error?: SubsonicError } }>())['subsonic-response'];
  if (!body) throw new Error(`Navidrome ${name}: not a Subsonic response (is the server URL right?)`);
  if (body.status !== 'ok') {
    const e = body.error ?? { code: 0, message: 'unknown error' };
    if (e.code === 70) throw new NotFound(e.message);
    throw new Error(`Navidrome: ${ERRORS[e.code] ?? e.message} (code ${e.code})`);
  }
  return body as T;
}

const asList = <T>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

// ---- Subsonic shapes (only what we read)

interface Album {
  id: string;
  name: string;
  artist?: string;
  artistId?: string;
  coverArt?: string;
  songCount?: number;
  year?: number;
  genre?: string;
  musicBrainzId?: string;
  song?: Song[];
}
interface Song {
  id: string;
  title: string;
  album?: string;
  albumId?: string;
  artist?: string;
  artistId?: string;
  track?: number;
  discNumber?: number;
  year?: number;
  duration?: number;
  suffix?: string;
  bitRate?: number;
  coverArt?: string;
  musicBrainzId?: string;
  contentType?: string;
}
interface Artist {
  id: string;
  name: string;
  coverArt?: string;
  albumCount?: number;
  musicBrainzId?: string;
  album?: Album[];
}
interface Playlist {
  id: string;
  name: string;
  comment?: string;
  songCount?: number;
  coverArt?: string;
  entry?: Song[];
}

// ---- mapping

const albumId = (id: string) => `${ID}:album:${id}`;
const artistId = (id: string) => `${ID}:artist:${id}`;
const trackId = (id: string) => `${ID}:track:${id}`;
const playlistId = (id: string) => `${ID}:playlist:${id}`;

function cover(ctx: SourceContext, coverArt: string | undefined): string | undefined {
  return coverArt ? ctx.proxyUrl(endpoint(ctx, 'getCoverArt', { id: coverArt, size: 600 })) : undefined;
}

function albumPreview(ctx: SourceContext, a: Album): MusicMetaPreview {
  return {
    id: albumId(a.id),
    type: 'music',
    name: a.name,
    poster: cover(ctx, a.coverArt),
    posterShape: 'square',
    releaseInfo: a.year ? String(a.year) : undefined,
    genres: a.genre ? [a.genre] : undefined,
    music: {
      kind: 'album',
      artist: a.artist,
      artistId: a.artistId ? artistId(a.artistId) : undefined,
      mbid: a.musicBrainzId || undefined,
      trackCount: a.songCount,
    },
  };
}

function artistPreview(ctx: SourceContext, a: Artist): MusicMetaPreview {
  return {
    id: artistId(a.id),
    type: 'music',
    name: a.name,
    poster: cover(ctx, a.coverArt),
    posterShape: 'square',
    music: { kind: 'artist', mbid: a.musicBrainzId || undefined, trackCount: undefined },
  };
}

function playlistPreview(ctx: SourceContext, p: Playlist): MusicMetaPreview {
  return {
    id: playlistId(p.id),
    type: 'music',
    name: p.name,
    poster: cover(ctx, p.coverArt),
    posterShape: 'square',
    description: p.comment || undefined,
    music: { kind: 'playlist', trackCount: p.songCount },
  };
}

function songPreview(ctx: SourceContext, s: Song): MusicMetaPreview {
  return {
    id: trackId(s.id),
    type: 'music',
    name: s.title,
    poster: cover(ctx, s.coverArt),
    posterShape: 'square',
    releaseInfo: s.year ? String(s.year) : undefined,
    music: {
      kind: 'track',
      artist: s.artist,
      artistId: s.artistId ? artistId(s.artistId) : undefined,
      album: s.album,
      albumId: s.albumId ? albumId(s.albumId) : undefined,
      duration: s.duration,
      mbid: s.musicBrainzId || undefined,
    },
  };
}

function track(s: Song, n?: number): MusicTrack {
  return {
    id: trackId(s.id),
    title: s.title,
    episode: s.track ?? n,
    season: s.discNumber ?? 1,
    released: s.year ? `${s.year}-01-01T00:00:00.000Z` : undefined,
    music: {
      artist: s.artist,
      artistId: s.artistId ? artistId(s.artistId) : undefined,
      album: s.album,
      albumId: s.albumId ? albumId(s.albumId) : undefined,
      duration: s.duration,
      mbid: s.musicBrainzId || undefined,
    },
  };
}

function parseId(id: string): { kind: string; nid: string } | null {
  const m = new RegExp(`^${ID}:(album|artist|track|playlist):(.+)$`).exec(id);
  return m ? { kind: m[1]!, nid: m[2]! } : null;
}

async function albumList(ctx: SourceContext, type: string, skip = 0, extra: Record<string, string> = {}) {
  const r = await api<{ albumList2?: { album?: Album[] } }>(ctx, 'getAlbumList2', { type, size: PAGE, offset: skip, ...extra });
  return asList(r.albumList2?.album).map((a) => albumPreview(ctx, a));
}

const source: MusicSource = {
  manifest: {
    id: ID,
    name: 'Navidrome',
    version: '1.0.0',
    description: 'Your own music library on Navidrome (or any Subsonic server). Each user signs in with their own Navidrome account.',
    icon: 'icon.svg',
    capabilities: { catalogs: true, search: true, meta: true, streams: true, downloadable: false, live: false },
    catalogs: [
      { id: 'newest', name: 'Recently added', kind: 'album', extra: [{ name: 'skip' }] },
      { id: 'frequent', name: 'Most played', kind: 'album', extra: [{ name: 'skip' }] },
      { id: 'starred', name: 'Starred' },
      { id: 'random', name: 'Random albums', kind: 'album' },
      { id: 'artists', name: 'Artists', kind: 'artist', extra: [{ name: 'skip' }] },
      { id: 'playlists', name: 'Playlists', kind: 'playlist' },
      { id: 'genre', name: 'By genre', kind: 'album', extra: [{ name: 'genre', isRequired: true }, { name: 'skip' }] },
      { id: 'search', name: 'Search', extra: [{ name: 'search', isRequired: true }] },
    ],
    settings: {
      server: { type: 'url', label: 'Server URL', default: 'http://navidrome:4533', required: true, help: 'As seen from this container, e.g. http://navidrome:4533 on the shared Docker network.' },
      username: { type: 'string', label: 'Navidrome username', perUser: true, required: true },
      password: { type: 'string', label: 'Navidrome password', perUser: true, secret: true, required: true },
    },
    // a server on your own network: generous, but don't hammer it
    rateLimit: { requestsPerSecond: 20, burst: 40, concurrency: 6 },
    cache: { catalog: 120, meta: 600, streams: 3600 },
    allowedHosts: [],
  },

  async catalog(req, ctx) {
    const skip = req.skip ?? 0;
    switch (req.catalogId) {
      case 'newest':
        return albumList(ctx, 'newest', skip);
      case 'frequent':
        return albumList(ctx, 'frequent', skip);
      case 'random':
        return albumList(ctx, 'random');
      case 'genre':
        return albumList(ctx, 'byGenre', skip, { genre: req.genre ?? '' });
      case 'starred': {
        const r = await api<{ starred2?: { album?: Album[]; song?: Song[]; artist?: Artist[] } }>(ctx, 'getStarred2');
        return [
          ...asList(r.starred2?.artist).map((a) => artistPreview(ctx, a)),
          ...asList(r.starred2?.album).map((a) => albumPreview(ctx, a)),
          ...asList(r.starred2?.song).map((s) => songPreview(ctx, s)),
        ];
      }
      case 'artists': {
        const r = await api<{ artists?: { index?: { artist?: Artist[] }[] } }>(ctx, 'getArtists');
        const all = asList(r.artists?.index).flatMap((i) => asList(i.artist));
        return all.slice(skip, skip + 100).map((a) => artistPreview(ctx, a));
      }
      case 'playlists': {
        const r = await api<{ playlists?: { playlist?: Playlist[] } }>(ctx, 'getPlaylists');
        return asList(r.playlists?.playlist).map((p) => playlistPreview(ctx, p));
      }
      case 'search': {
        const r = await api<{ searchResult3?: { artist?: Artist[]; album?: Album[]; song?: Song[] } }>(ctx, 'search3', {
          query: req.search ?? '',
          artistCount: 10,
          albumCount: 20,
          songCount: 20,
        });
        return [
          ...asList(r.searchResult3?.artist).map((a) => artistPreview(ctx, a)),
          ...asList(r.searchResult3?.album).map((a) => albumPreview(ctx, a)),
          ...asList(r.searchResult3?.song).map((s) => songPreview(ctx, s)),
        ];
      }
      default:
        return [];
    }
  },

  async meta(id, ctx) {
    const p = parseId(id);
    if (!p) return null;
    try {
      if (p.kind === 'album') {
        const { album } = await api<{ album: Album }>(ctx, 'getAlbum', { id: p.nid });
        const songs = asList(album.song);
        const meta: MusicMeta = { ...albumPreview(ctx, album), videos: songs.map((s, i) => track(s, i + 1)) };
        return meta;
      }
      if (p.kind === 'artist') {
        const { artist } = await api<{ artist: Artist }>(ctx, 'getArtist', { id: p.nid });
        const albums = asList(artist.album);
        // top songs come from Navidrome's agents (Last.fm…); without them, use the newest albums' tracks
        let songs: Song[] = [];
        try {
          const top = await api<{ topSongs?: { song?: Song[] } }>(ctx, 'getTopSongs', { artist: artist.name, count: 10 });
          songs = asList(top.topSongs?.song);
        } catch {
          songs = [];
        }
        if (songs.length === 0) {
          for (const a of [...albums].sort((x, y) => (y.year ?? 0) - (x.year ?? 0)).slice(0, 3)) {
            const { album } = await api<{ album: Album }>(ctx, 'getAlbum', { id: a.id });
            songs.push(...asList(album.song));
            if (songs.length >= 20) break;
          }
        }
        const meta: MusicMeta = {
          ...artistPreview(ctx, artist),
          music: { kind: 'artist', mbid: artist.musicBrainzId || undefined, trackCount: songs.length },
          videos: songs.slice(0, 20).map((s, i) => track(s, i + 1)),
          albums: albums.map((a) => albumPreview(ctx, a)),
        };
        return meta;
      }
      if (p.kind === 'playlist') {
        const { playlist } = await api<{ playlist: Playlist }>(ctx, 'getPlaylist', { id: p.nid });
        const meta: MusicMeta = {
          ...playlistPreview(ctx, playlist),
          // playlists can hold the same song twice; track ids must be unique, so keep the first
          videos: asList(playlist.entry)
            .filter((s, i, all) => all.findIndex((x) => x.id === s.id) === i)
            .map((s, i) => ({ ...track(s), episode: i + 1, season: 1 })),
        };
        return meta;
      }
      const { song } = await api<{ song: Song }>(ctx, 'getSong', { id: p.nid });
      return { ...songPreview(ctx, song) };
    } catch (err) {
      if (err instanceof NotFound) return null;
      throw err;
    }
  },

  async streams(id, ctx) {
    const p = parseId(id);
    if (!p || p.kind !== 'track') return [];
    let song: Song;
    try {
      ({ song } = await api<{ song: Song }>(ctx, 'getSong', { id: p.nid }));
    } catch (err) {
      if (err instanceof NotFound) return [];
      throw err;
    }
    const codec = (song.suffix ?? 'audio').toLowerCase();
    const original: MusicStream = {
      url: ctx.proxyUrl(endpoint(ctx, 'stream', { id: song.id, format: 'raw' })),
      name: `${codec.toUpperCase()}${song.bitRate ? ` ${song.bitRate}` : ''}`,
      description: 'Original file',
      behaviorHints: { music: { codec, bitrate: song.bitRate } },
    };
    if (codec === 'mp3' && (song.bitRate ?? 0) <= 320) return [original];
    // Navidrome transcodes server-side when a client can't play the original (e.g. ALAC)
    const mp3: MusicStream = {
      url: ctx.proxyUrl(endpoint(ctx, 'stream', { id: song.id, format: 'mp3', maxBitRate: 320 })),
      name: 'MP3 320',
      description: 'Transcoded by Navidrome',
      behaviorHints: { music: { codec: 'mp3', bitrate: 320 } },
    };
    return [original, mp3];
  },

  async test(ctx) {
    try {
      const r = await api<{ serverVersion?: string; type?: string }>(ctx, 'ping');
      return { ok: true, message: `Connected to ${r.type ?? 'Subsonic'} ${r.serverVersion ?? ''} as ${ctx.settings.username}.`.replace(/\s+/g, ' ') };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  },

  hooks: {
    async scrobble(id, ctx) {
      const p = parseId(id);
      if (p?.kind === 'track') await api(ctx, 'scrobble', { id: p.nid, submission: 'true' });
    },
    async setLiked(id, liked, ctx) {
      const p = parseId(id);
      if (!p) return;
      const param = p.kind === 'album' ? 'albumId' : p.kind === 'artist' ? 'artistId' : 'id';
      await api(ctx, liked ? 'star' : 'unstar', { [param]: p.nid });
    },
    async listLiked(ctx) {
      const r = await api<{ starred2?: { album?: Album[]; song?: Song[]; artist?: Artist[] } }>(ctx, 'getStarred2');
      return [
        ...asList(r.starred2?.song).map((s) => songPreview(ctx, s)),
        ...asList(r.starred2?.album).map((a) => albumPreview(ctx, a)),
        ...asList(r.starred2?.artist).map((a) => artistPreview(ctx, a)),
      ];
    },
    async savePlaylist({ remoteId, name, description, trackIds }, ctx) {
      const songId = trackIds.flatMap((id) => {
        const p = parseId(id);
        return p?.kind === 'track' ? [p.nid] : [];
      });
      let id = remoteId;
      if (id) {
        // createPlaylist with an id replaces its songs; the playlist may have been deleted in Navidrome
        try {
          await api(ctx, 'createPlaylist', { playlistId: id, songId }, true);
        } catch (err) {
          if (!(err instanceof NotFound)) throw err;
          id = undefined;
        }
      }
      if (!id) {
        const r = await api<{ playlist?: { id: string } }>(ctx, 'createPlaylist', { name, songId }, true);
        if (!r.playlist?.id) throw new Error('Navidrome did not return the new playlist');
        id = r.playlist.id;
      }
      await api(ctx, 'updatePlaylist', { playlistId: id, name, comment: description });
      return id;
    },
    async deletePlaylist(remoteId, ctx) {
      try {
        await api(ctx, 'deletePlaylist', { id: remoteId });
      } catch (err) {
        if (!(err instanceof NotFound)) throw err;
      }
    },
  },
};

export default source;
