// stremio-music: is the Lidarr integration on for this user? (asked once per page load)

const { request } = require('stremio/sm/api');

let status = null;

const lidarrStatus = () => {
    if (status === null) status = request('GET', 'api/lidarr/status').catch(() => ({ enabled: false, canRequest: false }));
    return status;
};

/** Forget the answer (after the settings change). */
const resetLidarrStatus = () => {
    status = null;
};

const findInLidarr = (q) => `#/music/downloads?tab=requests&q=${encodeURIComponent(q)}`;

module.exports = { lidarrStatus, resetLidarrStatus, findInLidarr };
