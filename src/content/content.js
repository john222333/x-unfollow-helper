// x.com 内容脚本：替后台在已登录的页面里调用 X 接口；接口不可用时在页面上读取关注列表、点关注按钮。
(function () {
  'use strict';
  // 插件更新后会把脚本重新注入到已打开的页面。旧脚本这时已经失效，由新脚本接管。
  const runtime = chrome.runtime;
  const alive = () => { try { return !!(runtime && runtime.id); } catch { return false; } };
  if (window.__xaContent && window.__xaContent.alive()) return;
  if (window.__xaContent) { try { window.__xaContent.retire(); } catch { /* 忽略 */ } }
  const INST = Math.random().toString(36).slice(2, 10);
  window.__xaContent = { alive, retire: () => {} };
  // 老版本在发推框和推文下加过「体检」按钮，这个功能已经去掉，清掉页面上残留的按钮。
  document.querySelectorAll('.xa-check-btn').forEach((b) => b.remove());

  const D = window.XADom;
  const XAPI = window.XAPI;
  const send = (msg) => window.XAMsg.send(msg);

  // ---------- 在页面里调用 X 接口 ----------
  // 从这个页面发出的请求和网页版自己的请求一样：同源、自动带上登录 cookie。
  function cookie(name) {
    const m = new RegExp(`(?:^|;\\s*)${name}=([^;]*)`).exec(document.cookie);
    return m ? decodeURIComponent(m[1]) : null;
  }

  // 当前登录账号的 ID（twid cookie 里的 u=...）。切换账号后 cookie 会立刻变。
  function loggedInUserId() {
    const m = /u=(\d+)/.exec(cookie('twid') || '');
    return m ? m[1] : null;
  }

  // 后台要求的账号和这个页面登录的账号不一致时，不发请求、不点按钮。
  // 读不到 cookie 时不在这里拦（没登录的话请求本身会失败），由后台按用户名核对。
  function accountMismatch(expectUserId) {
    const now = loggedInUserId();
    if (!expectUserId || !now || now === String(expectUserId)) return null;
    return { status: 0, error: 'wrong_account', userId: now };
  }

  async function apiFetch(req) {
    const csrf = cookie('ct0');
    if (!csrf) return { status: 0, error: 'no_csrf' };
    const wrong = accountMismatch(req.expectUserId);
    if (wrong) return wrong;
    const url = new URL(req.path, location.origin);
    for (const [k, v] of Object.entries(req.query || {})) url.searchParams.set(k, v);
    const headers = {
      authorization: `Bearer ${req.bearer || XAPI.WEB_BEARER}`,
      'x-csrf-token': csrf,
      'x-twitter-auth-type': 'OAuth2Session',
      'x-twitter-active-user': 'yes',
      'x-twitter-client-language': (document.documentElement.lang || 'en').toLowerCase(),
    };
    let body;
    if (req.form) {
      headers['content-type'] = 'application/x-www-form-urlencoded';
      body = new URLSearchParams(req.form).toString();
    }
    try {
      const res = await fetch(url.toString(), { method: req.method || 'GET', headers, body, credentials: 'include' });
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch { /* 不是 JSON */ }
      return {
        status: res.status,
        json,
        text: json ? undefined : text.slice(0, 300),
        rate: { remaining: res.headers.get('x-rate-limit-remaining'), reset: res.headers.get('x-rate-limit-reset') },
      };
    } catch (e) {
      return { status: 0, error: `network: ${e.message}` };
    }
  }

  function pageInfo() {
    return {
      handle: D.currentHandle(),
      loggedOut: D.loggedOut(),
      userId: loggedInUserId(),
      scripts: Array.from(document.scripts).map((x) => x.src).filter((src) => /\/client-web\/main\.[\w-]+\.js/.test(src)),
      visible: document.visibilityState,
    };
  }

  // ---------- 旁听到的关注列表数据 ----------
  const gqlUsers = [];
  let collecting = null;
  window.addEventListener('message', (ev) => {
    if (ev.source !== window || !ev.data || ev.data.source !== 'xa-hook') return;
    // 打开关注页时第一页数据在读取指令到达前就加载了，所以先缓存起来。
    if (ev.data.op === 'Following') {
      gqlUsers.push(...D.parseGraphQLUsers(ev.data.data));
      if (gqlUsers.length > 5000) gqlUsers.splice(0, gqlUsers.length - 5000);
    }
    if (ev.data.op === 'meta' && alive()) send({ type: 'xa:xmeta', meta: ev.data.meta }).catch(() => {});
  });
  // 本脚本加载前页面可能已经收到了第一页，让页面脚本把缓存的数据再发一遍。
  window.postMessage({ source: 'xa-content', op: 'replay' }, window.location.origin);


  function showBadge(text, withStop) {
    let el = document.getElementById('xa-collect-badge');
    if (!el) {
      el = document.createElement('div');
      el.id = 'xa-collect-badge';
      el.style.cssText = 'position:fixed;left:50%;top:12px;transform:translateX(-50%);z-index:2147483000;'
        + 'background:#0f1419;color:#fff;border-radius:999px;padding:8px 16px;font:14px -apple-system,"PingFang SC",sans-serif;'
        + 'box-shadow:0 4px 16px rgba(0,0,0,.25);display:flex;gap:12px;align-items:center';
      const span = document.createElement('span');
      const stop = document.createElement('button');
      stop.textContent = '停止';
      stop.style.cssText = 'border:0;border-radius:999px;padding:2px 10px;cursor:pointer';
      stop.onclick = () => { if (collecting) collecting.stop = 'manual'; };
      el.append(span, stop);
      document.documentElement.appendChild(el);
    }
    el.firstChild.textContent = text;
    el.lastChild.style.display = withStop === false ? 'none' : '';
  }

  function hideBadge() {
    const el = document.getElementById('xa-collect-badge');
    if (el) el.remove();
  }

  async function collect(runId) {
    try {
      await collectLoop(runId);
    } catch (e) {
      // 出错也要告诉后台，不然管理页会一直显示「读取中」。
      collecting = null;
      hideBadge();
      await send({ type: 'xa:collect-done', runId, complete: false, seen: 0, reason: `读取出错：${e.message}` }).catch(() => {});
    }
  }

  async function collectLoop(runId) {
    collecting = { runId, stop: false };
    const seen = new Set();
    const t0 = Date.now();
    let idle = 0;
    let rounds = 0;
    let complete = false;
    let reason = '';
    showBadge('X 取关助手正在读取关注列表… 请保持这个窗口打开');
    await D.waitFor(() => document.querySelector('[data-testid="UserCell"]'), 20000);

    while (!collecting.stop) {
      const batch = gqlUsers.splice(0).concat(D.visibleUsers());
      const fresh = [];
      for (const u of batch) {
        const k = u.handle.toLowerCase();
        if (u.source === 'graphql' || !seen.has(k)) fresh.push(u);
        seen.add(k);
      }
      if (fresh.length) {
        await send({ type: 'xa:users', users: fresh, runId }).catch(() => {});
      }
      const newCount = fresh.filter((u) => u.source === 'dom').length + fresh.filter((u) => u.source === 'graphql').length;
      // 窗口被挡住时浏览器不渲染页面，X 也就不加载下一页；这段时间不算「没有新内容」。
      const hidden = document.visibilityState === 'hidden';
      if (newCount) idle = 0;
      else if (!hidden) idle += 1;
      showBadge(`X 取关助手正在读取关注列表… 已读取 ${seen.size} 个`);
      if (rounds % 3 === 0 || hidden) send({ type: 'xa:collect-progress', runId, seen: seen.size, hidden }).catch(() => {});

      const blocker = D.detectBlocker();
      if (blocker) { reason = `被 X 拦截（${blocker}）`; break; }
      if (D.loadError()) { reason = 'X 加载出错，已停止，可以稍后重试'; break; }
      if (idle >= 8 && !hidden && D.nearBottom() && !D.loadingMore()) { complete = true; break; }
      if (idle >= 20) { reason = '长时间没有新内容，已停止'; break; }
      if (Date.now() - t0 > 40 * 60 * 1000) { reason = '超过 40 分钟，已停止'; break; }

      rounds++;
      // 不用平滑滚动：窗口在后台时平滑滚动可能根本不动。
      window.scrollBy({ top: window.innerHeight * D.rand(0.6, 0.95), behavior: 'instant' });
      await D.sleep(D.rand(1200, 2600));
      if (rounds % 25 === 0) await D.sleep(D.rand(4000, 8000));
    }
    if (collecting.stop === 'manual') reason = '你手动停止了';
    // 最后再收一次
    const tail = gqlUsers.splice(0).concat(D.visibleUsers()).filter((u) => u.source === 'graphql' || !seen.has(u.handle.toLowerCase()));
    tail.forEach((u) => seen.add(u.handle.toLowerCase()));
    if (tail.length) await send({ type: 'xa:users', users: tail, runId }).catch(() => {});
    const stoppedByBackground = collecting.stop === 'background';
    collecting = null;
    hideBadge();
    if (!stoppedByBackground) {
      await send({ type: 'xa:collect-done', runId, complete, seen: seen.size, reason }).catch(() => {});
    }
  }

  // ---------- 后台指令 ----------
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || !msg.type) return false;
    if (msg.type === 'xa:ping-page') {
      sendResponse({ ok: true, inst: INST, href: location.href });
      return false;
    }
    if (msg.type === 'xa:pageInfo') {
      sendResponse(pageInfo());
      return false;
    }
    if (msg.type === 'xa:api') {
      apiFetch(msg.req || {}).then(sendResponse);
      return true;
    }
    if (msg.type === 'xa:whoami') {
      D.whoami().then((r) => sendResponse(r), () => sendResponse({ handle: null }));
      return true;
    }
    if (msg.type === 'xa:collect') {
      if (!/\/following\/?$/.test(location.pathname)) {
        sendResponse({ started: false });
        return false;
      }
      if (!collecting) collect(msg.runId);
      sendResponse({ started: true });
      return false;
    }
    if (msg.type === 'xa:stopCollect') {
      if (collecting) collecting.stop = 'background';
      sendResponse({ ok: true });
      return false;
    }
    if (msg.type === 'xa:act') {
      if (accountMismatch(msg.expectUserId)) {
        sendResponse({ result: 'wrong_account', detail: '这个页面登录的账号和关注列表不一致' });
        return false;
      }
      const verb = msg.action === 'follow' ? '重新关注' : '取关';
      showBadge(`X 取关助手：正在${msg.dryRun ? '演练' : ''}${verb} @${msg.handle}`, false);
      const accountVerified = !!msg.expectUserId && loggedInUserId() === String(msg.expectUserId);
      D.act({ ...msg, accountVerified }).then(sendResponse, (e) => sendResponse({ result: 'error', detail: e.message }));
      return true;
    }
    return false;
  });

  // ---------- 告诉后台当前登录的是谁 ----------
  setTimeout(() => {
    const handle = D.currentHandle();
    if (handle) send({ type: 'xa:me', handle }).catch(() => {});
  }, 3000);
})();
