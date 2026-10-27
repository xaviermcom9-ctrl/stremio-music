// stremio-music: pieces shared by the music pages (data loading, the page header).

const React = require('react');
const PropTypes = require('prop-types');
const classnames = require('classnames');
const { default: Icon } = require('@stremio/stremio-icons/react');
const MusicIcon = require('stremio/music/icons');
const styles = require('./styles');

/**
 * { data, error, loading } of a promise-returning loader; reloads when `deps` change. `keep`: show
 * the previous data while reloading (no spinner flash after an edit).
 */
const useAsync = (load, deps, { keep = false } = {}) => {
    const [state, setState] = React.useState({ data: null, error: null, loading: true });
    React.useEffect(() => {
        let cancelled = false;
        setState((s) => ({ data: keep ? s.data : null, error: null, loading: true }));
        load()
            .then((data) => !cancelled && setState({ data, error: null, loading: false }))
            .catch((error) => !cancelled && setState({ data: null, error: error.message, loading: false }));
        return () => {
            cancelled = true;
        };
    }, deps);
    return state;
};

/** Cover: one image, a 2×2 mosaic (playlists), or a placeholder icon. */
const Cover = ({ src, mosaic, icon = 'note', round, className }) => {
    const four = (mosaic ?? []).slice(0, 4);
    return (
        <div className={classnames(styles['cover'], { [styles['round']]: round }, className)}>
            {
                src ?
                    <img src={src} alt={''} />
                    :
                    four.length === 4 ?
                        <div className={styles['mosaic']}>{four.map((p) => <img key={p} src={p} alt={''} />)}</div>
                        :
                        four.length ?
                            <img src={four[0]} alt={''} />
                            :
                            <MusicIcon className={styles['cover-placeholder']} name={icon} />
            }
        </div>
    );
};

Cover.propTypes = { src: PropTypes.string, mosaic: PropTypes.array, icon: PropTypes.string, round: PropTypes.bool, className: PropTypes.string };

/** Page header: cover, kind line, big title, details line, then the action buttons. */
const Hero = ({ cover, kind, title, sub, description, actions }) => (
    <header className={styles['hero']}>
        {cover}
        <div className={styles['hero-text']}>
            <div className={styles['kind']}>{kind}</div>
            <h1 className={styles['hero-title']}>{title}</h1>
            {sub ? <div className={styles['hero-sub']}>{sub}</div> : null}
            {description ? <p className={styles['description']}>{description}</p> : null}
            {actions ? <div className={styles['actions']}>{actions}</div> : null}
        </div>
    </header>
);

Hero.propTypes = { cover: PropTypes.node, kind: PropTypes.node, title: PropTypes.node, sub: PropTypes.node, description: PropTypes.node, actions: PropTypes.node };

const PlayButton = ({ label, onClick, busy }) => (
    <button type={'button'} className={styles['play-big']} onClick={onClick} aria-label={label} disabled={busy}>
        {busy ? <span className={styles['spinner']} /> : <Icon className={styles['icon']} name={'play'} />}
    </button>
);

PlayButton.propTypes = { label: PropTypes.string.isRequired, onClick: PropTypes.func.isRequired, busy: PropTypes.bool };

const ShuffleButton = ({ onClick }) => (
    <button type={'button'} className={styles['pill']} onClick={onClick}>
        <MusicIcon className={styles['icon']} name={'shuffle'} />{'Shuffle'}
    </button>
);

ShuffleButton.propTypes = { onClick: PropTypes.func.isRequired };

/** "1 h 12 min" / "42 min" / "35 s" */
const formatLength = (secs) => {
    if (!secs) return null;
    if (secs < 60) return `${Math.round(secs)} s`;
    const m = Math.round(secs / 60);
    return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`;
};

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

module.exports = { useAsync, Cover, Hero, PlayButton, ShuffleButton, formatLength, plural };
