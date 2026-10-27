// stremio-music: Media Session API: media keys, the desktop's media controls (MPRIS on Linux) and
// lock-screen / notification controls on Android.

const supported = () => typeof navigator !== 'undefined' && 'mediaSession' in navigator;

const absolute = (url) => {
    try {
        return new URL(url, document.baseURI).href;
    } catch (_) {
        return null;
    }
};

const bind = (player) => {
    if (!supported()) return;
    const ms = navigator.mediaSession;
    const handlers = {
        play: () => player.play(),
        pause: () => player.pause(),
        stop: () => player.pause(),
        previoustrack: () => player.prev(),
        nexttrack: () => player.next(),
        seekto: (d) => player.seek(d.seekTime),
        seekbackward: (d) => player.seek(player.position() - (d.seekOffset || 10)),
        seekforward: (d) => player.seek(player.position() + (d.seekOffset || 10)),
    };
    for (const [action, fn] of Object.entries(handlers)) {
        try {
            ms.setActionHandler(action, fn);
        } catch (_) {
            // not supported by this browser
        }
    }
};

const update = (player) => {
    if (!supported()) return;
    const item = player.current;
    if (!item) {
        navigator.mediaSession.metadata = null;
        return;
    }
    const live = item.live;
    const art = item.poster ? absolute(item.poster) : null;
    navigator.mediaSession.metadata = new window.MediaMetadata({
        // for radio, the station is the "album" and the current song (ICY) the title
        title: live && player.state.nowPlaying ? player.state.nowPlaying : item.title,
        artist: live ? (player.state.nowPlaying ? item.title : 'Live radio') : (item.artist ?? ''),
        album: live ? 'Live radio' : (item.album ?? ''),
        artwork: art ? [{ src: art, sizes: '512x512' }] : [],
    });
    // live streams can't seek
    for (const action of ['seekto', 'seekbackward', 'seekforward']) {
        try {
            navigator.mediaSession.setActionHandler(action, live ? null : (d) => {
                if (action === 'seekto') player.seek(d.seekTime);
                else player.seek(player.position() + (action === 'seekforward' ? 1 : -1) * (d.seekOffset || 10));
            });
        } catch (_) {
            // ignore
        }
    }
};

const state = (player) => {
    if (!supported()) return;
    navigator.mediaSession.playbackState = player.isPlaying() ? 'playing' : player.current ? 'paused' : 'none';
};

let lastPositionUpdate = 0;
const position = (player) => {
    if (!supported() || !navigator.mediaSession.setPositionState) return;
    const item = player.current;
    const duration = player.state.duration ?? item?.duration;
    if (!item || item.live || !duration || !Number.isFinite(duration)) return;
    const now = Date.now();
    if (now - lastPositionUpdate < 1000) return;
    lastPositionUpdate = now;
    try {
        navigator.mediaSession.setPositionState({ duration, playbackRate: 1, position: Math.min(player.position(), duration) });
    } catch (_) {
        // position briefly out of range while seeking
    }
};

module.exports = { bind, update, state, position };
