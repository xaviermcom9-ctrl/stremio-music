// stremio-music: app-wide overlays rendered once in MusicRoot: toasts and the "Add to playlist"
// picker. Anything can open them through the functions below.

const React = require('react');
const PropTypes = require('prop-types');
const EventEmitter = require('eventemitter3');
const { default: Icon } = require('@stremio/stremio-icons/react');
const MusicIcon = require('stremio/music/icons');
const useLibrary = require('stremio/music/library/useLibrary');
const styles = require('./styles');

const bus = new EventEmitter();

/** Short message at the bottom of the screen. */
const toast = (message, { error = false } = {}) => bus.emit('toast', { message, error, at: Date.now() });

/** Opens the playlist picker for these queue items / metas. */
const addToPlaylist = (items) => bus.emit('pick', items);

const Toasts = () => {
    const [list, setList] = React.useState([]);
    React.useEffect(() => {
        const on = (t) => {
            setList((l) => [...l.slice(-2), t]);
            setTimeout(() => setList((l) => l.filter((x) => x !== t)), t.error ? 6000 : 3000);
        };
        bus.on('toast', on);
        return () => bus.off('toast', on);
    }, []);
    return (
        <div className={styles['toasts']} role={'status'} aria-live={'polite'}>
            {list.map((t) => <div key={t.at} className={t.error ? styles['toast-error'] : styles['toast']}>{t.message}</div>)}
        </div>
    );
};

/** Modal dialog: Escape and the backdrop close it; focus goes to the first field or button. */
const Dialog = ({ title, onClose, children }) => {
    const ref = React.useRef(null);
    React.useEffect(() => {
        const previous = document.activeElement;
        ref.current?.querySelector('input, button:not([aria-label="Close"])')?.focus();
        const onKey = (e) => {
            if (e.key === 'Escape') {
                e.stopPropagation();
                onClose();
            }
        };
        document.addEventListener('keydown', onKey, true);
        return () => {
            document.removeEventListener('keydown', onKey, true);
            previous?.focus?.();
        };
    }, [onClose]);
    return (
        <div className={styles['backdrop']} onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
            <div ref={ref} className={styles['dialog']} role={'dialog'} aria-modal={'true'} aria-label={title}>
                <div className={styles['dialog-head']}>
                    <h2>{title}</h2>
                    <button type={'button'} className={styles['icon-btn']} aria-label={'Close'} onClick={onClose}><Icon className={styles['icon']} name={'close'} /></button>
                </div>
                {children}
            </div>
        </div>
    );
};

Dialog.propTypes = { title: PropTypes.string.isRequired, onClose: PropTypes.func.isRequired, children: PropTypes.node };

const PlaylistPicker = () => {
    const [items, setItems] = React.useState(null);
    const [lib, library] = useLibrary();
    const [name, setName] = React.useState('');
    const [busy, setBusy] = React.useState(false);
    React.useEffect(() => {
        const on = (i) => {
            setName('');
            setItems(i);
        };
        bus.on('pick', on);
        return () => bus.off('pick', on);
    }, []);
    const close = React.useCallback(() => setItems(null), []);
    if (!items) return null;
    const what = items.length === 1 ? `“${items[0].title ?? items[0].name}”` : `${items.length} tracks`;
    const run = async (fn, done) => {
        setBusy(true);
        try {
            const p = await fn();
            toast(`${done} “${p.name}”`);
            if (p.syncError) toast(`Playlist sync: ${p.syncError}`, { error: true });
            close();
        } catch (e) {
            toast(e.message, { error: true });
        } finally {
            setBusy(false);
        }
    };
    return (
        <Dialog title={`Add ${what} to a playlist`} onClose={close}>
            <form
                className={styles['new-playlist']}
                onSubmit={(e) => {
                    e.preventDefault();
                    if (name.trim()) run(() => library.createPlaylist(name.trim(), items), 'Created');
                }}
            >
                <input type={'text'} value={name} maxLength={200} placeholder={'New playlist name'} aria-label={'New playlist name'} onChange={(e) => setName(e.target.value)} />
                <button type={'submit'} className={styles['pill']} disabled={busy || !name.trim()}>{'Create'}</button>
            </form>
            <ul className={styles['picker-list']}>
                {
                    lib.playlists.map((p) => (
                        <li key={p.id}>
                            <button type={'button'} disabled={busy} onClick={() => run(() => library.addToPlaylist(p.id, items), 'Added to')}>
                                <MusicIcon className={styles['icon']} name={'playlist'} />
                                <span>{p.name}</span>
                                <span className={styles['muted']}>{`${p.trackCount} tracks`}</span>
                            </button>
                        </li>
                    ))
                }
            </ul>
            {lib.playlists.length === 0 ? <p className={styles['muted']}>{'No playlists yet: name one above.'}</p> : null}
        </Dialog>
    );
};

module.exports = { toast, addToPlaylist, Toasts, Dialog, PlaylistPicker };
