// stremio-music: icons Stremio's set doesn't have (music note, radio, …). Our own simple line
// drawings on a 24×24 grid, styled like @stremio/stremio-icons (currentColor, no fixed size).

const React = require('react');
const PropTypes = require('prop-types');

const PATHS = {
    note: (
        <>
            <path d="M9 17.5V5.8l10-2.3v11.7" />
            <ellipse cx="6.5" cy="17.5" rx="2.5" ry="2.2" />
            <ellipse cx="16.5" cy="15.2" rx="2.5" ry="2.2" />
            <path d="M9 9.3l10-2.3" />
        </>
    ),
    radio: (
        <>
            <rect x="3" y="8" width="18" height="12" rx="2.5" />
            <path d="M7 8l10-4.5" />
            <circle cx="15.5" cy="14" r="2.6" />
            <path d="M6.5 12h4M6.5 15.5h4" />
        </>
    ),
    sources: (
        <>
            <ellipse cx="12" cy="6" rx="7.5" ry="2.8" />
            <path d="M4.5 6v6c0 1.5 3.4 2.8 7.5 2.8s7.5-1.3 7.5-2.8V6" />
            <path d="M4.5 12v6c0 1.5 3.4 2.8 7.5 2.8s7.5-1.3 7.5-2.8v-6" />
        </>
    ),
};

const MusicIcon = ({ name, className }) => (
    <svg
        className={className}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        focusable="false"
    >
        {PATHS[name] ?? null}
    </svg>
);

MusicIcon.propTypes = {
    name: PropTypes.oneOf(Object.keys(PATHS)).isRequired,
    className: PropTypes.string,
};

module.exports = MusicIcon;
