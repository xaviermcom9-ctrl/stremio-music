// stremio-music: bottom player bar (desktop: full controls; phone: compact, tap to expand),
// the expanded now-playing view and the queue panel.

const React = require('react');
const classnames = require('classnames');
const { default: Icon } = require('@stremio/stremio-icons/react');
const MusicIcon = require('stremio/music/icons');
const usePlayer = require('../usePlayer');
const { currentOf } = require('../usePlayer');
const { DATA_SAVER_OPTIONS } = require('../caps');
const { itemHref, IconButton, Controls, Progress, Volume, Artwork, streamLabel } = require('./common');
const { LikeButton, Menu } = require('stremio/music/components');
const { addToPlaylist } = require('stremio/music/components/overlays');
const styles = require('./styles');

const Titles = ({ item, nowPlaying, onNavigate }) => (
    <div className={styles['titles']}>
        <a className={styles['title']} href={itemHref(item.albumId ?? item.id)} onClick={onNavigate}>{item.live && nowPlaying ? nowPlaying : item.title}</a>
        <div className={styles['subtitle']}>
            {
                item.live ?
                    <span>{nowPlaying ? item.title : 'Live radio'}</span>
                    :
                    item.artistId ?
                        <a href={itemHref(item.artistId)} onClick={onNavigate}>{item.artist}</a>
                        :
                        <span>{item.artist ?? item.sourceName ?? ''}</span>
            }
        </div>
    </div>
);

const Queue = ({ state, player, onClose }) => {
    const upcoming = state.order.map((qi, p) => ({ item: state.queue[qi], p })).filter(({ p }) => p > state.pos);
    const current = currentOf(state);
    return (
        <aside className={styles['queue-panel']} aria-label={'Queue'}>
            <div className={styles['panel-head']}>
                <h2>{'Queue'}</h2>
                <IconButton label={'Close queue'} onClick={onClose}><Icon className={styles['icon']} name={'close'} /></IconButton>
            </div>
            {current ? <><h3>{'Now playing'}</h3><QueueRow item={current} active /></> : null}
            <div className={styles['queue-subhead']}>
                <h3>{`Next up${upcoming.length ? ` (${upcoming.length})` : ''}`}</h3>
                {upcoming.length ? <button type={'button'} className={styles['text-btn']} onClick={() => player.clearUpcoming()}>{'Clear'}</button> : null}
            </div>
            {upcoming.length === 0 ? <p className={styles['muted']}>{'Nothing queued.'}</p> : null}
            <ol className={styles['queue-list']}>
                {
                    upcoming.slice(0, 300).map(({ item, p }) => (
                        <QueueRow key={`${p}:${item.id}`} item={item} onPlay={() => player.jumpTo(p)} onRemove={() => player.removeAt(p)} />
                    ))
                }
            </ol>
        </aside>
    );
};

const QueueRow = ({ item, active, onPlay, onRemove }) => (
    <li className={classnames(styles['queue-row'], { [styles['active']]: active })}>
        <button type={'button'} className={styles['queue-main']} onClick={onPlay} disabled={!onPlay}>
            <Artwork src={item.poster} className={styles['queue-art']} />
            <span className={styles['titles']}>
                <span className={styles['title']}>{item.title}</span>
                <span className={styles['subtitle']}>{item.live ? 'Live radio' : (item.artist ?? '')}</span>
            </span>
        </button>
        {onRemove ? <IconButton label={`Remove ${item.title}`} onClick={onRemove}><Icon className={styles['icon']} name={'close'} /></IconButton> : null}
    </li>
);

const NowPlaying = ({ state, player, onClose, onQueue }) => {
    const item = currentOf(state);
    const go = (id) => {
        onClose();
        window.location.hash = itemHref(id);
    };
    React.useEffect(() => {
        const onKey = (e) => {
            if (e.key === 'Escape') onClose();
        };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, [onClose]);
    if (!item) return null;
    return (
        <div className={styles['now-playing-view']} role={'dialog'} aria-label={'Now playing'}>
            <div className={styles['panel-head']}>
                <IconButton label={'Close'} onClick={onClose}><MusicIcon className={styles['icon']} name={'collapse'} /></IconButton>
                <span className={styles['muted']}>{item.live ? 'Live radio' : item.album ?? ''}</span>
                <IconButton label={'Queue'} onClick={onQueue}><MusicIcon className={styles['icon']} name={'queue'} /></IconButton>
            </div>
            <Artwork src={item.poster} className={styles['big-art']} />
            <div className={styles['np-titles']}>
                <Titles item={item} nowPlaying={state.nowPlaying} onNavigate={onClose} />
                <LikeButton item={item} kind={item.live ? 'station' : 'track'} big />
                {
                    item.live ?
                        null
                        :
                        <Menu
                            label={`More options for ${item.title}`}
                            items={[
                                { label: 'Add to playlist…', onSelect: () => addToPlaylist([item]) },
                                item.albumId ? { label: 'Go to album', onSelect: () => go(item.albumId) } : null,
                                item.artistId ? { label: 'Go to artist', onSelect: () => go(item.artistId) } : null,
                            ]}
                        />
                }
            </div>
            <Progress state={state} player={player} />
            <Controls state={state} player={player} big />
            <div className={styles['np-extra']}>
                <Volume state={state} player={player} />
                <label className={styles['saver']}>
                    {'Data saver'}
                    <select value={state.dataSaver} onChange={(e) => player.setDataSaver(Number(e.target.value))}>
                        {DATA_SAVER_OPTIONS.map((k) => <option key={k} value={k}>{k ? `Up to ${k} kbit/s` : 'Off (best quality)'}</option>)}
                    </select>
                </label>
                {state.decision ? <div className={styles['muted']}>{streamLabel(state.decision)}</div> : null}
                {state.error ? <div className={styles['error']} role={'alert'}>{state.error}</div> : null}
            </div>
        </div>
    );
};

const PlayerBar = () => {
    const [state, player] = usePlayer();
    const [view, setView] = React.useState(null);
    const item = currentOf(state);

    React.useEffect(() => {
        player.checkRemote();
    }, [player]);

    const close = React.useCallback(() => setView(null), []);

    return (
        <>
            {
                state.remote ?
                    <div className={styles['resume']} role={'status'}>
                        <span>{`Continue where you left off on ${state.remote.device ?? 'another device'}?`}</span>
                        <button type={'button'} className={styles['text-btn']} onClick={() => player.acceptRemote()}>{'Resume'}</button>
                        <button type={'button'} className={styles['text-btn']} onClick={() => player.dismissRemote()}>{'Dismiss'}</button>
                    </div>
                    :
                    null
            }
            {
                item ?
                    <div className={styles['player-bar']} aria-label={'Player'}>
                        <div className={styles['mobile-progress']}><Progress state={state} player={player} compact /></div>
                        <div className={styles['left-zone']}>
                            <button type={'button'} className={styles['left']} onClick={() => setView('now')} aria-label={'Open now playing'}>
                                <Artwork src={item.poster} className={styles['bar-art']} />
                                <span className={styles['titles']}>
                                    <span className={styles['title']}>{item.live && state.nowPlaying ? state.nowPlaying : item.title}</span>
                                    <span className={styles['subtitle']}>{item.live ? (state.nowPlaying ? item.title : 'Live radio') : (item.artist ?? item.sourceName ?? '')}</span>
                                </span>
                            </button>
                            <LikeButton item={item} kind={item.live ? 'station' : 'track'} />
                        </div>
                        <div className={styles['center']}>
                            <Controls state={state} player={player} />
                            <Progress state={state} player={player} />
                        </div>
                        <div className={styles['right']}>
                            {state.error ? <span className={styles['error-dot']} title={state.error}>{'!'}</span> : null}
                            {state.dataSaver ? <span className={styles['saver-badge']} title={'Data saver on'}>{`${state.dataSaver}k`}</span> : null}
                            <IconButton label={'Queue'} active={view === 'queue'} onClick={() => setView(view === 'queue' ? null : 'queue')}>
                                <MusicIcon className={styles['icon']} name={'queue'} />
                            </IconButton>
                            <Volume state={state} player={player} />
                            <IconButton label={'Now playing'} onClick={() => setView('now')}>
                                <MusicIcon className={styles['icon']} name={'expand'} />
                            </IconButton>
                        </div>
                        <div className={styles['mobile-controls']}>
                            <IconButton label={state.status === 'playing' ? 'Pause' : 'Play'} onClick={() => player.toggle()}>
                                <Icon className={styles['icon']} name={state.status === 'playing' || state.status === 'loading' ? 'pause' : 'play'} />
                            </IconButton>
                            <IconButton label={'Next'} onClick={() => player.next()} disabled={state.pos + 1 >= state.order.length && state.repeat !== 'all'}>
                                <Icon className={styles['icon']} name={'skip-forward'} />
                            </IconButton>
                        </div>
                    </div>
                    :
                    null
            }
            {view === 'queue' ? <Queue state={state} player={player} onClose={close} /> : null}
            {view === 'now' ? <NowPlaying state={state} player={player} onClose={close} onQueue={() => setView('queue')} /> : null}
        </>
    );
};

module.exports = PlayerBar;
