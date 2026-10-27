// stremio-music: Home, item pages (album/artist/playlist/station/track), Radio and Search.
// Functional versions for playback (Phase 7); the full music UI comes in Phase 8.

const React = require('react');
const PropTypes = require('prop-types');
const { useParams } = require('react-router');
const { default: Icon } = require('@stremio/stremio-icons/react');
const MusicIcon = require('stremio/music/icons');
const usePlayer = require('stremio/music/player/usePlayer');
const { itemHref, formatTime } = require('stremio/music/player/ui/common');
const { api, queueItems } = require('stremio/music/data');
const { CatalogRow, Grid, TrackList, Loading, ErrorBox, KIND_LABEL } = require('stremio/music/components');
const styles = require('./styles');

const useAsync = (load, deps) => {
    const [state, setState] = React.useState({ data: null, error: null, loading: true });
    React.useEffect(() => {
        let cancelled = false;
        setState({ data: null, error: null, loading: true });
        load()
            .then((data) => !cancelled && setState({ data, error: null, loading: false }))
            .catch((error) => !cancelled && setState({ data: null, error: error.message, loading: false }));
        return () => {
            cancelled = true;
        };
    }, deps);
    return state;
};

// ---------------------------------------------------------------- Home

const Home = () => {
    const { data: sources, error, loading } = useAsync(() => api.sources(), []);
    if (loading) return <Loading />;
    if (error) return <ErrorBox message={error} />;
    const rows = sources.flatMap((s) => s.catalogs.filter((c) => c.feed && s.id !== 'radio-browser').map((c) => ({ s, c })));
    return (
        <div className={styles['page']}>
            <h1 className={styles['page-title']}>{'Home'}</h1>
            {rows.length === 0 ? <p className={styles['muted']}>{'No active sources yet. Set them up under Sources.'}</p> : null}
            {rows.map(({ s, c }) => <CatalogRow key={`${s.id}:${c.id}`} source={s} catalog={c} />)}
        </div>
    );
};

// ---------------------------------------------------------------- Item

const Item = () => {
    const id = decodeURIComponent(useParams()['*'] ?? '');
    const [, player] = usePlayer();
    const { data, error, loading } = useAsync(() => api.meta(id), [id]);
    const [torrent, setTorrent] = React.useState(null);

    // albums served as one multi-file torrent: list its audio files as tracks
    React.useEffect(() => {
        setTorrent(null);
        if (!data || data.meta.videos?.length || !['album', undefined].includes(data.meta.music?.kind)) return;
        let cancelled = false;
        api.streams(id)
            .then(async (r) => {
                const t = r.streams.find((s) => s.infoHash && s.fileIdx === undefined);
                if (!t) return;
                setTorrent({ loading: true });
                const trackers = (t.sources ?? []).filter((s) => s.startsWith('tracker:'));
                const files = await api.torrentFiles(t.infoHash, trackers);
                if (!cancelled) setTorrent({ files: files.files.map((f) => ({ id: `torrent:${files.infoHash}:${f.fileIdx}`, title: f.name.replace(/^.*\//, '').replace(/\.[^.]+$/, ''), file: f.name, artist: data.meta.music?.artist ?? null, album: data.meta.name, poster: data.meta.poster })) });
            })
            .catch((e) => !cancelled && setTorrent({ error: e.message }));
        return () => {
            cancelled = true;
        };
    }, [data, id]);

    if (loading) return <Loading />;
    if (error) return <ErrorBox message={error === 'not found' ? 'This item is no longer available from its source.' : error} />;
    const { meta, source } = data;
    const kind = meta.music?.kind ?? (meta.videos?.length ? 'album' : 'track');
    const items = torrent?.files ?? queueItems(meta, source);
    const licence = meta.music?.licence;
    const playAll = (start = 0, shuffle = false) => player.playQueue(items.map((t) => ({ ...t, sourceName: source.name })), start, { shuffle });

    return (
        <div className={styles['page']}>
            <header className={styles['hero']}>
                <div className={styles[kind === 'artist' ? 'hero-art-round' : 'hero-art']}>
                    {meta.poster ? <img src={meta.poster} alt={''} /> : <MusicIcon className={styles['hero-placeholder']} name={kind === 'station' ? 'radio' : 'note'} />}
                </div>
                <div className={styles['hero-text']}>
                    <div className={styles['kind']}>
                        {kind === 'station' ? <span className={styles['live']}>{'LIVE'}</span> : null}
                        {KIND_LABEL[kind] ?? 'Item'}
                        <span className={styles['source-badge']}>{source.name}</span>
                    </div>
                    <h1 className={styles['hero-title']}>{meta.name}</h1>
                    <div className={styles['hero-sub']}>
                        {meta.music?.artistId ? <a href={itemHref(meta.music.artistId)}>{meta.music.artist}</a> : meta.music?.artist}
                        {meta.releaseInfo ? <span>{meta.releaseInfo}</span> : null}
                        {items.length > 1 ? <span>{`${items.length} tracks`}</span> : null}
                        {kind === 'track' && meta.music?.duration ? <span>{formatTime(meta.music.duration)}</span> : null}
                    </div>
                    {meta.description && kind !== 'album' ? <p className={styles['description']}>{meta.description}</p> : null}
                    <div className={styles['actions']}>
                        {
                            items.length ?
                                <button type={'button'} className={styles['play-big']} onClick={() => playAll(0)} aria-label={`Play ${meta.name}`}>
                                    <Icon className={styles['icon']} name={'play'} />
                                </button>
                                :
                                null
                        }
                        {
                            items.length > 1 ?
                                <button type={'button'} className={styles['pill']} onClick={() => playAll(0, true)}>
                                    <MusicIcon className={styles['icon']} name={'shuffle'} />{'Shuffle'}
                                </button>
                                :
                                null
                        }
                        {items.length ? <button type={'button'} className={styles['pill']} onClick={() => player.enqueue(items.map((t) => ({ ...t, sourceName: source.name })))}>{'Add to queue'}</button> : null}
                    </div>
                </div>
            </header>

            {torrent?.loading ? <Loading /> : null}
            {torrent?.error ? <ErrorBox message={`Torrent: ${torrent.error}`} /> : null}
            {items.length > 1 || (items.length === 1 && kind !== 'track' && kind !== 'station') ? <TrackList items={items} onPlay={(i) => playAll(i)} /> : null}

            {
                meta.albums?.length ?
                    <section className={styles['section']}>
                        <h2>{kind === 'artist' ? 'Albums' : 'More'}</h2>
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

// ---------------------------------------------------------------- Radio

const Radio = () => {
    const { data: sources, error, loading } = useAsync(() => api.sources(), []);
    const [genre, setGenre] = React.useState(null);
    if (loading) return <Loading />;
    if (error) return <ErrorBox message={error} />;
    const radios = sources.filter((s) => s.capabilities.live);
    if (radios.length === 0) return <div className={styles['page']}><h1 className={styles['page-title']}>{'Radio'}</h1><p className={styles['muted']}>{'Enable Radio Browser under Sources to listen to internet radio.'}</p></div>;
    return (
        <div className={styles['page']}>
            <h1 className={styles['page-title']}>{'Radio'}</h1>
            {
                radios.map((s) => {
                    const tag = s.catalogs.find((c) => c.id === 'tag');
                    return (
                        <React.Fragment key={s.id}>
                            {s.catalogs.filter((c) => c.feed).map((c) => <CatalogRow key={c.id} source={s} catalog={c} />)}
                            {
                                tag ?
                                    <GenreBrowser source={s} catalog={tag} genre={genre} onGenre={setGenre} />
                                    :
                                    null
                            }
                        </React.Fragment>
                    );
                })
            }
        </div>
    );
};

const GENRES = ['pop', 'rock', 'jazz', 'classical', 'electronic', 'dance', 'hits', '80s', '90s', 'chillout', 'ambient', 'news', 'talk', 'hiphop', 'metal', 'oldies', 'country', 'reggae', 'blues', 'folk', 'indie', 'soul'];

const GenreBrowser = ({ source, catalog, genre, onGenre }) => {
    const { data } = useAsync(() => (genre ? api.catalog(source.id, catalog.id, { genre }) : Promise.resolve(null)), [genre]);
    return (
        <section className={styles['section']}>
            <h2>{'Browse by genre'}</h2>
            <div className={styles['chips']} role={'group'} aria-label={'Genres'}>
                {GENRES.map((g) => <button key={g} type={'button'} className={styles['chip']} aria-pressed={genre === g} onClick={() => onGenre(genre === g ? null : g)}>{g}</button>)}
            </div>
            {genre && !data ? <Loading /> : null}
            {data ? <Grid metas={data.metas} source={source} /> : null}
        </section>
    );
};

GenreBrowser.propTypes = { source: PropTypes.object, catalog: PropTypes.object, genre: PropTypes.string, onGenre: PropTypes.func };

// ---------------------------------------------------------------- Search

const GROUPS = [['artist', 'Artists'], ['album', 'Albums'], ['playlist', 'Playlists'], ['station', 'Stations']];

const Search = () => {
    const [q, setQ] = React.useState(() => new URLSearchParams(window.location.hash.split('?')[1] ?? '').get('q') ?? '');
    const [query, setQuery] = React.useState(q);
    const [, player] = usePlayer();
    React.useEffect(() => {
        const t = setTimeout(() => setQuery(q.trim()), 400);
        return () => clearTimeout(t);
    }, [q]);
    const { data, error, loading } = useAsync(() => (query ? api.search(query) : Promise.resolve(null)), [query]);
    const all = (data?.results ?? []).flatMap((r) => r.metas.map((m) => ({ ...m, source: r.source })));
    const seen = new Set();
    const unique = all.filter((m) => !seen.has(m.id) && seen.add(m.id));
    const tracks = unique.filter((m) => m.music?.kind === 'track');
    const trackItems = tracks.map((m) => ({ ...queueItems(m, m.source)[0] }));
    return (
        <div className={styles['page']}>
            <h1 className={styles['page-title']}>{'Search'}</h1>
            <input
                className={styles['search-input']}
                type={'search'}
                value={q}
                placeholder={'Artists, albums, tracks, stations…'}
                aria-label={'Search music'}
                autoFocus
                onChange={(e) => setQ(e.target.value)}
            />
            {loading && query ? <Loading /> : null}
            {error ? <ErrorBox message={error} /> : null}
            {data && unique.length === 0 ? <p className={styles['muted']}>{`Nothing found for “${query}”.`}</p> : null}
            {
                tracks.length ?
                    <section className={styles['section']}>
                        <h2>{'Tracks'}</h2>
                        <TrackList items={trackItems} showArt onPlay={(i) => player.playQueue(trackItems, i)} />
                    </section>
                    :
                    null
            }
            {
                GROUPS.map(([kind, title]) => {
                    const metas = unique.filter((m) => m.music?.kind === kind);
                    return metas.length ? <section key={kind} className={styles['section']}><h2>{title}</h2><Grid metas={metas} /></section> : null;
                })
            }
            {data?.errors?.length ? <p className={styles['muted']}>{`Some sources didn't answer: ${data.errors.map((e) => e.source.name).join(', ')}`}</p> : null}
        </div>
    );
};

module.exports = { Home, Item, Radio, Search };
