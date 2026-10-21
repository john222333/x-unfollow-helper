// x.com 页面的读取与操作。X 改版时通常只需要改这个文件里的选择器。
(function (root) {
  'use strict';

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const rand = (lo, hi) => lo + Math.random() * (hi - lo);
  const humanPause = (lo = 400, hi = 1200) => sleep(rand(lo, hi));

  // 等页面出现某个状态。除了定时检查，页面一有变化也立刻检查：
  // 工作窗口在后台时浏览器会放慢定时器，只靠定时检查可能等很久。
  function waitFor(fn, timeoutMs = 15000, interval = 250) {
    return new Promise((resolve) => {
      let finished = false;
      let observer = null;
      let poll = null;
      let timer = null;
      const finish = (v) => {
        if (finished) return;
        finished = true;
        if (observer) observer.disconnect();
        clearInterval(poll);
        clearTimeout(timer);
        resolve(v);
      };
      const check = () => {
        if (finished) return;
        let v = null;
        try { v = fn(); } catch { v = null; }
        if (v) finish(v);
      };
      check();
      if (finished) return;
      observer = new MutationObserver(check);
      observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-testid'] });
      poll = setInterval(check, interval);
      timer = setTimeout(() => { check(); finish(null); }, timeoutMs);
    });
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

  // 当前登录的账号。桌面布局在左侧导航，找不到时返回 null（比如窗口太窄切成了手机布局）。
  function currentHandle() {
    const link = document.querySelector('a[data-testid="AppTabBar_Profile_Link"]');
    if (link) {
      const m = /^\/([A-Za-z0-9_]{1,15})\/?$/.exec(new URL(link.href, location.origin).pathname);
      if (m) return m[1];
    }
    const sw = document.querySelector('[data-testid="SideNav_AccountSwitcher_Button"]');
    const m2 = sw && /@([A-Za-z0-9_]{1,15})/.exec(sw.innerText || '');
    return m2 ? m2[1] : null;
  }

  function loggedOut() {
    if (currentHandle()) return false;
    return !!document.querySelector('[data-testid="loginButton"], [data-testid="signupButton"], a[href="/login"], a[href="/i/flow/login"]');
  }

  async function act({ action, id, dryRun, me, accountVerified }) {
    const blocker = detectBlocker();
    if (blocker) return { result: blocker };

    // 核对登录的账号，避免在别的账号上取关。
    const who = await waitFor(() => currentHandle() || (loggedOut() ? '-' : null), 8000);
    if (who === '-') return { result: 'auth', detail: 'x.com 没有登录' };
    if (who && me && who.toLowerCase() !== String(me).toLowerCase()) {
      return { result: 'wrong_account', detail: `现在登录的是 @${who}，关注列表是 @${me} 的` };
    }
    // 页面上找不到登录账号、也没法用 cookie 核对时，宁可不点。
    if (!who && !accountVerified) return { result: 'no_button', detail: '页面上找不到登录的账号，无法核对' };

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
    const v = await waitFor(() => currentHandle() || (loggedOut() ? '-' : null), 15000);
    if (v === '-') return { handle: null, loggedOut: true };
    return { handle: v || null, loggedOut: false };
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
    // 整个 UserCell 本身就是 role="button"，只排除它里面的按钮（关注按钮等）。
    const inInnerButton = (e) => {
      const b = e.closest('[role="button"], button');
      return !!b && b !== cell && cell.contains(b);
    };
    const texts = Array.from(cell.querySelectorAll('[dir="auto"]'))
      .filter((e) => !e.closest('a') && !inInnerButton(e) && !e.closest('[data-testid="userFollowIndicator"]'))
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

  function nearBottom() {
    const el = document.scrollingElement || document.documentElement;
    return el.scrollTop + window.innerHeight >= el.scrollHeight - 300;
  }

  function loadingMore() {
    return !!primaryColumn().querySelector('[role="progressbar"]');
  }

  // 只认 X 的「重试」按钮，不看整页文字：关注的人简介里也可能写着「出错了」。
  function loadError() {
    return Array.from(primaryColumn().querySelectorAll('[role="button"], button'))
      .some((b) => !b.closest('[data-testid="UserCell"]') && /^(retry|try again|重试|重新尝试)$/i.test((b.innerText || '').trim()));
  }

  root.XADom = {
    sleep, rand, waitFor, act, whoami, currentHandle, loggedOut, visibleUsers, parseGraphQLUsers: root.XAPI.parseGraphQLUsers, detectBlocker,
    nearBottom, loadingMore, loadError, primaryColumn,
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
