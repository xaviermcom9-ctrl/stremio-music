// stremio-music: React binding for the library store (loads it on first use).

const React = require('react');
const { getLibrary } = require('./store');

const subscribe = (cb) => {
    const l = getLibrary();
    l.on('change', cb);
    return () => l.off('change', cb);
};
const snapshot = () => getLibrary().state;

const useLibrary = () => {
    const state = React.useSyncExternalStore(subscribe, snapshot);
    React.useEffect(() => {
        getLibrary().load();
    }, []);
    return [state, getLibrary()];
};

module.exports = useLibrary;
