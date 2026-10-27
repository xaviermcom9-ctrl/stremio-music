// stremio-music: album requests through Lidarr. Search Lidarr's catalogue (MusicBrainz), request an
// album; Lidarr's automatic search with your Prowlarr indexers fetches it into the library.
// Admins: the Lidarr/Prowlarr settings.

const React = require('react');
const PropTypes = require('prop-types');
const classnames = require('classnames');
const { default: Icon } = require('@stremio/stremio-icons/react');
const { request } = require('stremio/sm/api');
const { toast } = require('stremio/music/components/overlays');
const { Loading } = require('stremio/music/components');
const { resetLidarrStatus } = require('stremio/music/lidarr');
const styles = require('./styles');

const STATUS = {
    searching: 'Searching',
    wanted: 'Wanted',
    downloading: 'Downloading',
    importing: 'Importing',
    warning: 'Needs attention',
    partial: 'Partly in library',
    available: 'In your library',
    unmonitored: 'Not monitored',
    removed: 'Removed from Lidarr',
};

const CHIP = { available: 'done', downloading: 'downloading', importing: 'downloading', searching: 'downloading', warning: 'failed', removed: 'failed' };

const gb = (b) => (b ? `${(b / 1e9).toFixed(0)} GB free` : '');

// ---------------------------------------------------------------- settings (admin)

const Settings = ({ onClose, onSaved }) => {
    const [s, setS] = React.useState(null);
    const [keys, setKeys] = React.useState({ lidarr: '', prowlarr: '' });
    const [test, setTest] = React.useState(null);
    const [busy, setBusy] = React.useState(false);
    React.useEffect(() => {
        request('GET', 'api/lidarr/settings').then(setS).catch((e) => toast(e.message, { error: true }));
    }, []);
    if (!s) return <Loading />;
    const put = (patch) => request('PUT', 'api/lidarr/settings', patch);
    const withKeys = () => ({
        lidarr: { url: s.lidarr.url, ...(keys.lidarr ? { apiKey: keys.lidarr } : {}) },
        prowlarr: { url: s.prowlarr.url, ...(keys.prowlarr ? { apiKey: keys.prowlarr } : {}) },
    });
    const runTest = async () => {
        setTest({ running: true });
        try {
            setS(await put(withKeys()));
            setKeys({ lidarr: '', prowlarr: '' });
            const t = await request('POST', 'api/lidarr/settings/test');
            setTest(t);
            // first time: preselect Lidarr's first folder and profiles
            if (t.lidarr?.ok) {
                setS((cur) => ({
                    ...cur,
                    lidarr: {
                        ...cur.lidarr,
                        rootFolderPath: cur.lidarr.rootFolderPath || t.lidarr.rootFolders[0]?.path || '',
                        qualityProfileId: cur.lidarr.qualityProfileId || t.lidarr.qualityProfiles[0]?.id || 0,
                        metadataProfileId: cur.lidarr.metadataProfileId || t.lidarr.metadataProfiles[0]?.id || 0,
                    },
                }));
            }
        } catch (err) {
            setTest({ lidarr: { ok: false, message: err.message } });
        }
    };
    const save = async (e) => {
        e.preventDefault();
        setBusy(true);
        try {
            const { url, rootFolderPath, qualityProfileId, metadataProfileId } = s.lidarr;
            const next = await put({ ...withKeys(), lidarr: { ...withKeys().lidarr, url, rootFolderPath, qualityProfileId, metadataProfileId }, allowUsers: s.allowUsers });
            setS(next);
            setKeys({ lidarr: '', prowlarr: '' });
            resetLidarrStatus();
            onSaved();
            toast(next.ready ? 'Lidarr settings saved' : 'Saved. Test the connection and pick the folder and profiles to finish.');
        } catch (err) {
            toast(err.message, { error: true });
        } finally {
            setBusy(false);
        }
    };
    const setL = (k, v) => setS({ ...s, lidarr: { ...s.lidarr, [k]: v } });
    const lt = test?.lidarr;
    const pt = test?.prowlarr;
    return (
        <form className={styles['settings']} onSubmit={save}>
            <div className={styles['settings-head']}>
                <h2>{'Lidarr & Prowlarr'}</h2>
                <button type={'button'} className={styles['link']} onClick={onClose}>{'Close'}</button>
            </div>
            <p className={styles['help']}>{'Requests go to your Lidarr, which searches the indexers Prowlarr gives it and imports into its root folder. API keys: Settings → General → Security in each app.'}</p>
            <fieldset>
                <legend>{'Lidarr'}</legend>
                <label>{'Address'}<input type={'url'} value={s.lidarr.url} onChange={(e) => setL('url', e.target.value)} placeholder={'http://lidarr:8686'} /></label>
                <label>{'API key'}<input type={'password'} value={keys.lidarr} onChange={(e) => setKeys({ ...keys, lidarr: e.target.value })} placeholder={s.lidarr.hasApiKey ? 'Saved (type to change)' : ''} autoComplete={'off'} /></label>
                {
                    lt?.ok ?
                        <>
                            <label>
                                {'Root folder for new artists (the library Navidrome reads)'}
                                <select value={s.lidarr.rootFolderPath} onChange={(e) => setL('rootFolderPath', e.target.value)}>
                                    {lt.rootFolders.map((r) => <option key={r.path} value={r.path}>{`${r.path} ${gb(r.freeSpace)}`}</option>)}
                                </select>
                            </label>
                            <label>
                                {'Quality profile'}
                                <select value={s.lidarr.qualityProfileId} onChange={(e) => setL('qualityProfileId', Number(e.target.value))}>
                                    {lt.qualityProfiles.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                                </select>
                            </label>
                            <label>
                                {'Metadata profile'}
                                <select value={s.lidarr.metadataProfileId} onChange={(e) => setL('metadataProfileId', Number(e.target.value))}>
                                    {lt.metadataProfiles.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                                </select>
                            </label>
                        </>
                        :
                        s.lidarr.rootFolderPath ? <p className={styles['dim']}>{`New artists go to ${s.lidarr.rootFolderPath}. Test the connection to change the folder or profiles.`}</p> : null
                }
                {lt ? <span className={lt.ok ? styles['ok'] : styles['error']}>{lt.message}</span> : null}
            </fieldset>
            <fieldset>
                <legend>{'Prowlarr (optional)'}</legend>
                <label>{'Address'}<input type={'url'} value={s.prowlarr.url} onChange={(e) => setS({ ...s, prowlarr: { ...s.prowlarr, url: e.target.value } })} placeholder={'http://prowlarr:9696'} /></label>
                <label>{'API key'}<input type={'password'} value={keys.prowlarr} onChange={(e) => setKeys({ ...keys, prowlarr: e.target.value })} placeholder={s.prowlarr.hasApiKey ? 'Saved (type to change)' : ''} autoComplete={'off'} /></label>
                {
                    pt ?
                        <div className={styles['dim']}>
                            <span className={pt.ok ? styles['ok'] : styles['error']}>{pt.message}</span>
                            {pt.ok ? ` ${pt.indexers.enabled} of ${pt.indexers.total} indexers enabled${pt.indexers.failing.length ? `; failing: ${pt.indexers.failing.join(', ')}` : ''}. ${pt.lidarrApp ? `Feeds Lidarr (${pt.lidarrApp.syncLevel}).` : 'Lidarr isn’t added as an app in Prowlarr: add it under Settings → Apps so Lidarr gets the indexers.'}` : ''}
                        </div>
                        :
                        null
                }
                {
                    pt?.ok && pt.lidarrApp ?
                        <div className={styles['test']}>
                            <button type={'button'} onClick={() => request('POST', 'api/lidarr/prowlarr/sync').then(() => toast('Prowlarr is syncing its indexers to Lidarr'), (e) => toast(e.message, { error: true }))}>{'Sync indexers to Lidarr'}</button>
                        </div>
                        :
                        null
                }
            </fieldset>
            <label className={styles['check']}>
                <input type={'checkbox'} checked={s.allowUsers} onChange={(e) => setS({ ...s, allowUsers: e.target.checked })} />
                {'Everyone can request albums (otherwise admins only)'}
            </label>
            <div className={styles['test']}>
                <button type={'button'} onClick={runTest} disabled={test?.running}>{test?.running ? 'Testing…' : 'Test connection'}</button>
                <button type={'submit'} className={styles['primary']} disabled={busy}>{'Save'}</button>
            </div>
        </form>
    );
};

Settings.propTypes = { onClose: PropTypes.func.isRequired, onSaved: PropTypes.func.isRequired };

// ---------------------------------------------------------------- requests

const Result = ({ album, onRequest }) => {
    const [busy, setBusy] = React.useState(false);
    const have = album.inLidarr && album.inLidarr.percent >= 100;
    const label = have ? 'In your library' : album.requested ? 'Request again' : album.inLidarr?.monitored ? 'Search again' : 'Request';
    return (
        <li className={styles['result']}>
            <div className={styles['art']}>{album.cover ? <img src={album.cover} alt={''} loading={'lazy'} /> : null}</div>
            <div className={styles['result-text']}>
                <div className={styles['name']}>{album.title}</div>
                <div className={styles['dim']}>{[album.artist, album.year, album.type].filter(Boolean).join(' · ')}</div>
            </div>
            <button
                type={'button'}
                className={classnames(styles['request'], { [styles['quiet']]: have || album.requested })}
                disabled={busy || have}
                onClick={() => {
                    setBusy(true);
                    onRequest(album).finally(() => setBusy(false));
                }}
            >
                {busy ? 'Requesting…' : label}
            </button>
        </li>
    );
};

Result.propTypes = { album: PropTypes.object.isRequired, onRequest: PropTypes.func.isRequired };

const RequestRow = ({ r, onChange }) => (
    <li className={classnames(styles['item'], styles[CHIP[r.status] ?? ''])}>
        <div className={styles['art-small']}>{r.cover ? <img src={r.cover} alt={''} loading={'lazy'} /> : null}</div>
        <div className={styles['item-main']}>
            <div className={styles['item-title']}>
                <span className={styles['name']}>{r.title}</span>
                <span className={styles['dim']}>{[r.artist, r.year].filter(Boolean).join(' · ')}</span>
            </div>
            <div className={styles['item-status']}>
                <span className={styles['chip']}>{STATUS[r.status] ?? r.status}</span>
                {r.detail ? <span className={styles['dim']}>{r.detail}</span> : null}
                {r.requestedBy ? <span className={styles['dim']}>{`requested by ${r.requestedBy}`}</span> : null}
            </div>
            {r.progress !== undefined && r.progress !== null && r.status !== 'available' ? <div className={classnames(styles['bar'], styles['downloading'])}><div style={{ width: `${Math.round(r.progress * 100)}%` }} /></div> : null}
        </div>
        <div className={styles['item-actions']}>
            {['wanted', 'unmonitored', 'warning', 'partial'].includes(r.status) ? <button type={'button'} onClick={() => request('POST', `api/lidarr/requests/${r.id}/search`).then(() => (toast('Lidarr is searching again'), onChange()), (e) => toast(e.message, { error: true }))}>{'Search again'}</button> : null}
            <button type={'button'} title={'Remove from this list (Lidarr keeps the album)'} onClick={() => request('DELETE', `api/lidarr/requests/${r.id}`).then(onChange, (e) => toast(e.message, { error: true }))}>{'Remove'}</button>
        </div>
    </li>
);

RequestRow.propTypes = { r: PropTypes.object.isRequired, onChange: PropTypes.func.isRequired };

const Requests = ({ status, admin, initialQuery, onSettingsSaved }) => {
    const [q, setQ] = React.useState(initialQuery ?? '');
    const [results, setResults] = React.useState(null);
    const [searching, setSearching] = React.useState(false);
    const [list, setList] = React.useState(null);
    const [settings, setSettings] = React.useState(admin && !status.enabled);

    const load = React.useCallback(() => {
        request('GET', 'api/lidarr/requests').then((r) => setList(r.requests)).catch((e) => setList({ error: e.message }));
    }, []);
    React.useEffect(() => {
        load();
        // Lidarr has no push updates: refresh while the page is open
        const t = setInterval(load, 15_000);
        return () => clearInterval(t);
    }, [load]);

    const search = React.useCallback(async (term) => {
        if (!term.trim()) return;
        setSearching(true);
        try {
            setResults((await request('GET', `api/lidarr/search?q=${encodeURIComponent(term.trim())}`)).albums);
        } catch (e) {
            toast(e.message, { error: true });
            setResults([]);
        } finally {
            setSearching(false);
        }
    }, []);
    React.useEffect(() => {
        if (initialQuery && status.canRequest) search(initialQuery);
    }, [initialQuery, status.canRequest]);

    const requestAlbum = async (album) => {
        try {
            const r = await request('POST', 'api/lidarr/requests', { foreignAlbumId: album.foreignAlbumId });
            toast(`“${album.title}”: ${r.note}`);
            setResults((rs) => rs?.map((a) => (a.foreignAlbumId === album.foreignAlbumId ? { ...a, requested: true } : a)));
            load();
        } catch (e) {
            toast(e.message, { error: true });
        }
    };

    return (
        <>
            <p className={styles['intro']}>{'Ask your Lidarr for albums that aren’t in your library: it searches the indexers Prowlarr manages, downloads with your client, and imports into your music folder, where Navidrome picks them up.'}</p>
            {admin ? <div className={styles['head-actions']}><button type={'button'} aria-expanded={settings} onClick={() => setSettings(!settings)}><Icon className={styles['icon']} name={'settings'} />{'Lidarr settings'}</button></div> : null}
            {settings ? <Settings onClose={() => setSettings(false)} onSaved={onSettingsSaved} /> : null}
            {
                !status.enabled ?
                    <p className={styles['empty']}>{admin ? 'Connect Lidarr in the settings above to request albums.' : 'Album requests aren’t set up yet: an admin can connect Lidarr here.'}</p>
                    :
                    !status.canRequest ?
                        <p className={styles['empty']}>{'Only admins can request albums.'}</p>
                        :
                        <>
                            <form
                                className={styles['search']}
                                onSubmit={(e) => {
                                    e.preventDefault();
                                    search(q);
                                }}
                            >
                                <input type={'search'} value={q} onChange={(e) => setQ(e.target.value)} placeholder={'Artist and album, e.g. Portishead Dummy'} aria-label={'Search Lidarr'} />
                                <button type={'submit'} disabled={searching || !q.trim()}>{searching ? 'Searching…' : 'Search'}</button>
                            </form>
                            {results && results.length === 0 && !searching ? <p className={styles['dim']}>{'Nothing found. Try the artist’s name, or artist plus album.'}</p> : null}
                            {results?.length ? <ul className={styles['results']}>{results.map((a) => <Result key={a.foreignAlbumId} album={a} onRequest={requestAlbum} />)}</ul> : null}
                        </>
            }
            {
                Array.isArray(list) && list.length ?
                    <section className={styles['group']}>
                        <div className={styles['group-head']}><div className={styles['group-text']}><h2>{admin ? 'Requests' : 'Your requests'}</h2></div></div>
                        <ol className={styles['items']}>{list.map((r) => <RequestRow key={r.id} r={r} onChange={load} />)}</ol>
                    </section>
                    :
                    null
            }
            {list?.error ? <p className={styles['error']}>{list.error}</p> : null}
        </>
    );
};

Requests.propTypes = { status: PropTypes.object.isRequired, admin: PropTypes.bool, initialQuery: PropTypes.string, onSettingsSaved: PropTypes.func.isRequired };

module.exports = Requests;
