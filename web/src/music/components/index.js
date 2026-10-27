// stremio-music: cards, rows, track lists, like buttons and menus for the music pages.

const React = require('react');
const ReactDOM = require('react-dom');
const PropTypes = require('prop-types');
const classnames = require('classnames');
const { default: Icon } = require('@stremio/stremio-icons/react');
const MusicIcon = require('stremio/music/icons');
const usePlayer = require('stremio/music/player/usePlayer');
const { currentOf } = require('stremio/music/player/usePlayer');
const { itemHref, formatTime } = require('stremio/music/player/ui/common');
const { api, playMeta, libraryKind } = require('stremio/music/data');
const useLibrary = require('stremio/music/library/useLibrary');
const { toast, addToPlaylist } = require('./overlays');
const styles = require('./styles');

const KIND_LABEL = { artist: 'Artist', album: 'Album', track: 'Track', station: 'Station', playlist: 'Playlist' };

const subtitleOf = (m) => {
    const k = m.music?.kind;
    if (k === 'station') return m.description ?? 'Radio station';
    if (k === 'artist') return 'Artist';
    return [m.music?.artist, m.releaseInfo].filter(Boolean).join(' · ') || KIND_LABEL[k] || '';
};

const SourceBadge = ({ name, className }) => (name ? <span className={classnames(styles['source-badge'], className)}>{name}</span> : null);
SourceBadge.propTypes = { name: PropTypes.string, className: PropTypes.string };

const LIKE_LABEL = { track: ['Like', 'Remove from Liked songs'], album: ['Save album', 'Remove album from library'], artist: ['Follow', 'Unfollow'], station: ['Save station', 'Remove station from library'], playlist: ['Save playlist', 'Remove playlist from library'] };

/** Heart: like a track, save an album/station/playlist, follow an artist. */
const LikeButton = ({ item, kind, source, className, big }) => {
    const [, library] = useLibrary();
    const k = kind ?? libraryKind(item);
    const on = library.has(k, item.id);
    const [add, remove] = LIKE_LABEL[k];
    const onClick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        library.toggle(k, item, source)
            .then(() => toast(on ? 'Removed from your library' : (k === 'track' ? 'Added to Liked songs' : 'Saved to your library')))
            .catch((err) => toast(err.message, { error: true }));
    };
    return (
        <button type={'button'} className={classnames(styles['like'], { [styles['on']]: on, [styles['big']]: big }, className)} aria-pressed={on} aria-label={on ? remove : add} title={on ? remove : add} onClick={onClick}>
            <MusicIcon className={styles['icon']} name={on ? 'heart-filled' : 'heart'} />
        </button>
    );
};

LikeButton.propTypes = { item: PropTypes.object.isRequired, kind: PropTypes.string, source: PropTypes.object, className: PropTypes.string, big: PropTypes.bool };

/** "…" button with a popover menu. `items`: [{ label, onSelect } | { label, href }], falsy entries skipped. */
const Menu = ({ label, items, className }) => {
    const [pos, setPos] = React.useState(null);
    const btn = React.useRef(null);
    const menu = React.useRef(null);
    const close = React.useCallback(() => setPos(null), []);
    React.useEffect(() => {
        if (!pos) return;
        menu.current?.querySelector('[role="menuitem"]')?.focus();
        const onDown = (e) => !menu.current?.contains(e.target) && !btn.current?.contains(e.target) && close();
        const onKey = (e) => {
            if (e.key === 'Escape') {
                close();
                btn.current?.focus();
            } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault();
                const all = [...menu.current.querySelectorAll('[role="menuitem"]')];
                const i = all.indexOf(document.activeElement);
                all[(i + (e.key === 'ArrowDown' ? 1 : all.length - 1)) % all.length]?.focus();
            }
        };
        document.addEventListener('pointerdown', onDown);
        document.addEventListener('keydown', onKey);
        window.addEventListener('resize', close);
        document.addEventListener('scroll', close, true);
        return () => {
            document.removeEventListener('pointerdown', onDown);
            document.removeEventListener('keydown', onKey);
            window.removeEventListener('resize', close);
            document.removeEventListener('scroll', close, true);
        };
    }, [pos, close]);
    const open = (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (pos) return close();
        const r = btn.current.getBoundingClientRect();
        // below the button, or above it near the bottom of the screen; right-aligned
        const up = r.bottom > window.innerHeight * 0.6;
        setPos({ right: Math.max(8, window.innerWidth - r.right), ...(up ? { bottom: window.innerHeight - r.top + 4 } : { top: r.bottom + 4 }) });
    };
    const entries = items.filter(Boolean);
    return (
        <>
            <button ref={btn} type={'button'} className={classnames(styles['more'], className)} aria-label={label} title={label} aria-haspopup={'menu'} aria-expanded={Boolean(pos)} onClick={open}>
                <Icon className={styles['icon']} name={'more-horizontal'} />
            </button>
            {
                pos ?
                    ReactDOM.createPortal(
                        <div ref={menu} className={styles['menu']} role={'menu'} style={pos}>
                            {
                                entries.map((it) => (
                                    it.href ?
                                        <a key={it.label} role={'menuitem'} tabIndex={-1} href={it.href} onClick={close}>{it.label}</a>
                                        :
                                        <button
                                            key={it.label}
                                            type={'button'}
                                            role={'menuitem'}
                                            tabIndex={-1}
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                close();
                                                it.onSelect();
                                            }}
                                        >
                                            {it.label}
                                        </button>
                                ))
                            }
                        </div>,
                        document.body
                    )
                    :
                    null
            }
        </>
    );
};

Menu.propTypes = { label: PropTypes.string.isRequired, items: PropTypes.array.isRequired, className: PropTypes.string };

const MetaCard = ({ meta, source, showSource }) => {
    const [, player] = usePlayer();
    const [busy, setBusy] = React.useState(false);
    const kind = meta.music?.kind;
    const onPlay = (e) => {
        e.preventDefault();
        e.stopPropagation();
        setBusy(true);
        playMeta(player, { ...meta, source }).catch((err) => toast(err.message, { error: true })).finally(() => setBusy(false));
    };
    return (
        <a className={classnames(styles['card'], { [styles['round']]: kind === 'artist' })} href={itemHref(meta.id)}>
            <div className={styles['card-art']}>
                {meta.poster ? <img src={meta.poster} alt={''} loading={'lazy'} /> : <MusicIcon className={styles['placeholder']} name={kind === 'station' ? 'radio' : 'note'} />}
                {kind === 'station' ? <span className={styles['live']}>{'LIVE'}</span> : null}
                {
                    kind !== 'artist' ?
                        <button type={'button'} className={styles['card-play']} aria-label={`Play ${meta.name}`} onClick={onPlay} disabled={busy}>
                            {busy ? <span className={styles['spinner']} /> : <Icon className={styles['icon']} name={'play'} />}
                        </button>
                        :
                        null
                }
            </div>
            <div className={styles['card-title']} title={meta.name}>{meta.name}</div>
            <div className={styles['card-sub']}>
                {showSource && source?.name ? <SourceBadge name={source.name} className={styles['card-badge']} /> : null}
                {subtitleOf(meta)}
            </div>
        </a>
    );
};

MetaCard.propTypes = { meta: PropTypes.object.isRequired, source: PropTypes.object, showSource: PropTypes.bool };

const Grid = ({ metas, source, showSource }) => (
    <div className={styles['grid']}>
        {metas.map((m) => <MetaCard key={`${m.source?.id ?? ''}:${m.id}`} meta={m} source={source ?? m.source} showSource={showSource} />)}
    </div>
);

Grid.propTypes = { metas: PropTypes.array.isRequired, source: PropTypes.object, showSource: PropTypes.bool };

/** Horizontally scrolling row of cards. */
const Shelf = ({ title, badge, children, innerRef }) => (
    <section ref={innerRef} className={styles['row']}>
        <h2 className={styles['row-title']}>
            {title}
            <SourceBadge name={badge} />
        </h2>
        <div className={styles['row-scroll']}>{children}</div>
    </section>
);

Shelf.propTypes = { title: PropTypes.node, badge: PropTypes.string, children: PropTypes.node, innerRef: PropTypes.object };

/** A catalog as a shelf; loads when it scrolls into view. */
const CatalogRow = ({ source, catalog, title, extra, hideBadge }) => {
    const ref = React.useRef(null);
    const [visible, setVisible] = React.useState(false);
    const [state, setState] = React.useState({ metas: null, error: null });
    React.useEffect(() => {
        const el = ref.current;
        if (!el || visible) return;
        const io = new IntersectionObserver((entries) => {
            if (entries.some((e) => e.isIntersecting)) setVisible(true);
        }, { rootMargin: '400px' });
        io.observe(el);
        return () => io.disconnect();
    }, [visible]);
    React.useEffect(() => {
        if (!visible) return;
        let cancelled = false;
        api.catalog(source.id, catalog.id, extra)
            .then((r) => !cancelled && setState({ metas: r.metas, error: null }))
            .catch((e) => !cancelled && setState({ metas: [], error: e.message }));
        return () => {
            cancelled = true;
        };
    }, [visible, source.id, catalog.id, JSON.stringify(extra)]);
    if (state.metas && state.metas.length === 0 && !state.error) return null;
    return (
        <Shelf innerRef={ref} title={title ?? catalog.name} badge={hideBadge ? null : source.name}>
            {state.error ? <p className={styles['row-error']}>{state.error}</p> : null}
            {
                state.metas === null ?
                    Array.from({ length: 6 }, (_, i) => <div key={i} className={classnames(styles['card'], styles['skeleton'])}><div className={styles['card-art']} /></div>)
                    :
                    state.metas.map((m) => <MetaCard key={m.id} meta={m} source={source} />)
            }
        </Shelf>
    );
};

CatalogRow.propTypes = { source: PropTypes.object.isRequired, catalog: PropTypes.object.isRequired, title: PropTypes.string, extra: PropTypes.object, hideBadge: PropTypes.bool };

/** The standard actions for a track row's "…" menu. */
const trackMenuItems = (t, player) => [
    { label: 'Play next', onSelect: () => player.enqueue([t], { next: true }) },
    { label: 'Add to queue', onSelect: () => player.enqueue([t]) },
    { label: 'Add to playlist…', onSelect: () => addToPlaylist([t]) },
    t.albumId ? { label: 'Go to album', href: itemHref(t.albumId) } : null,
    t.artistId ? { label: 'Go to artist', href: itemHref(t.artistId) } : null,
];

/**
 * Tracks (queue items) of an album/playlist/artist/search. Tap or click a row to play from there.
 * `extraMenu(t, i)` adds entries to a row's menu (e.g. remove from playlist).
 */
const TrackList = ({ items, onPlay, showArt, showAlbum, showSource, numbered = true, extraMenu }) => {
    const [state, player] = usePlayer();
    const current = currentOf(state);
    return (
        <ol className={classnames(styles['tracks'], { [styles['with-album']]: showAlbum })}>
            {
                items.map((t, i) => {
                    const active = current?.id === t.id;
                    return (
                        <li
                            key={`${t.entry ?? ''}:${t.id}`}
                            className={classnames(styles['track'], { [styles['active']]: active })}
                            // touch: the whole row plays; buttons and links inside keep their own action
                            onClick={(e) => !e.target.closest('a, button') && onPlay(i)}
                        >
                            <button type={'button'} className={styles['track-no']} onClick={() => onPlay(i)} aria-label={`Play ${t.title}`}>
                                <span className={styles['no']}>{active && state.status === 'playing' ? <MusicIcon className={styles['eq']} name={'note'} /> : (numbered ? i + 1 : '')}</span>
                                <Icon className={styles['play-on-hover']} name={'play'} />
                            </button>
                            {showArt ? <span className={styles['track-art']}>{t.poster ? <img src={t.poster} alt={''} loading={'lazy'} /> : null}</span> : null}
                            <span className={styles['track-titles']}>
                                <span className={styles['track-title']}>{t.title}</span>
                                <span className={styles['track-artist']}>
                                    {showSource ? <SourceBadge name={t.sourceName} className={styles['inline-badge']} /> : null}
                                    {t.live ? 'Live radio' : t.artistId ? <a href={itemHref(t.artistId)}>{t.artist}</a> : t.artist}
                                </span>
                            </span>
                            {showAlbum ? <span className={styles['track-album']}>{t.albumId ? <a href={itemHref(t.albumId)}>{t.album}</a> : t.album}</span> : null}
                            <LikeButton item={t} kind={t.live ? 'station' : 'track'} className={styles['track-like']} />
                            <span className={styles['track-time']}>{t.duration ? formatTime(t.duration) : ''}</span>
                            <Menu label={`More options for ${t.title}`} items={[...trackMenuItems(t, player), ...(extraMenu ? extraMenu(t, i) : [])]} />
                        </li>
                    );
                })
            }
        </ol>
    );
};

TrackList.propTypes = {
    items: PropTypes.array.isRequired,
    onPlay: PropTypes.func.isRequired,
    showArt: PropTypes.bool,
    showAlbum: PropTypes.bool,
    showSource: PropTypes.bool,
    numbered: PropTypes.bool,
    extraMenu: PropTypes.func,
};

const Loading = () => <div className={styles['loading']} role={'status'}><span className={styles['spinner']} />{'Loading…'}</div>;

const ErrorBox = ({ message }) => <div className={styles['error-box']} role={'alert'}>{message}</div>;
ErrorBox.propTypes = { message: PropTypes.string };

module.exports = { MetaCard, Grid, Shelf, CatalogRow, TrackList, LikeButton, Menu, SourceBadge, Loading, ErrorBox, KIND_LABEL, trackMenuItems };
