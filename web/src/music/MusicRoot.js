// stremio-music: the Music route tree (#/music/*). Own layout (Spotify-like structure, Stremio look):
// top bar, sidebar with your playlists (bottom tab bar on phones), content, player bar.

const React = require('react');
const classnames = require('classnames');
const { Routes, Route, NavLink } = require('react-router-dom');
const { default: Icon } = require('@stremio/stremio-icons/react');
const ModeSwitch = require('stremio/sm/ModeSwitch');
const { getAuthState } = require('stremio/sm/api');
const AccountMenu = require('./AccountMenu');
const MusicIcon = require('./icons');
const Sources = require('./pages/Sources');
const { Home, Item, Radio, Search, Library, Liked, Playlist, NewPlaylistButton } = require('./pages/Pages');
const { Toasts, PlaylistPicker } = require('./components/overlays');
const useLibrary = require('./library/useLibrary');
const Downloads = require('./pages/Downloads');
const { useDownloads, activeCount } = require('./downloads/store');
const { api } = require('./data');
const PlayerBar = require('./player/ui/PlayerBar');
const { getPlayer } = require('./player/store');
const { default: useShortcut } = require('stremio/common/Shortcuts/useShortcut');
const { default: useRouteFocused } = require('stremio/common/useRouteFocused');
const styles = require('./styles');

const stremioIcon = (name) => (className) => <Icon className={className} name={name} />;
const musicIcon = (name) => (className) => <MusicIcon className={className} name={name} />;

const PAGES = [
    { path: '', label: 'Home', icon: stremioIcon('home'), element: <Home /> },
    { path: 'search', label: 'Search', icon: stremioIcon('search'), element: <Search /> },
    { path: 'library', label: 'Library', icon: stremioIcon('library'), element: <Library /> },
    { path: 'radio', label: 'Radio', icon: musicIcon('radio'), element: <Radio /> },
    { path: 'downloads', label: 'Downloads', icon: stremioIcon('download'), element: <Downloads />, badge: true },
    // phones: in the account menu (five tabs fit a bottom bar, six don't)
    { path: 'sources', label: 'Sources', icon: musicIcon('sources'), element: <Sources />, secondary: true },
];

const Placeholder = ({ page }) => (
    <section className={styles['placeholder']}>
        <div className={styles['placeholder-icon']}>{page.icon(styles['placeholder-icon-svg'])}</div>
        <h1 className={styles['page-title']}>{page.label}</h1>
        <p className={styles['placeholder-text']}>{page.text}</p>
        {page.phase ? <p className={styles['placeholder-phase']}>{`Coming in phase ${page.phase}.`}</p> : null}
    </section>
);

/** Keyboard: Space play/pause, ←/→ seek 10 s, while the Music view is in front. */
const usePlayerShortcuts = () => {
    const focused = useRouteFocused();
    useShortcut('playPause', React.useCallback(() => getPlayer().toggle(), []), focused);
    useShortcut('seekForward', React.useCallback((combo) => {
        const p = getPlayer();
        p.seek(p.position() + (combo === 1 ? 30 : 10));
    }, []), focused);
    useShortcut('seekBackward', React.useCallback((combo) => {
        const p = getPlayer();
        p.seek(p.position() - (combo === 1 ? 30 : 10));
    }, []), focused);
};

/** Sidebar (desktop): Liked songs and your playlists. */
const YourPlaylists = () => {
    const [lib] = useLibrary();
    const navClass = ({ isActive }) => classnames(styles['lib-link'], { [styles['active']]: isActive });
    return (
        <div className={styles['side-library']}>
            <div className={styles['side-head']}>
                <span>{'Playlists'}</span>
                <NewPlaylistButton className={styles['side-add']}><Icon className={styles['side-add-icon']} name={'add'} /><span className={styles['visually-hidden']}>{'New playlist'}</span></NewPlaylistButton>
            </div>
            <NavLink to={'/music/library/liked'} className={navClass}>
                <MusicIcon className={styles['lib-link-icon']} name={'heart-filled'} />
                <span>{'Liked songs'}</span>
            </NavLink>
            {
                lib.playlists.map((p) => (
                    <NavLink key={p.id} to={`/music/playlist/${p.id}`} className={navClass} title={p.name}>
                        <MusicIcon className={styles['lib-link-icon']} name={p.sync ? 'sync' : 'playlist'} />
                        <span>{p.name}</span>
                    </NavLink>
                ))
            }
        </div>
    );
};

/** Number of downloads on the way, on the Downloads nav item. */
const DownloadsBadge = () => {
    const [state] = useDownloads();
    const n = activeCount(state.groups);
    return n ? <span className={styles['nav-badge']} aria-label={`${n} downloading`}>{n > 99 ? '99+' : n}</span> : null;
};

const MusicRoot = () => {
    usePlayerShortcuts();
    // which sources allow downloads (for the "Download" menu items)
    React.useEffect(() => {
        api.sources().catch(() => {});
    }, []);
    const [user, setUser] = React.useState(null);

    React.useEffect(() => {
        getAuthState().then((state) => setUser(state.user)).catch(() => {});
    }, []);

    const pages = PAGES;

    return (
        <div className={styles['music-root']}>
            <header className={styles['top-bar']}>
                <div className={styles['brand']}>
                    <MusicIcon className={styles['brand-icon']} name={'note'} />
                    <span className={styles['brand-label']}>{'Music'}</span>
                </div>
                <ModeSwitch className={styles['mode-switch']} />
                <AccountMenu user={user} />
            </header>
            <nav className={styles['side-nav']} aria-label={'Music'}>
                {
                    pages.map((page) => (
                        <NavLink
                            key={page.path}
                            to={page.path ? `/music/${page.path}` : '/music'}
                            end={page.path === ''}
                            className={({ isActive }) => classnames(styles['nav-item'], { [styles['active']]: isActive, [styles['secondary']]: page.secondary })}
                        >
                            {page.icon(styles['nav-icon'])}
                            <span className={styles['nav-label']}>{page.label}</span>
                            {page.badge ? <DownloadsBadge /> : null}
                        </NavLink>
                    ))
                }
                <YourPlaylists />
            </nav>
            <main className={styles['content']}>
                <Routes>
                    {
                        PAGES.map((page) => (
                            <Route
                                key={page.path}
                                index={page.path === ''}
                                path={page.path || undefined}
                                element={page.element ?? <Placeholder page={page} />}
                            />
                        ))
                    }
                    <Route path={'library/liked'} element={<Liked />} />
                    <Route path={'playlist/:id'} element={<Playlist />} />
                    <Route path={'item/*'} element={<Item />} />
                    <Route path={'*'} element={<Placeholder page={{ label: 'Not found', icon: musicIcon('note'), text: 'This music page does not exist.' }} />} />
                </Routes>
            </main>
            <PlayerBar />
            <PlaylistPicker />
            <Toasts />
        </div>
    );
};

module.exports = MusicRoot;
