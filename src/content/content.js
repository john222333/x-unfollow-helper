// x.com 内容脚本：替后台在已登录的页面里调用 X 接口、读取关注列表，在发推框和推文上加「体检」按钮。
(function () {
  'use strict';
  // 插件更新后会把脚本重新注入到已打开的页面。旧脚本这时已经失效，由新脚本接管。
  const runtime = chrome.runtime;
  const alive = () => { try { return !!(runtime && runtime.id); } catch { return false; } };
  if (window.__xaContent && window.__xaContent.alive()) return;
  if (window.__xaContent) { try { window.__xaContent.retire(); } catch { /* 忽略 */ } }
  const INST = Math.random().toString(36).slice(2, 10);
  let observer = null;
  window.__xaContent = {
    alive,
    retire: () => { if (observer) observer.disconnect(); },
  };

  const D = window.XADom;
  const XAPI = window.XAPI;
  const send = (msg) => window.XAPanel.send(msg);

  // ---------- 在页面里调用 X 接口 ----------
  // 从这个页面发出的请求和网页版自己的请求一样：同源、自动带上登录 cookie。
  function cookie(name) {
    const m = new RegExp(`(?:^|;\\s*)${name}=([^;]*)`).exec(document.cookie);
    return m ? decodeURIComponent(m[1]) : null;
  }

  async function apiFetch(req) {
    const csrf = cookie('ct0');
    if (!csrf) return { status: 0, error: 'no_csrf' };
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
    const twid = cookie('twid') || '';
    const m = /u=(\d+)/.exec(twid);
    return {
      handle: D.currentHandle(),
      loggedOut: D.loggedOut(),
      userId: m ? m[1] : null,
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
    showBadge('X 助手正在读取关注列表… 请保持这个窗口打开');
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
      showBadge(`X 助手正在读取关注列表… 已读取 ${seen.size} 个`);
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
      const verb = msg.action === 'follow' ? '重新关注' : '取关';
      showBadge(`X 助手：正在${msg.dryRun ? '演练' : ''}${verb} @${msg.handle}`, false);
      D.act(msg).then(sendResponse, (e) => sendResponse({ result: 'error', detail: e.message }));
      return true;
    }
    return false;
  });

  // ---------- 告诉后台当前登录的是谁 ----------
  setTimeout(() => {
    const handle = D.currentHandle();
    if (handle) send({ type: 'xa:me', handle }).catch(() => {});
  }, 3000);

  // ---------- 体检按钮 ----------
  let ui = { composeButton: true, tweetButtons: true };
  chrome.storage.local.get('settings').then(({ settings }) => {
    if (settings && settings.ui) ui = { ...ui, ...settings.ui };
    scan();
  });
  chrome.storage.onChanged.addListener((changes) => {
    if (changes.settings && changes.settings.newValue) {
      ui = { ...ui, ...(changes.settings.newValue.ui || {}) };
      document.querySelectorAll('.xa-check-btn').forEach((b) => b.remove());
      document.querySelectorAll('[data-xa-done]').forEach((e) => e.removeAttribute('data-xa-done'));
      scan();
    }
  });

  function makeButton(title) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'xa-check-btn';
    b.dataset.xaInst = INST;
    b.textContent = '体检';
    b.title = title;
    b.style.cssText = 'border:1px solid rgba(29,155,240,.5);color:rgb(29,155,240);background:transparent;border-radius:999px;'
      + 'font:600 12px -apple-system,"PingFang SC",sans-serif;padding:2px 10px;margin:0 6px;cursor:pointer;height:26px;align-self:center';
    return b;
  }

  // 写推文时按钮上实时显示本地规则算出的 AI 味，不用点开就能看到。
  function liveLabel(btn, text) {
    const t = (text || '').trim();
    if (!t) { btn.textContent = '体检'; btn.style.color = 'rgb(29,155,240)'; return; }
    const score = window.XARules.analyze(t).score;
    btn.textContent = `体检 · AI味 ${score}`;
    btn.style.color = score >= 60 ? 'rgb(244,33,46)' : score >= 30 ? 'rgb(255,173,31)' : 'rgb(0,186,124)';
  }
  let liveTimer = null;
  document.addEventListener('input', (e) => {
    const ed = e.target && e.target.closest && e.target.closest('[data-testid^="tweetTextarea_"]');
    if (!ed || !ui.composeButton) return;
    clearTimeout(liveTimer);
    liveTimer = setTimeout(() => {
      let node = ed;
      for (let i = 0; i < 14 && node; i++, node = node.parentElement) {
        const btn = node.querySelector && node.querySelector(`[data-testid="toolBar"] .xa-check-btn[data-xa-inst="${INST}"]`);
        if (btn) { liveLabel(btn, ed.innerText); return; }
      }
    }, 400);
  }, true);

  function scan() {
    if (!alive()) { if (observer) observer.disconnect(); return; }
    // 旧版本脚本留下的按钮已经失效，换成新的。
    document.querySelectorAll(`.xa-check-btn:not([data-xa-inst="${INST}"])`).forEach((b) => b.remove());
    if (ui.composeButton) {
      document.querySelectorAll(`[data-testid="toolBar"]:not([data-xa-done="${INST}"])`).forEach((bar) => {
        bar.setAttribute('data-xa-done', INST);
        const btn = makeButton('检查这条推文的 AI 味和算法友好度');
        btn.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          const editor = D.composeEditorFor(bar);
          const text = editor ? editor.innerText.trim() : '';
          if (!text) { btn.textContent = '先写点内容'; setTimeout(() => { btn.textContent = '体检'; }, 1500); return; }
          window.XAPanel.open({ text, floating: true, onReplace: (t) => D.replaceEditorText(D.composeEditorFor(bar) || editor, t) });
        });
        const list = bar.querySelector('[data-testid="ScrollSnap-List"]');
        (list || bar).appendChild(btn);
      });
    }
    if (ui.tweetButtons) {
      document.querySelectorAll(`article[data-testid="tweet"]:not([data-xa-done="${INST}"])`).forEach((article) => {
        const group = article.querySelector('[role="group"]');
        if (!group) return;
        article.setAttribute('data-xa-done', INST);
        if (!D.tweetText(article)) return;
        const btn = makeButton('检查这条推文的 AI 味');
        btn.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          window.XAPanel.open({ text: D.tweetText(article), floating: true });
        });
        group.appendChild(btn);
      });
    }
  }

  let pending = false;
  observer = new MutationObserver(() => {
    if (pending) return;
    pending = true;
    setTimeout(() => { pending = false; scan(); }, 600);
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
})();
