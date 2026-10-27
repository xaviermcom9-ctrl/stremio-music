// stremio-music: Radio. Live stations from sources with live streams (Radio Browser): their rows,
// then browsing by genre.

const React = require('react');
const PropTypes = require('prop-types');
const { api } = require('stremio/music/data');
const useLibrary = require('stremio/music/library/useLibrary');
const { CatalogRow, Grid, Shelf, MetaCard, Loading, ErrorBox } = require('stremio/music/components');
const { useAsync } = require('./common');
const styles = require('./styles');

const GENRES = ['pop', 'rock', 'jazz', 'classical', 'electronic', 'dance', 'hits', '80s', '90s', 'chillout', 'ambient', 'news', 'talk', 'hiphop', 'metal', 'oldies', 'country', 'reggae', 'blues', 'folk', 'indie', 'soul'];

const GenreBrowser = ({ source, catalog }) => {
    const [genre, setGenre] = React.useState(null);
    const { data, error } = useAsync(() => (genre ? api.catalog(source.id, catalog.id, { genre }) : Promise.resolve(null)), [genre]);
    return (
        <section className={styles['section']}>
            <h2>{'Browse by genre'}</h2>
            <div className={styles['chips']} role={'group'} aria-label={'Genres'}>
                {GENRES.map((g) => <button key={g} type={'button'} className={styles['chip']} aria-pressed={genre === g} onClick={() => setGenre(genre === g ? null : g)}>{g}</button>)}
            </div>
            {genre && !data && !error ? <Loading /> : null}
            {error ? <ErrorBox message={error} /> : null}
            {data ? <Grid metas={data.metas} source={source} /> : null}
        </section>
    );
};

GenreBrowser.propTypes = { source: PropTypes.object, catalog: PropTypes.object };

const Radio = () => {
    const { data: sources, error, loading } = useAsync(() => api.sources(), []);
    const [lib] = useLibrary();
    if (loading) return <Loading />;
    if (error) return <ErrorBox message={error} />;
    const radios = sources.filter((s) => s.capabilities.live);
    const saved = lib.items.filter((i) => i.kind === 'station');
    return (
        <div className={styles['page']}>
            <h1 className={styles['page-title']}>{'Radio'}</h1>
            {radios.length === 0 ? <p className={styles['muted']}>{'Enable Radio Browser under Sources to listen to internet radio.'}</p> : null}
            {
                saved.length ?
                    <Shelf title={'Your stations'}>
                        {saved.map((i) => <MetaCard key={i.id} meta={{ ...i.data, type: 'music', music: { ...i.data.music, kind: 'station' } }} source={i.data.source} />)}
                    </Shelf>
                    :
                    null
            }
            {
                radios.map((s) => {
                    const tag = s.catalogs.find((c) => c.id === 'tag');
                    return (
                        <React.Fragment key={s.id}>
                            {s.catalogs.filter((c) => c.feed).map((c) => <CatalogRow key={c.id} source={s} catalog={c} hideBadge={radios.length === 1} />)}
                            {tag ? <GenreBrowser source={s} catalog={tag} /> : null}
                        </React.Fragment>
                    );
                })
            }
        </div>
    );
};

module.exports = Radio;
