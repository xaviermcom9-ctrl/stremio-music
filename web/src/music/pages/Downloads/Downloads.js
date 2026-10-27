// stremio-music: Downloads. Server-side downloads into the music library, live (SSE): progress,
// pause, resume, cancel, retry, remove from the list, save a finished file to this device.
// Admins also get the settings (existing files, parallel downloads, torrent client, rescan).

const React = require('react');
const PropTypes = require('prop-types');
const classnames = require('classnames');
const { default: Icon } = require('@stremio/stremio-icons/react');
const MusicIcon = require('stremio/music/icons');
const { request, getAuthState } = require('stremio/sm/api');
const { useDownloads } = require('stremio/music/downloads/store');
const { toast } = require('stremio/music/components/overlays');
const { Loading } = require('stremio/music/components');
const styles = require('./styles');

const STATUS = {
    queued: 'Waiting',
    downloading: 'Downloading',
    paused: 'Paused',
    processing: 'Tagging',
    done: 'In your library',
    skipped: 'Already in your library',
    failed: 'Failed',
    cancelled: 'Cancelled',
};

const BACKEND = { http: 'web', engine: 'torrent (built-in)', qbittorrent: 'torrent (qBittorrent)' };

const size = (b) => (b >= 1e9 ? `${(b / 1e9).toFixed(2)} GB` : b >= 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.round((b ?? 0) / 1e3)} kB`);

const Bar = ({ value, total, state }) => (
    <div className={classnames(styles['bar'], styles[state])} role={'progressbar'} aria-valuemin={0} aria-valuemax={100} aria-valuenow={total ? Math.round((value / total) * 100) : undefined}>
        <div style={{ width: `${total ? Math.min(100, (value / total) * 100) : state === 'done' ? 100 : 0}%` }} />
    </div>
);

Bar.propTypes = { value: PropTypes.number, total: PropTypes.number, state: PropTypes.string };

const act = (store, kind, id, action) => store.act(kind, id, action).catch((e) => toast(e.message, { error: true }));

const ItemRow = ({ item, store }) => {
    const pct = item.total ? Math.round((item.downloaded / item.total) * 100) : null;
    return (
        <li className={classnames(styles['item'], styles[item.status])}>
            <div className={styles['item-main']}>
                <div className={styles['item-title']}>
                    {item.trackNo ? <span className={styles['no']}>{item.trackNo}</span> : null}
                    <span className={styles['name']}>{item.title}</span>
                    {item.artist ? <span className={styles['dim']}>{item.artist}</span> : null}
                </div>
                <div className={styles['item-status']}>
                    <span className={styles['chip']}>{STATUS[item.status]}</span>
                    {item.status === 'downloading' || item.status === 'paused' ? <span className={styles['dim']}>{`${size(item.downloaded)}${item.total ? ` of ${size(item.total)} · ${pct}%` : ''}`}</span> : null}
                    {item.backend && item.status === 'downloading' ? <span className={styles['dim']}>{`via ${BACKEND[item.backend] ?? item.backend}`}</span> : null}
                    {item.path && (item.status === 'done' || item.status === 'skipped') ? <span className={styles['path']} title={`/music/${item.path}`}>{item.path}</span> : null}
                    {item.note && item.status !== 'skipped' ? <span className={styles['dim']}>{item.note}</span> : null}
                </div>
                {item.error ? <div className={styles['error']}>{item.error}</div> : null}
                {item.status === 'downloading' || item.status === 'paused' ? <Bar value={item.downloaded} total={item.total} state={item.status} /> : null}
            </div>
            <div className={styles['item-actions']}>
                {item.status === 'downloading' || item.status === 'queued' ? <button type={'button'} onClick={() => act(store, 'items', item.id, 'pause')}>{'Pause'}</button> : null}
                {item.status === 'paused' ? <button type={'button'} onClick={() => act(store, 'items', item.id, 'resume')}>{'Resume'}</button> : null}
                {['queued', 'downloading', 'paused'].includes(item.status) ? <button type={'button'} onClick={() => act(store, 'items', item.id, 'cancel')}>{'Cancel'}</button> : null}
                {item.status === 'failed' || item.status === 'cancelled' ? <button type={'button'} onClick={() => act(store, 'items', item.id, 'retry')}>{'Retry'}</button> : null}
                {item.status === 'done' || item.status === 'skipped' ? <a href={`api/downloads/items/${item.id}/file`} download>{'Save to device'}</a> : null}
            </div>
        </li>
    );
};

ItemRow.propTypes = { item: PropTypes.object.isRequired, store: PropTypes.object.isRequired };

const count = (items, ...states) => items.filter((i) => states.includes(i.status)).length;

const Group = ({ group, store }) => {
    const items = group.items;
    const active = count(items, 'queued', 'downloading', 'processing');
    const paused = count(items, 'paused');
    const finished = count(items, 'done', 'skipped');
    const failed = count(items, 'failed', 'cancelled');
    // open what needs attention: single tracks, ones on the way right now, failures
    const [open, setOpen] = React.useState(items.length === 1 || count(items, 'downloading', 'processing') > 0 || failed > 0);
    const summary = [
        `${finished} of ${items.length} ${items.length === 1 ? 'track' : 'tracks'} in your library`,
        active ? `${active} to go` : null,
        active ? `${size(items.reduce((s, i) => s + (i.downloaded ?? 0), 0))} downloaded` : null,
        paused ? `${paused} paused` : null,
        failed ? `${failed} failed` : null,
    ].filter(Boolean).join(' · ');
    const state = active ? 'downloading' : paused ? 'paused' : failed ? 'failed' : 'done';
    // finished tracks count whole, the ones on the way by their bytes
    const progress = items.reduce((s, i) => s + (['done', 'skipped'].includes(i.status) ? 1 : i.total ? i.downloaded / i.total : 0), 0);
    return (
        <section className={styles['group']}>
            <div className={styles['group-head']}>
                <div className={styles['art']}>{group.poster ? <img src={group.poster} alt={''} loading={'lazy'} /> : null}</div>
                <div className={styles['group-text']}>
                    <h2>{group.title}</h2>
                    <div className={styles['dim']}>{[group.subtitle, summary].filter(Boolean).join(' · ')}</div>
                    <Bar value={progress} total={items.length} state={state} />
                </div>
                <div className={styles['group-actions']}>
                    {active ? <button type={'button'} onClick={() => act(store, 'groups', group.id, 'pause')}>{'Pause'}</button> : null}
                    {paused ? <button type={'button'} onClick={() => act(store, 'groups', group.id, 'resume')}>{'Resume'}</button> : null}
                    {active || paused ? <button type={'button'} onClick={() => act(store, 'groups', group.id, 'cancel')}>{'Cancel'}</button> : null}
                    {failed ? <button type={'button'} onClick={() => act(store, 'groups', group.id, 'retry')}>{failed === items.length ? 'Retry' : 'Retry failed'}</button> : null}
                    {!active && !paused ? <button type={'button'} title={'Remove from this list (the files stay in your library)'} onClick={() => act(store, 'groups', group.id, 'remove')}>{'Remove'}</button> : null}
                    {
                        items.length > 1 ?
                            <button type={'button'} className={styles['toggle']} aria-expanded={open} aria-label={open ? 'Hide tracks' : 'Show tracks'} onClick={() => setOpen(!open)}>
                                <MusicIcon className={styles['icon']} name={open ? 'expand' : 'collapse'} />
                            </button>
                            :
                            null
                    }
                </div>
            </div>
            {open ? <ol className={styles['items']}>{items.map((i) => <ItemRow key={i.id} item={i} store={store} />)}</ol> : null}
        </section>
    );
};

Group.propTypes = { group: PropTypes.object.isRequired, store: PropTypes.object.isRequired };

// ---------------------------------------------------------------- settings (admin)

const Settings = ({ onClose }) => {
    const [s, setS] = React.useState(null);
    const [password, setPassword] = React.useState('');
    const [busy, setBusy] = React.useState(false);
    const [test, setTest] = React.useState(null);
    React.useEffect(() => {
        request('GET', 'api/downloads/settings').then(setS).catch((e) => toast(e.message, { error: true }));
    }, []);
    if (!s) return <Loading />;
    const qb = s.qbittorrent;
    const setQb = (k, v) => setS({ ...s, qbittorrent: { ...qb, [k]: v } });
    const save = async (e) => {
        e.preventDefault();
        setBusy(true);
        try {
            const { hasPassword: _h, ...qbittorrent } = qb;
            setS(await request('PUT', 'api/downloads/settings', { ...s, qbittorrent: { ...qbittorrent, ...(password ? { password } : {}) } }));
            setPassword('');
            toast('Download settings saved');
        } catch (err) {
            toast(err.message, { error: true });
        } finally {
            setBusy(false);
        }
    };
    const runTest = async () => {
        setTest({ message: 'Testing…' });
        try {
            if (password) await request('PUT', 'api/downloads/settings', { qbittorrent: { password } });
            setTest(await request('POST', 'api/downloads/settings/test'));
        } catch (err) {
            setTest({ ok: false, message: err.message });
        }
    };
    return (
        <form className={styles['settings']} onSubmit={save}>
            <div className={styles['settings-head']}>
                <h2>{'Download settings'}</h2>
                <button type={'button'} className={styles['link']} onClick={onClose}>{'Close'}</button>
            </div>
            <label>
                {'When the file is already in the library'}
                <select value={s.onExisting} onChange={(e) => setS({ ...s, onExisting: e.target.value })}>
                    <option value={'skip'}>{'Skip it'}</option>
                    <option value={'rename'}>{'Keep both (adds “(2)”)'}</option>
                </select>
            </label>
            <label>
                {'Downloads at the same time'}
                <input type={'number'} min={1} max={6} value={s.concurrency} onChange={(e) => setS({ ...s, concurrency: Number(e.target.value) })} />
            </label>
            <label className={styles['check']}>
                <input type={'checkbox'} checked={s.rescan} onChange={(e) => setS({ ...s, rescan: e.target.checked })} />
                {'Ask Navidrome to rescan when downloads finish (needs a Navidrome admin login under Sources; otherwise Navidrome’s own scan picks them up)'}
            </label>
            <fieldset>
                <legend>{'Torrents'}</legend>
                <label className={styles['check']}>
                    <input type={'radio'} name={'tc'} checked={s.torrentClient === 'engine'} onChange={() => setS({ ...s, torrentClient: 'engine' })} />
                    {'Built-in engine (stops sharing when done)'}
                </label>
                <label className={styles['check']}>
                    <input type={'radio'} name={'tc'} checked={s.torrentClient === 'qbittorrent'} onChange={() => setS({ ...s, torrentClient: 'qbittorrent' })} />
                    {'qBittorrent (keeps seeding; only the wanted files are downloaded)'}
                </label>
                {
                    s.torrentClient === 'qbittorrent' ?
                        <div className={styles['qb']}>
                            <label>{'Web UI address'}<input type={'url'} value={qb.url} onChange={(e) => setQb('url', e.target.value)} placeholder={'http://qbittorrent:8080'} /></label>
                            <label>{'Username'}<input type={'text'} value={qb.username} onChange={(e) => setQb('username', e.target.value)} autoComplete={'off'} /></label>
                            <label>{'Password'}<input type={'password'} value={password} onChange={(e) => setPassword(e.target.value)} placeholder={qb.hasPassword ? 'Saved (type to change)' : ''} autoComplete={'new-password'} /></label>
                            <label>{'Category'}<input type={'text'} value={qb.category} onChange={(e) => setQb('category', e.target.value)} /></label>
                            <label>
                                {'Save folder, as qBittorrent sees it'}
                                <input type={'text'} value={qb.savePath} onChange={(e) => setQb('savePath', e.target.value)} placeholder={'/data/library/music/.stremio-music-torrents'} />
                            </label>
                            <label>
                                {'The same folder, as this app sees it'}
                                <input type={'text'} value={qb.localPath} onChange={(e) => setQb('localPath', e.target.value)} placeholder={'/music/.stremio-music-torrents'} />
                            </label>
                            <p className={styles['help']}>{'Pick a folder inside your music volume: finished files are tagged into the library from there, and the torrent keeps seeding. The test adds a .ndignore file so Navidrome doesn’t list the torrent copies.'}</p>
                            <div className={styles['test']}>
                                <button type={'button'} onClick={runTest}>{'Test connection'}</button>
                                {test ? <span className={test.ok ? styles['ok'] : test.ok === false ? styles['error'] : styles['dim']}>{test.message}</span> : null}
                            </div>
                        </div>
                        :
                        null
                }
            </fieldset>
            <button type={'submit'} className={styles['primary']} disabled={busy}>{'Save'}</button>
        </form>
    );
};

Settings.propTypes = { onClose: PropTypes.func.isRequired };

const Downloads = () => {
    const [state, store] = useDownloads();
    const [admin, setAdmin] = React.useState(false);
    const [settings, setSettings] = React.useState(false);
    React.useEffect(() => {
        getAuthState().then((a) => setAdmin(Boolean(a.user?.isAdmin))).catch(() => {});
    }, []);
    const groups = state.groups ?? [];
    const clearable = groups.filter((g) => g.items.every((i) => ['done', 'skipped', 'cancelled'].includes(i.status)));
    return (
        <div className={styles['page']}>
            <div className={styles['head']}>
                <h1>{'Downloads'}</h1>
                <div className={styles['head-actions']}>
                    {clearable.length ? <button type={'button'} onClick={() => clearable.forEach((g) => act(store, 'groups', g.id, 'remove'))}>{'Clear finished'}</button> : null}
                    {admin ? <button type={'button'} aria-expanded={settings} onClick={() => setSettings(!settings)}><Icon className={styles['icon']} name={'settings'} />{'Settings'}</button> : null}
                </div>
            </div>
            <p className={styles['intro']}>{'Albums and tracks are downloaded by the server into your music library (Artist / Album / NN - Title), tagged, with cover art and, for Creative Commons music, a LICENSE.txt. They carry on when you close the app.'}</p>
            {settings ? <Settings onClose={() => setSettings(false)} /> : null}
            {state.groups === null ? <Loading /> : null}
            {state.groups && !state.connected ? <p className={styles['dim']}>{'Reconnecting for live updates…'}</p> : null}
            {
                state.groups && groups.length === 0 ?
                    <p className={styles['empty']}>{'Nothing downloaded yet. Use “Download” in the ⋯ menu of an album or track from Internet Archive, Jamendo, Free Music Archive or a torrent addon.'}</p>
                    :
                    null
            }
            {groups.map((g) => <Group key={g.id} group={g} store={store} />)}
        </div>
    );
};

module.exports = Downloads;
