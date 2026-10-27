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
    shuffle: (
        <>
            <path d="M3 7h3.5c2 0 3.2 1 4.3 2.7l2.4 4.6C14.3 16 15.5 17 17.5 17H21" />
            <path d="M3 17h3.5c1.4 0 2.4-.5 3.2-1.4M14.3 8.4C15.1 7.5 16.1 7 17.5 7H21" />
            <path d="M18.5 4.5 21 7l-2.5 2.5M18.5 14.5 21 17l-2.5 2.5" />
        </>
    ),
    repeat: (
        <>
            <path d="M4 11V9a3 3 0 0 1 3-3h12" />
            <path d="m16.5 3.5 2.5 2.5-2.5 2.5" />
            <path d="M20 13v2a3 3 0 0 1-3 3H5" />
            <path d="M7.5 20.5 5 18l2.5-2.5" />
        </>
    ),
    'repeat-one': (
        <>
            <path d="M4 11V9a3 3 0 0 1 3-3h12" />
            <path d="m16.5 3.5 2.5 2.5-2.5 2.5" />
            <path d="M20 13v2a3 3 0 0 1-3 3H5" />
            <path d="M7.5 20.5 5 18l2.5-2.5" />
            <path d="M11 10.5 12.5 9.5V14.5" />
        </>
    ),
    queue: (
        <>
            <path d="M4 6h12M4 11h12M4 16h7" />
            <path d="M15 14.5v5l4-2.5z" />
        </>
    ),
    expand: <path d="M6 15l6-6 6 6" />,
    collapse: <path d="M6 9l6 6 6-6" />,
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
