// Service worker 里的「多久没发推」检查：在后台一个个读取关注对象的推文时间线，记下 TA 最近一次发帖的时间。
// 由 background.js 用 importScripts 载入，借用它的 store、apiCall、currentAccount、getGqlOp 等工具。
// 只读取，不取关：结果写进关注列表，你在管理页按「多久没发推」筛选后自己决定取关谁。
(function () {
  'use strict';

  const FLUSH_EVERY = 10; // 攒够这么多人的结果写一次存储，免得管理页频繁重绘
  const FLUSH_MS = 20000;
  const FAIL_STOP = 5; // 连续这么多次请求失败就停下
  const EMPTY_STOP = 8; // 连续这么多人都「看不到推文」，多半是接口结构变了：停下，不记这些结果
  const OPS = ['UserTweetsAndReplies', 'UserTweets'];

  const lock = makeLock();
  const runs = new Set();

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

  // 读取推文时间线的接口：页面上记下来的优先，其次从 X 的前端代码里找。回复也算发推，所以先找带回复的那个。
  async function findOp(scripts, refresh) {
    for (const name of OPS) {
      const op = await getGqlOp(name, scripts, refresh);
      if (op) return { ...op, name };
    }
    return null;
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
      await store.set({ activity: { status: 'done', runId, startedAt: Date.now(), endedAt: Date.now(), total: 0, done: 0, message: `两周内都检查过了，不用重新检查` } });
      return { total: 0 };
    }
    await store.set({
      activity: {
        status: 'running', runId, startedAt: Date.now(), lastProgressAt: Date.now(), total: todo.length, done: 0,
        userId: (owner && owner.userId) || null, waitingUntil: 0, message: '正在后台检查…',
      },
    });
    run(runId).catch((e) => console.error('[X 取关助手] 检查发推时间出错', e));
    await kick();
    return { total: todo.length };
  }

  async function stop() {
    const a = await getActivity();
    if (!a || a.status !== 'running') return { ok: true };
    await endActivity(a.runId, 'stopped', `已停止，检查了 ${a.done || 0} 人，结果已保存`);
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

  async function run(runId) {
    if (runs.has(runId)) return;
    runs.add(runId);
    const buffer = {};
    let lastFlush = Date.now();
    try {
      const acct = await currentAccount(true);
      if (acct.loggedOut) throw new Error('x.com 没有登录，请先在 Chrome 里登录 x.com。');
      const { owner } = await store.get('owner');
      const userId = (owner && owner.userId) || null;
      if (userId && acct.userId && String(acct.userId) !== String(userId)) {
        throw new Error(`关注列表是 @${owner.handle} 的，现在 x.com 登录的是 @${acct.handle || acct.userId}。请切回 @${owner.handle} 再检查。`);
      }
      let op = await findOp(acct.scripts);
      if (!op) throw new Error('没找到读取推文的接口。在 x.com 上随便打开一个人的主页，再回来点「检查」。');

      let refreshed = false;
      let fails = 0;
      let emptyRun = []; // 连续「看不到推文」的人
      const skip = new Set(); // 这一轮里一直出错的人，先跳过
      const tries = {};

      for (;;) {
        const a = await getActivity();
        if (!a || a.runId !== runId || a.status !== 'running') return;
        const collect = await getCollect();
        if (collect && collect.status === 'running') {
          // 读取关注列表时不检查：换账号读取会清空列表，检查结果写回去也没有意义。
          await flush(buffer);
          await setActivity({ runId, waitingUntil: Date.now() + 60000, message: '等关注列表读完再继续' });
          return;
        }
        const { users, whitelist } = await store.get(['users', 'whitelist']);
        const todo = candidates(users, whitelist, Date.now()).filter((u) => !buffer[u.key] && !skip.has(u.key));
        if (!todo.length) {
          await flush(buffer);
          await endActivity(runId, 'done', '检查完了');
          await closeWorkerIfIdle();
          return;
        }
        const u = todo[0];
        const xmeta = await getXmeta();
        const r = await apiCall({ ...self.XAPI.userTweetsRequest(op, u.id, xmeta.features), expectUserId: userId });
        const rate = (r && r.rate) || {};

        if (r && r.error === 'wrong_account') throw new Error('x.com 上登录的账号变了，已停止。切回原来的账号后可以继续检查。');
        if (r && r.status === 429) {
          const until = Number(rate.reset) ? Number(rate.reset) * 1000 + 5000 : Date.now() + 15 * 60000;
          await flush(buffer);
          await setActivity({ runId, waitingUntil: until, lastProgressAt: Date.now(), message: `X 限制了读取频率，${new Date(until).toLocaleTimeString()} 自动继续` });
          await closeWorkerIfIdle();
          await kick();
          return;
        }
        if (r && (r.status === 401 || (r.status === 403 && self.XAPI.classifyFriendship('unfollow', r).result === 'auth'))) {
          throw new Error('x.com 需要重新登录，已停止。登录后点「检查」接着查。');
        }
        let res = null;
        if (r && !r.error && r.status === 200 && r.json) res = self.XAPI.lastActivity(r.json, u.id);
        if (!res || res.state === 'bad') {
          // 接口地址可能随 X 更新变了：重新找一次再试。
          if (!refreshed && r && !r.error && [400, 404].includes(r.status)) {
            refreshed = true;
            op = (await findOp(acct.scripts, true)) || op;
            continue;
          }
          fails += 1;
          tries[u.key] = (tries[u.key] || 0) + 1;
          if (tries[u.key] >= 2) skip.add(u.key);
          if (fails >= FAIL_STOP) {
            const why = r ? r.error || `接口返回 ${r.status}` : '页面没有响应';
            throw new Error(`连续 ${fails} 次读取失败（${why}），已停止，已检查的结果都保存了，可以稍后再点「检查」接着查。`);
          }
          await sleep(rand(4000, 8000));
          continue;
        }
        fails = 0;
        refreshed = false;
        const now = Date.now();
        buffer[u.key] = { activity: res.state, lastTweetAt: res.lastAt, activityAt: now, activityApprox: false };
        if (res.state === 'empty' && u.tweets > 0) {
          emptyRun.push(u.key);
          if (emptyRun.length >= EMPTY_STOP) {
            // 有推文的人连续都读不到推文，不像真实情况：这些结果不记，免得被当成不活跃取关掉。
            for (const k of emptyRun) delete buffer[k];
            throw new Error(`连续 ${EMPTY_STOP} 个人都读不到推文，可能是 X 改了接口，已停止，这些人没有被标记。`);
          }
        } else {
          emptyRun = [];
        }
        const done = (a.done || 0) + 1;
        const left = Math.max(0, todo.length - 1);
        // 按 X 告诉我们的剩余额度把请求均匀摊开，不一口气用完再干等。
        const numOf = (v) => (v === null || v === undefined || v === '' ? NaN : Number(v));
        const remaining = numOf(rate.remaining);
        const resetAt = numOf(rate.reset) * 1000;
        let gap = rand(1500, 3000);
        if (Number.isFinite(remaining) && resetAt > now) gap = Math.max(gap, Math.min(20000, (resetAt - now) / Math.max(1, remaining)));
        const per = numOf(rate.limit) > 0 ? Math.max(2250, (15 * 60000) / numOf(rate.limit)) : 2250;
        const etaMin = Math.ceil((left * per) / 60000);
        const etaText = left ? (etaMin > 90 ? `，预计还要约 ${Math.round(etaMin / 60)} 小时` : `，预计还要约 ${Math.max(1, etaMin)} 分钟`) : '';
        await setActivity({ runId, done, total: done + left, lastProgressAt: now, waitingUntil: 0, message: `已检查 ${done} 人，还剩 ${left} 人${etaText}` });
        if (Object.keys(buffer).length >= FLUSH_EVERY || now - lastFlush > FLUSH_MS) {
          await flush(buffer);
          lastFlush = Date.now();
        }
        // 额度快用完了：先存好，等额度恢复后由定时器接着查。
        if (Number.isFinite(remaining) && remaining <= 1 && resetAt > now) {
          await flush(buffer);
          await setActivity({ runId, waitingUntil: resetAt + 5000, message: `已检查 ${done} 人，为避免触发 X 的频率限制，${new Date(resetAt + 5000).toLocaleTimeString()} 自动继续` });
          await closeWorkerIfIdle();
          await kick();
          return;
        }
        await sleep(gap);
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

  // 定时器调用：频率限制解除了，或者 service worker 被浏览器回收过，接着查。
  async function resumeIfNeeded() {
    const a = await getActivity();
    if (!a || a.status !== 'running' || runs.has(a.runId)) return;
    if (a.waitingUntil && Date.now() < a.waitingUntil) return;
    run(a.runId).catch((e) => console.error('[X 取关助手] 继续检查出错', e));
  }

  async function handle(msg) {
    switch (msg.type) {
      case 'xa:activityStart':
        return start();
      case 'xa:activityStop':
        return stop();
      default:
        return { error: `unknown message ${msg.type}` };
    }
  }

  self.XAActivityBG = { handle, resumeIfNeeded, getActivity, OPS };
})();
