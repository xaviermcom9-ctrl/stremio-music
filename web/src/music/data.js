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
            sourceName,
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

module.exports = { api, queueItems, playMeta };
