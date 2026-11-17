/**
 * 记忆管理页面的 HTML。
 *
 * 为什么直接由网关托管一个页面：改动最小、不需要碰 App、也不依赖任何前端构建。
 * 手机浏览器打开就能看能删，正好补上"它到底记住了我什么"这个空白。
 *
 * 安全：整页要求网关令牌（HTTP Basic，密码即令牌）；页面自身没有任何外部资源，
 * 不带任何第三方脚本，所有请求都走同源的 /memory/api。
 */
export const MEMORY_ADMIN_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="dark light">
<title>记忆管理</title>
<style>
  :root { --bg:#14161a; --panel:#1d2026; --line:#2c313a; --ink:#e7eaf0; --muted:#8b93a1; --accent:#5b9dff; --danger:#ff6b6b; }
  @media (prefers-color-scheme: light) {
    :root { --bg:#f4f6fa; --panel:#ffffff; --line:#e2e6ee; --ink:#1e2229; --muted:#69707d; --accent:#2f6fe4; --danger:#d33; }
  }
  * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
  body { margin:0; background:var(--bg); color:var(--ink); font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif; }
  header { position:sticky; top:0; z-index:2; background:var(--bg); border-bottom:1px solid var(--line); padding:12px 14px; }
  h1 { margin:0 0 8px; font-size:17px; font-weight:600; }
  .stats { display:flex; gap:14px; flex-wrap:wrap; font-size:12px; color:var(--muted); }
  .stats b { color:var(--ink); font-weight:600; }
  .tabs { display:flex; gap:8px; padding:12px 14px 0; }
  .tab { flex:1; padding:9px 12px; border:1px solid var(--line); background:var(--panel); color:var(--muted); border-radius:10px; font-size:14px; cursor:pointer; }
  .tab.on { color:var(--ink); border-color:var(--accent); }
  main { padding:12px 14px 40px; }
  .row { display:flex; gap:8px; margin-bottom:12px; }
  input[type=search], input[type=text] { flex:1; min-width:0; padding:10px 12px; border-radius:10px; border:1px solid var(--line); background:var(--panel); color:var(--ink); font-size:15px; }
  button { border:1px solid var(--line); background:var(--panel); color:var(--ink); border-radius:10px; padding:10px 14px; font-size:14px; cursor:pointer; }
  button.primary { background:var(--accent); border-color:var(--accent); color:#fff; }
  button.danger { color:var(--danger); border-color:var(--danger); }
  .card { background:var(--panel); border:1px solid var(--line); border-radius:12px; padding:12px 14px; margin-bottom:10px; }
  .meta { display:flex; gap:10px; font-size:12px; color:var(--muted); margin-bottom:6px; flex-wrap:wrap; }
  .badge { background:var(--bg); border:1px solid var(--line); border-radius:6px; padding:1px 6px; font-size:11px; }
  .body { white-space:pre-wrap; word-break:break-word; font-size:14px; }
  .empty { color:var(--muted); text-align:center; padding:40px 0; font-size:14px; }
  .actions { display:flex; gap:8px; margin-top:10px; }
  .actions button { padding:6px 12px; font-size:13px; }
  .hitscore { font-variant-numeric:tabular-nums; }
  .note { font-size:12px; color:var(--muted); margin-bottom:12px; }
  .err { color:var(--danger); font-size:13px; }
</style>
</head>
<body>
<header>
  <h1>记忆管理</h1>
  <div class="stats" id="stats"><span>加载中…</span></div>
</header>

<section id="login" hidden>
  <div class="card">
    <div class="meta"><span class="badge">需要登录</span></div>
    <div class="note">填入网关令牌（就是 App 里 API Key 那一栏那串）。只存在本机浏览器里，不会上传。</div>
    <div class="row" style="margin-top:8px">
      <input type="password" id="tok" placeholder="网关令牌" autocomplete="off">
      <button class="primary" id="btnLogin" type="button">进入</button>
    </div>
    <div class="err" id="loginErr"></div>
  </div>
</section>

<div class="tabs">
  <button class="tab on" id="tabList" type="button">记忆列表</button>
  <button class="tab" id="tabRecall" type="button">召回测试</button>
</div>

<main>
  <section id="panelList">
    <div class="row">
      <input type="search" id="q" placeholder="搜索记忆内容…" autocomplete="off">
      <button id="btnRefresh" type="button">刷新</button>
    </div>
    <div class="note">只有「全局记忆」会话里<strong>你自己说的话</strong>会进这里（助手的回答不参与召回）。</div>
    <div id="list"><div class="empty">加载中…</div></div>
  </section>

  <section id="panelRecall" hidden>
    <div class="row">
      <input type="text" id="rq" placeholder="输入一句你会问的话…" autocomplete="off">
      <button class="primary" id="btnRecall" type="button">测试召回</button>
    </div>
    <div class="note">这里只显示「假如你问这句话会被召回什么」，不会真的发消息、也不会改动记忆。</div>
    <div id="recall"></div>
  </section>
</main>

<script>
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var TOKEN_KEY = 'dsh_memory_token';

  function readToken() {
    try { return localStorage.getItem(TOKEN_KEY) || ''; } catch (e) { return ''; }
  }
  function saveToken(value) {
    try { localStorage.setItem(TOKEN_KEY, value); } catch (e) {}
  }
  function clearToken() {
    try { localStorage.removeItem(TOKEN_KEY); } catch (e) {}
  }

  /**
   * 启动时优先读地址里的 #t=令牌。
   * 用 hash 而不是查询参数：hash 不会发送到服务器，也就不会进访问日志。
   * 读完之后立刻从地址栏抹掉，避免被截图或误分享。
   */
  function takeTokenFromHash() {
    var hash = location.hash || '';
    var match = hash.match(/(?:^#|&)t=([^&]+)/);
    if (!match) { return false; }
    var token = decodeURIComponent(match[1]);
    if (token) { saveToken(token); }
    try { history.replaceState(null, '', location.pathname); } catch (e) {}
    return !!token;
  }

  function api(path, options) {
    var init = options || {};
    init.headers = Object.assign({}, init.headers || {}, { 'x-api-key': readToken() });
    return fetch(path, init).then(function (r) {
      if (r.status === 401) { showLogin('令牌无效或已失效，请重新填写'); throw new Error('unauthorized'); }
      if (!r.ok) { throw new Error('HTTP ' + r.status); }
      return r.json();
    });
  }

  function showLogin(message) {
    $('login').hidden = false;
    $('loginErr').textContent = message || '';
    $('panelList').hidden = true;
    $('panelRecall').hidden = true;
  }

  function hideLogin() {
    $('login').hidden = true;
    $('panelList').hidden = $('tabRecall').classList.contains('on');
    $('panelRecall').hidden = !$('tabRecall').classList.contains('on');
  }

  function fmtDate(ms) {
    var d = new Date(ms);
    function p(n) { return n < 10 ? '0' + n : '' + n; }
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  function esc(text) {
    return String(text).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  function loadStats() {
    api('/memory/api/stats').then(function (s) {
      hideLogin();
      $('stats').innerHTML =
        '会话 <b>' + s.sessions + '</b>' +
        '　消息 <b>' + s.messages + '</b>' +
        '　可召回切片 <b>' + s.chunks + '</b>' +
        '　有使用痕迹 <b>' + s.usageRows + '</b>' +
        '　向量 <b>' + (s.vectors ? '已启用' : '未配置') + '</b>';
    }).catch(function (e) {
      if (e.message !== 'unauthorized') {
        $('stats').innerHTML = '<span class="err">状态读取失败：' + esc(e.message) + '</span>';
      }
    });
  }

  function loadList() {
    var q = encodeURIComponent($('q').value.trim());
    $('list').innerHTML = '<div class="empty">加载中…</div>';
    api('/memory/api/list?limit=200&q=' + q).then(function (data) {
      if (!data.items.length) {
        $('list').innerHTML = '<div class="empty">' + (q ? '没有匹配的记忆' : '还没有可召回的全局记忆') + '</div>';
        return;
      }
      var html = '';
      data.items.forEach(function (item) {
        html += '<div class="card" data-id="' + esc(item.id) + '">' +
          '<div class="meta">' +
            '<span class="badge">' + esc(fmtDate(item.createdAt)) + '</span>' +
            '<span class="badge">会话 ' + esc(item.sessionId.slice(0, 8)) + '</span>' +
            (item.hits > 0 ? '<span class="badge">被召回 ' + item.hits + ' 次</span>' : '') +
          '</div>' +
          '<div class="body">' + esc(item.body) + '</div>' +
          '<div class="actions"><button class="danger" data-del="' + esc(item.id) + '" type="button">删除这条</button></div>' +
        '</div>';
      });
      $('list').innerHTML = html;
    }).catch(function (e) {
      if (e.message !== 'unauthorized') {
        $('list').innerHTML = '<div class="empty err">读取失败：' + esc(e.message) + '</div>';
      }
    });
  }

  $('btnLogin').addEventListener('click', function () {
    var token = $('tok').value.trim();
    if (!token) { return; }
    saveToken(token);
    $('tok').value = '';
    loadStats();
    loadList();
  });
  $('tok').addEventListener('keydown', function (e) { if (e.key === 'Enter') { $('btnLogin').click(); } });

  $('list').addEventListener('click', function (event) {
    var id = event.target && event.target.getAttribute && event.target.getAttribute('data-del');
    if (!id) { return; }
    if (!confirm('删除这条记忆？删除后无法恢复。')) { return; }
    api('/memory/api/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [id] })
    }).then(function () { loadList(); loadStats(); })
      .catch(function (e) { if (e.message !== 'unauthorized') { alert('删除失败：' + e.message); } });
  });

  $('btnRefresh').addEventListener('click', function () { loadList(); loadStats(); });
  $('q').addEventListener('keydown', function (e) { if (e.key === 'Enter') { loadList(); } });

  $('btnRecall').addEventListener('click', function () {
    var q = $('rq').value.trim();
    if (!q) { return; }
    $('recall').innerHTML = '<div class="empty">检索中…</div>';
    api('/memory/api/recall?q=' + encodeURIComponent(q)).then(function (data) {
      if (!data.hits.length) {
        $('recall').innerHTML = '<div class="empty">没有任何记忆被召回<br><small>这种情况下会什么都不注入，让模型老实说不记得</small></div>';
        return;
      }
      // score 是 bm25 原始值（负数，越负越相关），直接显示会变成 -0.000 这种怪数字。
      // 统一换算成「同批结果内的相对强度百分比」。
      var maxAbs = 0;
      data.hits.forEach(function (hit) { maxAbs = Math.max(maxAbs, Math.abs(Number(hit.score))); });
      maxAbs = maxAbs > 0 ? maxAbs : 1;
      var html = '<div class="note">共召回 ' + data.hits.length + ' 条，会按下面顺序拼进提问。百分比是同批结果内的相对强度。</div>';
      data.hits.forEach(function (hit, i) {
        var abs = Math.abs(Number(hit.score));
        var label = abs < 0.001
          ? '<span class="badge">关键词匹配</span>'
          : '<span class="badge hitscore">' + Math.round(abs / maxAbs * 100) + '%</span>';
        html += '<div class="card">' +
          '<div class="meta">' +
            '<span class="badge">#' + (i + 1) + '</span>' +
            '<span class="badge">' + esc(fmtDate(hit.createdAt)) + '</span>' +
            '<span class="badge">会话 ' + esc(hit.sessionId.slice(0, 8)) + '</span>' +
            label +
          '</div>' +
          '<div class="body">' + esc(hit.body) + '</div>' +
        '</div>';
      });
      $('recall').innerHTML = html;
    }).catch(function (e) {
      if (e.message !== 'unauthorized') {
        $('recall').innerHTML = '<div class="empty err">检索失败：' + esc(e.message) + '</div>';
      }
    });
  });

  $('rq').addEventListener('keydown', function (e) { if (e.key === 'Enter') { $('btnRecall').click(); } });

  function switchTab(toRecall) {
    $('panelList').hidden = toRecall;
    $('panelRecall').hidden = !toRecall;
    $('tabList').classList.toggle('on', !toRecall);
    $('tabRecall').classList.toggle('on', toRecall);
  }
  $('tabList').addEventListener('click', function () { switchTab(false); });
  $('tabRecall').addEventListener('click', function () { switchTab(true); });

  takeTokenFromHash();
  if (!readToken()) {
    showLogin('');
    return;
  }
  loadStats();
  loadList();
})();
</script>
</body>
</html>`
