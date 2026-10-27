// stremio-music: YouTube streams (ytId from remote addons) are play-only and use YouTube's official
// embedded player, shown at 200×200 (YouTube's terms require the player to stay visible); audio is
// never extracted. Loaded only when a YouTube stream is played.

const API = 'https://www.youtube.com/iframe_api';
let apiPromise = null;

const loadApi = () => {
    if (window.YT && window.YT.Player) return Promise.resolve(window.YT);
    if (!apiPromise) {
        apiPromise = new Promise((resolve, reject) => {
            const previous = window.onYouTubeIframeAPIReady;
            window.onYouTubeIframeAPIReady = () => {
                previous?.();
                resolve(window.YT);
            };
            const s = document.createElement('script');
            s.src = API;
            s.async = true;
            s.onerror = () => {
                apiPromise = null;
                reject(new Error('Could not load the YouTube player (blocked by the browser?)'));
            };
            document.head.appendChild(s);
        });
    }
    return apiPromise;
};

const createYouTube = (player) => {
    const box = document.createElement('div');
    box.className = 'sm-youtube-box';
    Object.assign(box.style, {
        position: 'fixed', right: '16px', bottom: '96px', width: '200px', height: '200px', zIndex: '50',
        borderRadius: '12px', overflow: 'hidden', boxShadow: '0 8px 30px rgba(0,0,0,.5)', display: 'none', background: '#000',
    });
    const mount = document.createElement('div');
    box.appendChild(mount);
    document.body.appendChild(box);
    let yt = null;
    let timer = null;

    const tick = () => {
        if (!yt?.getCurrentTime) return;
        player.set({ position: yt.getCurrentTime(), duration: yt.getDuration() || player.state.duration });
    };

    return {
        async load(videoId, start, autoplay) {
            try {
                const YT = await loadApi();
                box.style.display = 'block';
                const vars = { autoplay: autoplay ? 1 : 0, start: Math.floor(start || 0), playsinline: 1, rel: 0 };
                if (yt) {
                    if (autoplay) yt.loadVideoById({ videoId, startSeconds: start || 0 });
                    else yt.cueVideoById({ videoId, startSeconds: start || 0 });
                } else {
                    await new Promise((resolve) => {
                        yt = new YT.Player(mount, {
                            width: 200,
                            height: 200,
                            videoId,
                            playerVars: vars,
                            events: {
                                onReady: () => {
                                    yt.setVolume(Math.round(player.state.volume * 100));
                                    resolve();
                                },
                                onStateChange: (e) => {
                                    const S = YT.PlayerState;
                                    if (e.data === S.PLAYING) player.set({ status: 'playing', error: null });
                                    else if (e.data === S.PAUSED) player.set({ status: 'paused' });
                                    else if (e.data === S.BUFFERING) player.set({ status: 'loading' });
                                    else if (e.data === S.ENDED) player.next(true);
                                },
                                onError: () => player.fail('This YouTube video cannot be played here.', false),
                            },
                        });
                    });
                }
                clearInterval(timer);
                timer = setInterval(tick, 1000);
            } catch (error) {
                player.fail(error.message, false);
            }
        },
        play: () => yt?.playVideo(),
        pause: () => yt?.pauseVideo(),
        seek: (t) => yt?.seekTo(t, true),
        time: () => (yt?.getCurrentTime ? yt.getCurrentTime() : 0),
        volume: (v) => yt?.setVolume?.(Math.round(v * 100)),
        mute: (m) => (m ? yt?.mute?.() : yt?.unMute?.()),
        stop() {
            clearInterval(timer);
            yt?.stopVideo?.();
            box.style.display = 'none';
        },
    };
};

module.exports = { createYouTube };
