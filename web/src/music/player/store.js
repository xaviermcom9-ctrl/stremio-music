// stremio-music: the music player. One <audio> element and one store for the whole app, so playback
// survives navigation (and switching to Movies & TV). The server picks the stream for each track
// (POST api/music/play) from what this browser can play; this side plays it, keeps the queue, and
// saves it per device and per user (to resume on another device).

const EventEmitter = require('eventemitter3');
const { request } = require('stremio/sm/api');
const { detectCaps, getDataSaver, storage, deviceId, deviceName } = require('./caps');
const mediaSession = require('./mediaSession');

const SAVE_LOCAL_MS = 5000;
const SAVE_SERVER_MS = 15000;
const NOW_PLAYING_MS = 20000;
const RECONNECT_DELAYS = [1, 2, 5, 10, 20, 30];
const SCROBBLE_FRACTION = 0.5;
const SCROBBLE_MAX_SECONDS = 240;
const MAX_QUEUE = 2000;

const shuffled = (list) => {
    const a = [...list];
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
};

/** Only what the queue needs; streams are chosen fresh at play time. */
const toItem = (t) => ({
    id: t.id,
    title: t.title ?? t.name ?? 'Untitled',
    artist: t.artist ?? t.music?.artist ?? null,
    album: t.album ?? t.music?.album ?? null,
    albumId: t.albumId ?? t.music?.albumId ?? null,
    artistId: t.artistId ?? t.music?.artistId ?? null,
    poster: t.poster ?? null,
    duration: typeof t.duration === 'number' ? t.duration : (t.music?.duration ?? null),
    live: Boolean(t.live ?? t.music?.live ?? t.music?.kind === 'station'),
    sourceName: t.sourceName ?? t.source?.name ?? null,
    // file name, for torrent files (codec detection)
    ...(t.file ? { file: t.file } : {}),
});

class Player extends EventEmitter {
    constructor() {
        super();
        this.audio = new Audio();
        this.audio.preload = 'auto';
        this.hls = null;
        this.yt = null;
        this.state = {
            queue: [],
            order: [],
            pos: -1,
            shuffle: false,
            repeat: 'off',
            volume: storage.get('sm.volume', 1),
            muted: false,
            status: 'idle',
            position: 0,
            duration: null,
            decision: null,
            error: null,
            nowPlaying: null,
            remote: null,
            dataSaver: getDataSaver(),
        };
        this.offset = 0;
        this.listened = 0;
        this.scrobbled = false;
        this.lastTick = null;
        this.loadSeq = 0;
        this.reconnectAttempt = 0;
        this.timers = {};
        this.audio.volume = this.state.volume;
        this.bindAudio();
        mediaSession.bind(this);
        this.restoreLocal();
        this.timers.local = setInterval(() => this.saveLocal(), SAVE_LOCAL_MS);
        window.addEventListener('pagehide', () => this.saveServer(true));
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'hidden') this.saveServer(true);
        });
        // a movie starting in Movies & TV pauses the music
        window.addEventListener('hashchange', () => {
            if (window.location.hash.startsWith('#/player/') && this.isPlaying()) this.pause();
        });
    }

    // ------------------------------------------------------------- state

    set(patch) {
        this.state = { ...this.state, ...patch };
        this.emit('change', this.state);
    }

    get current() {
        const { queue, order, pos } = this.state;
        return pos >= 0 && pos < order.length ? queue[order[pos]] : null;
    }

    isPlaying() {
        return this.state.status === 'playing' || this.state.status === 'loading' || this.state.status === 'reconnecting';
    }

    // ------------------------------------------------------------- queue

    /** Replace the queue and start at `start` (index into items). */
    playQueue(items, start = 0, { shuffle } = {}) {
        const queue = items.slice(0, MAX_QUEUE).map(toItem);
        if (queue.length === 0) return;
        const doShuffle = shuffle ?? this.state.shuffle;
        const order = doShuffle ? [start, ...shuffled(queue.map((_, i) => i).filter((i) => i !== start))] : queue.map((_, i) => i);
        this.set({ queue, order, pos: doShuffle ? 0 : start, shuffle: doShuffle, remote: null });
        this.load(true);
    }

    /** Add to the end, or right after the current track (`next`). */
    enqueue(items, { next = false } = {}) {
        const add = items.map(toItem);
        if (this.state.queue.length === 0) return this.playQueue(add, 0);
        const queue = [...this.state.queue, ...add].slice(0, MAX_QUEUE);
        const newIdx = add.map((_, i) => this.state.queue.length + i).filter((i) => i < queue.length);
        const order = [...this.state.order];
        order.splice(next ? this.state.pos + 1 : order.length, 0, ...newIdx);
        this.set({ queue, order });
        this.saveSoon();
    }

    /** Remove the track at a position in play order. */
    removeAt(orderPos) {
        if (orderPos === this.state.pos) return;
        const qIdx = this.state.order[orderPos];
        const queue = this.state.queue.filter((_, i) => i !== qIdx);
        const order = this.state.order.filter((_, p) => p !== orderPos).map((i) => (i > qIdx ? i - 1 : i));
        const pos = orderPos < this.state.pos ? this.state.pos - 1 : this.state.pos;
        this.set({ queue, order, pos });
        this.saveSoon();
    }

    clearUpcoming() {
        const keep = this.state.order.slice(0, this.state.pos + 1);
        const queue = keep.map((i) => this.state.queue[i]);
        this.set({ queue, order: queue.map((_, i) => i), pos: keep.length - 1 });
        this.saveSoon();
    }

    jumpTo(orderPos) {
        if (orderPos < 0 || orderPos >= this.state.order.length) return;
        this.set({ pos: orderPos });
        this.load(true);
    }

    setShuffle(on) {
        const { queue, order, pos } = this.state;
        if (queue.length === 0) return this.set({ shuffle: on });
        const cur = order[pos];
        const newOrder = on ? [cur, ...shuffled(queue.map((_, i) => i).filter((i) => i !== cur))] : queue.map((_, i) => i);
        this.set({ shuffle: on, order: newOrder, pos: on ? 0 : cur });
        this.saveSoon();
    }

    cycleRepeat() {
        const next = { off: 'all', all: 'one', one: 'off' }[this.state.repeat];
        this.set({ repeat: next });
        this.saveSoon();
    }

    next(auto = false) {
        const { pos, order, repeat } = this.state;
        if (auto && repeat === 'one') return this.seek(0, true);
        if (pos + 1 < order.length) {
            this.set({ pos: pos + 1 });
            return this.load(true);
        }
        if (repeat === 'all' && order.length) {
            this.set({ pos: 0 });
            return this.load(true);
        }
        if (auto) {
            this.stopMedia();
            this.set({ status: 'paused', position: 0 });
        }
    }

    prev() {
        if (this.position() > 3 || this.state.pos === 0) return this.seek(0);
        this.set({ pos: this.state.pos - 1 });
        this.load(true);
    }

    // ------------------------------------------------------------- loading a track

    async load(autoplay, startAt = 0) {
        const item = this.current;
        if (!item) return;
        const seq = ++this.loadSeq;
        this.stopMedia();
        this.clearTimer('nowPlaying');
        this.offset = 0;
        this.listened = 0;
        this.scrobbled = false;
        this.set({ status: autoplay ? 'loading' : 'paused', position: startAt, duration: item.duration ?? null, decision: null, error: null, nowPlaying: null });
        mediaSession.update(this);
        let decision;
        try {
            const caps = detectCaps();
            decision = await request('POST', 'api/music/play', {
                id: item.id,
                ...(item.file ? { name: item.file } : {}),
                caps: {
                    codecs: caps.codecs,
                    hls: caps.hls,
                    secure: window.location.protocol === 'https:',
                    ...(this.state.dataSaver ? { maxBitrate: this.state.dataSaver } : {}),
                },
            });
        } catch (error) {
            if (seq !== this.loadSeq) return;
            return this.fail(error.message, item.live);
        }
        if (seq !== this.loadSeq) return;
        this.set({ decision });
        if (decision.mode === 'youtube') return this.loadYouTube(decision, autoplay, startAt, seq);
        await this.attach(decision, startAt, seq);
        if (seq !== this.loadSeq) return;
        if (autoplay) this.play();
        if (item.live) this.pollNowPlaying(item, seq);
        this.saveSoon();
    }

    /** URL for the current decision, starting at `t` (transcodes restart server-side). */
    srcFor(decision, t) {
        if (decision.seek === 'restart' && t > 0) {
            this.offset = t;
            return `${decision.url}&t=${Math.floor(t)}`;
        }
        this.offset = 0;
        return decision.url;
    }

    async attach(decision, startAt, seq) {
        const src = this.srcFor(decision, startAt);
        if (decision.codec === 'hls' && !detectCaps().nativeHls) {
            const { default: Hls } = await import(/* webpackChunkName: "hls" */ 'hls.js');
            if (seq !== this.loadSeq) return;
            this.hls = new Hls({ enableWorker: true, lowLatencyMode: false });
            this.hls.on(Hls.Events.ERROR, (_e, data) => {
                if (data.fatal) this.onAudioError();
            });
            this.hls.loadSource(new URL(src, document.baseURI).href);
            this.hls.attachMedia(this.audio);
        } else {
            this.audio.src = src;
        }
        if (startAt > 0 && decision.seek === 'native') {
            this.audio.addEventListener('loadedmetadata', () => {
                this.audio.currentTime = startAt;
            }, { once: true });
        }
    }

    stopMedia() {
        this.clearTimer('reconnect');
        if (this.hls) {
            this.hls.destroy();
            this.hls = null;
        }
        if (this.yt) this.yt.stop();
        this.audio.pause();
        this.audio.removeAttribute('src');
        this.audio.load();
    }

    // ------------------------------------------------------------- transport

    play() {
        if (!this.current) return;
        if (this.state.decision?.mode === 'youtube') return this.yt?.play();
        if (!this.state.decision) return this.load(true, this.state.position);
        this.set({ status: this.audio.readyState >= 3 ? 'playing' : 'loading' });
        const p = this.audio.play();
        if (p && p.catch) {
            p.catch((err) => {
                if (err.name === 'NotAllowedError') this.set({ status: 'paused' });
                else if (err.name !== 'AbortError') this.onAudioError();
            });
        }
    }

    pause() {
        if (this.state.decision?.mode === 'youtube') this.yt?.pause();
        else this.audio.pause();
        this.set({ status: this.current ? 'paused' : 'idle' });
        this.clearTimer('reconnect');
        this.saveServer();
    }

    toggle() {
        if (this.isPlaying()) this.pause();
        else this.play();
    }

    position() {
        if (this.state.decision?.mode === 'youtube') return this.yt?.time() ?? 0;
        return this.offset + (this.audio.currentTime || 0);
    }

    seek(t, play = false) {
        const d = this.state.decision;
        const item = this.current;
        if (!d || !item || d.seek === 'none') return;
        const dur = this.state.duration ?? item.duration ?? Infinity;
        const target = Math.max(0, Math.min(t, Number.isFinite(dur) ? dur - 0.5 : t));
        if (d.mode === 'youtube') this.yt?.seek(target);
        else if (d.seek === 'restart') {
            const wasPlaying = play || this.isPlaying();
            this.audio.src = this.srcFor(d, target);
            if (wasPlaying) this.play();
        } else {
            this.audio.currentTime = target;
            if (play) this.play();
        }
        this.set({ position: target });
        mediaSession.position(this);
    }

    setVolume(v) {
        const volume = Math.max(0, Math.min(1, v));
        this.audio.volume = volume;
        this.yt?.volume(volume);
        storage.set('sm.volume', volume);
        this.set({ volume, muted: volume === 0 ? this.state.muted : false });
        this.audio.muted = this.state.muted;
    }

    toggleMute() {
        const muted = !this.state.muted;
        this.audio.muted = muted;
        this.yt?.mute(muted);
        this.set({ muted });
    }

    setDataSaver(kbps) {
        require('./caps').setDataSaver(kbps);
        this.set({ dataSaver: getDataSaver() });
        // apply now: reload the current track at the same position
        if (this.current && !this.current.live && this.state.decision) this.load(this.isPlaying(), this.position());
        else if (this.current?.live && this.state.decision) this.load(this.isPlaying());
    }

    // ------------------------------------------------------------- audio events

    bindAudio() {
        const a = this.audio;
        a.addEventListener('playing', () => {
            this.reconnectAttempt = 0;
            this.lastTick = performance.now();
            this.set({ status: 'playing', error: null });
            mediaSession.state(this);
            const item = this.current;
            if (item?.live && !this.scrobbled) this.reportPlayed('start');
        });
        a.addEventListener('pause', () => {
            if (this.state.status === 'playing') this.set({ status: 'paused' });
            mediaSession.state(this);
        });
        a.addEventListener('waiting', () => {
            if (this.state.status === 'playing') this.set({ status: 'loading' });
        });
        a.addEventListener('timeupdate', () => this.onTime());
        a.addEventListener('durationchange', () => {
            const d = this.state.decision;
            if (d && d.seek === 'native' && Number.isFinite(a.duration)) this.set({ duration: a.duration });
        });
        a.addEventListener('ended', () => {
            if (this.current?.live) return this.reconnect();
            this.next(true);
        });
        a.addEventListener('error', () => this.onAudioError());
        a.addEventListener('stalled', () => {
            if (this.current?.live && this.state.status === 'loading') this.reconnect();
        });
    }

    onTime() {
        const position = this.position();
        const now = performance.now();
        if (this.lastTick !== null && this.state.status === 'playing') this.listened += Math.min(5, (now - this.lastTick) / 1000);
        this.lastTick = now;
        this.set({ position });
        const item = this.current;
        const dur = this.state.duration ?? item?.duration;
        if (item && !item.live && !this.scrobbled && dur && (this.listened >= dur * SCROBBLE_FRACTION || this.listened >= SCROBBLE_MAX_SECONDS)) {
            this.reportPlayed('scrobble');
        }
        mediaSession.position(this);
    }

    reportPlayed(event) {
        this.scrobbled = true;
        const item = this.current;
        if (item) request('POST', 'api/music/played', { id: item.id, event }).catch(() => {});
    }

    onAudioError() {
        const item = this.current;
        if (!item || !this.state.decision) return;
        if (item.live) return this.reconnect();
        const err = this.audio.error;
        this.fail(err?.code === 4 ? 'This stream could not be played.' : 'Playback failed.', false);
    }

    fail(message, live) {
        if (live) return this.reconnect(message);
        this.set({ status: 'error', error: message });
        // skip to the next track after a moment, like a radio would
        this.timers.skip = setTimeout(() => {
            if (this.state.status === 'error') this.next(true);
        }, 3000);
    }

    /** Live streams: retry with backoff, asking the server for a fresh stream each time. */
    reconnect(reason) {
        if (this.timers.reconnect || !this.current) return;
        const delay = RECONNECT_DELAYS[Math.min(this.reconnectAttempt, RECONNECT_DELAYS.length - 1)];
        this.reconnectAttempt++;
        this.set({ status: 'reconnecting', error: reason ?? `Connection lost, retrying in ${delay}s…` });
        this.timers.reconnect = setTimeout(() => {
            this.timers.reconnect = null;
            this.load(true);
        }, delay * 1000);
    }

    clearTimer(name) {
        if (this.timers[name]) {
            clearTimeout(this.timers[name]);
            clearInterval(this.timers[name]);
            this.timers[name] = null;
        }
    }

    // ------------------------------------------------------------- radio "now playing"

    pollNowPlaying(item, seq) {
        const tick = () => {
            if (seq !== this.loadSeq) return this.clearTimer('nowPlaying');
            if (this.state.status !== 'playing' && this.state.status !== 'loading') return;
            request('GET', `api/music/nowplaying?id=${encodeURIComponent(item.id)}`)
                .then((r) => {
                    if (seq === this.loadSeq && r.title !== this.state.nowPlaying) {
                        this.set({ nowPlaying: r.title || null });
                        mediaSession.update(this);
                    }
                })
                .catch(() => {});
        };
        tick();
        this.timers.nowPlaying = setInterval(tick, NOW_PLAYING_MS);
    }

    // ------------------------------------------------------------- YouTube (official embedded player)

    async loadYouTube(decision, autoplay, startAt, seq) {
        const { createYouTube } = require('./youtube');
        if (!this.yt) this.yt = createYouTube(this);
        await this.yt.load(decision.ytId, startAt, autoplay);
        if (seq !== this.loadSeq) this.yt.stop();
    }

    // ------------------------------------------------------------- persistence

    snapshot() {
        const { queue, order, pos, shuffle, repeat } = this.state;
        return { queue, order, pos, shuffle, repeat, position: this.position(), savedAt: Date.now(), deviceId: deviceId() };
    }

    saveLocal() {
        if (this.state.queue.length) storage.set('sm.player', this.snapshot());
    }

    saveSoon() {
        this.saveLocal();
        clearTimeout(this.timers.server);
        this.timers.server = setTimeout(() => this.saveServer(), SAVE_SERVER_MS);
    }

    saveServer(beacon = false) {
        if (!this.state.queue.length) return;
        clearTimeout(this.timers.server);
        const body = JSON.stringify({ state: this.snapshot(), device: deviceName() });
        fetch('api/me/player', { method: 'PUT', headers: { 'content-type': 'application/json' }, body, keepalive: beacon && body.length < 60000, credentials: 'same-origin' }).catch(() => {});
    }

    restoreLocal() {
        const s = storage.get('sm.player', null);
        if (!s || !Array.isArray(s.queue) || s.queue.length === 0) return;
        this.applySnapshot(s);
    }

    applySnapshot(s) {
        const pos = Math.max(0, Math.min(s.pos ?? 0, (s.order?.length ?? s.queue.length) - 1));
        this.set({
            queue: s.queue,
            order: Array.isArray(s.order) && s.order.length === s.queue.length ? s.order : s.queue.map((_, i) => i),
            pos,
            shuffle: Boolean(s.shuffle),
            repeat: ['off', 'all', 'one'].includes(s.repeat) ? s.repeat : 'off',
            status: 'paused',
            position: s.queue[s.order?.[pos] ?? pos]?.live ? 0 : (s.position ?? 0),
            decision: null,
        });
    }

    /** After sign-in: offer the queue from another device if it's newer than ours. */
    async checkRemote() {
        try {
            const r = await request('GET', 'api/me/player');
            const s = r.state;
            if (!s || !Array.isArray(s.queue) || s.deviceId === deviceId()) return;
            const local = storage.get('sm.player', null);
            if (local && local.savedAt >= (s.savedAt ?? 0)) return;
            this.set({ remote: { state: s, device: r.device, updatedAt: r.updatedAt } });
        } catch (_) {
            // offline or signed out: nothing to offer
        }
    }

    acceptRemote() {
        const r = this.state.remote;
        if (!r) return;
        this.stopMedia();
        this.applySnapshot(r.state);
        this.set({ remote: null });
        this.saveLocal();
    }

    dismissRemote() {
        this.set({ remote: null });
    }
}

let instance = null;
const getPlayer = () => {
    if (!instance) instance = new Player();
    return instance;
};

module.exports = { getPlayer, toItem };
