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
form.add { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 8px; align-items: end; margin-top: 8px; }
label { display: flex; flex-direction: column; gap: 4px; font-size: 12px; opacity: 0.85; }
input { padding: 6px 8px; font: inherit; border: 1px solid color-mix(in srgb, CanvasText 25%, transparent); border-radius: 6px; background: Canvas; color: CanvasText; }
button { padding: 6px 12px; font: inherit; border: 1px solid color-mix(in srgb, CanvasText 25%, transparent); border-radius: 6px; background: color-mix(in srgb, CanvasText 6%, transparent); color: CanvasText; cursor: pointer; }
button:hover { background: color-mix(in srgb, CanvasText 12%, transparent); }
button:disabled { opacity: 0.5; cursor: default; }
button.primary { background: #2563eb; border-color: #2563eb; color: #fff; }
button.primary:hover { background: #1d4ed8; }
.state { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 12px; }
.state-on { background: #dcfce7; color: #166534; }
.state-off { background: color-mix(in srgb, CanvasText 10%, transparent); }
.state-connecting { background: #fef9c3; color: #854d0e; }
.state-error { background: #fee2e2; color: #991b1b; }
.msg { margin: 8px 0; padding: 8px 12px; border-radius: 6px; font-size: 13px; white-space: pre-wrap; }
.msg-error { background: #fee2e2; color: #991b1b; }
.msg-ok { background: #dcfce7; color: #166534; }
.row-actions { display: flex; gap: 6px; flex-wrap: wrap; }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
.hidden { display: none; }
.muted { opacity: 0.6; }
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
<label>Name <input name="name" required pattern="[A-Za-z0-9][A-Za-z0-9._-]*" placeholder="my-server"></label>
<label>Host <input name="host" required placeholder="192.168.1.10"></label>
<label>User <input name="user" placeholder="root"></label>
<label>Port <input name="port" type="number" min="1" max="65535" placeholder="22"></label>
<label>Identity file <input name="identity_file" placeholder="~/.ssh/id_ed25519"></label>
<button type="submit" class="primary">Add</button>
</form>
<h2>Connections</h2>
<table>
<thead><tr><th>Name</th><th>Target</th><th>State</th><th>Detail</th><th>Actions</th></tr></thead>
<tbody id="rows"></tbody>
</table>
<p class="muted" id="empty-hint">No connections yet.</p>
</section>
</main>
<script>
(function () {
  var tokenSection = document.getElementById('token-section');
  var mainSection = document.getElementById('main-section');
  var messageBox = document.getElementById('message');
  var rows = document.getElementById('rows');
  var emptyHint = document.getElementById('empty-hint');
  var pollTimer = null;

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

  function api(path, options) {
    return fetch(path, {
      method: (options && options.method) || 'GET',
      headers: {
        authorization: 'Bearer ' + token,
        'content-type': 'application/json'
      },
      body: options && options.body !== undefined ? JSON.stringify(options.body) : undefined
    }).then(function (res) {
      return res.json().then(function (envelope) {
        if (envelope.code !== 0) {
          throw new Error(envelope.msg || ('request failed with code ' + envelope.code));
        }
        return envelope.data;
      });
    });
  }

  function targetText(conn) {
    var target = conn.user ? conn.user + '@' + conn.host : conn.host;
    return target + ':' + conn.port;
  }

  function detailText(conn) {
    if (conn.status.state === 'on' && conn.status.local_origin) return conn.status.local_origin;
    if (conn.status.state === 'error' && conn.status.error) return conn.status.error;
    return '';
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

  function render(connections) {
    rows.textContent = '';
    emptyHint.classList.toggle('hidden', connections.length > 0);
    connections.forEach(function (conn) {
      var tr = document.createElement('tr');
      var nameTd = document.createElement('td');
      nameTd.textContent = conn.name;
      nameTd.className = 'mono';
      tr.appendChild(nameTd);
      var targetTd = document.createElement('td');
      targetTd.textContent = targetText(conn);
      targetTd.className = 'mono';
      tr.appendChild(targetTd);
      var stateTd = document.createElement('td');
      var badge = document.createElement('span');
      badge.className = 'state state-' + conn.status.state;
      badge.textContent = conn.status.state;
      stateTd.appendChild(badge);
      tr.appendChild(stateTd);
      var detailTd = document.createElement('td');
      detailTd.textContent = detailText(conn);
      detailTd.className = 'mono muted';
      tr.appendChild(detailTd);
      var actionsTd = document.createElement('td');
      var actions = document.createElement('div');
      actions.className = 'row-actions';
      actions.appendChild(actionButton('Test', function () {
        return api('/api/v1/ssh/connections/' + encodeURIComponent(conn.name) + '/test', { method: 'POST' }).then(function (result) {
          showMessage(result.ok ? ('test ok: ' + (result.platform || 'unknown platform') + (result.server_running ? ', server running' : '')) : ('test failed: ' + (result.error || 'unknown error')), result.ok ? 'ok' : 'error');
        });
      }));
      actions.appendChild(actionButton('Connect', function () {
        return api('/api/v1/ssh/connections/' + encodeURIComponent(conn.name) + '/connect', { method: 'POST' }).then(function () {
          showMessage('connected: ' + conn.name, 'ok');
        });
      }));
      actions.appendChild(actionButton('Disconnect', function () {
        return api('/api/v1/ssh/connections/' + encodeURIComponent(conn.name) + '/disconnect', { method: 'POST' }).then(function () {
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
      actionsTd.appendChild(actions);
      tr.appendChild(actionsTd);
      rows.appendChild(tr);
    });
  }

  function refresh() {
    return api('/api/v1/ssh/connections').then(function (data) {
      render(data.connections || []);
    }).catch(function (error) {
      showMessage(error.message, 'error');
    });
  }

  function start() {
    document.getElementById('add-form').addEventListener('submit', function (event) {
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
      var identityFile = form.elements.identity_file.value.trim();
      if (identityFile !== '') body.identity_file = identityFile;
      api('/api/v1/ssh/connections', { method: 'POST', body: body }).then(function () {
        form.reset();
        showMessage('added: ' + body.name, 'ok');
        refresh();
      }).catch(function (error) {
        showMessage(error.message, 'error');
      });
    });
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
