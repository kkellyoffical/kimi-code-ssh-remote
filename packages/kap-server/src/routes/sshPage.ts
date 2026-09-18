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
<title>SSH 连接 - Kimi Code</title>
<style>
:root {
  color-scheme: dark;
  --bg: #121212;
  --card: #1a1a1a;
  --inset: #161616;
  --border: #2e2e2e;
  --row-border: #262626;
  --fg: #ededed;
  --muted: #999999;
  --faint: #666666;
  --hover: rgba(255, 255, 255, 0.04);
  --primary-bg: #ededed;
  --primary-fg: #161616;
  --success: hsl(152, 48%, 55%);
  --warning: hsl(32, 65%, 58%);
  --danger: hsl(0, 60%, 50%);
  --danger-fg: hsl(0, 70%, 68%);
  --info: hsl(215, 55%, 62%);
}
* { box-sizing: border-box; }
body { margin: 0; padding: 32px 24px 48px; background: var(--bg); color: var(--fg); font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif; font-size: 14px; line-height: 1.6; }
main { max-width: 960px; margin: 0 auto; }
.page-head h1 { font-size: 20px; font-weight: 600; margin: 0; }
.page-head p { margin: 4px 0 0; }
.muted { color: var(--muted); }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
.hidden { display: none; }
.card { background: var(--card); border: 1px solid var(--border); border-radius: 10px; padding: 16px 20px 20px; margin-top: 16px; }
.card h2 { font-size: 15px; font-weight: 600; margin: 0; }
.card h3 { font-size: 13px; font-weight: 600; color: var(--muted); margin: 20px 0 0; }
#message { display: flex; align-items: flex-start; gap: 10px; margin-top: 16px; padding: 10px 14px; border-radius: 8px; border: 1px solid transparent; font-size: 13px; }
#message.msg-error { background: color-mix(in srgb, var(--danger) 14%, transparent); border-color: color-mix(in srgb, var(--danger) 35%, transparent); color: var(--danger-fg); }
#message.msg-ok { background: color-mix(in srgb, var(--success) 14%, transparent); border-color: color-mix(in srgb, var(--success) 35%, transparent); color: var(--success); }
#message-text { flex: 1; white-space: pre-wrap; }
#message-close { border: none; background: none; padding: 0 2px; color: inherit; opacity: 0.7; cursor: pointer; font-size: 14px; line-height: 1.4; }
#message-close:hover { background: none; opacity: 1; }
table { width: 100%; border-collapse: collapse; margin-top: 12px; }
th { text-align: left; padding: 6px 10px; border-bottom: 1px solid var(--border); font-size: 12px; font-weight: 500; color: var(--muted); }
td { padding: 8px 10px; border-bottom: 1px solid var(--row-border); vertical-align: middle; }
tbody tr:last-child td { border-bottom: none; }
tbody tr:hover td { background: var(--hover); }
tr.password-row td, tr.host-key-row td { background: var(--inset); padding: 12px 10px; }
tbody tr.password-row:hover td, tbody tr.host-key-row:hover td { background: var(--inset); }
form#token-form { display: flex; gap: 10px; align-items: flex-end; margin-top: 12px; }
form#token-form label { flex: 1; max-width: 360px; }
form.add .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; margin-top: 12px; }
label { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--muted); }
label.radio, label.checkbox { flex-direction: row; align-items: center; gap: 6px; color: var(--fg); font-size: 13px; }
input, select { padding: 6px 10px; font: inherit; font-size: 13px; color: var(--fg); background: var(--inset); border: 1px solid var(--border); border-radius: 6px; }
input:focus, select:focus { outline: none; border-color: #4d4d4d; }
input::placeholder { color: var(--faint); }
input[type="radio"], input[type="checkbox"] { padding: 0; accent-color: var(--primary-bg); }
fieldset.auth-method { margin: 14px 0 0; padding: 0; border: none; display: flex; gap: 16px; flex-wrap: wrap; }
fieldset.auth-method legend { font-size: 12px; color: var(--muted); padding: 0; margin-bottom: 6px; }
.auth-panel { margin-top: 10px; max-width: 420px; }
.auth-panel .risk { margin: 6px 0 0; font-size: 12px; }
form.add button[type="submit"] { margin-top: 14px; }
button { padding: 5px 12px; font: inherit; font-size: 13px; color: var(--fg); background: transparent; border: 1px solid var(--border); border-radius: 6px; cursor: pointer; }
button:hover { background: var(--hover); }
button:disabled { opacity: 0.5; cursor: default; }
button:disabled:hover { background: transparent; }
button.primary { background: var(--primary-bg); border-color: var(--primary-bg); color: var(--primary-fg); font-weight: 500; }
button.primary:hover { background: #ffffff; }
button.primary:disabled:hover { background: var(--primary-bg); }
button.danger { color: var(--danger-fg); border-color: color-mix(in srgb, var(--danger) 40%, transparent); }
button.danger:hover { background: color-mix(in srgb, var(--danger) 15%, transparent); }
button.link { border: none; background: none; padding: 0; color: var(--info); text-align: left; }
button.link:hover { background: none; text-decoration: underline; }
.state { display: inline-block; padding: 1px 10px; border-radius: 999px; font-size: 12px; line-height: 18px; white-space: nowrap; }
.state-on { background: color-mix(in srgb, var(--success) 16%, transparent); color: var(--success); }
.state-off { background: rgba(255, 255, 255, 0.08); color: var(--muted); }
.state-connecting { background: color-mix(in srgb, var(--warning) 16%, transparent); color: var(--warning); }
.state-error { background: color-mix(in srgb, var(--danger) 16%, transparent); color: var(--danger-fg); }
.state-needs-password { background: color-mix(in srgb, var(--warning) 16%, transparent); color: var(--warning); }
.state-host-key { background: color-mix(in srgb, var(--danger) 16%, transparent); color: var(--danger-fg); }
.row-actions { display: flex; gap: 6px; flex-wrap: wrap; }
form.password-form { display: flex; gap: 8px; align-items: flex-end; flex-wrap: wrap; padding: 12px 14px; border: 1px solid var(--border); border-radius: 8px; background: var(--card); }
form.password-form label { min-width: 220px; }
form.password-form .risk { flex-basis: 100%; margin: 0; font-size: 12px; }
form.password-form .form-error { flex-basis: 100%; margin: 0; font-size: 12px; color: var(--danger-fg); white-space: pre-wrap; }
.host-key-box { padding: 12px 14px; border: 1px solid color-mix(in srgb, var(--danger) 35%, transparent); border-radius: 8px; background: color-mix(in srgb, var(--danger) 8%, transparent); }
.host-key-box p { margin: 2px 0; }
.host-key-box .host-key-title { margin: 0 0 4px; font-weight: 600; color: var(--danger-fg); }
.host-key-box .row-actions { margin-top: 10px; }
.console-head { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
.console-head h2 { margin: 0; }
.console-head select { min-width: 220px; }
.console-bar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-top: 10px; }
.path-text { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; color: var(--muted); background: var(--inset); border: 1px solid var(--border); border-radius: 6px; padding: 4px 8px; word-break: break-all; }
.inline-error { margin: 10px 0 0; padding: 8px 12px; border-radius: 8px; border: 1px solid color-mix(in srgb, var(--danger) 35%, transparent); background: color-mix(in srgb, var(--danger) 14%, transparent); color: var(--danger-fg); font-size: 13px; white-space: pre-wrap; }
.size-cell, .mtime-cell { white-space: nowrap; font-size: 12px; color: var(--muted); }
</style>
</head>
<body>
<main>
<header class="page-head">
<h1>SSH 连接</h1>
<p class="muted">注册并管理远程机器，连接后可浏览远程文件与项目。</p>
</header>
<section id="token-section" class="card hidden">
<h2>访问令牌</h2>
<p class="muted">粘贴本地服务器启动横幅中显示的访问令牌。令牌仅保存在本页 URL 的 fragment 中。</p>
<form id="token-form">
<label>令牌 <input id="token-input" type="password" autocomplete="off" required></label>
<button type="submit" class="primary">保存</button>
</form>
</section>
<section id="main-section" class="hidden">
<div id="message" class="hidden"><span id="message-text"></span><button type="button" id="message-close" aria-label="关闭">×</button></div>
<section class="card">
<h2>添加连接</h2>
<form class="add" id="add-form">
<div class="grid">
<label>名称 <input name="name" required pattern="[A-Za-z0-9][A-Za-z0-9._-]*" placeholder="my-server"></label>
<label>主机 <input name="host" required placeholder="192.168.1.10"></label>
<label>用户 <input name="user" placeholder="root"></label>
<label>端口 <input name="port" type="number" min="1" max="65535" placeholder="22"></label>
</div>
<fieldset class="auth-method" id="auth-method">
<legend>认证方式</legend>
<label class="radio"><input type="radio" name="auth_method" value="default" checked> Agent / 默认密钥（免密）</label>
<label class="radio"><input type="radio" name="auth_method" value="identity"> Identity 文件</label>
<label class="radio"><input type="radio" name="auth_method" value="password"> 密码</label>
</fieldset>
<div class="auth-panel hidden" id="auth-identity-panel">
<label>Identity 文件 <input name="identity_file" placeholder="~/.ssh/id_ed25519"></label>
</div>
<div class="auth-panel hidden" id="auth-password-panel">
<label>密码 <input name="password" type="password" autocomplete="new-password"></label>
<label class="checkbox"><input name="save_password" type="checkbox"> 记住密码</label>
<p class="muted risk">保存的密码将以明文存放在本机 ~/.kimi-code/ssh/secrets.json 中。若不保存，连接时会要求输入密码。</p>
</div>
<button type="submit" class="primary">添加</button>
</form>
</section>
<section class="card">
<h2>连接列表</h2>
<table>
<thead><tr><th>名称</th><th>目标</th><th>认证</th><th>状态</th><th>详情</th><th>操作</th></tr></thead>
<tbody id="rows"></tbody>
</table>
<p class="muted" id="empty-hint">暂无连接，先在上方添加一台远程机器。</p>
</section>
<section class="card">
<div class="console-head">
<h2>Remote console</h2>
<select id="console-select" class="mono"></select>
</div>
<p class="muted" id="console-empty">添加连接后即可浏览远程文件与项目。</p>
<div id="console-section" class="hidden">
<h3>文件</h3>
<div class="console-bar">
<button type="button" id="files-up">上级</button>
<button type="button" id="files-refresh">刷新</button>
<button type="button" id="files-mkdir">新建文件夹</button>
<button type="button" id="files-upload">上传</button>
<input type="file" id="files-upload-input" class="hidden">
<span class="path-text" id="files-path"></span>
</div>
<div id="files-error" class="inline-error hidden"></div>
<table>
<thead><tr><th>名称</th><th>大小</th><th>修改时间</th><th>操作</th></tr></thead>
<tbody id="files-rows"></tbody>
</table>
<h3>项目</h3>
<div class="console-bar">
<button type="button" id="projects-refresh">刷新</button>
</div>
<div id="projects-error" class="inline-error hidden"></div>
<table>
<thead><tr><th>名称</th><th>根目录</th><th>会话数</th><th>操作</th></tr></thead>
<tbody id="projects-rows"></tbody>
</table>
</div>
</section>
</section>
</main>
<script>
(function () {
  var SSH_AUTH_REQUIRED = 40130;
  var SSH_HOST_KEY_CHANGED = 40931;
  var MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
  var tokenSection = document.getElementById('token-section');
  var mainSection = document.getElementById('main-section');
  var messageBox = document.getElementById('message');
  var messageText = document.getElementById('message-text');
  var rows = document.getElementById('rows');
  var emptyHint = document.getElementById('empty-hint');
  var pollTimer = null;
  var passwordPrompts = {};
  var dismissedPrompts = {};
  var hostKeyPrompts = {};
  var dismissedHostKey = {};
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

  document.getElementById('message-close').addEventListener('click', function () {
    messageBox.className = 'hidden';
  });

  function showMessage(text, kind) {
    if (text === '') {
      messageBox.className = 'hidden';
      return;
    }
    messageText.textContent = text;
    messageBox.className = kind === 'ok' ? 'msg-ok' : 'msg-error';
  }

  function rawApi(path, options) {
    var headers = { authorization: 'Bearer ' + token };
    var body;
    if (options && options.rawBody !== undefined) {
      headers['content-type'] = 'application/octet-stream';
      body = options.rawBody;
    } else if (options && options.body !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(options.body);
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
          error.details = envelope.details;
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
    if (conn.identity_file) parts.push('密钥 ' + conn.identity_file);
    if (conn.has_password) parts.push('密码（已保存）');
    if (parts.length === 0) return 'agent / 默认密钥';
    return parts.join(' + ');
  }

  function detailText(conn) {
    if (conn.status.state === 'on' && conn.status.local_origin) return conn.status.local_origin;
    if (conn.status.state === 'error' && conn.status.error) return conn.status.error;
    return '';
  }

  function stateText(state) {
    if (state === 'on') return '已连接';
    if (state === 'connecting') return '连接中';
    if (state === 'error') return '错误';
    return '未连接';
  }

  function anyPromptOpen() {
    return Object.keys(passwordPrompts).length > 0 || Object.keys(hostKeyPrompts).length > 0;
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
      showMessage('已连接：' + conn.name, 'ok');
      refresh(true);
    }).catch(function (error) {
      for (var i = 0; i < buttons.length; i++) buttons[i].disabled = false;
      input.value = '';
      input.focus();
      if (error.code === SSH_HOST_KEY_CHANGED) {
        delete passwordPrompts[conn.name];
        openHostKeyPrompt(conn.name, error.details, 'connect');
        return;
      }
      if (error.code === SSH_AUTH_REQUIRED) {
        errorLine.textContent = '认证失败，请检查密码后重试';
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
    label.textContent = '输入 ' + targetText(conn) + ' 的密码';
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
    rememberLabel.appendChild(document.createTextNode('记住密码'));
    form.appendChild(rememberLabel);
    var submit = document.createElement('button');
    submit.type = 'submit';
    submit.className = 'primary';
    submit.textContent = 'Connect';
    form.appendChild(submit);
    var cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.textContent = '取消';
    cancel.addEventListener('click', function () {
      closePasswordPrompt(conn.name);
    });
    form.appendChild(cancel);
    var risk = document.createElement('p');
    risk.className = 'muted risk';
    risk.textContent = '保存的密码将以明文存放在本机 ~/.kimi-code/ssh/secrets.json 中。';
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

  function openHostKeyPrompt(name, details, retry) {
    hostKeyPrompts[name] = { details: details || null, retry: retry };
    refresh(true);
  }

  function forgetHostKeyAndRetry(name) {
    var prompt = hostKeyPrompts[name];
    if (prompt === undefined) return Promise.resolve();
    return api('/api/v1/ssh/connections/' + encodeURIComponent(name) + '/host-key/forget', {
      method: 'POST'
    }).then(function () {
      delete hostKeyPrompts[name];
      showMessage(name + ' 的旧主机密钥已移除，正在重试', 'ok');
      var conn = null;
      for (var i = 0; i < knownConnections.length; i++) {
        if (knownConnections[i].name === name) conn = knownConnections[i];
      }
      if (conn === null) return undefined;
      return prompt.retry === 'test' ? testConnection(conn) : connectConnection(conn);
    });
  }

  function hostKeyPromptRow(conn, prompt) {
    var tr = document.createElement('tr');
    tr.className = 'host-key-row';
    var td = document.createElement('td');
    td.colSpan = 6;
    var box = document.createElement('div');
    box.className = 'host-key-box';
    var title = document.createElement('p');
    title.className = 'host-key-title';
    title.textContent = '警告：' + targetText(conn) + ' 的主机密钥已变更';
    box.appendChild(title);
    var explain = document.createElement('p');
    explain.className = 'muted';
    explain.textContent = '服务器可能重装过系统或轮换了主机密钥，但也可能是中间人攻击（man-in-the-middle attack）。信任新密钥前，请与服务器管理员核实指纹。';
    box.appendChild(explain);
    var details = prompt.details;
    if (details !== null) {
      if (details.fingerprint) {
        var presented = document.createElement('p');
        presented.className = 'mono';
        presented.textContent = '新密钥指纹：' + details.fingerprint + (details.key_type ? '（' + details.key_type + '）' : '');
        box.appendChild(presented);
      }
      if (details.expected_fingerprint) {
        var expected = document.createElement('p');
        expected.className = 'mono';
        expected.textContent = '此前信任的指纹：' + details.expected_fingerprint;
        box.appendChild(expected);
      }
      if (details.known_hosts_file) {
        var knownHosts = document.createElement('p');
        knownHosts.className = 'mono muted';
        knownHosts.textContent = '保存于 ' + details.known_hosts_file + (details.known_hosts_line ? '（第 ' + details.known_hosts_line + ' 行）' : '');
        box.appendChild(knownHosts);
      }
    }
    var buttons = document.createElement('div');
    buttons.className = 'row-actions';
    var cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.textContent = '取消';
    cancel.addEventListener('click', function () {
      delete hostKeyPrompts[conn.name];
      dismissedHostKey[conn.name] = true;
      refresh(true);
    });
    var retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'primary';
    retry.textContent = '移除旧密钥并重试';
    retry.addEventListener('click', function () {
      retry.disabled = true;
      cancel.disabled = true;
      forgetHostKeyAndRetry(conn.name).catch(function (error) {
        showMessage(error.message, 'error');
      }).finally(function () {
        refresh(true);
      });
    });
    buttons.appendChild(retry);
    buttons.appendChild(cancel);
    box.appendChild(buttons);
    td.appendChild(box);
    tr.appendChild(td);
    return tr;
  }

  function testConnection(conn) {
    return api('/api/v1/ssh/connections/' + encodeURIComponent(conn.name) + '/test', { method: 'POST' }).then(function (result) {
      if (!result.ok && result.needs_password) {
        openPasswordPrompt(conn.name, result.error || '需要密码');
        return;
      }
      showMessage(result.ok ? ('测试通过：' + (result.platform || '未知平台') + (result.server_running ? '，服务器运行中' : '')) : ('测试失败：' + (result.error || '未知错误')), result.ok ? 'ok' : 'error');
    }).catch(function (error) {
      if (error.code === SSH_HOST_KEY_CHANGED) {
        openHostKeyPrompt(conn.name, error.details, 'test');
        return;
      }
      if (error.code === SSH_AUTH_REQUIRED) {
        openPasswordPrompt(conn.name, error.message);
        return;
      }
      throw error;
    });
  }

  function connectConnection(conn) {
    return api('/api/v1/ssh/connections/' + encodeURIComponent(conn.name) + '/connect', { method: 'POST' }).then(function () {
      showMessage('已连接：' + conn.name, 'ok');
    }).catch(function (error) {
      if (error.code === SSH_HOST_KEY_CHANGED) {
        openHostKeyPrompt(conn.name, error.details, 'connect');
        return;
      }
      if (error.code === SSH_AUTH_REQUIRED) {
        openPasswordPrompt(conn.name, error.message);
        return;
      }
      throw error;
    });
  }

  function actionButton(label, onClick, kind) {
    var button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    if (kind !== undefined) button.className = kind;
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
        download.textContent = '下载';
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
    var input = window.prompt('在 ' + state.path + ' 下新建文件夹');
    if (input === null) return;
    var name = input.trim();
    if (name === '' || name.indexOf('/') >= 0) {
      showMessage('文件夹名称必须是单级路径段', 'error');
      return;
    }
    remoteApi(consoleConnection, '/fs:mkdir', {
      method: 'POST',
      body: { path: state.path + '/' + name }
    }).then(function () {
      showMessage('文件夹已创建：' + name, 'ok');
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
      showMessage('文件过大：上传大小限制为 10 MiB', 'error');
      return;
    }
    file.arrayBuffer().then(function (buffer) {
      return remoteApi(consoleConnection, '/fs:content?path=' + encodeURIComponent(state.path + '/' + file.name), {
        method: 'PUT',
        rawBody: buffer
      });
    }).then(function () {
      showMessage('已上传：' + file.name, 'ok');
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
          throw new Error(envelope.msg || ('下载失败，状态码 ' + res.status));
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
      if (!conn.status.host_key) delete dismissedHostKey[conn.name];
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
      badge.textContent = stateText(conn.status.state);
      stateTd.appendChild(badge);
      if (conn.status.needs_password) {
        stateTd.appendChild(document.createTextNode(' '));
        var needsBadge = document.createElement('span');
        needsBadge.className = 'state state-needs-password';
        needsBadge.textContent = '需要密码';
        stateTd.appendChild(needsBadge);
      }
      if (hostKeyPrompts[conn.name] !== undefined) {
        stateTd.appendChild(document.createTextNode(' '));
        var hostKeyBadge = document.createElement('span');
        hostKeyBadge.className = 'state state-host-key';
        hostKeyBadge.textContent = '主机密钥已变更';
        stateTd.appendChild(hostKeyBadge);
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
        return testConnection(conn);
      }));
      actions.appendChild(actionButton('Connect', function () {
        return connectConnection(conn);
      }));
      actions.appendChild(actionButton('Disconnect', function () {
        return api('/api/v1/ssh/connections/' + encodeURIComponent(conn.name) + '/disconnect', { method: 'POST' }).then(function () {
          showMessage('已断开：' + conn.name, 'ok');
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
        actions.appendChild(actionButton('输入密码', function () {
          openPasswordPrompt(conn.name, null);
          return Promise.resolve();
        }));
      }
      if (conn.has_password) {
        actions.appendChild(actionButton('忘记密码', function () {
          return api('/api/v1/ssh/connections/' + encodeURIComponent(conn.name) + '/password', { method: 'DELETE' }).then(function () {
            showMessage('已清除保存的密码：' + conn.name, 'ok');
          });
        }));
      }
      actions.appendChild(actionButton('删除', function () {
        if (!window.confirm('确定删除连接 ' + conn.name + ' 吗？该连接已保存的密码也会一并移除。')) {
          return Promise.resolve();
        }
        return api('/api/v1/ssh/connections/' + encodeURIComponent(conn.name), { method: 'DELETE' }).then(function () {
          delete passwordPrompts[conn.name];
          delete hostKeyPrompts[conn.name];
          showMessage('已删除：' + conn.name, 'ok');
        });
      }, 'danger'));
      actionsTd.appendChild(actions);
      tr.appendChild(actionsTd);
      rows.appendChild(tr);
      if (conn.status.needs_password && passwordPrompts[conn.name] === undefined && !dismissedPrompts[conn.name]) {
        passwordPrompts[conn.name] = { error: null, prefill: null };
      }
      if (conn.status.host_key && hostKeyPrompts[conn.name] === undefined && !dismissedHostKey[conn.name]) {
        hostKeyPrompts[conn.name] = { details: conn.status.host_key, retry: 'connect' };
      }
      if (passwordPrompts[conn.name] !== undefined) {
        rows.appendChild(passwordPromptRow(conn, passwordPrompts[conn.name]));
      }
      if (hostKeyPrompts[conn.name] !== undefined) {
        rows.appendChild(hostKeyPromptRow(conn, hostKeyPrompts[conn.name]));
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
        showMessage('已添加：' + body.name, 'ok');
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
