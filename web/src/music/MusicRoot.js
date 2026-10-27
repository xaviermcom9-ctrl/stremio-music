// stremio-music: the Music route tree (#/music/*). Own layout (Spotify-like structure, Stremio look):
// top bar, sidebar (bottom tab bar on phones), content. Pages are placeholders until the source
// plugins (Phase 5-6), playback (Phase 7) and the music UI (Phase 8) land.

const React = require('react');
const classnames = require('classnames');
const { Routes, Route, NavLink } = require('react-router-dom');
const { default: Icon } = require('@stremio/stremio-icons/react');
const ModeSwitch = require('stremio/sm/ModeSwitch');
const { getAuthState } = require('stremio/sm/api');
const AccountMenu = require('./AccountMenu');
const MusicIcon = require('./icons');
const Sources = require('./pages/Sources');
const styles = require('./styles');

const stremioIcon = (name) => (className) => <Icon className={className} name={name} />;
const musicIcon = (name) => (className) => <MusicIcon className={className} name={name} />;

const PAGES = [
    { path: '', label: 'Home', icon: stremioIcon('home'), text: 'Rows from your music sources will appear here, ordered by source priority.', phase: 8 },
    { path: 'search', label: 'Search', icon: stremioIcon('search'), text: 'One search box across every source: artists, albums, tracks and stations.', phase: 8 },
    { path: 'library', label: 'Library', icon: stremioIcon('library'), text: 'Your liked songs, saved albums and playlists.', phase: 8 },
    { path: 'radio', label: 'Radio', icon: musicIcon('radio'), text: 'Live radio stations from Radio Browser: top voted, trending, by genre and by country.', phase: 6 },
    { path: 'downloads', label: 'Downloads', icon: stremioIcon('download'), text: 'Server-side downloads into your music library, with progress, pause and retry.', phase: 9 },
    { path: 'sources', label: 'Sources', icon: musicIcon('sources'), element: <Sources /> },
];

const Placeholder = ({ page }) => (
    <section className={styles['placeholder']}>
        <div className={styles['placeholder-icon']}>{page.icon(styles['placeholder-icon-svg'])}</div>
        <h1 className={styles['page-title']}>{page.label}</h1>
        <p className={styles['placeholder-text']}>{page.text}</p>
        {page.phase ? <p className={styles['placeholder-phase']}>{`Coming in phase ${page.phase}.`}</p> : null}
    </section>
);

const MusicRoot = () => {
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
                            className={({ isActive }) => classnames(styles['nav-item'], { [styles['active']]: isActive })}
                        >
                            {page.icon(styles['nav-icon'])}
                            <span className={styles['nav-label']}>{page.label}</span>
                        </NavLink>
                    ))
                }
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
                    <Route path={'*'} element={<Placeholder page={{ label: 'Not found', icon: musicIcon('note'), text: 'This music page does not exist.' }} />} />
                </Routes>
            </main>
        </div>
    );
};

module.exports = MusicRoot;
