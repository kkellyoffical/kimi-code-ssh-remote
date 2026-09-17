import type { FastifyInstance } from 'fastify';

export function registerSshPageRoute(app: FastifyInstance): void {
  app.get(
    '/ssh',
    { schema: { description: 'Built-in SSH connections management page', tags: ['ssh'] } },
    async (_req, reply) => {
      await reply
        .type('text/html; charset=utf-8')
        .header('cache-control', 'no-cache')
        .send(SSH_PAGE_HTML);
    },
  );
}

const SSH_PAGE_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>SSH Connections - Kimi Code</title>
<style>
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
body { margin: 0; padding: 24px; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; font-size: 14px; line-height: 1.5; background: Canvas; color: CanvasText; }
main { max-width: 960px; margin: 0 auto; }
h1 { font-size: 18px; margin: 0 0 16px; }
h2 { font-size: 15px; margin: 24px 0 8px; }
table { width: 100%; border-collapse: collapse; margin-top: 8px; }
th, td { text-align: left; padding: 6px 10px; border-bottom: 1px solid color-mix(in srgb, CanvasText 15%, transparent); vertical-align: middle; }
th { font-weight: 600; font-size: 12px; opacity: 0.7; }
form.add { margin-top: 8px; }
form.add .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 8px; align-items: end; }
label { display: flex; flex-direction: column; gap: 4px; font-size: 12px; opacity: 0.85; }
label.radio, label.checkbox { flex-direction: row; align-items: center; gap: 6px; }
input, select { padding: 6px 8px; font: inherit; border: 1px solid color-mix(in srgb, CanvasText 25%, transparent); border-radius: 6px; background: Canvas; color: CanvasText; }
input[type="radio"], input[type="checkbox"] { padding: 0; }
button { padding: 6px 12px; font: inherit; border: 1px solid color-mix(in srgb, CanvasText 25%, transparent); border-radius: 6px; background: color-mix(in srgb, CanvasText 6%, transparent); color: CanvasText; cursor: pointer; }
button:hover { background: color-mix(in srgb, CanvasText 12%, transparent); }
button:disabled { opacity: 0.5; cursor: default; }
button.primary { background: #2563eb; border-color: #2563eb; color: #fff; }
button.primary:hover { background: #1d4ed8; }
button.link { border: none; background: none; padding: 0; color: #2563eb; text-align: left; }
button.link:hover { background: none; text-decoration: underline; }
fieldset.auth-method { margin: 12px 0 0; padding: 0; border: none; display: flex; gap: 16px; flex-wrap: wrap; }
fieldset.auth-method legend { font-size: 12px; opacity: 0.7; padding: 0; margin-bottom: 4px; }
.auth-panel { margin-top: 8px; max-width: 420px; }
.auth-panel .risk { margin: 4px 0 0; font-size: 12px; }
form.add button[type="submit"] { margin-top: 12px; }
.state { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 12px; }
.state-on { background: #dcfce7; color: #166534; }
.state-off { background: color-mix(in srgb, CanvasText 10%, transparent); }
.state-connecting { background: #fef9c3; color: #854d0e; }
.state-error { background: #fee2e2; color: #991b1b; }
.state-needs-password { background: #ffedd5; color: #9a3412; }
.msg { margin: 8px 0; padding: 8px 12px; border-radius: 6px; font-size: 13px; white-space: pre-wrap; }
.msg-error { background: #fee2e2; color: #991b1b; }
.msg-ok { background: #dcfce7; color: #166534; }
.row-actions { display: flex; gap: 6px; flex-wrap: wrap; }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
.hidden { display: none; }
.muted { opacity: 0.6; }
tr.password-row td { padding: 8px 10px; background: color-mix(in srgb, CanvasText 4%, transparent); }
form.password-form { display: flex; gap: 8px; align-items: flex-end; flex-wrap: wrap; }
form.password-form label { min-width: 200px; }
form.password-form .risk { flex-basis: 100%; margin: 0; font-size: 12px; }
form.password-form .form-error { flex-basis: 100%; margin: 0; font-size: 12px; color: #991b1b; white-space: pre-wrap; }
.console-head { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-top: 24px; }
.console-head h2 { margin: 0; }
.console-head select { min-width: 200px; }
.console-bar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-top: 8px; }
.path-text { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; word-break: break-all; }
.console-error { margin: 8px 0; padding: 8px 12px; border-radius: 6px; font-size: 13px; background: #fee2e2; color: #991b1b; white-space: pre-wrap; }
.size-cell, .mtime-cell { white-space: nowrap; font-size: 12px; opacity: 0.75; }
</style>
</head>
<body>
<main>
<h1>SSH Connections</h1>
<section id="token-section" class="hidden">
<h2>Access token</h2>
<p class="muted">Paste the local server token (shown in the server startup banner). It is kept in this page's URL fragment only.</p>
<form id="token-form">
<label>Token <input id="token-input" type="password" autocomplete="off" required></label>
<button type="submit" class="primary">Save</button>
</form>
</section>
<section id="main-section" class="hidden">
<div id="message"></div>
<h2>Add connection</h2>
<form class="add" id="add-form">
<div class="grid">
<label>Name <input name="name" required pattern="[A-Za-z0-9][A-Za-z0-9._-]*" placeholder="my-server"></label>
<label>Host <input name="host" required placeholder="192.168.1.10"></label>
<label>User <input name="user" placeholder="root"></label>
<label>Port <input name="port" type="number" min="1" max="65535" placeholder="22"></label>
</div>
<fieldset class="auth-method" id="auth-method">
<legend>Authentication</legend>
<label class="radio"><input type="radio" name="auth_method" value="default" checked> Agent / default keys (password-less)</label>
<label class="radio"><input type="radio" name="auth_method" value="identity"> Identity file</label>
<label class="radio"><input type="radio" name="auth_method" value="password"> Password</label>
</fieldset>
<div class="auth-panel hidden" id="auth-identity-panel">
<label>Identity file <input name="identity_file" placeholder="~/.ssh/id_ed25519"></label>
</div>
<div class="auth-panel hidden" id="auth-password-panel">
<label>Password <input name="password" type="password" autocomplete="new-password"></label>
<label class="checkbox"><input name="save_password" type="checkbox"> Remember password</label>
<p class="muted risk">Saved passwords are stored in clear text in ~/.kimi-code/ssh/secrets.json on this machine. If not saved, you will be asked for the password when connecting.</p>
</div>
<button type="submit" class="primary">Add</button>
</form>
<h2>Connections</h2>
<table>
<thead><tr><th>Name</th><th>Target</th><th>Auth</th><th>State</th><th>Detail</th><th>Actions</th></tr></thead>
<tbody id="rows"></tbody>
</table>
<p class="muted" id="empty-hint">No connections yet.</p>
<div class="console-head">
<h2>Remote console</h2>
<select id="console-select" class="mono"></select>
</div>
<section id="console-empty">
<p class="muted">Add a connection to browse remote files and projects.</p>
</section>
<section id="console-section" class="hidden">
<h2>Files</h2>
<div class="console-bar">
<button type="button" id="files-up">Up</button>
<button type="button" id="files-refresh">Refresh</button>
<button type="button" id="files-mkdir">New folder</button>
<button type="button" id="files-upload">Upload</button>
<input type="file" id="files-upload-input" class="hidden">
<span class="path-text" id="files-path"></span>
</div>
<div id="files-error" class="console-error hidden"></div>
<table>
<thead><tr><th>Name</th><th>Size</th><th>Modified</th><th>Actions</th></tr></thead>
<tbody id="files-rows"></tbody>
</table>
<h2>Projects</h2>
<div class="console-bar">
<button type="button" id="projects-refresh">Refresh</button>
</div>
<div id="projects-error" class="console-error hidden"></div>
<table>
<thead><tr><th>Name</th><th>Root</th><th>Sessions</th><th>Actions</th></tr></thead>
<tbody id="projects-rows"></tbody>
</table>
</section>
</section>
</main>
<script>
(function () {
  var SSH_AUTH_REQUIRED = 40130;
  var MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
  var tokenSection = document.getElementById('token-section');
  var mainSection = document.getElementById('main-section');
  var messageBox = document.getElementById('message');
  var rows = document.getElementById('rows');
  var emptyHint = document.getElementById('empty-hint');
  var pollTimer = null;
  var passwordPrompts = {};
  var dismissedPrompts = {};
  var consoleSelect = document.getElementById('console-select');
  var consoleEmpty = document.getElementById('console-empty');
  var consoleSection = document.getElementById('console-section');
  var consoleConnection = null;
  var consoleState = {};
  var knownConnections = [];

  function readToken() {
    var hash = location.hash.replace(/^#/, '');
    var params = new URLSearchParams(hash);
    var token = params.get('token');
    return token === null || token === '' ? null : token;
  }

  var token = readToken();
  if (token === null) {
    tokenSection.classList.remove('hidden');
  } else {
    mainSection.classList.remove('hidden');
    start();
  }

  document.getElementById('token-form').addEventListener('submit', function (event) {
    event.preventDefault();
    var value = document.getElementById('token-input').value.trim();
    if (value === '') return;
    location.hash = '#token=' + encodeURIComponent(value);
    location.reload();
  });

  function showMessage(text, kind) {
    messageBox.textContent = text;
    messageBox.className = 'msg ' + (kind === 'ok' ? 'msg-ok' : 'msg-error');
    if (text === '') messageBox.className = 'hidden';
  }

  function rawApi(path, options) {
    var headers = { authorization: 'Bearer ' + token };
    var body;
    if (options && options.rawBody !== undefined) {
      headers['content-type'] = 'application/octet-stream';
      body = options.rawBody;
    } else {
      headers['content-type'] = 'application/json';
      body = options && options.body !== undefined ? JSON.stringify(options.body) : undefined;
    }
    return fetch(path, {
      method: (options && options.method) || 'GET',
      headers: headers,
      body: body
    }).then(function (res) {
      return res.json().then(function (envelope) {
        if (envelope.code !== 0) {
          var error = new Error(envelope.msg || ('request failed with code ' + envelope.code));
          error.code = envelope.code;
          throw error;
        }
        return envelope.data;
      });
    });
  }

  function api(path, options) {
    return rawApi(path, options);
  }

  function remoteApi(name, path, options) {
    return rawApi('/ssh/' + encodeURIComponent(name) + '/api/v1' + path, options);
  }

  function targetText(conn) {
    var target = conn.user ? conn.user + '@' + conn.host : conn.host;
    return target + ':' + conn.port;
  }

  function authText(conn) {
    var parts = [];
    if (conn.identity_file) parts.push('key: ' + conn.identity_file);
    if (conn.has_password) parts.push('password (saved)');
    if (parts.length === 0) return 'agent / default keys';
    return parts.join(' + ');
  }

  function detailText(conn) {
    if (conn.status.state === 'on' && conn.status.local_origin) return conn.status.local_origin;
    if (conn.status.state === 'error' && conn.status.error) return conn.status.error;
    return '';
  }

  function anyPromptOpen() {
    return Object.keys(passwordPrompts).length > 0;
  }

  function openPasswordPrompt(name, error, prefill) {
    passwordPrompts[name] = { error: error || null, prefill: prefill || null };
    delete dismissedPrompts[name];
    refresh(true);
  }

  function closePasswordPrompt(name) {
    delete passwordPrompts[name];
    dismissedPrompts[name] = true;
    refresh(true);
  }

  function submitPassword(conn, form) {
    var input = form.querySelector('.password-input');
    var remember = form.querySelector('.save-password-input');
    var errorLine = form.querySelector('.form-error');
    var password = input.value;
    if (password === '') return;
    var buttons = form.querySelectorAll('button');
    for (var i = 0; i < buttons.length; i++) buttons[i].disabled = true;
    api('/api/v1/ssh/connections/' + encodeURIComponent(conn.name) + '/password', {
      method: 'POST',
      body: { password: password, save_password: remember.checked }
    }).then(function () {
      delete passwordPrompts[conn.name];
      showMessage('connected: ' + conn.name, 'ok');
      refresh(true);
    }).catch(function (error) {
      for (var i = 0; i < buttons.length; i++) buttons[i].disabled = false;
      input.value = '';
      input.focus();
      if (error.code === SSH_AUTH_REQUIRED) {
        errorLine.textContent = 'authentication failed, please check the password and try again';
      } else {
        errorLine.textContent = error.message;
      }
    });
  }

  function passwordPromptRow(conn, prompt) {
    var tr = document.createElement('tr');
    tr.className = 'password-row';
    var td = document.createElement('td');
    td.colSpan = 6;
    var form = document.createElement('form');
    form.className = 'password-form';
    var label = document.createElement('label');
    label.textContent = 'Password for ' + targetText(conn);
    var input = document.createElement('input');
    input.type = 'password';
    input.className = 'password-input';
    input.autocomplete = 'off';
    input.required = true;
    if (prompt.prefill !== null) input.value = prompt.prefill;
    label.appendChild(input);
    form.appendChild(label);
    var rememberLabel = document.createElement('label');
    rememberLabel.className = 'checkbox';
    var remember = document.createElement('input');
    remember.type = 'checkbox';
    remember.className = 'save-password-input';
    rememberLabel.appendChild(remember);
    rememberLabel.appendChild(document.createTextNode('Remember password'));
    form.appendChild(rememberLabel);
    var submit = document.createElement('button');
    submit.type = 'submit';
    submit.className = 'primary';
    submit.textContent = 'Connect';
    form.appendChild(submit);
    var cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.textContent = 'Cancel';
    cancel.addEventListener('click', function () {
      closePasswordPrompt(conn.name);
    });
    form.appendChild(cancel);
    var risk = document.createElement('p');
    risk.className = 'muted risk';
    risk.textContent = 'Saved passwords are stored in clear text in ~/.kimi-code/ssh/secrets.json on this machine.';
    form.appendChild(risk);
    var errorLine = document.createElement('p');
    errorLine.className = 'form-error';
    if (prompt.error !== null) errorLine.textContent = prompt.error;
    form.appendChild(errorLine);
    form.addEventListener('submit', function (event) {
      event.preventDefault();
      submitPassword(conn, form);
    });
    td.appendChild(form);
    tr.appendChild(td);
    return tr;
  }

  function actionButton(label, onClick, primary) {
    var button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    if (primary) button.className = 'primary';
    button.addEventListener('click', function () {
      button.disabled = true;
      onClick().catch(function (error) {
        showMessage(error.message, 'error');
      }).finally(function () {
        button.disabled = false;
        refresh();
      });
    });
    return button;
  }

  function formatSize(size) {
    if (size === undefined || size === null) return '';
    if (size < 1024) return size + ' B';
    if (size < 1024 * 1024) return (size / 1024).toFixed(1) + ' KB';
    return (size / (1024 * 1024)).toFixed(1) + ' MB';
  }

  function formatTime(iso) {
    if (!iso) return '';
    var date = new Date(iso);
    if (isNaN(date.getTime())) return '';
    return date.toLocaleString();
  }

  function stateFor(name) {
    if (consoleState[name] === undefined) {
      consoleState[name] = { path: null, parent: null, entries: [], filesError: null, projects: [], projectsError: null, loaded: false };
    }
    return consoleState[name];
  }

  function renderConsoleSelect() {
    var previous = consoleConnection;
    consoleSelect.textContent = '';
    knownConnections.forEach(function (conn) {
      var option = document.createElement('option');
      option.value = conn.name;
      option.textContent = conn.name + ' (' + targetText(conn) + ')';
      consoleSelect.appendChild(option);
    });
    var names = knownConnections.map(function (conn) { return conn.name; });
    if (previous !== null && names.indexOf(previous) >= 0) {
      consoleConnection = previous;
    } else {
      consoleConnection = names.length > 0 ? names[0] : null;
    }
    consoleSelect.value = consoleConnection || '';
    consoleEmpty.classList.toggle('hidden', consoleConnection !== null);
    consoleSection.classList.toggle('hidden', consoleConnection === null);
    if (consoleConnection !== null) {
      renderConsole();
      if (!stateFor(consoleConnection).loaded) loadConsole();
    }
  }

  function renderConsole() {
    if (consoleConnection === null) return;
    var state = stateFor(consoleConnection);
    document.getElementById('files-path').textContent = state.path || '';
    var filesError = document.getElementById('files-error');
    filesError.textContent = state.filesError || '';
    filesError.classList.toggle('hidden', state.filesError === null);
    var filesRows = document.getElementById('files-rows');
    filesRows.textContent = '';
    state.entries.forEach(function (entry) {
      var tr = document.createElement('tr');
      var nameTd = document.createElement('td');
      if (entry.is_dir) {
        var openDir = document.createElement('button');
        openDir.type = 'button';
        openDir.className = 'link mono';
        openDir.textContent = entry.name + '/';
        openDir.addEventListener('click', function () {
          loadFiles(entry.path);
        });
        nameTd.appendChild(openDir);
      } else {
        nameTd.textContent = entry.name;
        nameTd.className = 'mono';
      }
      tr.appendChild(nameTd);
      var sizeTd = document.createElement('td');
      sizeTd.className = 'size-cell';
      sizeTd.textContent = entry.is_dir ? '' : formatSize(entry.size);
      tr.appendChild(sizeTd);
      var mtimeTd = document.createElement('td');
      mtimeTd.className = 'mtime-cell';
      mtimeTd.textContent = formatTime(entry.modified_at);
      tr.appendChild(mtimeTd);
      var actionsTd = document.createElement('td');
      if (!entry.is_dir) {
        var download = document.createElement('button');
        download.type = 'button';
        download.textContent = 'Download';
        download.addEventListener('click', function () {
          download.disabled = true;
          downloadRemoteFile(consoleConnection, entry).catch(function (error) {
            showMessage(error.message, 'error');
          }).finally(function () {
            download.disabled = false;
          });
        });
        actionsTd.appendChild(download);
      }
      tr.appendChild(actionsTd);
      filesRows.appendChild(tr);
    });
    var projectsError = document.getElementById('projects-error');
    projectsError.textContent = state.projectsError || '';
    projectsError.classList.toggle('hidden', state.projectsError === null);
    var projectsRows = document.getElementById('projects-rows');
    projectsRows.textContent = '';
    state.projects.forEach(function (ws) {
      var tr = document.createElement('tr');
      var nameTd = document.createElement('td');
      nameTd.textContent = ws.name;
      tr.appendChild(nameTd);
      var rootTd = document.createElement('td');
      rootTd.textContent = ws.root;
      rootTd.className = 'mono muted';
      tr.appendChild(rootTd);
      var countTd = document.createElement('td');
      countTd.textContent = String(ws.session_count);
      tr.appendChild(countTd);
      var actionsTd = document.createElement('td');
      var open = document.createElement('button');
      open.type = 'button';
      open.textContent = 'Open';
      open.addEventListener('click', function () {
        var origin = location.origin;
        var url = origin + '/?kimi_origin=' + encodeURIComponent(origin + '/ssh/' + consoleConnection) + '#token=' + encodeURIComponent(token);
        window.open(url, '_blank', 'noopener');
      });
      actionsTd.appendChild(open);
      tr.appendChild(actionsTd);
      projectsRows.appendChild(tr);
    });
  }

  function loadFiles(path) {
    if (consoleConnection === null) return Promise.resolve();
    var name = consoleConnection;
    var state = stateFor(name);
    state.filesError = null;
    var request = path === null
      ? remoteApi(name, '/fs:home').then(function (home) {
          return remoteApi(name, '/fs:list?path=' + encodeURIComponent(home.home));
        })
      : remoteApi(name, '/fs:list?path=' + encodeURIComponent(path));
    return request.then(function (data) {
      state.path = data.path;
      state.parent = data.parent;
      state.entries = data.entries || [];
      renderConsole();
    }).catch(function (error) {
      state.filesError = error.message;
      renderConsole();
    });
  }

  function loadProjects() {
    if (consoleConnection === null) return Promise.resolve();
    var name = consoleConnection;
    var state = stateFor(name);
    state.projectsError = null;
    return remoteApi(name, '/workspaces').then(function (data) {
      state.projects = data.items || [];
      renderConsole();
    }).catch(function (error) {
      state.projectsError = error.message;
      renderConsole();
    });
  }

  function loadConsole() {
    if (consoleConnection === null) return;
    stateFor(consoleConnection).loaded = true;
    loadFiles(null);
    loadProjects();
  }

  function mkdirRemote() {
    if (consoleConnection === null) return;
    var state = stateFor(consoleConnection);
    if (state.path === null) return;
    var input = window.prompt('New folder name in ' + state.path);
    if (input === null) return;
    var name = input.trim();
    if (name === '' || name.indexOf('/') >= 0) {
      showMessage('folder name must be a single path segment', 'error');
      return;
    }
    remoteApi(consoleConnection, '/fs:mkdir', {
      method: 'POST',
      body: { path: state.path + '/' + name }
    }).then(function () {
      showMessage('folder created: ' + name, 'ok');
      loadFiles(state.path);
    }).catch(function (error) {
      showMessage(error.message, 'error');
    });
  }

  function uploadRemote(file) {
    if (consoleConnection === null) return;
    var state = stateFor(consoleConnection);
    if (state.path === null) return;
    if (file.size > MAX_UPLOAD_BYTES) {
      showMessage('file is too large: uploads are limited to 10 MiB', 'error');
      return;
    }
    file.arrayBuffer().then(function (buffer) {
      return remoteApi(consoleConnection, '/fs:content?path=' + encodeURIComponent(state.path + '/' + file.name), {
        method: 'PUT',
        rawBody: buffer
      });
    }).then(function () {
      showMessage('uploaded: ' + file.name, 'ok');
      loadFiles(state.path);
    }).catch(function (error) {
      showMessage(error.message, 'error');
    });
  }

  function downloadRemoteFile(name, entry) {
    return fetch('/ssh/' + encodeURIComponent(name) + '/api/v1/fs:content?path=' + encodeURIComponent(entry.path), {
      headers: { authorization: 'Bearer ' + token }
    }).then(function (res) {
      var contentType = res.headers.get('content-type') || '';
      if (!res.ok || contentType.indexOf('application/json') >= 0) {
        return res.json().then(function (envelope) {
          throw new Error(envelope.msg || ('download failed with status ' + res.status));
        });
      }
      return res.blob();
    }).then(function (blob) {
      var url = URL.createObjectURL(blob);
      var anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = entry.name;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    });
  }

  function render(connections) {
    rows.textContent = '';
    emptyHint.classList.toggle('hidden', connections.length > 0);
    connections.forEach(function (conn) {
      if (!conn.status.needs_password) delete dismissedPrompts[conn.name];
      var tr = document.createElement('tr');
      var nameTd = document.createElement('td');
      nameTd.textContent = conn.name;
      nameTd.className = 'mono';
      tr.appendChild(nameTd);
      var targetTd = document.createElement('td');
      targetTd.textContent = targetText(conn);
      targetTd.className = 'mono';
      tr.appendChild(targetTd);
      var authTd = document.createElement('td');
      authTd.textContent = authText(conn);
      authTd.className = 'mono muted';
      tr.appendChild(authTd);
      var stateTd = document.createElement('td');
      var badge = document.createElement('span');
      badge.className = 'state state-' + conn.status.state;
      badge.textContent = conn.status.state;
      stateTd.appendChild(badge);
      if (conn.status.needs_password) {
        stateTd.appendChild(document.createTextNode(' '));
        var needsBadge = document.createElement('span');
        needsBadge.className = 'state state-needs-password';
        needsBadge.textContent = 'needs password';
        stateTd.appendChild(needsBadge);
      }
      tr.appendChild(stateTd);
      var detailTd = document.createElement('td');
      detailTd.textContent = detailText(conn);
      detailTd.className = 'mono muted';
      tr.appendChild(detailTd);
      var actionsTd = document.createElement('td');
      var actions = document.createElement('div');
      actions.className = 'row-actions';
      actions.appendChild(actionButton('Test', function () {
        return api('/api/v1/ssh/connections/' + encodeURIComponent(conn.name) + '/test', { method: 'POST', body: {} }).then(function (result) {
          if (!result.ok && result.needs_password) {
            openPasswordPrompt(conn.name, result.error || 'password required');
            return;
          }
          showMessage(result.ok ? ('test ok: ' + (result.platform || 'unknown platform') + (result.server_running ? ', server running' : '')) : ('test failed: ' + (result.error || 'unknown error')), result.ok ? 'ok' : 'error');
        }).catch(function (error) {
          if (error.code === SSH_AUTH_REQUIRED) {
            openPasswordPrompt(conn.name, error.message);
            return;
          }
          throw error;
        });
      }));
      actions.appendChild(actionButton('Connect', function () {
        return api('/api/v1/ssh/connections/' + encodeURIComponent(conn.name) + '/connect', { method: 'POST', body: {} }).then(function () {
          showMessage('connected: ' + conn.name, 'ok');
        }).catch(function (error) {
          if (error.code === SSH_AUTH_REQUIRED) {
            openPasswordPrompt(conn.name, error.message);
            return;
          }
          throw error;
        });
      }));
      actions.appendChild(actionButton('Disconnect', function () {
        return api('/api/v1/ssh/connections/' + encodeURIComponent(conn.name) + '/disconnect', { method: 'POST', body: {} }).then(function () {
          showMessage('disconnected: ' + conn.name, 'ok');
        });
      }));
      var openButton = document.createElement('button');
      openButton.type = 'button';
      openButton.textContent = 'Open';
      openButton.addEventListener('click', function () {
        var origin = location.origin;
        var url = origin + '/?kimi_origin=' + encodeURIComponent(origin + '/ssh/' + conn.name) + '#token=' + encodeURIComponent(token);
        window.open(url, '_blank', 'noopener');
      });
      actions.appendChild(openButton);
      if (conn.status.needs_password && dismissedPrompts[conn.name]) {
        actions.appendChild(actionButton('Enter password', function () {
          openPasswordPrompt(conn.name, null);
          return Promise.resolve();
        }));
      }
      if (conn.has_password) {
        actions.appendChild(actionButton('Forget password', function () {
          return api('/api/v1/ssh/connections/' + encodeURIComponent(conn.name) + '/password', { method: 'DELETE' }).then(function () {
            showMessage('saved password cleared: ' + conn.name, 'ok');
          });
        }));
      }
      actionsTd.appendChild(actions);
      tr.appendChild(actionsTd);
      rows.appendChild(tr);
      if (conn.status.needs_password && passwordPrompts[conn.name] === undefined && !dismissedPrompts[conn.name]) {
        passwordPrompts[conn.name] = { error: null, prefill: null };
      }
      if (passwordPrompts[conn.name] !== undefined) {
        rows.appendChild(passwordPromptRow(conn, passwordPrompts[conn.name]));
      }
    });
    var names = connections.map(function (conn) { return conn.name; });
    Object.keys(consoleState).forEach(function (name) {
      if (names.indexOf(name) < 0) delete consoleState[name];
    });
    knownConnections = connections;
    renderConsoleSelect();
  }

  function refresh(force) {
    if (!force && anyPromptOpen()) return Promise.resolve();
    return api('/api/v1/ssh/connections').then(function (data) {
      render(data.connections || []);
    }).catch(function (error) {
      showMessage(error.message, 'error');
    });
  }

  function start() {
    var addForm = document.getElementById('add-form');
    var identityPanel = document.getElementById('auth-identity-panel');
    var passwordPanel = document.getElementById('auth-password-panel');
    document.getElementById('auth-method').addEventListener('change', function (event) {
      var method = event.target.value;
      identityPanel.classList.toggle('hidden', method !== 'identity');
      passwordPanel.classList.toggle('hidden', method !== 'password');
    });
    addForm.addEventListener('submit', function (event) {
      event.preventDefault();
      var form = event.target;
      var body = {
        name: form.elements.name.value.trim(),
        host: form.elements.host.value.trim()
      };
      var user = form.elements.user.value.trim();
      if (user !== '') body.user = user;
      var port = form.elements.port.value.trim();
      if (port !== '') body.port = Number(port);
      var method = form.elements.auth_method.value;
      if (method === 'identity') {
        var identityFile = form.elements.identity_file.value.trim();
        if (identityFile !== '') body.identity_file = identityFile;
      }
      var pendingPassword = null;
      if (method === 'password') {
        var password = form.elements.password.value;
        if (password !== '' && form.elements.save_password.checked) {
          body.password = password;
          body.save_password = true;
        } else if (password !== '') {
          pendingPassword = password;
        }
      }
      api('/api/v1/ssh/connections', { method: 'POST', body: body }).then(function () {
        form.reset();
        identityPanel.classList.add('hidden');
        passwordPanel.classList.add('hidden');
        showMessage('added: ' + body.name, 'ok');
        if (pendingPassword !== null) {
          openPasswordPrompt(body.name, null, pendingPassword);
          return;
        }
        refresh(true);
      }).catch(function (error) {
        showMessage(error.message, 'error');
      });
    });
    consoleSelect.addEventListener('change', function () {
      consoleConnection = consoleSelect.value === '' ? null : consoleSelect.value;
      renderConsole();
      loadConsole();
    });
    document.getElementById('files-up').addEventListener('click', function () {
      if (consoleConnection === null) return;
      var state = stateFor(consoleConnection);
      if (state.parent !== null) loadFiles(state.parent);
    });
    document.getElementById('files-refresh').addEventListener('click', function () {
      if (consoleConnection === null) return;
      loadFiles(stateFor(consoleConnection).path);
    });
    document.getElementById('files-mkdir').addEventListener('click', mkdirRemote);
    var uploadInput = document.getElementById('files-upload-input');
    document.getElementById('files-upload').addEventListener('click', function () {
      uploadInput.value = '';
      uploadInput.click();
    });
    uploadInput.addEventListener('change', function () {
      if (uploadInput.files && uploadInput.files.length > 0) {
        uploadRemote(uploadInput.files[0]);
      }
    });
    document.getElementById('projects-refresh').addEventListener('click', loadProjects);
    refresh();
    pollTimer = setInterval(refresh, 3000);
    window.addEventListener('beforeunload', function () {
      if (pollTimer !== null) clearInterval(pollTimer);
    });
  }
})();
</script>
</body>
</html>
`;
