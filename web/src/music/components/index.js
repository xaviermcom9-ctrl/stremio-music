// stremio-music: cards, rows and track lists for the music pages.

const React = require('react');
const PropTypes = require('prop-types');
const classnames = require('classnames');
const { default: Icon } = require('@stremio/stremio-icons/react');
const MusicIcon = require('stremio/music/icons');
const usePlayer = require('stremio/music/player/usePlayer');
const { currentOf } = require('stremio/music/player/usePlayer');
const { itemHref, formatTime } = require('stremio/music/player/ui/common');
const { api, playMeta } = require('stremio/music/data');
const styles = require('./styles');

const KIND_LABEL = { artist: 'Artist', album: 'Album', track: 'Track', station: 'Station', playlist: 'Playlist' };

const subtitleOf = (m) => {
    const k = m.music?.kind;
    if (k === 'station') return m.description ?? 'Radio station';
    if (k === 'artist') return 'Artist';
    return [m.music?.artist, m.releaseInfo].filter(Boolean).join(' · ') || KIND_LABEL[k] || '';
};

const MetaCard = ({ meta, source }) => {
    const [, player] = usePlayer();
    const [busy, setBusy] = React.useState(false);
    const kind = meta.music?.kind;
    const onPlay = (e) => {
        e.preventDefault();
        e.stopPropagation();
        setBusy(true);
        playMeta(player, { ...meta, source }).catch(() => {}).finally(() => setBusy(false));
    };
    return (
        <a className={classnames(styles['card'], { [styles['round']]: kind === 'artist' })} href={itemHref(meta.id)}>
            <div className={styles['card-art']}>
                {meta.poster ? <img src={meta.poster} alt={''} loading={'lazy'} /> : <MusicIcon className={styles['placeholder']} name={kind === 'station' ? 'radio' : 'note'} />}
                {kind === 'station' ? <span className={styles['live']}>{'LIVE'}</span> : null}
                {
                    kind !== 'artist' ?
                        <button type={'button'} className={styles['card-play']} aria-label={`Play ${meta.name}`} onClick={onPlay} disabled={busy}>
                            <Icon className={styles['icon']} name={'play'} />
                        </button>
                        :
                        null
                }
            </div>
            <div className={styles['card-title']} title={meta.name}>{meta.name}</div>
            <div className={styles['card-sub']}>{subtitleOf(meta)}</div>
        </a>
    );
};

MetaCard.propTypes = { meta: PropTypes.object.isRequired, source: PropTypes.object };

const Grid = ({ metas, source }) => (
    <div className={styles['grid']}>
        {metas.map((m) => <MetaCard key={m.id} meta={m} source={source ?? m.source} />)}
    </div>
);

Grid.propTypes = { metas: PropTypes.array.isRequired, source: PropTypes.object };

/** A catalog as a horizontally scrolling row; loads when it scrolls into view. */
const CatalogRow = ({ source, catalog, title, extra }) => {
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
        <section ref={ref} className={styles['row']}>
            <h2 className={styles['row-title']}>
                {title ?? catalog.name}
                <span className={styles['source-badge']}>{source.name}</span>
            </h2>
            {state.error ? <p className={styles['row-error']}>{state.error}</p> : null}
            <div className={styles['row-scroll']}>
                {
                    state.metas === null ?
                        Array.from({ length: 6 }, (_, i) => <div key={i} className={classnames(styles['card'], styles['skeleton'])}><div className={styles['card-art']} /></div>)
                        :
                        state.metas.map((m) => <MetaCard key={m.id} meta={m} source={source} />)
                }
            </div>
        </section>
    );
};

CatalogRow.propTypes = { source: PropTypes.object.isRequired, catalog: PropTypes.object.isRequired, title: PropTypes.string, extra: PropTypes.object };

/** Tracks of an album/playlist/artist; click plays from that track. */
const TrackList = ({ items, onPlay, showArt }) => {
    const [state] = usePlayer();
    const current = currentOf(state);
    return (
        <ol className={styles['tracks']}>
            {
                items.map((t, i) => {
                    const active = current?.id === t.id;
                    return (
                        <li key={t.id} className={classnames(styles['track'], { [styles['active']]: active })}>
                            <button type={'button'} className={styles['track-btn']} onClick={() => onPlay(i)} aria-label={`Play ${t.title}`}>
                                <span className={styles['track-no']}>{active && state.status === 'playing' ? <MusicIcon className={styles['eq']} name={'note'} /> : (i + 1)}</span>
                                {showArt ? <span className={styles['track-art']}>{t.poster ? <img src={t.poster} alt={''} loading={'lazy'} /> : null}</span> : null}
                                <span className={styles['track-titles']}>
                                    <span className={styles['track-title']}>{t.title}</span>
                                    {t.artist ? <span className={styles['track-artist']}>{t.artist}</span> : null}
                                </span>
                                <span className={styles['track-time']}>{t.duration ? formatTime(t.duration) : ''}</span>
                            </button>
                        </li>
                    );
                })
            }
        </ol>
    );
};

TrackList.propTypes = { items: PropTypes.array.isRequired, onPlay: PropTypes.func.isRequired, showArt: PropTypes.bool };

const Loading = () => <div className={styles['loading']} role={'status'}><span className={styles['spinner']} />{'Loading…'}</div>;

const ErrorBox = ({ message }) => <div className={styles['error-box']} role={'alert'}>{message}</div>;
ErrorBox.propTypes = { message: PropTypes.string };

module.exports = { MetaCard, Grid, CatalogRow, TrackList, Loading, ErrorBox, KIND_LABEL };
