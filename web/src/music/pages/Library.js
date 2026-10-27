// stremio-music: Library (playlists, liked songs, saved albums/artists/stations), Liked songs, and
// the user's own playlists. All stored server-side per user (api/library).

const React = require('react');
const PropTypes = require('prop-types');
const { useParams, useNavigate } = require('react-router');
const classnames = require('classnames');
const { default: Icon } = require('@stremio/stremio-icons/react');
const MusicIcon = require('stremio/music/icons');
const usePlayer = require('stremio/music/player/usePlayer');
const useLibrary = require('stremio/music/library/useLibrary');
const { api, snapshotToItem } = require('stremio/music/data');
const { MetaCard, TrackList, Menu, Loading, ErrorBox, download } = require('stremio/music/components');
const { canDownload } = require('stremio/music/data');
const { toast, addToPlaylist, Dialog } = require('stremio/music/components/overlays');
const { useAsync, Cover, Hero, PlayButton, ShuffleButton, formatLength, plural } = require('./common');
const styles = require('./styles');

/** "Download all" for a list of queue items: the downloadable ones, as one entry. */
const downloadAll = (items, title) => {
    const ok = items.filter((t) => canDownload(t.id, t.live));
    if (!ok.length) return null;
    return {
        label: ok.length === items.length ? 'Download all' : `Download ${ok.length} of ${items.length} (the others can’t be downloaded)`,
        onSelect: () => download({ items: ok.map((t) => ({ id: t.id, albumId: t.albumId ?? undefined })), title }, `${ok.length} tracks`),
    };
};

// ---------------------------------------------------------------- dialogs

const PlaylistDialog = ({ title, initial = {}, submitLabel, onSubmit, onClose }) => {
    const [name, setName] = React.useState(initial.name ?? '');
    const [description, setDescription] = React.useState(initial.description ?? '');
    const [busy, setBusy] = React.useState(false);
    const submit = async (e) => {
        e.preventDefault();
        if (!name.trim()) return;
        setBusy(true);
        try {
            await onSubmit({ name: name.trim(), description: description.trim() });
            onClose();
        } catch (err) {
            toast(err.message, { error: true });
            setBusy(false);
        }
    };
    return (
        <Dialog title={title} onClose={onClose}>
            <form className={styles['form']} onSubmit={submit}>
                <label>{'Name'}<input type={'text'} value={name} maxLength={200} required onChange={(e) => setName(e.target.value)} /></label>
                <label>{'Description'}<textarea value={description} maxLength={2000} rows={3} onChange={(e) => setDescription(e.target.value)} /></label>
                <button type={'submit'} className={styles['pill']} disabled={busy || !name.trim()}>{submitLabel}</button>
            </form>
        </Dialog>
    );
};

PlaylistDialog.propTypes = { title: PropTypes.string.isRequired, initial: PropTypes.object, submitLabel: PropTypes.string.isRequired, onSubmit: PropTypes.func.isRequired, onClose: PropTypes.func.isRequired };

const ConfirmDialog = ({ title, text, confirmLabel, onConfirm, onClose }) => (
    <Dialog title={title} onClose={onClose}>
        <p className={styles['dialog-text']}>{text}</p>
        <div className={styles['dialog-actions']}>
            <button type={'button'} className={styles['pill-quiet']} onClick={onClose}>{'Cancel'}</button>
            <button type={'button'} className={styles['pill-danger']} onClick={() => onConfirm().then(onClose, (e) => toast(e.message, { error: true }))}>{confirmLabel}</button>
        </div>
    </Dialog>
);

ConfirmDialog.propTypes = { title: PropTypes.string.isRequired, text: PropTypes.string.isRequired, confirmLabel: PropTypes.string.isRequired, onConfirm: PropTypes.func.isRequired, onClose: PropTypes.func.isRequired };

/** "New playlist" button + dialog; opens the new playlist. */
const NewPlaylistButton = ({ className, children }) => {
    const [open, setOpen] = React.useState(false);
    const [, library] = useLibrary();
    const navigate = useNavigate();
    return (
        <>
            <button type={'button'} className={className ?? styles['pill']} onClick={() => setOpen(true)}>{children ?? <><Icon className={styles['icon']} name={'add'} />{'New playlist'}</>}</button>
            {
                open ?
                    <PlaylistDialog
                        title={'New playlist'}
                        submitLabel={'Create'}
                        onClose={() => setOpen(false)}
                        onSubmit={async ({ name, description }) => {
                            const p = await library.createPlaylist(name);
                            if (description) await library.updatePlaylist(p.id, { description });
                            navigate(`/music/playlist/${p.id}`);
                        }}
                    />
                    :
                    null
            }
        </>
    );
};

NewPlaylistButton.propTypes = { className: PropTypes.string, children: PropTypes.node };

// ---------------------------------------------------------------- Library

const FILTERS = [['all', 'All'], ['playlist', 'Playlists'], ['album', 'Albums'], ['artist', 'Artists'], ['station', 'Stations']];

const PlaylistCard = ({ playlist }) => (
    <a className={styles['lib-card']} href={`#/music/playlist/${playlist.id}`}>
        <Cover mosaic={playlist.posters} icon={'playlist'} className={styles['lib-cover']} />
        <span className={styles['lib-title']}>{playlist.name}</span>
        <span className={styles['lib-sub']}>
            {playlist.sync ? <MusicIcon className={styles['sync-icon']} name={'sync'} /> : null}
            {`Playlist · ${plural(playlist.trackCount, 'track')}`}
        </span>
    </a>
);

PlaylistCard.propTypes = { playlist: PropTypes.object.isRequired };

const LikedCard = ({ count }) => (
    <a className={classnames(styles['lib-card'], styles['liked-card'])} href={'#/music/library/liked'}>
        <span className={styles['liked-cover']}><MusicIcon className={styles['liked-icon']} name={'heart-filled'} /></span>
        <span className={styles['lib-title']}>{'Liked songs'}</span>
        <span className={styles['lib-sub']}>{plural(count, 'song')}</span>
    </a>
);

LikedCard.propTypes = { count: PropTypes.number.isRequired };

const Library = () => {
    const [lib, library] = useLibrary();
    const [filter, setFilter] = React.useState('all');
    const [sort, setSort] = React.useState('recent');
    const [refreshing, setRefreshing] = React.useState(false);
    const liked = lib.items.filter((i) => i.kind === 'track');
    const byName = (a, b) => a.name.localeCompare(b.name);
    const entries = [
        ...lib.playlists.map((p) => ({ kind: 'playlist', key: `local:${p.id}`, name: p.name, at: p.updatedAt, el: <PlaylistCard playlist={p} /> })),
        ...lib.items.filter((i) => i.kind !== 'track').map((i) => ({
            kind: i.kind,
            key: `${i.kind}:${i.id}`,
            name: i.data.name,
            at: i.addedAt,
            el: <MetaCard meta={{ ...i.data, type: 'music', music: { ...i.data.music, kind: i.kind } }} source={i.data.source} showSource />,
        })),
    ]
        .filter((e) => filter === 'all' || e.kind === filter)
        .sort(sort === 'name' ? byName : (a, b) => b.at - a.at);
    const counts = Object.fromEntries(FILTERS.map(([k]) => [k, k === 'all' ? null : k === 'playlist' ? lib.playlists.length : lib.items.filter((i) => i.kind === k).length]));
    const refresh = () => {
        setRefreshing(true);
        library.load(true).finally(() => setRefreshing(false));
    };
    return (
        <div className={styles['page']}>
            <div className={styles['page-head']}>
                <h1 className={styles['page-title']}>{'Your library'}</h1>
                <NewPlaylistButton />
            </div>
            <div className={styles['toolbar']}>
                <div className={styles['chips']} role={'group'} aria-label={'Show'}>
                    {
                        FILTERS.filter(([k]) => k === 'all' || counts[k]).map(([k, label]) => (
                            <button key={k} type={'button'} className={styles['chip']} aria-pressed={filter === k} onClick={() => setFilter(k)}>{label}</button>
                        ))
                    }
                </div>
                <label className={styles['sort']}>
                    <span className={styles['visually-hidden']}>{'Sort'}</span>
                    <select value={sort} onChange={(e) => setSort(e.target.value)}>
                        <option value={'recent'}>{'Recently added'}</option>
                        <option value={'name'}>{'Name'}</option>
                    </select>
                </label>
                <button type={'button'} className={styles['text-btn']} onClick={refresh} disabled={refreshing} title={'Pull likes from synced sources (Navidrome)'}>
                    {refreshing ? 'Syncing…' : 'Sync'}
                </button>
            </div>
            {!lib.loaded ? <Loading /> : null}
            {lib.error ? <ErrorBox message={lib.error} /> : null}
            {lib.errors.map((e) => <p key={e.source.id} className={styles['muted']}>{`Couldn't get your likes from ${e.source.name}: ${e.error}`}</p>)}
            <div className={styles['grid']}>
                {filter === 'all' || filter === 'playlist' ? <LikedCard count={liked.length} /> : null}
                {entries.map((e) => <React.Fragment key={e.key}>{e.el}</React.Fragment>)}
            </div>
            {
                lib.loaded && !lib.items.length && !lib.playlists.length ?
                    <p className={styles['muted']}>{'Tap the heart on songs, albums, artists and stations to keep them here, or make a playlist.'}</p>
                    :
                    null
            }
        </div>
    );
};

// ---------------------------------------------------------------- Liked songs

const Liked = () => {
    const [lib] = useLibrary();
    const [, player] = usePlayer();
    const items = lib.items.filter((i) => i.kind === 'track').map((i) => snapshotToItem(i.data));
    const total = items.reduce((s, t) => s + (t.duration ?? 0), 0);
    const play = (i, shuffle = false) => player.playQueue(items, i, { shuffle });
    return (
        <div className={styles['page']}>
            <Hero
                cover={<span className={classnames(styles['cover'], styles['liked-cover'])}><MusicIcon className={styles['liked-icon']} name={'heart-filled'} /></span>}
                kind={'Playlist'}
                title={'Liked songs'}
                sub={<span>{plural(items.length, 'song')}{total ? `, ${formatLength(total)}` : ''}</span>}
                actions={
                    items.length ?
                        <>
                            <PlayButton label={'Play Liked songs'} onClick={() => play(0)} />
                            <ShuffleButton onClick={() => play(0, true)} />
                            <Menu
                                label={'More options for Liked songs'}
                                items={[
                                    { label: 'Add to queue', onSelect: () => player.enqueue(items) },
                                    { label: 'Add to playlist…', onSelect: () => addToPlaylist(items) },
                                    downloadAll(items, 'Liked songs'),
                                ]}
                            />
                        </>
                        :
                        null
                }
            />
            {!lib.loaded ? <Loading /> : null}
            {lib.loaded && !items.length ? <p className={styles['muted']}>{'Songs you like appear here. Tap the heart next to any song.'}</p> : null}
            <TrackList items={items} onPlay={(i) => play(i)} showArt showAlbum showSource />
        </div>
    );
};

// ---------------------------------------------------------------- one of your playlists

const Playlist = () => {
    const id = Number(useParams().id);
    const navigate = useNavigate();
    const [, player] = usePlayer();
    const [lib, library] = useLibrary();
    const [version, setVersion] = React.useState(0);
    const [dialog, setDialog] = React.useState(null);
    const { data, error, loading } = useAsync(() => library.playlist(id), [id, version], { keep: true });
    const { data: sources } = useAsync(() => api.sources(), []);

    // reload after any change to this playlist (here or from the "Add to playlist" picker)
    React.useEffect(() => {
        const on = (pid) => pid === id && setVersion((v) => v + 1);
        library.on('playlist', on);
        return () => library.off('playlist', on);
    }, [id]);

    if (loading && !data) return <Loading />;
    if (error) return <ErrorBox message={error} />;
    const p = lib.playlists.find((x) => x.id === id) ?? data.playlist;
    const items = data.tracks.map((t) => ({ ...snapshotToItem(t.data), entry: t.entry }));
    const play = (i, shuffle = false) => player.playQueue(items, i, { shuffle });
    const targets = (sources ?? []).filter((s) => s.sync?.playlists);
    const guard = (promise) => promise.then((r) => {
        if (r?.syncError) toast(`Playlist sync: ${r.syncError}`, { error: true });
    }, (e) => toast(e.message, { error: true }));

    return (
        <div className={styles['page']}>
            <Hero
                cover={<Cover mosaic={p.posters} icon={'playlist'} />}
                kind={'Playlist'}
                title={p.name}
                sub={
                    <>
                        <span>{plural(p.trackCount, 'track')}{p.duration ? `, ${formatLength(p.duration)}` : ''}</span>
                        {p.sync ? <span className={p.syncError ? styles['sync-error'] : null}><MusicIcon className={styles['sync-icon']} name={'sync'} />{p.syncError ? `Sync failed: ${p.syncError}` : `Synced to ${targets.map((s) => s.name).join(', ') || 'your sources'}`}</span> : null}
                    </>
                }
                description={p.description}
                actions={
                    <>
                        {items.length ? <PlayButton label={`Play ${p.name}`} onClick={() => play(0)} /> : null}
                        {items.length > 1 ? <ShuffleButton onClick={() => play(0, true)} /> : null}
                        <Menu
                            label={`More options for ${p.name}`}
                            items={[
                                items.length ? { label: 'Add to queue', onSelect: () => player.enqueue(items) } : null,
                                { label: 'Edit details', onSelect: () => setDialog('edit') },
                                downloadAll(items, p.name),
                                ...targets.map((s) => ({
                                    label: p.sync ? `Stop syncing to ${s.name}` : `Sync to ${s.name}`,
                                    onSelect: () => guard(library.updatePlaylist(id, { sync: !p.sync })).then(() => toast(p.sync ? `No longer synced (the copy on ${s.name} stays)` : `Synced to ${s.name}: its tracks from ${s.name} appear there`)),
                                })),
                                { label: 'Delete playlist', onSelect: () => setDialog('delete') },
                            ]}
                        />
                    </>
                }
            />
            {
                items.length ?
                    <TrackList
                        items={items}
                        onPlay={(i) => play(i)}
                        showArt
                        showAlbum
                        showSource
                        extraMenu={(t, i) => [
                            i > 0 ? { label: 'Move up', onSelect: () => guard(library.moveInPlaylist(id, t.entry, i - 1)) } : null,
                            i < items.length - 1 ? { label: 'Move down', onSelect: () => guard(library.moveInPlaylist(id, t.entry, i + 1)) } : null,
                            { label: 'Remove from this playlist', onSelect: () => guard(library.removeFromPlaylist(id, t.entry)) },
                        ]}
                    />
                    :
                    <p className={styles['muted']}>{'Empty for now. Use “Add to playlist…” in any track’s menu.'}</p>
            }
            {
                dialog === 'edit' ?
                    <PlaylistDialog title={'Edit details'} initial={p} submitLabel={'Save'} onClose={() => setDialog(null)} onSubmit={(patch) => library.updatePlaylist(id, patch)} />
                    :
                    null
            }
            {
                dialog === 'delete' ?
                    <ConfirmDialog
                        title={`Delete “${p.name}”?`}
                        text={p.sync ? `This also deletes its copy on ${targets.map((s) => s.name).join(', ') || 'your synced sources'}.` : 'This can’t be undone.'}
                        confirmLabel={'Delete'}
                        onClose={() => setDialog(null)}
                        onConfirm={() => library.deletePlaylist(id).then(() => navigate('/music/library'))}
                    />
                    :
                    null
            }
        </div>
    );
};

module.exports = { Library, Liked, Playlist, NewPlaylistButton };
