// stremio-music: Sources page. Admins manage every source (enable, order, settings, test, logs,
// add addon URLs, reload plugins); other users set their own per-user logins (e.g. Navidrome).

const React = require('react');
const PropTypes = require('prop-types');
const classnames = require('classnames');
const { request, getAuthState } = require('stremio/sm/api');
const MusicIcon = require('stremio/music/icons');
const SettingsForm = require('./SettingsForm');
const styles = require('./styles');

const KIND_LABEL = { builtin: 'Built-in', folder: 'Plugin', remote: 'Addon' };
const STATE_LABEL = { 'ok': 'Active', 'needs-setup': 'Needs setup', 'error': 'Error', 'disabled': 'Disabled' };
const CAPS = [['catalogs', 'Catalogs'], ['search', 'Search'], ['streams', 'Streams'], ['downloadable', 'Downloads'], ['live', 'Live']];

const SourceCard = ({ source, admin, first, last, onChanged, onMove }) => {
    const [open, setOpen] = React.useState(source.state === 'needs-setup');
    const [test, setTest] = React.useState(null);
    const [logs, setLogs] = React.useState(null);
    const [busy, setBusy] = React.useState(false);
    const [error, setError] = React.useState(null);

    const act = (fn) => {
        setBusy(true);
        setError(null);
        return Promise.resolve()
            .then(fn)
            .catch((e) => setError(e.message))
            .finally(() => setBusy(false));
    };

    const toggle = () => act(() => request('PATCH', `api/sources/${source.id}`, { enabled: !source.enabled }).then(onChanged));
    const runTest = () => act(() => request('POST', `api/sources/${source.id}/test`).then(setTest));
    const showLogs = () => act(() => (logs ? setLogs(null) : request('GET', `api/sources/${source.id}/logs`).then((r) => setLogs(r.lines))));
    const remove = () => {
        if (window.confirm(`Remove "${source.name}"?`)) act(() => request('DELETE', `api/sources/${source.id}`).then(onChanged));
    };
    const saveGlobal = (settings) => request('PATCH', `api/sources/${source.id}`, { settings }).then(onChanged);
    const saveUser = (settings) => request('PUT', `api/me/sources/${source.id}/settings`, settings).then(onChanged);

    const hasGlobal = Object.values(source.settings.schema).some((f) => !f.perUser);
    const hasUser = Object.values(source.settings.schema).some((f) => f.perUser);

    return (
        <li className={classnames(styles['card'], { [styles['disabled']]: !source.enabled })}>
            <div className={styles['card-head']}>
                <div className={styles['source-icon']}>
                    {source.icon ? <img src={source.icon} alt={''} /> : <MusicIcon name={'sources'} className={styles['source-icon-svg']} />}
                </div>
                <div className={styles['title']}>
                    <div className={styles['name']}>{source.name}</div>
                    <div className={styles['meta']}>
                        <span className={styles['badge']}>{KIND_LABEL[source.kind]}</span>
                        {source.version ? <span>{`v${source.version}`}</span> : null}
                        <span className={classnames(styles['state'], styles[`state-${source.state}`])}>{STATE_LABEL[source.state]}</span>
                    </div>
                </div>
                {
                    admin ?
                        <div className={styles['head-actions']}>
                            <button type={'button'} className={styles['icon-btn']} title={'Move up'} aria-label={`Move ${source.name} up`} disabled={first || busy} onClick={() => onMove(-1)}>{'↑'}</button>
                            <button type={'button'} className={styles['icon-btn']} title={'Move down'} aria-label={`Move ${source.name} down`} disabled={last || busy} onClick={() => onMove(1)}>{'↓'}</button>
                            <label className={styles['switch']} title={source.enabled ? 'Disable' : 'Enable'}>
                                <input type={'checkbox'} role={'switch'} checked={source.enabled} disabled={busy} onChange={toggle} aria-label={`${source.name} enabled`} />
                                <span />
                            </label>
                        </div>
                        :
                        null
                }
            </div>
            {source.description ? <p className={styles['description']}>{source.description}</p> : null}
            <div className={styles['chips']}>
                {CAPS.filter(([k]) => source.capabilities[k]).map(([k, label]) => <span key={k} className={styles['chip']}>{label}</span>)}
                {source.attribution ? <span className={styles['attribution']}>{source.attribution}</span> : null}
            </div>
            {source.missing.length ? <div className={styles['notice']}>{`Needs: ${source.missing.join(', ')}`}</div> : null}
            {source.error && source.state !== 'disabled' ? <div className={styles['error']}>{source.error}</div> : null}
            {source.warnings.length ? <div className={styles['help']}>{source.warnings.join(' · ')}</div> : null}

            <div className={styles['actions']}>
                {(hasGlobal && admin) || hasUser ? <button type={'button'} className={styles['button-secondary']} onClick={() => setOpen(!open)} aria-expanded={open}>{open ? 'Hide settings' : 'Settings'}</button> : null}
                <button type={'button'} className={styles['button-secondary']} disabled={busy} onClick={runTest}>{'Test connection'}</button>
                {admin ? <button type={'button'} className={styles['button-secondary']} disabled={busy} onClick={showLogs}>{logs ? 'Hide logs' : 'Logs'}</button> : null}
                {admin && source.kind === 'remote' ? <button type={'button'} className={classnames(styles['button-secondary'], styles['danger'])} disabled={busy} onClick={remove}>{'Remove'}</button> : null}
            </div>
            {test ? <div className={test.ok ? styles['ok'] : styles['error']} role={'status'}>{test.message}</div> : null}
            {error ? <div className={styles['error']} role={'alert'}>{error}</div> : null}

            {
                open ?
                    <div className={styles['settings']}>
                        {admin && hasGlobal ? <><h3>{'Settings'}</h3><SettingsForm schema={source.settings.schema} values={source.settings.global} scope={'global'} onSave={saveGlobal} /></> : null}
                        {hasUser ? <><h3>{'Your settings'}</h3><p className={styles['help']}>{'Only you see and use these.'}</p><SettingsForm schema={source.settings.schema} values={source.settings.user} scope={'user'} onSave={saveUser} /></> : null}
                    </div>
                    :
                    null
            }
            {
                admin && logs ?
                    <div className={styles['logs']}>
                        {source.stats ? <div className={styles['help']}>{`${source.stats.requests} requests · ${source.stats.errors} errors · ${source.stats.rateLimited} rate-limited · ${source.stats.invalidItems} invalid items · ${source.stats.avgMs} ms avg`}</div> : null}
                        <pre>{logs.length ? logs.slice(-100).join('\n') : 'No log entries yet.'}</pre>
                    </div>
                    :
                    null
            }
            {admin && source.location ? <div className={styles['location']}>{source.location}</div> : null}
        </li>
    );
};

SourceCard.propTypes = {
    source: PropTypes.object.isRequired,
    admin: PropTypes.bool,
    first: PropTypes.bool,
    last: PropTypes.bool,
    onChanged: PropTypes.func.isRequired,
    onMove: PropTypes.func.isRequired,
};

const Sources = () => {
    const [user, setUser] = React.useState(null);
    const [data, setData] = React.useState(null);
    const [error, setError] = React.useState(null);
    const [url, setUrl] = React.useState('');
    const [busy, setBusy] = React.useState(false);
    const [notice, setNotice] = React.useState(null);

    const load = React.useCallback(() => request('GET', 'api/sources').then(setData).catch((e) => setError(e.message)), []);

    React.useEffect(() => {
        getAuthState().then((s) => setUser(s.user)).catch(() => {});
        load();
    }, [load]);

    const admin = Boolean(user?.isAdmin);

    const move = (index, delta) => {
        const ids = data.sources.map((s) => s.id);
        const [id] = ids.splice(index, 1);
        ids.splice(index + delta, 0, id);
        request('PUT', 'api/sources/order', { ids }).then(load).catch((e) => setError(e.message));
    };

    const addAddon = (event) => {
        event.preventDefault();
        setBusy(true);
        setNotice(null);
        request('POST', 'api/sources', { url })
            .then((r) => {
                setUrl('');
                setNotice({ ok: true, text: `Added "${r.source.name}".` });
                return load();
            })
            .catch((e) => setNotice({ ok: false, text: e.message }))
            .finally(() => setBusy(false));
    };

    const reload = () => {
        setBusy(true);
        setNotice(null);
        request('POST', 'api/sources/reload')
            .then((r) => {
                setNotice({ ok: r.errors.length === 0, text: `Plugins loaded: ${r.loaded.length ? r.loaded.join(', ') : 'none'}${r.errors.length ? ` · ${r.errors.length} failed (see below)` : ''}.` });
                return load();
            })
            .catch((e) => setNotice({ ok: false, text: e.message }))
            .finally(() => setBusy(false));
    };

    return (
        <section className={styles['sources-page']}>
            <h1 className={styles['page-title']}>{'Sources'}</h1>
            <p className={styles['intro']}>
                {
                    admin ?
                        'Every source is a Stremio addon. Higher sources come first in Home and search results. Built-in sources ship with the app; plugins live in /config/music-sources; addons are added by URL.'
                        :
                        'Sources that need your own login. Your settings are only used for you.'
                }
            </p>

            {admin && data?.secretKey === 'generated' ? <div className={styles['notice']}>{'Saved passwords and API keys are encrypted with a key stored next to the data (/config/secret.key). For better protection set APP_SECRET_KEY or APP_SECRET_KEY_FILE (a Docker secret); see the README.'}</div> : null}

            {
                admin ?
                    <div className={styles['toolbar']}>
                        <form className={styles['add-form']} onSubmit={addAddon}>
                            <label htmlFor={'addon-url'} className={styles['visually-hidden']}>{'Addon manifest URL'}</label>
                            <input id={'addon-url'} type={'url'} placeholder={'https://…/manifest.json'} value={url} onChange={(e) => setUrl(e.target.value)} required spellCheck={false} />
                            <button type={'submit'} className={styles['button']} disabled={busy || !url}>{'Add addon'}</button>
                        </form>
                        <button type={'button'} className={styles['button-secondary']} disabled={busy} onClick={reload}>{'Reload plugins'}</button>
                    </div>
                    :
                    null
            }
            {notice ? <div className={notice.ok ? styles['ok'] : styles['error']} role={'status'}>{notice.text}</div> : null}
            {error ? <div className={styles['error']} role={'alert'}>{error}</div> : null}

            {
                admin && data?.pluginErrors?.length ?
                    <div className={styles['plugin-errors']}>
                        <h2>{'Plugins that failed to load'}</h2>
                        <ul>
                            {data.pluginErrors.map((e) => <li key={e.location}><code>{e.location}</code><div className={styles['error']}>{e.error}</div></li>)}
                        </ul>
                    </div>
                    :
                    null
            }

            {
                data === null ?
                    <p className={styles['help']}>{'Loading…'}</p>
                    :
                    data.sources.length === 0 ?
                        <p className={styles['empty']}>{admin ? 'No sources yet. Built-in sources arrive in the next update; meanwhile add an addon URL or drop a plugin into /config/music-sources.' : 'No source needs your login.'}</p>
                        :
                        <ol className={styles['list']}>
                            {
                                data.sources.map((s, i) => (
                                    <SourceCard
                                        key={s.id}
                                        source={s}
                                        admin={admin}
                                        first={i === 0}
                                        last={i === data.sources.length - 1}
                                        onChanged={load}
                                        onMove={(d) => move(i, d)}
                                    />
                                ))
                            }
                        </ol>
            }
        </section>
    );
};

module.exports = Sources;
