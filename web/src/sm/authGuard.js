// stremio-music: when the backend says the session is gone (401 + x-auth-required on a same-origin
// request), go to the login page and come back to the current view afterwards.

const AUTH_REQUIRED_HEADER = 'x-auth-required';

const loginUrl = () => {
    const base = new URL('./', document.baseURI);
    const here = window.location.pathname.startsWith(base.pathname) ?
        '/' + window.location.pathname.slice(base.pathname.length) + window.location.search
        :
        '/';
    return new URL('login?next=' + encodeURIComponent(here) + window.location.hash, base).href;
};

let redirecting = false;
const originalFetch = window.fetch.bind(window);

window.fetch = function(input, init) {
    return originalFetch(input, init).then((response) => {
        if (!redirecting && response.status === 401 && response.headers.get(AUTH_REQUIRED_HEADER) === '1') {
            let sameOrigin = false;
            try {
                sameOrigin = new URL(response.url).origin === window.location.origin;
            } catch (_) {
                sameOrigin = false;
            }
            if (sameOrigin) {
                redirecting = true;
                window.location.assign(loginUrl());
            }
        }
        return response;
    });
};
