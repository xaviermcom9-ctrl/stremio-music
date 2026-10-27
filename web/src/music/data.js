// stremio-music: Music API client (cached briefly so navigating back is instant) and the
// helpers that turn metas into queue items.

const { request } = require('stremio/sm/api');

const TTL_MS = 60_000;
const cache = new Map();

const cached = (key, load) => {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < TTL_MS) return hit.promise;
    const promise = load().catch((error) => {
        cache.delete(key);
        throw error;
    });
    cache.set(key, { at: Date.now(), promise });
    if (cache.size > 300) cache.delete(cache.keys().next().value);
    return promise;
};

const qs = (params) => new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '')).toString();

const api = {
    sources: () => cached('sources', () => request('GET', 'api/music/sources').then((r) => r.sources)),
    catalog: (source, catalog, extra = {}) =>
        cached(`cat:${source}:${catalog}:${qs(extra)}`, () => request('GET', `api/music/catalog/${encodeURIComponent(source)}/${encodeURIComponent(catalog)}${Object.keys(extra).length ? `?${qs(extra)}` : ''}`)),
    search: (q) => cached(`search:${q}`, () => request('GET', `api/music/search?${qs({ q })}`)),
    meta: (id) => cached(`meta:${id}`, () => request('GET', `api/music/meta?${qs({ id })}`)),
    streams: (id) => request('GET', `api/music/streams?${qs({ id })}`),
    artist: (id) => cached(`artist:${id}`, () => request('GET', `api/music/artist?${qs({ id })}`)),
    alternatives: (id) => cached(`alt:${id}`, () => request('GET', `api/music/alternatives?${qs({ id })}`)),
    torrentFiles: (ih, trackers = []) => request('GET', `api/music/torrent/${ih}?${trackers.map((t) => `tr=${encodeURIComponent(t)}`).join('&')}`),
};

/** Queue items for a meta: an album/playlist/artist's tracks, or the item itself. */
const queueItems = (meta, source) => {
    const sourceName = source?.name ?? null;
    if (Array.isArray(meta.videos) && meta.videos.length) {
        return meta.videos.map((v) => ({
            id: v.id,
            title: v.title,
            artist: v.music?.artist ?? meta.music?.artist ?? null,
            artistId: v.music?.artistId ?? meta.music?.artistId ?? null,
            album: v.music?.album ?? (meta.music?.kind === 'album' ? meta.name : null),
            albumId: v.music?.albumId ?? (meta.music?.kind === 'album' ? meta.id : null),
            poster: v.thumbnail ?? meta.poster ?? null,
            duration: v.music?.duration ?? null,
            live: false,
            sourceName: v.source?.name ?? sourceName,
        }));
    }
    const kind = meta.music?.kind;
    if (kind === 'track' || kind === 'station' || !kind) {
        return [{
            id: meta.id,
            title: meta.name,
            artist: meta.music?.artist ?? null,
            artistId: meta.music?.artistId ?? null,
            album: meta.music?.album ?? null,
            albumId: meta.music?.albumId ?? null,
            poster: meta.poster ?? null,
            duration: meta.music?.duration ?? null,
            live: kind === 'station' || Boolean(meta.music?.live),
            sourceName,
        }];
    }
    return [];
};

/** Plays a catalog item: fetches the full meta when it's a container (album, playlist, artist). */
const playMeta = async (player, preview, { shuffle = false, start = 0 } = {}) => {
    const kind = preview.music?.kind;
    if (kind === 'track' || kind === 'station') return player.playQueue(queueItems(preview, preview.source), 0);
    const { meta, source } = await api.meta(preview.id);
    const items = queueItems(meta, source);
    if (items.length) player.playQueue(items, shuffle ? Math.floor(Math.random() * items.length) : start, { shuffle });
};

/** Library kind of a meta (tracks of albums have no `music.kind`). */
const libraryKind = (meta) => {
    const k = meta.music?.kind;
    if (k === 'station' || meta.music?.live) return 'station';
    return ['album', 'artist', 'playlist'].includes(k) ? k : 'track';
};

const sourceIdOf = (id) => (typeof id === 'string' && id.includes(':') ? id.slice(0, id.indexOf(':')) : null);

/** What the library stores of a meta preview or a queue item (see server/src/music/library.ts). */
const toSnapshot = (x, source) => {
    const src = source ?? x.source ?? (x.sourceName ? { id: sourceIdOf(x.id), name: x.sourceName } : null);
    const isQueueItem = 'title' in x && !('name' in x);
    const music = isQueueItem ?
        { kind: x.live ? 'station' : 'track', artist: x.artist, artistId: x.artistId, album: x.album, albumId: x.albumId, duration: x.duration, live: x.live || undefined }
        :
        { ...x.music, kind: libraryKind(x) };
    const clean = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== ''));
    return clean({
        id: x.id,
        name: isQueueItem ? x.title : x.name,
        poster: x.poster,
        posterShape: x.posterShape,
        releaseInfo: x.releaseInfo,
        source: src && src.id && src.name ? { id: src.id, name: src.name } : undefined,
        music: clean({
            kind: music.kind,
            artist: music.artist,
            artistId: music.artistId,
            album: music.album,
            albumId: music.albumId,
            duration: typeof music.duration === 'number' ? music.duration : undefined,
            live: music.live,
            trackCount: music.trackCount,
            mbid: music.mbid,
        }),
    });
};

/** Library/playlist track snapshot -> queue item. */
const snapshotToItem = (s) => ({
    id: s.id,
    title: s.name,
    artist: s.music?.artist ?? null,
    artistId: s.music?.artistId ?? null,
    album: s.music?.album ?? null,
    albumId: s.music?.albumId ?? null,
    poster: s.poster ?? null,
    duration: s.music?.duration ?? null,
    live: s.music?.kind === 'station' || Boolean(s.music?.live),
    sourceName: s.source?.name ?? null,
});

module.exports = { api, queueItems, playMeta, toSnapshot, snapshotToItem, libraryKind, sourceIdOf };
