// stremio-music: artist page, merged across sources (server: api/music/artist). Shows the source's
// own page at once, then the merged one when it arrives (other sources are searched for it).

const React = require('react');
const PropTypes = require('prop-types');
const usePlayer = require('stremio/music/player/usePlayer');
const { api, queueItems } = require('stremio/music/data');
const { TrackList, LikeButton, SourceBadge, Grid, Loading } = require('stremio/music/components');
const { useAsync, Cover, Hero, PlayButton, ShuffleButton } = require('./common');
const styles = require('./styles');

const TOP_SHOWN = 5;

const Artist = ({ id, preview }) => {
    const [, player] = usePlayer();
    const merged = useAsync(() => api.artist(id), [id]);
    const [more, setMore] = React.useState(false);
    const { meta, source } = merged.data ?? preview;
    const sources = merged.data?.sources?.map((s) => s.source) ?? [source];
    const multi = sources.length > 1;
    const tracks = queueItems({ ...meta, music: { ...meta.music, kind: 'artist' } }, source);
    const albums = (meta.albums ?? []).map((a) => ({ ...a, source: a.source ?? source }));
    const play = (i, shuffle = false) => player.playQueue(tracks, i, { shuffle });
    return (
        <div className={styles['page']}>
            <Hero
                cover={<Cover src={meta.poster ?? albums.find((a) => a.poster)?.poster} round />}
                kind={<>{'Artist'}{sources.map((s) => <SourceBadge key={s.id} name={s.name} />)}</>}
                title={meta.name}
                sub={merged.loading ? <span className={styles['muted']}>{'Looking for this artist on your other sources…'}</span> : null}
                description={meta.description}
                actions={
                    <>
                        {tracks.length ? <PlayButton label={`Play ${meta.name}`} onClick={() => play(0)} /> : null}
                        {tracks.length > 1 ? <ShuffleButton onClick={() => play(0, true)} /> : null}
                        <LikeButton item={meta} kind={'artist'} source={source} big />
                    </>
                }
            />
            {
                tracks.length ?
                    <section className={styles['section']}>
                        <h2>{'Popular'}</h2>
                        <TrackList items={more ? tracks : tracks.slice(0, TOP_SHOWN)} onPlay={(i) => play(i)} showArt showSource={multi} />
                        {tracks.length > TOP_SHOWN ? <button type={'button'} className={styles['text-btn']} onClick={() => setMore(!more)}>{more ? 'Show less' : 'Show more'}</button> : null}
                    </section>
                    :
                    null
            }
            {
                albums.length ?
                    <section className={styles['section']}>
                        <h2>{'Albums'}</h2>
                        <Grid metas={albums} showSource={multi} />
                    </section>
                    :
                    null
            }
            {merged.loading && !tracks.length && !albums.length ? <Loading /> : null}
        </div>
    );
};

Artist.propTypes = { id: PropTypes.string.isRequired, preview: PropTypes.object.isRequired };

module.exports = Artist;
