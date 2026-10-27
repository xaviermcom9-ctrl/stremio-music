// stremio-music: Home. Your library at a glance, then each source's catalogs as rows, grouped by
// source in the order set on the Sources page.

const React = require('react');
const PropTypes = require('prop-types');
const MusicIcon = require('stremio/music/icons');
const { api } = require('stremio/music/data');
const { itemHref } = require('stremio/music/player/ui/common');
const useLibrary = require('stremio/music/library/useLibrary');
const { CatalogRow, Loading, ErrorBox } = require('stremio/music/components');
const { useAsync, Cover } = require('./common');
const styles = require('./styles');

const greeting = () => {
    const h = new Date().getHours();
    return h < 5 ? 'Good night' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
};

/** Up to 8 shortcuts: Liked songs, then recent playlists and saved albums/artists/stations. */
const QuickTiles = () => {
    const [lib] = useLibrary();
    const liked = lib.items.filter((i) => i.kind === 'track').length;
    const tiles = [
        ...(liked ? [{ key: 'liked', href: '#/music/library/liked', name: 'Liked songs', liked: true }] : []),
        ...lib.playlists.map((p) => ({ key: `p${p.id}`, href: `#/music/playlist/${p.id}`, name: p.name, mosaic: p.posters, at: p.updatedAt })),
        ...lib.items.filter((i) => i.kind !== 'track').map((i) => ({ key: `${i.kind}:${i.id}`, href: itemHref(i.id), name: i.data.name, poster: i.data.poster, round: i.kind === 'artist', at: i.addedAt })),
    ];
    const shown = [tiles[0], ...tiles.slice(1).sort((a, b) => (b.at ?? 0) - (a.at ?? 0))].filter(Boolean).slice(0, 8);
    if (!shown.length) return null;
    return (
        <div className={styles['tiles']}>
            {
                shown.map((t) => (
                    <a key={t.key} className={styles['tile']} href={t.href}>
                        {t.liked ? <span className={styles['liked-cover']}><MusicIcon className={styles['liked-icon']} name={'heart-filled'} /></span> : <Cover src={t.poster} mosaic={t.mosaic} round={t.round} className={styles['tile-cover']} />}
                        <span className={styles['tile-name']}>{t.name}</span>
                    </a>
                ))
            }
        </div>
    );
};

const SourceGroup = ({ source }) => {
    const rows = source.catalogs.filter((c) => c.feed);
    // radio has its own page: one row here is enough
    const shown = source.capabilities.live ? rows.slice(0, 1) : rows;
    if (!shown.length) return null;
    return (
        <section className={styles['source-group']}>
            <h2 className={styles['group-title']}>
                {source.icon ? <img className={styles['group-icon']} src={source.icon} alt={''} /> : null}
                {source.name}
                {source.capabilities.live ? <a className={styles['group-link']} href={'#/music/radio'}>{'All radio'}</a> : null}
            </h2>
            {shown.map((c) => <CatalogRow key={c.id} source={source} catalog={c} hideBadge />)}
        </section>
    );
};

SourceGroup.propTypes = { source: PropTypes.object.isRequired };

const Home = () => {
    const { data: sources, error, loading } = useAsync(() => api.sources(), []);
    return (
        <div className={styles['page']}>
            <h1 className={styles['page-title']}>{greeting()}</h1>
            <QuickTiles />
            {loading ? <Loading /> : null}
            {error ? <ErrorBox message={error} /> : null}
            {sources && sources.length === 0 ? <p className={styles['muted']}>{'No active sources yet. Set them up under Sources.'}</p> : null}
            {(sources ?? []).map((s) => <SourceGroup key={s.id} source={s} />)}
        </div>
    );
};

module.exports = Home;
