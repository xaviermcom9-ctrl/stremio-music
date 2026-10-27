// stremio-music: form generated from a source's settings schema. Secrets are never sent to the
// browser: a saved secret shows as "saved"; leaving the field empty keeps it.

const React = require('react');
const PropTypes = require('prop-types');
const styles = require('./styles');

const initialValue = (field, value) => {
    if (field.secret) return '';
    if (value === null || value === undefined) return field.type === 'boolean' ? Boolean(field.default) : '';
    return value;
};

const SettingsForm = ({ schema, values, scope, onSave, saveLabel }) => {
    const fields = Object.entries(schema).filter(([, f]) => (scope === 'user' ? f.perUser : !f.perUser));
    const [draft, setDraft] = React.useState(() => Object.fromEntries(fields.map(([k, f]) => [k, initialValue(f, values?.[k])])));
    const [clear, setClear] = React.useState({});
    const [state, setState] = React.useState({ busy: false, error: null, saved: false });

    if (fields.length === 0) return null;

    const onSubmit = (event) => {
        event.preventDefault();
        const payload = {};
        for (const [key, field] of fields) {
            const v = draft[key];
            if (field.secret) {
                if (clear[key]) payload[key] = '';
                else if (v !== '') payload[key] = v;
            } else if (field.type === 'number') {
                payload[key] = v === '' ? null : Number(v);
            } else {
                payload[key] = v === '' ? null : v;
            }
        }
        setState({ busy: true, error: null, saved: false });
        onSave(payload)
            .then(() => {
                setState({ busy: false, error: null, saved: true });
                setDraft((d) => Object.fromEntries(Object.entries(d).map(([k, v]) => [k, schema[k].secret ? '' : v])));
                setClear({});
            })
            .catch((error) => setState({ busy: false, error: error.message, saved: false }));
    };

    return (
        <form className={styles['settings-form']} onSubmit={onSubmit}>
            {
                fields.map(([key, field]) => {
                    const saved = field.secret && values?.[key]?.set;
                    const id = `sf-${scope}-${key}`;
                    return (
                        <div key={key} className={styles['field']}>
                            {
                                field.type === 'boolean' ?
                                    <label className={styles['check']} htmlFor={id}>
                                        <input id={id} type={'checkbox'} checked={Boolean(draft[key])} onChange={(e) => setDraft({ ...draft, [key]: e.target.checked })} />
                                        {field.label}
                                    </label>
                                    :
                                    <>
                                        <label htmlFor={id}>{field.label}{field.required ? ' *' : ''}</label>
                                        {
                                            field.type === 'select' ?
                                                <select id={id} value={draft[key]} onChange={(e) => setDraft({ ...draft, [key]: e.target.value })}>
                                                    <option value={''}>{'—'}</option>
                                                    {field.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                                                </select>
                                                :
                                                <input
                                                    id={id}
                                                    type={field.secret ? 'password' : field.type === 'number' ? 'number' : field.type === 'url' ? 'url' : 'text'}
                                                    value={draft[key]}
                                                    placeholder={saved ? 'Saved (leave empty to keep)' : (field.default !== undefined ? String(field.default) : '')}
                                                    autoComplete={field.secret ? 'new-password' : 'off'}
                                                    spellCheck={false}
                                                    disabled={Boolean(clear[key])}
                                                    onChange={(e) => setDraft({ ...draft, [key]: e.target.value })}
                                                />
                                        }
                                        {
                                            saved ?
                                                <label className={styles['check']}>
                                                    <input type={'checkbox'} checked={Boolean(clear[key])} onChange={(e) => setClear({ ...clear, [key]: e.target.checked })} />
                                                    {'Remove saved value'}
                                                </label>
                                                :
                                                null
                                        }
                                    </>
                            }
                            {field.help ? <div className={styles['help']}>{field.help}</div> : null}
                        </div>
                    );
                })
            }
            {state.error ? <div className={styles['error']} role={'alert'}>{state.error}</div> : null}
            {state.saved ? <div className={styles['ok']} role={'status'}>{'Saved.'}</div> : null}
            <button type={'submit'} className={styles['button']} disabled={state.busy}>{saveLabel}</button>
        </form>
    );
};

SettingsForm.propTypes = {
    schema: PropTypes.object.isRequired,
    values: PropTypes.object,
    scope: PropTypes.oneOf(['global', 'user']).isRequired,
    onSave: PropTypes.func.isRequired,
    saveLabel: PropTypes.string,
};

SettingsForm.defaultProps = {
    saveLabel: 'Save',
};

module.exports = SettingsForm;
