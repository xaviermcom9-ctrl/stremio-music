// stremio-music: the top-level "Movies & TV | Music" segmented control (shown in both modes).

const React = require('react');
const PropTypes = require('prop-types');
const classnames = require('classnames');
const { useLocation, useNavigate } = require('react-router');
const { default: Icon } = require('@stremio/stremio-icons/react');
const MusicIcon = require('stremio/music/icons');
const { modeOfPath, pathForMode } = require('../mode');
const styles = require('./styles');

const OPTIONS = [
    { mode: 'movies', label: 'Movies & TV', icon: <Icon className={styles['icon']} name={'movies'} /> },
    { mode: 'music', label: 'Music', icon: <MusicIcon className={styles['icon']} name={'note'} /> },
];

const ModeSwitch = ({ className }) => {
    const location = useLocation();
    const navigate = useNavigate();
    const current = modeOfPath(location.pathname);

    const select = React.useCallback((mode) => {
        if (mode !== current) navigate(pathForMode(mode));
    }, [current, navigate]);

    const onKeyDown = React.useCallback((event) => {
        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
            event.preventDefault();
            event.stopPropagation();
            select(current === 'movies' ? 'music' : 'movies');
        }
    }, [current, select]);

    return (
        <div className={classnames(className, styles['mode-switch'])} role={'tablist'} aria-label={'Mode'} onKeyDown={onKeyDown}>
            {
                OPTIONS.map(({ mode, label, icon }) => (
                    <button
                        key={mode}
                        type={'button'}
                        role={'tab'}
                        aria-selected={mode === current}
                        tabIndex={mode === current ? 0 : -1}
                        className={classnames(styles['option'], { [styles['selected']]: mode === current })}
                        title={`${label} (Shift+M)`}
                        onClick={() => select(mode)}
                    >
                        {icon}
                        <span className={styles['label']}>{label}</span>
                    </button>
                ))
            }
        </div>
    );
};

ModeSwitch.propTypes = {
    className: PropTypes.string,
};

module.exports = ModeSwitch;
