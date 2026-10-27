// stremio-music: React binding for the player store.

const React = require('react');
const { getPlayer } = require('./store');

const subscribe = (cb) => {
    const p = getPlayer();
    p.on('change', cb);
    return () => p.off('change', cb);
};
const snapshot = () => getPlayer().state;

/** The player state (re-renders on every change) and the player itself. */
const usePlayer = () => {
    const state = React.useSyncExternalStore(subscribe, snapshot);
    return [state, getPlayer()];
};

/** The track at the current position, from a state snapshot. */
const currentOf = (state) => (state.pos >= 0 && state.pos < state.order.length ? state.queue[state.order[state.pos]] : null);

module.exports = usePlayer;
module.exports.currentOf = currentOf;
