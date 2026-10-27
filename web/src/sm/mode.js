// stremio-music: the two top-level modes. Movies & TV is every upstream route; Music lives under
// /music. Each mode remembers where you were, so switching back returns to the same page.

const React = require('react');
const { useLocation, useNavigate } = require('react-router');
const { getPrefs, setPref } = require('./api');

const MUSIC_ROOT = '/music';
const MODES = ['movies', 'music'];

const modeOfPath = (pathname) => (
    pathname === MUSIC_ROOT || pathname.startsWith(MUSIC_ROOT + '/') ? 'music' : 'movies'
);

// Movies & TV pages worth returning to (not details or the player, which need their context)
const MOVIES_RETURNABLE = /^\/(?:discover|library|calendar|continuewatching|search|addons|settings)?(?:\/|$)/;

const lastPaths = { movies: '/', music: MUSIC_ROOT };

const rememberPath = (pathname, search = '') => {
    const mode = modeOfPath(pathname);
    if (mode === 'music' || MOVIES_RETURNABLE.test(pathname)) {
        lastPaths[mode] = pathname + search;
    }
};

const pathForMode = (mode) => lastPaths[mode];

const otherModePath = (pathname) => pathForMode(modeOfPath(pathname) === 'music' ? 'movies' : 'music');

/**
 * Mounted once in App: on launch, reopens the mode you used last (per user, stored server-side, so
 * it follows you across devices) when the app opens on its default page; afterwards records every
 * mode change.
 */
const ModeTracker = () => {
    const location = useLocation();
    const navigate = useNavigate();
    const savedModeRef = React.useRef(null);
    const launchPathRef = React.useRef(location.pathname);

    React.useEffect(() => {
        let cancelled = false;
        getPrefs()
            .then((prefs) => {
                if (cancelled) return;
                savedModeRef.current = MODES.includes(prefs.mode) ? prefs.mode : 'movies';
                // only if the app opened on its default page and you haven't moved on since
                const currentPath = window.location.hash.slice(1).split('?')[0] || '/';
                if (savedModeRef.current === 'music' && launchPathRef.current === '/' && currentPath === '/') {
                    navigate(MUSIC_ROOT, { replace: true });
                }
            })
            .catch(() => {
                savedModeRef.current = 'movies';
            });
        return () => {
            cancelled = true;
        };
    }, []);

    React.useEffect(() => {
        rememberPath(location.pathname, location.search);
        const mode = modeOfPath(location.pathname);
        if (savedModeRef.current === null || savedModeRef.current === mode) return;
        savedModeRef.current = mode;
        setPref('mode', mode).catch(() => {});
    }, [location.pathname, location.search]);

    return null;
};

module.exports = { MUSIC_ROOT, modeOfPath, pathForMode, otherModePath, ModeTracker };
