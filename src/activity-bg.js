// Service worker 里的「多久没发推」检查：记下每个关注对象最近一次发帖的时间。
// 由 background.js 用 importScripts 载入，借用它的 store、openInWorker、currentAccount 等工具。
// 只读取，不取关：结果写进关注列表，你在管理页按「多久没发推」筛选后自己决定取关谁。
//
// 怎么查：在插件的后台标签页里像你自己一样打开对方主页，旁听页面自己加载的资料和推文，插件不额外发请求。
// （X 的推文接口要求带网页自己生成的校验，插件直接调用会被拒绝（404）；插件也不去仿造这种校验。）
// 你平时在首页、列表里刷到的帖子也会顺带记下作者的发帖时间，一个月内发过帖的人就不用再开主页。
// 节奏按正常浏览来：每个主页间隔十几秒、每看几十个休息几分钟、每天有上限，取关进行时让路。
(function () {
  'use strict';

  const FLUSH_EVERY = 10; // 攒够这么多人的结果写一次存储，免得管理页频繁重绘
  const FLUSH_MS = 20000;
  const FAIL_STOP = 5; // 连续这么多个主页都没读到数据就停下
  const EMPTY_STOP = 8; // 连续这么多人都「看不到推文」，不像真实情况：停下，不记这些结果
  const GAP_MS = [9000, 18000]; // 两个主页之间的间隔
  const REST_EVERY = [30, 45]; // 看这么多个主页后休息一会儿
  const REST_MS = [4 * 60000, 9 * 60000];
  const DAILY_CAP = 600; // 每天最多打开这么多个主页，剩下的第二天自动接着查
  const LOAD_WAIT_MS = 20000; // 主页加载完后最多再等这么久拿数据
  const RATE_WAIT_MS = 20 * 60000; // 页面被 X 限制频率时等多久
  // 端到端测试里可以通过 self.XAActivityPace 调快节奏。
  const pace = () => ({ gap: GAP_MS, restEvery: REST_EVERY, restMs: REST_MS, dailyCap: DAILY_CAP, loadWait: LOAD_WAIT_MS, ...(self.XAActivityPace || {}) });

  const lock = makeLock();
  const runs = new Set();
  const waiters = new Map(); // 账号 ID 或 @用户名 → 等主页数据的回调
  let visiting = false; // 正在后台标签页里打开某个主页（这时取关任务先等一下，免得抢同一个标签页）

  const rand = (lo, hi) => lo + Math.random() * (hi - lo);

  async function getActivity() {
    const { activity } = await store.get('activity');
    return activity || null;
  }

  const setActivity = (patch) => lock(async () => {
    const a = await getActivity();
    if (!a || a.runId !== patch.runId || a.status !== 'running') return false;
    await store.set({ activity: { ...a, ...patch } });
    return true;
  });

  const endActivity = (runId, status, message) => lock(async () => {
    const a = await getActivity();
    if (!a || a.runId !== runId) return;
    await store.set({ activity: { ...a, status, message, waitingUntil: 0, endedAt: Date.now() } });
  });

  // 要检查的人：不在白名单、没检查过或结果过期。最早关注的人先查（更可能已经不发推了）。
  function candidates(users, whitelist, now) {
    return Object.values(users || {})
      .filter((u) => !(whitelist && whitelist[u.key]) && S.needsActivityCheck(u, now))
      .sort((a, b) => (b.seq || 0) - (a.seq || 0));
  }

  async function start() {
    const collect = await getCollect();
    if (collect && collect.status === 'running') throw new Error('正在读取关注列表，读完后再检查。');
    const current = await getActivity();
    if (current && current.status === 'running') return { total: current.total, running: true };
    const { users, whitelist, owner } = await store.get(['users', 'whitelist', 'owner']);
    if (!users || !Object.keys(users).length) throw new Error('先点「读取关注列表」，再检查多久没发推。');
    const todo = candidates(users, whitelist, Date.now());
    const runId = `act-${Date.now()}`;
    if (!todo.length) {
      await store.set({ activity: { status: 'done', runId, startedAt: Date.now(), endedAt: Date.now(), total: 0, done: 0, message: '两周内都检查过了，不用重新检查' } });
      return { total: 0 };
    }
    // 每天的上限跨轮次累计：停下再点「检查」不会重新算。
    const day = S.dayKey();
    const visitsToday = current && current.day === day ? current.visitsToday || 0 : 0;
    await store.set({
      activity: {
        status: 'running', runId, startedAt: Date.now(), lastProgressAt: Date.now(), total: todo.length, done: 0,
        userId: (owner && owner.userId) || null, waitingUntil: 0, day, visitsToday, sinceRest: 0, message: '正在后台检查…',
      },
    });
    run(runId).catch((e) => console.error('[X 取关助手] 检查发推时间出错', e));
    await kick();
    return { total: todo.length };
  }

  async function stop(message) {
    const a = await getActivity();
    if (!a || a.status !== 'running') return { ok: true };
    await endActivity(a.runId, 'stopped', message || `已停止，检查了 ${a.done || 0} 人，结果已保存`);
    await closeWorkerIfIdle();
    return { ok: true };
  }

  // 把攒下的结果写进关注列表。只更新还在列表里的人（检查期间被取关的人不会被加回来）。
  const flush = (buffer) => withLock(async () => {
    const keys = Object.keys(buffer);
    if (!keys.length) return;
    const { users } = await store.get('users');
    const map = users || {};
    for (const k of keys) {
      if (map[k]) map[k] = { ...map[k], ...buffer[k] };
      delete buffer[k];
    }
    await store.set({ users: map });
  });

  // 在后台标签页里打开某人的主页，等页面自己加载出资料和推文。
  // 先开「回复」页（回复也算发帖），没等到数据再开普通主页。
  // 页面数据没旁听到时，直接看页面上显示的推文时间。
  // 返回 { state, lastAt, userId? } | { rate: true } | { wrongAccount: true } | { fail: 原因 }
  async function visit(u) {
    const handle = String(u.handle).toLowerCase();
    const keys = [u.id ? String(u.id) : null, `@${handle}`].filter(Boolean);
    let why = '页面没有加载出数据';
    for (const path of [`${u.handle}/with_replies`, u.handle]) {
      let resolve;
      const got = new Promise((r) => { resolve = r; });
      keys.forEach((k) => waiters.set(k, resolve));
      let timer = null;
      visiting = true;
      try {
        let tabId = null;
        try {
          tabId = await openInWorker(`https://x.com/${path}`);
        } catch (e) {
          why = `主页打开超时（${e.message}）`;
        }
        timer = setTimeout(() => resolve(null), pace().loadWait);
        const r = await got;
        if (r) return r;
        if (tabId) {
          const dom = await sendToTab(tabId, { type: 'xa:profileTimes', handle }, 15000).catch(() => null);
          if (dom && dom.state) return dom;
          const info = await sendToTab(tabId, { type: 'xa:pageInfo' }, 5000).catch(() => null);
          if (info && info.loggedOut) return { fail: 'x.com 没有登录' };
          why = info ? `主页上没找到 @${u.handle} 的推文` : '插件没能连上这个页面';
        }
      } finally {
        clearTimeout(timer);
        for (const [k, v] of waiters) if (v === resolve) waiters.delete(k);
        visiting = false;
      }
      await sleep(rand(...pace().gap) / 3);
    }
    return { fail: why };
  }

  // 后台取关正在处理一批时不检查：两边会抢同一个后台标签页。批次之间休息时照常检查。
  async function jobBusy() {
    const job = await getJob();
    return job.status === 'running' && !!(job.current || (job.batch && job.batch.length));
  }

  async function run(runId) {
    if (runs.has(runId)) return;
    runs.add(runId);
    const buffer = {};
    let lastFlush = Date.now();
    // 先暂停的话，返回时要不要关掉后台标签页。
    const pauseUntil = async (until, message) => {
      await flush(buffer);
      await setActivity({ runId, waitingUntil: until, lastProgressAt: Date.now(), message });
      await closeWorkerIfIdle();
      await kick();
    };
    try {
      const acct = await currentAccount(true);
      if (acct.loggedOut) throw new Error('x.com 没有登录，请先在 Chrome 里登录 x.com。');
      const { owner } = await store.get('owner');
      const ownerId = (owner && owner.userId) || null;
      if (ownerId && acct.userId && String(acct.userId) !== String(ownerId)) {
        throw new Error(`关注列表是 @${owner.handle} 的，现在 x.com 登录的是 @${acct.handle || acct.userId}。请切回 @${owner.handle} 再检查。`);
      }

      let fails = 0;
      let lastFail = '';
      let emptyRun = []; // 连续「看不到推文」的人
      const skip = new Set(); // 这一轮里一直拿不到数据的人，先跳过
      const tries = {};

      for (;;) {
        const a = await getActivity();
        if (!a || a.runId !== runId || a.status !== 'running') return;
        const collect = await getCollect();
        if (collect && collect.status === 'running') {
          // 读取关注列表时不检查：换账号读取会清空列表，检查结果写回去也没有意义。
          await pauseUntil(Date.now() + 60000, '等关注列表读完再继续');
          return;
        }
        if (await jobBusy()) {
          await pauseUntil(Date.now() + 60000, '取关正在进行，这一批结束后接着检查');
          return;
        }
        const P = pace();
        const now = Date.now();
        const day = S.dayKey(now);
        const visitsToday = a.day === day ? a.visitsToday || 0 : 0;
        if (visitsToday >= P.dailyCap) {
          const d = new Date(now);
          d.setHours(24, 0, 0, 0);
          const until = d.getTime() + rand(20, 60) * 60000;
          await pauseUntil(until, `今天已经查了 ${P.dailyCap} 个主页，为了像正常浏览一样，${new Date(until).toLocaleString()} 自动接着查`);
          return;
        }
        if ((a.sinceRest || 0) >= (a.restAfter || P.restEvery[0])) {
          const until = now + rand(...P.restMs);
          await setActivity({ runId, sinceRest: 0, restAfter: Math.round(rand(...P.restEvery)) });
          await pauseUntil(until, `已检查 ${a.done || 0} 人，休息一会儿，${new Date(until).toLocaleTimeString()} 接着查`);
          return;
        }

        const { users, whitelist } = await store.get(['users', 'whitelist']);
        const todo = candidates(users, whitelist, now).filter((u) => !buffer[u.key] && !skip.has(u.key) && u.handle);
        if (!todo.length) {
          await flush(buffer);
          await endActivity(runId, 'done', '检查完了');
          await closeWorkerIfIdle();
          return;
        }
        const u = todo[0];
        await setActivity({ runId, day, visitsToday: visitsToday + 1, sinceRest: (a.sinceRest || 0) + 1, current: u.handle });
        const r = await visit(u);

        if (r && r.wrongAccount) throw new Error('x.com 上登录的账号变了，已停止。切回原来的账号后可以继续检查。');
        if (r && r.rate) {
          await pauseUntil(Date.now() + RATE_WAIT_MS, `X 提示看得太频繁，先停 ${RATE_WAIT_MS / 60000} 分钟，${new Date(Date.now() + RATE_WAIT_MS).toLocaleTimeString()} 自动接着查`);
          return;
        }
        if (!r || !r.state || r.state === 'bad') {
          fails += 1;
          lastFail = `@${u.handle}：${(r && r.fail) || '数据格式不对'}`;
          tries[u.key] = (tries[u.key] || 0) + 1;
          if (tries[u.key] >= 2) skip.add(u.key);
          if (fails >= FAIL_STOP) {
            throw new Error(`连续 ${fails} 个主页都没读到推文（最后一个 ${lastFail}），已停止，已检查的结果都保存了。请确认 x.com 能正常打开，稍后再点「检查」接着查。`);
          }
          await sleep(rand(...P.gap));
          continue;
        }
        fails = 0;
        const at = Date.now();
        buffer[u.key] = { activity: r.state, lastTweetAt: r.lastAt || 0, activityAt: at, activityApprox: false };
        if (!u.id && r.userId) buffer[u.key].id = String(r.userId);
        if (r.state === 'empty' && u.tweets > 0) {
          emptyRun.push(u.key);
          if (emptyRun.length >= EMPTY_STOP) {
            // 有推文的人连续都读不到推文，多半是页面结构变了：这些结果不记，免得被当成不活跃取关掉。
            for (const k of emptyRun) delete buffer[k];
            throw new Error(`连续 ${EMPTY_STOP} 个人都读不到推文，可能是 X 改版了，已停止，这些人没有被标记。`);
          }
        } else {
          emptyRun = [];
        }
        const done = (a.done || 0) + 1;
        const left = Math.max(0, todo.length - 1);
        const per = (P.gap[0] + P.gap[1]) / 2 + 6000 + (P.restMs[0] + P.restMs[1]) / 2 / ((P.restEvery[0] + P.restEvery[1]) / 2);
        const etaMin = Math.ceil((left * per) / 60000);
        const days = Math.floor(left / P.dailyCap);
        const etaText = !left ? '' : days ? `，每天最多查 ${P.dailyCap} 人，大约还要 ${days + 1} 天` : etaMin > 90 ? `，预计还要约 ${Math.round(etaMin / 60)} 小时` : `，预计还要约 ${Math.max(1, etaMin)} 分钟`;
        await setActivity({ runId, done, total: done + left, lastProgressAt: at, waitingUntil: 0, current: '', message: `已检查 ${done} 人，还剩 ${left} 人${etaText}` });
        if (Object.keys(buffer).length >= FLUSH_EVERY || at - lastFlush > FLUSH_MS) {
          await flush(buffer);
          lastFlush = Date.now();
        }
        await sleep(rand(...P.gap));
      }
    } catch (e) {
      await flush(buffer).catch(() => {});
      await endActivity(runId, 'error', e.message);
      await closeWorkerIfIdle();
    } finally {
      await flush(buffer).catch(() => {});
      runs.delete(runId);
    }
  }

  // 页面上旁听到某人的主页数据（内容脚本转来的）。插件正在等这个人就交给检查流程，
  // 否则是你自己点开的主页：第一页推文直接记下来（看不到推文的不记）。
  async function onProfileSeen(msg) {
    const { owner } = await store.get('owner');
    const ownerId = owner && owner.userId;
    const mine = msg.me && ownerId && String(msg.me) !== String(ownerId) ? { wrongAccount: true } : null;
    if (msg.op === 'UserByScreenName') {
      const w = waiters.get(`@${msg.handle}`);
      if (!w) return { ok: true };
      if (mine) w(mine);
      else if (msg.status === 429) w({ rate: true });
      else if (msg.unavailable) w({ state: 'unavailable', lastAt: 0 });
      // 顺便记下账号 ID：等会儿的推文时间线按 ID 对上（关注列表里没有 ID 的人也能对上）。
      else if (msg.userId && !waiters.has(String(msg.userId))) waiters.set(String(msg.userId), w);
      return { ok: true };
    }
    const w = waiters.get(String(msg.userId)) || (msg.page ? waiters.get(`@${msg.page}`) : null);
    if (w) {
      if (mine) w(mine);
      else if (msg.status === 429) w({ rate: true });
      else if (msg.first && msg.res && msg.res.state !== 'bad') w({ ...msg.res, userId: msg.userId });
      return { ok: true };
    }
    if (mine || !msg.first || !msg.res || msg.res.state !== 'ok') return { ok: true };
    await withLock(async () => {
      const { users } = await store.get('users');
      const u = users && (Object.values(users).find((x) => x.id === String(msg.userId)) || (msg.page && users[msg.page]));
      if (!u) return;
      users[u.key] = { ...u, id: u.id || String(msg.userId), activity: 'ok', lastTweetAt: msg.res.lastAt, activityAt: Date.now(), activityApprox: false };
      await store.set({ users });
    });
    return { ok: true };
  }

  // 首页、列表里刷到的帖子：更新作者的「最近发推」（只会让人显得更活跃）。
  async function onSeenPosts(msg) {
    const times = msg.times || {};
    if (!Object.keys(times).length) return { ok: true };
    await withLock(async () => {
      const { users } = await store.get('users');
      if (!users) return;
      const now = Date.now();
      let changed = false;
      for (const u of Object.values(users)) {
        const at = u.id && times[u.id];
        if (!at) continue;
        const patch = S.seenPostPatch(u, at, now);
        if (!patch) continue;
        users[u.key] = { ...u, ...patch };
        changed = true;
      }
      if (changed) await store.set({ users });
    });
    return { ok: true };
  }

  // 定时器调用：休息结束、限制解除了，或者 service worker 被浏览器回收过，接着查。
  async function resumeIfNeeded() {
    const a = await getActivity();
    if (!a || a.status !== 'running' || runs.has(a.runId)) return;
    if (a.waitingUntil && Date.now() < a.waitingUntil) return;
    run(a.runId).catch((e) => console.error('[X 取关助手] 继续检查出错', e));
  }

  // 正在后台标签页里开主页，或者马上要开（取关任务先让一下）。
  const busy = () => visiting;

  async function handle(msg) {
    switch (msg.type) {
      case 'xa:activityStart':
        return start();
      case 'xa:activityStop':
        return stop();
      case 'xa:profileSeen':
        return onProfileSeen(msg);
      case 'xa:seenPosts':
        return onSeenPosts(msg);
      default:
        return { error: `unknown message ${msg.type}` };
    }
  }

  self.XAActivityBG = { handle, resumeIfNeeded, getActivity, stop, busy, runningNow: () => runs.size > 0 };
})();
