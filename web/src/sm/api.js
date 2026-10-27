// stremio-music: calls to our own backend. Paths are relative to the app base, so they work at the
// root of a host or under a reverse-proxy sub-path.

const request = async (method, path, body) => {
    const response = await fetch(path, {
        method,
        credentials: 'same-origin',
        headers: body !== undefined ? { 'content-type': 'application/json' } : {},
        body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
        throw new Error(data.error || `HTTP ${response.status}`);
    }
    return data;
};

let authStatePromise = null;

/** { mode: 'local' | 'proxy', setupRequired, user: { id, username, isAdmin } } (cached per page load) */
const getAuthState = () => {
    if (authStatePromise === null) {
        authStatePromise = request('GET', 'api/auth/state').catch((error) => {
            authStatePromise = null;
            throw error;
        });
    }
    return authStatePromise;
};

const getPrefs = () => request('GET', 'api/me/prefs').then((data) => data.prefs);

const setPref = (key, value) => request('PUT', `api/me/prefs/${encodeURIComponent(key)}`, { value });

const signOut = () => request('POST', 'api/auth/logout')
    .catch(() => {})
    .then(() => window.location.assign(new URL('login', document.baseURI).href));

const accountUrl = () => new URL('account', document.baseURI).href;

module.exports = { request, getAuthState, getPrefs, setPref, signOut, accountUrl };
