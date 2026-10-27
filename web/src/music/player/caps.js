// stremio-music: what this browser's <audio> can play, sent to the server so it can pick a stream
// (or transcode). Also the per-device settings: data saver and a device id/name for "resume".

const probe = document.createElement('audio');
const can = (type) => {
    try {
        return probe.canPlayType(type) !== '';
    } catch (_) {
        return false;
    }
};

let cached = null;

const detectCaps = () => {
    if (cached) return cached;
    const codecs = [];
    if (can('audio/mpeg')) codecs.push('mp3');
    if (can('audio/mp4; codecs="mp4a.40.2"') || can('audio/aac')) codecs.push('aac');
    if (can('audio/flac') || can('audio/x-flac')) codecs.push('flac');
    if (can('audio/ogg; codecs="vorbis"')) codecs.push('vorbis');
    if (can('audio/ogg; codecs="opus"') || can('audio/webm; codecs="opus"')) codecs.push('opus');
    if (can('audio/wav') || can('audio/x-wav')) codecs.push('wav');
    if (can('audio/mp4; codecs="alac"')) codecs.push('alac');
    const nativeHls = can('application/vnd.apple.mpegurl');
    const mse = typeof window.MediaSource !== 'undefined' && window.MediaSource.isTypeSupported?.('audio/mp4; codecs="mp4a.40.2"');
    cached = { codecs, hls: Boolean(nativeHls || mse), nativeHls };
    return cached;
};

const storage = {
    get(key, fallback) {
        try {
            const v = window.localStorage.getItem(key);
            return v === null ? fallback : JSON.parse(v);
        } catch (_) {
            return fallback;
        }
    },
    set(key, value) {
        try {
            window.localStorage.setItem(key, JSON.stringify(value));
        } catch (_) {
            // private mode etc.: settings just don't persist
        }
    },
};

/** Data saver, per device: 0 = off, else max kbit/s. */
const DATA_SAVER_OPTIONS = [0, 192, 128, 96, 64];
const getDataSaver = () => {
    const v = storage.get('sm.dataSaver', 0);
    return DATA_SAVER_OPTIONS.includes(v) ? v : 0;
};
const setDataSaver = (kbps) => storage.set('sm.dataSaver', DATA_SAVER_OPTIONS.includes(kbps) ? kbps : 0);

const deviceId = () => {
    let id = storage.get('sm.deviceId', null);
    if (!id) {
        id = Math.random().toString(36).slice(2, 10);
        storage.set('sm.deviceId', id);
    }
    return id;
};

const deviceName = () => {
    const ua = navigator.userAgent;
    const browser = navigator.brave ? 'Brave' : /Firefox\//.test(ua) ? 'Firefox' : /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
    const os = /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : 'unknown';
    return `${browser} on ${os}`;
};

module.exports = { detectCaps, storage, DATA_SAVER_OPTIONS, getDataSaver, setDataSaver, deviceId, deviceName };
