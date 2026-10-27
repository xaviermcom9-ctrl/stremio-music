// Login, first-run setup and account pages. Standalone (not part of the stremio-web bundle) so the
// upstream UI stays untouched; styled with Stremio's theme tokens. No inline scripts (strict CSP).

function layout(title: string, page: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#0c0b11">
<meta name="robots" content="noindex">
<title>${title} · Stremio Music</title>
<link rel="manifest" href="manifest.json">
<link rel="icon" href="favicons/favicon.ico">
<link rel="stylesheet" href="auth/auth.css">
<script src="auth/auth.js" defer></script>
</head>
<body data-page="${page}">
<main class="card">
${body}
</main>
</body>
</html>`;
}

const brand = `<div class="brand"><img src="images/icon_196x196.png" alt="" width="40" height="40"><span>Stremio Music</span></div>`;

export const loginPage = () =>
  layout(
    'Sign in',
    'login',
    `${brand}
<h1>Sign in</h1>
<form id="form" novalidate>
  <label>Username<input name="username" autocomplete="username" autocapitalize="none" spellcheck="false" required></label>
  <label>Password<input name="password" type="password" autocomplete="current-password" required></label>
  <p class="error" role="alert" hidden></p>
  <button type="submit">Sign in</button>
</form>`,
  );

export const setupPage = () =>
  layout(
    'Set up',
    'setup',
    `${brand}
<h1>Create the admin account</h1>
<p class="hint">Enter the setup code from the container log (<code>docker logs stremio-music</code>).</p>
<form id="form" novalidate>
  <label>Setup code<input name="code" autocomplete="one-time-code" autocapitalize="characters" spellcheck="false" placeholder="XXXX-XXXX" required></label>
  <label>Username<input name="username" autocomplete="username" autocapitalize="none" spellcheck="false" required></label>
  <label>Password<input name="password" type="password" autocomplete="new-password" minlength="8" required></label>
  <label>Repeat password<input name="password2" type="password" autocomplete="new-password" minlength="8" required></label>
  <p class="error" role="alert" hidden></p>
  <button type="submit">Create account</button>
</form>`,
  );

export const accountPage = (mode: 'local' | 'proxy') =>
  layout(
    'Account',
    'account',
    `${brand}
<p><a href="./" class="back">← Back to the app</a></p>
<h1>Account</h1>
<p>Signed in as <strong id="me">…</strong></p>
${
  mode === 'local'
    ? `<section>
  <h2>Change password</h2>
  <form id="password-form" novalidate>
    <label>Current password<input name="current" type="password" autocomplete="current-password" required></label>
    <label>New password<input name="password" type="password" autocomplete="new-password" minlength="8" required></label>
    <label>Repeat new password<input name="password2" type="password" autocomplete="new-password" minlength="8" required></label>
    <p class="error" role="alert" hidden></p>
    <p class="ok" role="status" hidden>Password changed. Other devices were signed out.</p>
    <button type="submit">Change password</button>
  </form>
</section>
<button id="logout" class="secondary">Sign out</button>`
    : `<p class="hint">Sign-in is handled by your reverse proxy.</p>`
}
<section id="admin" hidden>
  <h2>Users</h2>
  <ul id="users" class="users"></ul>
  <h3>Add user</h3>
  <form id="user-form" novalidate>
    <label>Username<input name="username" autocapitalize="none" spellcheck="false" required></label>
    ${mode === 'local' ? '<label>Password<input name="password" type="password" autocomplete="new-password" minlength="8" required></label>' : ''}
    <label class="check"><input name="isAdmin" type="checkbox"> Admin</label>
    <p class="error" role="alert" hidden></p>
    <button type="submit">Add user</button>
  </form>
</section>`,
  );

export const AUTH_CSS = `@font-face { font-family: PlusJakartaSans; src: url("../fonts/PlusJakartaSans.ttf"); font-display: swap; }
:root {
  --bg: rgb(12, 11, 17); --bg2: rgb(26, 23, 62); --modal: rgb(15, 13, 32);
  --fg: rgba(255, 255, 255, 0.9); --muted: rgba(255, 255, 255, 0.6);
  --accent: rgb(123, 91, 245); --ok: rgb(34, 179, 101); --error: rgb(255, 107, 107);
  --overlay: rgba(255, 255, 255, 0.05); --glow: 0 0 15px rgba(123, 91, 245, 0.37);
  color-scheme: dark;
}
* { box-sizing: border-box; }
html { background: var(--bg); }
body {
  margin: 0; min-height: 100vh; min-height: 100dvh;
  background: radial-gradient(140% 640px at 50% 0, var(--bg2), transparent) no-repeat;
  color: var(--fg); font: 16px/1.5 PlusJakartaSans, system-ui, sans-serif;
  display: flex; justify-content: center; align-items: flex-start;
  padding: max(24px, env(safe-area-inset-top)) 16px max(24px, env(safe-area-inset-bottom));
}
.card { width: 100%; max-width: 420px; }
@media (min-width: 600px) {
  body { align-items: center; }
  .card { background: var(--modal); border-radius: 16px; padding: 32px; box-shadow: 0 8px 40px rgba(0,0,0,.4); }
}
.brand { display: flex; align-items: center; gap: 12px; font-weight: 700; font-size: 18px; margin-bottom: 24px; }
.brand img { border-radius: 10px; }
h1 { font-size: 24px; margin: 0 0 16px; }
h2 { font-size: 18px; margin: 32px 0 12px; }
h3 { font-size: 16px; margin: 24px 0 8px; }
p { margin: 0 0 16px; }
.hint { color: var(--muted); font-size: 14px; }
code { background: var(--overlay); padding: 1px 6px; border-radius: 6px; }
a { color: var(--accent); }
form { display: flex; flex-direction: column; gap: 14px; }
label { display: flex; flex-direction: column; gap: 6px; font-size: 14px; color: var(--muted); }
label.check { flex-direction: row; align-items: center; gap: 10px; color: var(--fg); }
input:not([type=checkbox]) {
  height: 48px; padding: 0 14px; font: inherit; font-size: 16px; color: var(--fg);
  background: var(--overlay); border: 2px solid transparent; border-radius: 12px; outline: none;
}
input:focus-visible { border-color: var(--accent); box-shadow: var(--glow); }
input[type=checkbox] { width: 20px; height: 20px; accent-color: var(--accent); }
button {
  height: 48px; padding: 0 20px; font: inherit; font-weight: 700; color: #fff; cursor: pointer;
  background: var(--accent); border: 0; border-radius: 24px;
}
button:hover, button:focus-visible { box-shadow: var(--glow); outline: none; }
button:disabled { opacity: .6; cursor: progress; }
button.secondary { background: var(--overlay); margin-top: 24px; width: 100%; }
button.small { height: 36px; padding: 0 14px; font-size: 14px; background: var(--overlay); }
button.danger { color: var(--error); }
.error { color: var(--error); font-size: 14px; margin: 0; }
.ok { color: var(--ok); font-size: 14px; margin: 0; }
.users { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 10px; }
.users li { background: var(--overlay); border-radius: 12px; padding: 12px 14px; }
.users .name { font-weight: 700; }
.users .tags { color: var(--muted); font-size: 13px; margin-left: 6px; }
.users .actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
[hidden] { display: none !important; }
`;

export const AUTH_JS = `'use strict';
(function () {
  var page = document.body.dataset.page;
  function $(sel, root) { return (root || document).querySelector(sel); }
  function api(method, url, body) {
    return fetch(url, {
      method: method,
      headers: body ? { 'content-type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
      credentials: 'same-origin'
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok) throw new Error(data.error || data.message || ('Error ' + res.status));
        return data;
      });
    });
  }
  function bind(form, handler) {
    var err = $('.error', form), btn = $('button[type=submit]', form);
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      err.hidden = true;
      btn.disabled = true;
      var data = Object.fromEntries(new FormData(form));
      Promise.resolve().then(function () { return handler(data, form); })
        .catch(function (ex) { err.textContent = ex.message; err.hidden = false; })
        .then(function () { btn.disabled = false; });
    });
  }
  function nextUrl() {
    var next = new URLSearchParams(location.search).get('next') || '/';
    if (!/^\\/(?![\\/\\\\])/.test(next)) next = '/';
    return '.' + next + location.hash;
  }

  if (page === 'login') {
    bind($('#form'), function (d) {
      return api('POST', 'api/auth/login', { username: d.username.trim(), password: d.password })
        .then(function () { location.replace(nextUrl()); });
    });
    $('input[name=username]').focus();
  }

  if (page === 'setup') {
    bind($('#form'), function (d) {
      if (d.password !== d.password2) throw new Error('The passwords don\\'t match.');
      return api('POST', 'api/auth/setup', { code: d.code, username: d.username.trim(), password: d.password })
        .then(function () { location.replace('./'); });
    });
  }

  if (page === 'account') {
    var me = null;
    var pw = $('#password-form');
    if (pw) bind(pw, function (d, form) {
      if (d.password !== d.password2) throw new Error('The passwords don\\'t match.');
      return api('POST', 'api/auth/password', { current: d.current, password: d.password })
        .then(function () { form.reset(); $('.ok', form).hidden = false; });
    });
    var logout = $('#logout');
    if (logout) logout.addEventListener('click', function () {
      api('POST', 'api/auth/logout').then(function () { location.replace('login'); });
    });

    function action(label, cls, fn) {
      var b = document.createElement('button');
      b.type = 'button'; b.className = 'small' + (cls ? ' ' + cls : ''); b.textContent = label;
      b.addEventListener('click', function () {
        Promise.resolve().then(fn).then(loadUsers).catch(function (ex) { alert(ex.message); });
      });
      return b;
    }
    function loadUsers() {
      return api('GET', 'api/users').then(function (data) {
        var list = $('#users');
        list.textContent = '';
        data.users.forEach(function (u) {
          var li = document.createElement('li');
          var name = document.createElement('span'); name.className = 'name'; name.textContent = u.username;
          var tags = document.createElement('span'); tags.className = 'tags';
          tags.textContent = [u.isAdmin ? 'admin' : '', u.disabled ? 'disabled' : '', u.id === me.id ? 'you' : ''].filter(Boolean).join(' · ');
          var actions = document.createElement('div'); actions.className = 'actions';
          if (u.hasPassword) actions.appendChild(action('Reset password', '', function () {
            var p = prompt('New password for ' + u.username + ' (min 8 characters):');
            if (p) return api('PATCH', 'api/users/' + u.id, { password: p });
          }));
          if (u.id !== me.id) {
            actions.appendChild(action(u.isAdmin ? 'Remove admin' : 'Make admin', '', function () {
              return api('PATCH', 'api/users/' + u.id, { isAdmin: !u.isAdmin });
            }));
            actions.appendChild(action(u.disabled ? 'Enable' : 'Disable', '', function () {
              return api('PATCH', 'api/users/' + u.id, { disabled: !u.disabled });
            }));
            actions.appendChild(action('Delete', 'danger', function () {
              if (confirm('Delete ' + u.username + '? Their library and settings are removed.')) return api('DELETE', 'api/users/' + u.id);
            }));
          }
          li.append(name, tags, actions);
          list.appendChild(li);
        });
      });
    }
    bind($('#user-form'), function (d, form) {
      return api('POST', 'api/users', { username: d.username.trim(), password: d.password || '', isAdmin: !!d.isAdmin })
        .then(function () { form.reset(); return loadUsers(); });
    });
    api('GET', 'api/auth/state').then(function (s) {
      me = s.user;
      $('#me').textContent = me.username;
      if (me.isAdmin) { $('#admin').hidden = false; return loadUsers(); }
    });
  }
})();
`;
