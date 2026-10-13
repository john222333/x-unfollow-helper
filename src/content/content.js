// x.com 内容脚本：响应后台指令（读取关注列表、取关），在发推框和推文上加「体检」按钮。
(function () {
  'use strict';
  if (window.__xaContentLoaded) return;
  window.__xaContentLoaded = true;

  const D = window.XADom;
  const send = (msg) => window.XAPanel.send(msg);

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
  });


  function showBadge(text) {
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
  }

  function hideBadge() {
    const el = document.getElementById('xa-collect-badge');
    if (el) el.remove();
  }

  async function collect(runId) {
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
      idle = newCount ? 0 : idle + 1;
      showBadge(`X 助手正在读取关注列表… 已读取 ${seen.size} 个`);
      if (rounds % 3 === 0) send({ type: 'xa:collect-progress', runId, seen: seen.size }).catch(() => {});

      const blocker = D.detectBlocker();
      if (blocker) { reason = `被 X 拦截（${blocker}）`; break; }
      if (D.loadError()) { reason = 'X 加载出错，已停止，可以稍后重试'; break; }
      if (idle >= 8 && D.nearBottom() && !D.loadingMore()) { complete = true; break; }
      if (idle >= 20) { reason = '长时间没有新内容，已停止'; break; }
      if (Date.now() - t0 > 40 * 60 * 1000) { reason = '超过 40 分钟，已停止'; break; }

      rounds++;
      window.scrollBy({ top: window.innerHeight * D.rand(0.6, 0.95), behavior: 'smooth' });
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
    if (msg.type === 'xa:whoami') {
      D.whoami().then((handle) => sendResponse({ handle }));
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
      D.act(msg).then(sendResponse, (e) => sendResponse({ result: 'error', detail: e.message }));
      return true;
    }
    return false;
  });

  // ---------- 告诉后台当前登录的是谁 ----------
  setTimeout(async () => {
    const link = document.querySelector('a[data-testid="AppTabBar_Profile_Link"]');
    if (!link) return;
    const m = /^\/([A-Za-z0-9_]{1,15})\/?$/.exec(new URL(link.href, location.origin).pathname);
    if (m) send({ type: 'xa:me', handle: m[1] }).catch(() => {});
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
    b.textContent = '体检';
    b.title = title;
    b.style.cssText = 'border:1px solid rgba(29,155,240,.5);color:rgb(29,155,240);background:transparent;border-radius:999px;'
      + 'font:600 12px -apple-system,"PingFang SC",sans-serif;padding:2px 10px;margin:0 6px;cursor:pointer;height:26px;align-self:center';
    return b;
  }

  function scan() {
    if (ui.composeButton) {
      document.querySelectorAll('[data-testid="toolBar"]:not([data-xa-done])').forEach((bar) => {
        bar.setAttribute('data-xa-done', '1');
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
      document.querySelectorAll('article[data-testid="tweet"]:not([data-xa-done])').forEach((article) => {
        const group = article.querySelector('[role="group"]');
        if (!group) return;
        article.setAttribute('data-xa-done', '1');
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
  new MutationObserver(() => {
    if (pending) return;
    pending = true;
    setTimeout(() => { pending = false; scan(); }, 600);
  }).observe(document.documentElement, { childList: true, subtree: true });
})();
