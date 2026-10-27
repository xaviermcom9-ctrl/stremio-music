// stremio-music: the user's library (liked songs, saved albums/artists/stations, playlists), kept
// on the server (api/library). One store for the app; changes are applied optimistically and
// rolled back if the server refuses (e.g. Navidrome is down and can't take the star).

const EventEmitter = require('eventemitter3');
const { request } = require('stremio/sm/api');
const { toSnapshot } = require('stremio/music/data');

const key = (kind, id) => `${kind}\n${id}`;

class Library extends EventEmitter {
    constructor() {
        super();
        this.state = { loaded: false, items: [], playlists: [], errors: [], error: null };
        this.index = new Map();
        this.loading = null;
    }

    set(patch) {
        this.state = { ...this.state, ...patch };
        if (patch.items) this.index = new Map(this.state.items.map((i) => [key(i.kind, i.id), i]));
        this.emit('change');
    }

    /** Loads once; `refresh` pulls likes from synced sources again. */
    load(refresh = false) {
        if (this.loading && !refresh) return this.loading;
        this.loading = request('GET', `api/library${refresh ? '?refresh=1' : ''}`)
            .then((r) => this.set({ loaded: true, items: r.items, playlists: r.playlists, errors: r.errors ?? [], error: null }))
            .catch((e) => {
                this.loading = null;
                this.set({ loaded: true, error: e.message });
            });
        return this.loading;
    }

    has(kind, id) {
        return this.index.has(key(kind, id));
    }

    of(kind) {
        return this.state.items.filter((i) => i.kind === kind);
    }

    async save(kind, item, source) {
        const data = toSnapshot(item, source);
        if (this.has(kind, data.id)) return;
        const before = this.state.items;
        this.set({ items: [{ kind, id: data.id, data, addedAt: Date.now() }, ...before] });
        try {
            await request('PUT', 'api/library/items', { kind, item: data });
        } catch (e) {
            this.set({ items: before });
            throw e;
        }
    }

    async remove(kind, id) {
        const before = this.state.items;
        this.set({ items: before.filter((i) => !(i.kind === kind && i.id === id)) });
        try {
            await request('DELETE', `api/library/items?kind=${encodeURIComponent(kind)}&id=${encodeURIComponent(id)}`);
        } catch (e) {
            this.set({ items: before });
            throw e;
        }
    }

    toggle(kind, item, source) {
        return this.has(kind, item.id) ? this.remove(kind, item.id) : this.save(kind, item, source);
    }

    // ---------------------------------------------------------------- playlists

    replacePlaylist(p) {
        const rest = this.state.playlists.filter((x) => x.id !== p.id);
        this.set({ playlists: [p, ...rest] });
        this.emit('playlist', p.id);
        return p;
    }

    async createPlaylist(name, items = []) {
        const r = await request('POST', 'api/library/playlists', { name, items: items.map((i) => toSnapshot(i)) });
        return this.replacePlaylist(r.playlist);
    }

    async updatePlaylist(id, patch) {
        return this.replacePlaylist((await request('PATCH', `api/library/playlists/${id}`, patch)).playlist);
    }

    async deletePlaylist(id) {
        await request('DELETE', `api/library/playlists/${id}`);
        this.set({ playlists: this.state.playlists.filter((p) => p.id !== id) });
    }

    async addToPlaylist(id, items) {
        return this.replacePlaylist((await request('POST', `api/library/playlists/${id}/tracks`, { items: items.map((i) => toSnapshot(i)) })).playlist);
    }

    async removeFromPlaylist(id, entry) {
        return this.replacePlaylist((await request('DELETE', `api/library/playlists/${id}/tracks/${entry}`)).playlist);
    }

    async moveInPlaylist(id, entry, to) {
        return this.replacePlaylist((await request('POST', `api/library/playlists/${id}/move`, { entry, to })).playlist);
    }

    playlist(id) {
        return request('GET', `api/library/playlists/${id}`);
    }
}

let library = null;
const getLibrary = () => {
    if (library === null) library = new Library();
    return library;
};

module.exports = { getLibrary };
