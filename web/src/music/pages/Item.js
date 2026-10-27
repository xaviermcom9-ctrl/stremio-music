// stremio-music: one item from a source: album, playlist, station or track (artists: Artist.js).

const React = require('react');
const PropTypes = require('prop-types');
const { useParams, useNavigate } = require('react-router');
const MusicIcon = require('stremio/music/icons');
const usePlayer = require('stremio/music/player/usePlayer');
const { itemHref, formatTime } = require('stremio/music/player/ui/common');
const { api, queueItems, canDownload } = require('stremio/music/data');
const { TrackList, LikeButton, Menu, SourceBadge, Grid, Loading, ErrorBox, KIND_LABEL, download } = require('stremio/music/components');
const { addToPlaylist } = require('stremio/music/components/overlays');
const { useAsync, Cover, Hero, PlayButton, ShuffleButton, formatLength, plural } = require('./common');
const Artist = require('./Artist');
const styles = require('./styles');

/** Albums served as one multi-file torrent: list its audio files as tracks. */
const useTorrentTracks = (id, meta) => {
    const [torrent, setTorrent] = React.useState(null);
    React.useEffect(() => {
        setTorrent(null);
        if (!meta || meta.videos?.length || !['album', undefined].includes(meta.music?.kind)) return;
        let cancelled = false;
        api.streams(id)
            .then(async (r) => {
                const t = r.streams.find((s) => s.infoHash && s.fileIdx === undefined);
                if (!t) return;
                setTorrent({ loading: true });
                const trackers = (t.sources ?? []).filter((s) => s.startsWith('tracker:'));
                const files = await api.torrentFiles(t.infoHash, trackers);
                if (!cancelled) setTorrent({ files: files.files.map((f) => ({ id: `torrent:${files.infoHash}:${f.fileIdx}`, title: f.name.replace(/^.*\//, '').replace(/\.[^.]+$/, ''), file: f.name, artist: meta.music?.artist ?? null, album: meta.name, poster: meta.poster })) });
            })
            .catch((e) => !cancelled && setTorrent({ error: e.message }));
        return () => {
            cancelled = true;
        };
    }, [meta, id]);
    return torrent;
};

/** The same album on other sources: a picker that switches to it. */
const SourcePicker = ({ id, source }) => {
    const navigate = useNavigate();
    const { data } = useAsync(() => api.alternatives(id).catch(() => ({ alternatives: [] })), [id]);
    const alts = data?.alternatives ?? [];
    if (!alts.length) return null;
    const detail = (a) => [a.releaseInfo, a.trackCount ? plural(a.trackCount, 'track') : null, a.licence].filter(Boolean).join(' · ');
    return (
        <label className={styles['source-picker']}>
            <span>{'Source'}</span>
            <select value={id} onChange={(e) => navigate(itemHref(e.target.value).slice(1))}>
                <option value={id}>{source.name}</option>
                {alts.map((a) => <option key={a.id} value={a.id}>{`${a.source.name}${detail(a) ? ` — ${detail(a)}` : ''}`}</option>)}
            </select>
        </label>
    );
};

SourcePicker.propTypes = { id: PropTypes.string.isRequired, source: PropTypes.object.isRequired };

const ItemView = ({ id }) => {
    const [, player] = usePlayer();
    const { data, error, loading } = useAsync(() => api.meta(id), [id]);
    const torrent = useTorrentTracks(id, data?.meta);

    if (loading) return <Loading />;
    if (error) return <ErrorBox message={error === 'not found' ? 'This item is no longer available from its source.' : error} />;
    const { meta, source } = data;
    const kind = meta.music?.kind ?? (meta.videos?.length ? 'album' : 'track');
    if (kind === 'artist') return <Artist id={id} preview={data} />;
    const items = (torrent?.files ?? queueItems(meta, source)).map((t) => ({ ...t, sourceName: t.sourceName ?? source.name, albumId: t.albumId ?? (torrent ? meta.id : null) }));
    const licence = meta.music?.licence;
    const playAll = (start = 0, shuffle = false) => player.playQueue(items, start, { shuffle });
    const total = items.reduce((s, t) => s + (t.duration ?? 0), 0);
    const isList = kind === 'album' || kind === 'playlist';

    return (
        <div className={styles['page']}>
            <Hero
                cover={<Cover src={meta.poster} icon={kind === 'station' ? 'radio' : 'note'} />}
                kind={<>{kind === 'station' ? <span className={styles['live']}>{'LIVE'}</span> : null}{KIND_LABEL[kind] ?? 'Item'}<SourceBadge name={source.name} /></>}
                title={meta.name}
                sub={
                    <>
                        {meta.music?.artistId ? <a href={itemHref(meta.music.artistId)}>{meta.music.artist}</a> : meta.music?.artist ? <span>{meta.music.artist}</span> : null}
                        {meta.releaseInfo ? <span>{meta.releaseInfo}</span> : null}
                        {isList && items.length ? <span>{plural(items.length, 'track')}{total ? `, ${formatLength(total)}` : ''}</span> : null}
                        {kind === 'track' && meta.music?.duration ? <span>{formatTime(meta.music.duration)}</span> : null}
                    </>
                }
                description={meta.description && kind !== 'album' ? meta.description : null}
                actions={
                    <>
                        {items.length ? <PlayButton label={`Play ${meta.name}`} onClick={() => playAll(0)} /> : null}
                        {items.length > 1 ? <ShuffleButton onClick={() => playAll(0, true)} /> : null}
                        <LikeButton item={meta} source={source} big />
                        {
                            items.length ?
                                <Menu
                                    label={`More options for ${meta.name}`}
                                    items={[
                                        { label: 'Add to queue', onSelect: () => player.enqueue(items) },
                                        kind !== 'station' ? { label: 'Add to playlist…', onSelect: () => addToPlaylist(items) } : null,
                                        meta.music?.artistId ? { label: 'Go to artist', href: itemHref(meta.music.artistId) } : null,
                                        meta.music?.albumId && kind === 'track' ? { label: 'Go to album', href: itemHref(meta.music.albumId) } : null,
                                        kind !== 'station' && canDownload(meta.id) ? { label: kind === 'track' ? 'Download' : `Download ${kind}`, onSelect: () => download({ id: meta.id }, `“${meta.name}”`) } : null,
                                    ]}
                                />
                                :
                                null
                        }
                        {kind === 'album' ? <SourcePicker id={id} source={source} /> : null}
                    </>
                }
            />

            {torrent?.loading ? <Loading /> : null}
            {torrent?.error ? <ErrorBox message={`Torrent: ${torrent.error}`} /> : null}
            {isList && items.length ? <TrackList items={items} onPlay={(i) => playAll(i)} showArt={kind === 'playlist'} showAlbum={kind === 'playlist'} /> : null}

            {
                meta.albums?.length ?
                    <section className={styles['section']}>
                        <h2>{'More'}</h2>
                        <Grid metas={meta.albums} source={source} />
                    </section>
                    :
                    null
            }

            <footer className={styles['credits']}>
                {licence ? <div>{licence.url ? <a href={licence.url} target={'_blank'} rel={'noreferrer'}>{licence.name}</a> : licence.name}{licence.attribution ? ` · ${licence.attribution}` : ''}</div> : null}
                {(meta.links ?? []).filter((l) => /^https?:/.test(l.url)).map((l) => <a key={l.url} href={l.url} target={'_blank'} rel={'noreferrer'}>{l.name}</a>)}
                {kind === 'album' && meta.description ? <p className={styles['description']}>{meta.description}</p> : null}
            </footer>
        </div>
    );
};

ItemView.propTypes = { id: PropTypes.string.isRequired };

const Item = () => {
    const id = decodeURIComponent(useParams()['*'] ?? '');
    return <ItemView key={id} id={id} />;
};

module.exports = Item;
