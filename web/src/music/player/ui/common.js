// stremio-music: small pieces shared by the player UI.

const React = require('react');
const PropTypes = require('prop-types');
const classnames = require('classnames');
const { default: Icon } = require('@stremio/stremio-icons/react');
const MusicIcon = require('stremio/music/icons');
const styles = require('./styles');

const formatTime = (s) => {
    if (!Number.isFinite(s) || s < 0) return '–:––';
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = Math.floor(s % 60).toString().padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
};

const itemHref = (id) => `#/music/item/${encodeURIComponent(id)}`;

const IconButton = ({ label, onClick, active, disabled, big, children, className }) => (
    <button
        type={'button'}
        className={classnames(styles['icon-btn'], { [styles['active']]: active, [styles['big']]: big }, className)}
        aria-label={label}
        title={label}
        aria-pressed={active === undefined ? undefined : Boolean(active)}
        disabled={disabled}
        onClick={onClick}
    >
        {children}
    </button>
);

IconButton.propTypes = {
    label: PropTypes.string.isRequired,
    onClick: PropTypes.func,
    active: PropTypes.bool,
    disabled: PropTypes.bool,
    big: PropTypes.bool,
    children: PropTypes.node,
    className: PropTypes.string,
};

const PlayPauseIcon = ({ playing, loading }) => (
    loading ? <span className={styles['spinner']} aria-hidden={'true'} /> : <Icon className={styles['icon']} name={playing ? 'pause' : 'play'} />
);

PlayPauseIcon.propTypes = { playing: PropTypes.bool, loading: PropTypes.bool };

/** Transport buttons; `big` for the now-playing view. */
const Controls = ({ state, player, big }) => {
    const live = Boolean(state.queue[state.order[state.pos]]?.live);
    const playing = state.status === 'playing';
    const loading = state.status === 'loading' || state.status === 'reconnecting';
    return (
        <div className={classnames(styles['controls'], { [styles['big']]: big })}>
            <IconButton label={state.shuffle ? 'Shuffle on' : 'Shuffle off'} active={state.shuffle} onClick={() => player.setShuffle(!state.shuffle)}>
                <MusicIcon className={styles['icon']} name={'shuffle'} />
            </IconButton>
            <IconButton label={'Previous'} disabled={state.pos <= 0 && live} onClick={() => player.prev()}>
                <Icon className={styles['icon']} name={'skip-back'} />
            </IconButton>
            <IconButton label={playing ? 'Pause' : 'Play'} big className={styles['play-btn']} onClick={() => player.toggle()} disabled={state.pos < 0}>
                <PlayPauseIcon playing={playing || loading} loading={loading} />
            </IconButton>
            <IconButton label={'Next'} disabled={state.pos + 1 >= state.order.length && state.repeat !== 'all'} onClick={() => player.next()}>
                <Icon className={styles['icon']} name={'skip-forward'} />
            </IconButton>
            <IconButton label={`Repeat: ${state.repeat}`} active={state.repeat !== 'off'} onClick={() => player.cycleRepeat()}>
                <MusicIcon className={styles['icon']} name={state.repeat === 'one' ? 'repeat-one' : 'repeat'} />
            </IconButton>
        </div>
    );
};

Controls.propTypes = { state: PropTypes.object.isRequired, player: PropTypes.object.isRequired, big: PropTypes.bool };

/** Seek bar, or a LIVE badge for radio. */
const Progress = ({ state, player, compact }) => {
    const item = state.queue[state.order[state.pos]];
    const [drag, setDrag] = React.useState(null);
    if (!item) return null;
    if (item.live) {
        return (
            <div className={styles['progress']}>
                <span className={styles['live-badge']}>{'LIVE'}</span>
                {!compact && state.nowPlaying ? <span className={styles['now-playing']}>{state.nowPlaying}</span> : null}
            </div>
        );
    }
    const duration = state.duration ?? item.duration ?? 0;
    const value = drag ?? Math.min(state.position, duration || state.position);
    const seekable = state.decision?.seek !== 'none' && duration > 0;
    return (
        <div className={styles['progress']}>
            {compact ? null : <span className={styles['time']}>{formatTime(value)}</span>}
            <input
                type={'range'}
                className={styles['seek']}
                min={0}
                max={duration || 1}
                step={0.5}
                value={value}
                disabled={!seekable}
                aria-label={'Seek'}
                // the phone bar's thin line is decorative; the now-playing view has the real control
                aria-hidden={compact ? 'true' : undefined}
                tabIndex={compact ? -1 : undefined}
                aria-valuetext={`${formatTime(value)} of ${formatTime(duration)}`}
                style={{ '--progress': `${duration ? (value / duration) * 100 : 0}%` }}
                onChange={(e) => setDrag(Number(e.target.value))}
                onPointerUp={() => {
                    if (drag !== null) player.seek(drag);
                    setDrag(null);
                }}
                onKeyUp={(e) => {
                    if (drag !== null && ['ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown'].includes(e.key)) {
                        player.seek(drag);
                        setDrag(null);
                    }
                }}
            />
            {compact ? null : <span className={styles['time']}>{formatTime(duration)}</span>}
        </div>
    );
};

Progress.propTypes = { state: PropTypes.object.isRequired, player: PropTypes.object.isRequired, compact: PropTypes.bool };

const Volume = ({ state, player }) => (
    <div className={styles['volume']}>
        <IconButton label={state.muted ? 'Unmute' : 'Mute'} onClick={() => player.toggleMute()}>
            <Icon className={styles['icon']} name={state.muted || state.volume === 0 ? 'volume-mute' : state.volume < 0.5 ? 'volume-low' : 'volume-high'} />
        </IconButton>
        <input
            type={'range'}
            className={styles['seek']}
            min={0}
            max={1}
            step={0.02}
            value={state.muted ? 0 : state.volume}
            aria-label={'Volume'}
            style={{ '--progress': `${(state.muted ? 0 : state.volume) * 100}%` }}
            onChange={(e) => player.setVolume(Number(e.target.value))}
        />
    </div>
);

Volume.propTypes = { state: PropTypes.object.isRequired, player: PropTypes.object.isRequired };

const Artwork = ({ src, className }) => (
    <div className={classnames(styles['artwork'], className)}>
        {src ? <img src={src} alt={''} loading={'lazy'} /> : <MusicIcon className={styles['artwork-placeholder']} name={'note'} />}
    </div>
);

Artwork.propTypes = { src: PropTypes.string, className: PropTypes.string };

/** e.g. "FLAC · Internet Archive" / "MP3 128 (data saver) · Radio Browser · via server" */
const streamLabel = (decision) => {
    if (!decision) return null;
    const parts = [];
    if (decision.mode === 'transcode') parts.push(`MP3 ${decision.bitrate} (converted on the server)`);
    else if (decision.mode === 'youtube') parts.push('YouTube');
    else parts.push(decision.stream?.name || decision.codec.toUpperCase());
    parts.push(decision.source.name);
    if (decision.mode === 'proxy') parts.push('via server');
    if (decision.mode === 'engine') parts.push('torrent');
    return parts.join(' · ');
};

module.exports = { formatTime, itemHref, IconButton, Controls, Progress, Volume, Artwork, streamLabel };
