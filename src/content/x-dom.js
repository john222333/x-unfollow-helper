// x.com 页面的读取与操作。X 改版时通常只需要改这个文件里的选择器。
(function (root) {
  'use strict';

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const rand = (lo, hi) => lo + Math.random() * (hi - lo);
  const humanPause = (lo = 400, hi = 1200) => sleep(rand(lo, hi));

  async function waitFor(fn, timeoutMs = 15000, interval = 250) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      let v = null;
      try { v = fn(); } catch { v = null; }
      if (v) return v;
      if (Date.now() > deadline) return null;
      await sleep(interval);
    }
  }

  function primaryColumn() {
    return document.querySelector('[data-testid="primaryColumn"]') || document.body;
  }

  const FOLLOW_BTN = '[data-testid$="-follow"],[data-testid$="-unfollow"],[data-testid$="-cancel"]';

  function buttonState(btn) {
    const id = btn.getAttribute('data-testid') || '';
    if (id.endsWith('-unfollow')) return 'following';
    if (id.endsWith('-cancel')) return 'pending';
    if (id.endsWith('-follow')) return 'not_following';
    return 'unknown';
  }

  function buttonUserId(btn) {
    const id = btn.getAttribute('data-testid') || '';
    const m = /^(\d+)-(?:follow|unfollow|cancel)$/.exec(id);
    return m ? m[1] : null;
  }

  // 主页顶部的关注按钮（排除下方「你可能喜欢」等推荐卡片里的按钮）
  function headerButton() {
    const btns = Array.from(primaryColumn().querySelectorAll(FOLLOW_BTN));
    return btns.find((b) => !b.closest('[data-testid="UserCell"]')) || null;
  }

  function detectBlocker() {
    const path = location.pathname;
    if (/^\/(?:login|logout|i\/flow\/login|i\/flow\/signup)/.test(path)) return 'auth';
    if (/^\/account\/access/.test(path)) return 'locked';
    if (document.querySelector('iframe[src*="arkoselabs"], iframe[src*="captcha"], iframe[title*="challenge" i]')) return 'captcha';
    const toasts = Array.from(document.querySelectorAll('[data-testid="toast"], [role="alert"]'))
      .map((e) => e.innerText || '')
      .join(' ');
    if (/rate limit|try again later|too many|unable to (?:follow|unfollow)|稍后再试|频繁|无法(?:关注|取消关注)|已达到|上限/i.test(toasts)) {
      return 'rate_limited';
    }
    return null;
  }

  function profileGone() {
    const empty = document.querySelector('[data-testid="emptyState"]');
    if (!empty) return false;
    return /doesn.t exist|suspended|不存在|已被冻结|已被停用|暂停/i.test(primaryColumn().innerText || '');
  }

  async function act({ action, id, dryRun }) {
    const blocker = detectBlocker();
    if (blocker) return { result: blocker };

    const found = await waitFor(() => {
      const b = headerButton();
      if (b) return b;
      if (profileGone()) return 'gone';
      return detectBlocker();
    }, 20000);
    if (!found) return { result: 'no_button' };
    if (typeof found === 'string') return { result: found };

    const btn = found;
    const state = buttonState(btn);
    const pageId = buttonUserId(btn);
    if (id && pageId && String(id) !== pageId) {
      return { result: 'mismatch', detail: `队列里的 ID 是 ${id}，页面上是 ${pageId}` };
    }

    if (action === 'unfollow') {
      if (state !== 'following') return { result: 'already', id: pageId };
      if (dryRun) return { result: 'dry_run', id: pageId };
      await humanPause();
      btn.click();
      const confirm = await waitFor(() => document.querySelector('[data-testid="confirmationSheetConfirm"]'), 5000);
      if (confirm) {
        await humanPause(300, 900);
        confirm.click();
      }
      const outcome = await waitFor(() => {
        const bl = detectBlocker();
        if (bl) return bl;
        const b = headerButton();
        return b && buttonState(b) === 'not_following' ? 'ok' : null;
      }, 8000);
      return { result: outcome || detectBlocker() || 'not_applied', id: pageId };
    }

    // 重新关注（撤销）
    if (state === 'following' || state === 'pending') return { result: 'already', id: pageId };
    if (dryRun) return { result: 'dry_run', id: pageId };
    await humanPause();
    btn.click();
    const outcome = await waitFor(() => {
      const bl = detectBlocker();
      if (bl) return bl;
      const b = headerButton();
      if (!b) return null;
      const s = buttonState(b);
      return s === 'following' ? 'ok' : s === 'pending' ? 'pending' : null;
    }, 8000);
    return { result: outcome || detectBlocker() || 'not_applied', id: pageId };
  }

  async function whoami() {
    const link = await waitFor(() => document.querySelector('a[data-testid="AppTabBar_Profile_Link"]'), 15000);
    if (!link) return null;
    const m = /^\/([A-Za-z0-9_]{1,15})\/?$/.exec(new URL(link.href, location.origin).pathname);
    return m ? m[1] : null;
  }

  // ---------- 解析关注列表 ----------

  function parseUserCell(cell) {
    const links = Array.from(cell.querySelectorAll('a[href^="/"]'));
    let handle = null;
    for (const a of links) {
      const m = /^\/([A-Za-z0-9_]{1,15})\/?$/.exec(a.getAttribute('href') || '');
      if (m) { handle = m[1]; break; }
    }
    if (!handle) return null;
    const nameLink = links.find((a) => {
      const t = (a.innerText || '').trim();
      return t && !t.startsWith('@');
    });
    const btn = cell.querySelector(FOLLOW_BTN);
    const img = cell.querySelector('img[src*="profile_images"], img[src*="default_profile"]');
    const avatar = img ? img.src : undefined;
    const texts = Array.from(cell.querySelectorAll('[dir="auto"]'))
      .filter((e) => !e.closest('a') && !e.closest('[role="button"]') && !e.closest('[data-testid="userFollowIndicator"]'))
      .map((e) => (e.innerText || '').trim())
      .filter(Boolean);
    const state = btn ? buttonState(btn) : null;
    return {
      handle,
      id: btn ? buttonUserId(btn) || undefined : undefined,
      name: nameLink ? nameLink.innerText.trim().split('\n')[0] : undefined,
      bio: texts.length ? texts[texts.length - 1] : undefined,
      avatar,
      defaultAvatar: avatar ? /default_profile/.test(avatar) : undefined,
      followsYou: !!cell.querySelector('[data-testid="userFollowIndicator"]'),
      youFollow: state ? state === 'following' || state === 'pending' : undefined,
      verified: !!cell.querySelector('[data-testid="icon-verified"]') || undefined,
      protected: !!cell.querySelector('[data-testid="icon-lock"]') || undefined,
      source: 'dom',
    };
  }

  function visibleUsers() {
    return Array.from(primaryColumn().querySelectorAll('[data-testid="UserCell"]'))
      .map(parseUserCell)
      .filter(Boolean);
  }

  function fromGraphQLUser(o) {
    const L = o.legacy || {};
    const C = o.core || {};
    const R = o.relationship_perspectives || {};
    const handle = C.screen_name || L.screen_name;
    if (!handle) return null;
    const avatar = (o.avatar && o.avatar.image_url) || L.profile_image_url_https;
    const pick = (...vals) => vals.find((v) => v !== undefined && v !== null);
    return {
      id: String(o.rest_id),
      handle,
      name: pick(C.name, L.name),
      bio: pick(o.profile_bio && o.profile_bio.description, L.description),
      avatar,
      defaultAvatar: pick(L.default_profile_image, avatar ? /default_profile/.test(avatar) : undefined),
      followers: pick(L.followers_count),
      following: pick(L.friends_count),
      tweets: pick(L.statuses_count),
      followsYou: pick(R.followed_by, L.followed_by),
      youFollow: pick(R.following, L.following),
      verified: !!(o.is_blue_verified || (o.verification && o.verification.verified) || L.verified) || undefined,
      protected: pick(o.privacy && o.privacy.protected, L.protected),
      createdAt: pick(C.created_at, L.created_at),
      source: 'graphql',
    };
  }

  // 递归找出响应里所有 User 对象，对接口结构的小改动不敏感。
  function parseGraphQLUsers(data) {
    const out = [];
    const seen = new Set();
    (function walk(o, depth) {
      if (!o || typeof o !== 'object' || depth > 60) return;
      if (Array.isArray(o)) {
        for (const x of o) walk(x, depth + 1);
        return;
      }
      if (o.__typename === 'User' && o.rest_id) {
        const u = fromGraphQLUser(o);
        if (u && !seen.has(u.handle.toLowerCase())) {
          seen.add(u.handle.toLowerCase());
          out.push(u);
        }
        return;
      }
      for (const k of Object.keys(o)) walk(o[k], depth + 1);
    })(data, 0);
    return out;
  }

  function nearBottom() {
    const el = document.scrollingElement || document.documentElement;
    return el.scrollTop + window.innerHeight >= el.scrollHeight - 300;
  }

  function loadingMore() {
    return !!primaryColumn().querySelector('[role="progressbar"]');
  }

  function loadError() {
    const t = primaryColumn().innerText || '';
    return /Something went wrong|Try reloading|出错了|重试/i.test(t) && !!primaryColumn().querySelector('[role="button"]');
  }

  // 推文与发推框
  function tweetText(article) {
    const el = article.querySelector('[data-testid="tweetText"]');
    return el ? el.innerText.trim() : '';
  }

  function composeEditorFor(toolbar) {
    let node = toolbar;
    for (let i = 0; i < 10 && node; i++) {
      const ed = node.querySelector && node.querySelector('[data-testid^="tweetTextarea_"][contenteditable="true"], [data-testid^="tweetTextarea_"] [contenteditable="true"]');
      if (ed) return ed;
      node = node.parentElement;
    }
    return null;
  }

  async function replaceEditorText(editor, text) {
    editor.focus();
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(editor);
    sel.removeAllRanges();
    sel.addRange(range);
    // Draft.js 对粘贴事件的处理最稳定，能保留换行。
    try {
      const dt = new DataTransfer();
      dt.setData('text/plain', text);
      editor.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    } catch { /* 不支持就走下面的方法 */ }
    await sleep(300);
    const norm = (s) => s.replace(/\s+/g, '');
    if (norm(editor.innerText || '') === norm(text)) return true;
    editor.focus();
    document.execCommand('selectAll', false, null);
    document.execCommand('insertText', false, text);
    await sleep(200);
    return norm(editor.innerText || '') === norm(text);
  }

  root.XADom = {
    sleep, rand, waitFor, act, whoami, visibleUsers, parseGraphQLUsers, detectBlocker,
    nearBottom, loadingMore, loadError, tweetText, composeEditorFor, replaceEditorText, primaryColumn,
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
