// stremio-music: Search. One box; results from every source grouped Artists / Albums / Tracks /
// Stations / Playlists, each with its source's badge.

const React = require('react');
const usePlayer = require('stremio/music/player/usePlayer');
const { api, queueItems } = require('stremio/music/data');
const { Grid, TrackList, Loading, ErrorBox } = require('stremio/music/components');
const { useAsync } = require('./common');
const styles = require('./styles');

const GROUPS = [['artist', 'Artists'], ['album', 'Albums'], ['track', 'Tracks'], ['station', 'Stations'], ['playlist', 'Playlists']];
const TRACKS_SHOWN = 10;

const queryFromHash = () => new URLSearchParams(window.location.hash.split('?')[1] ?? '').get('q') ?? '';

const Search = () => {
    const [q, setQ] = React.useState(queryFromHash);
    const [query, setQuery] = React.useState(q.trim());
    const [allTracks, setAllTracks] = React.useState(false);
    const [, player] = usePlayer();
    React.useEffect(() => {
        const t = setTimeout(() => {
            setQuery(q.trim());
            setAllTracks(false);
            // keep the query in the URL so Back returns to these results
            const base = window.location.hash.split('?')[0];
            window.history.replaceState(window.history.state, '', q.trim() ? `${base}?q=${encodeURIComponent(q.trim())}` : base);
        }, 400);
        return () => clearTimeout(t);
    }, [q]);
    const { data, error, loading } = useAsync(() => (query ? api.search(query) : Promise.resolve(null)), [query]);
    const all = (data?.results ?? []).flatMap((r) => r.metas.map((m) => ({ ...m, source: r.source })));
    const seen = new Set();
    const unique = all.filter((m) => !seen.has(m.id) && seen.add(m.id));
    const sourceCount = new Set(unique.map((m) => m.source.id)).size;
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
                GROUPS.map(([kind, title]) => {
                    const metas = unique.filter((m) => m.music?.kind === kind);
                    if (!metas.length) return null;
                    if (kind === 'track') {
                        const items = metas.map((m) => queueItems(m, m.source)[0]);
                        const shown = allTracks ? items : items.slice(0, TRACKS_SHOWN);
                        return (
                            <section key={kind} className={styles['section']}>
                                <h2>{title}</h2>
                                <TrackList items={shown} showArt showAlbum showSource={sourceCount > 1} numbered={false} onPlay={(i) => player.playQueue(items, i)} />
                                {items.length > TRACKS_SHOWN ? <button type={'button'} className={styles['text-btn']} onClick={() => setAllTracks(!allTracks)}>{allTracks ? 'Show fewer' : `Show all ${items.length}`}</button> : null}
                            </section>
                        );
                    }
                    return <section key={kind} className={styles['section']}><h2>{title}</h2><Grid metas={metas} showSource /></section>;
                })
            }
            {data?.errors?.length ? <p className={styles['muted']}>{`Some sources didn't answer: ${[...new Set(data.errors.map((e) => e.source.name))].join(', ')}`}</p> : null}
        </div>
    );
};

module.exports = Search;
