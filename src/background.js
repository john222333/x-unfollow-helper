// Service worker：取关调度、关注列表合并、LLM 调用。
// 所有节奏控制都在这里做，内容脚本只负责在页面上读取和点击。
importScripts('lib/store.js', 'lib/rules.js', 'lib/algo.js', 'lib/llm.js');

const S = self.XAStore;
const TICK_ALARM = 'xa-tick';

const TRIP_NOW = new Set(['rate_limited', 'auth', 'locked', 'captcha']);
const SOFT_FAIL = new Set(['not_applied', 'no_button', 'timeout', 'no_response', 'error']);
const RESULT_LABELS = {
  ok: '成功',
  dry_run: '演练（未点击）',
  already: '已经是目标状态',
  gone: '账号不存在或已冻结',
  mismatch: '页面账号不匹配，已跳过',
  pending: '已发送关注请求（受保护账号）',
  rate_limited: 'X 提示操作过于频繁',
  auth: '需要重新登录',
  wrong_account: '登录的账号不对',
  locked: '账号被临时锁定',
  captcha: '出现人机验证',
  not_applied: '点击后状态没有变化',
  no_button: '没有找到关注按钮',
  timeout: '页面加载超时',
  no_response: '页面没有响应',
  error: '出错',
};

// ---------- 基础工具 ----------

const store = {
  get: (keys) => chrome.storage.local.get(keys),
  set: (obj) => chrome.storage.local.set(obj),
};

function makeLock() {
  let chain = Promise.resolve();
  return (fn) => {
    const run = chain.then(fn, fn);
    chain = run.catch(() => {});
    return run;
  };
}
const withLock = makeLock();
const withCollectLock = makeLock(); // 读取状态的更新要排队，避免进度消息覆盖「已完成」

const rand = (lo, hi) => lo + Math.random() * (hi - lo);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function nextDayStart() {
  const d = new Date();
  d.setHours(24, 0, 0, 0);
  return d.getTime();
}

async function getSettings() {
  const { settings } = await store.get('settings');
  return S.mergeSettings(settings);
}

const DEFAULT_JOB = {
  status: 'idle', // idle | running | awaiting_confirm | paused | tripped | daily_cap
  batch: [],
  batchNo: 0,
  batchConfirmed: false,
  current: null,
  nextActionAt: 0,
  day: S.dayKey(),
  doneToday: 0,
  consecutiveFail: 0,
  consecutiveAlready: 0,
  lastError: '',
  pausedUntil: 0,
};

async function getJob() {
  const { job } = await store.get('job');
  const j = { ...DEFAULT_JOB, ...(job || {}) };
  if (j.day !== S.dayKey()) {
    j.day = S.dayKey();
    j.doneToday = 0;
  }
  return j;
}
const saveJob = (job) => store.set({ job });

async function getQueue() {
  const { queue } = await store.get('queue');
  return Array.isArray(queue) ? queue : [];
}

function notify(title, message) {
  try {
    chrome.notifications.create('', {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon128.png'),
      title,
      message,
    });
  } catch (e) {
    console.warn('notify failed', e);
  }
}

async function updateBadge() {
  const job = await getJob();
  const map = { running: '▶', awaiting_confirm: '?', tripped: '!', daily_cap: '✓', paused: 'Ⅱ' };
  const text = job.status === 'running' ? String(job.doneToday) : map[job.status] || '';
  const color = job.status === 'tripped' ? '#d93025' : job.status === 'awaiting_confirm' ? '#e37400' : '#1d9bf0';
  await chrome.action.setBadgeText({ text });
  await chrome.action.setBadgeBackgroundColor({ color });
}

async function appendLog(entries) {
  const { log } = await store.get('log');
  const next = (Array.isArray(log) ? log : []).concat(entries);
  await store.set({ log: next.slice(-5000) });
}

// ---------- 工作窗口 ----------
// 取关和抓取都在一个独立的小窗口里进行，避免打扰你正在看的页面。
// 窗口不能最小化：最小化的页面会被浏览器节流，按钮可能不渲染。

async function getWorker() {
  const { worker } = await store.get('worker');
  if (!worker || worker.tabId == null) return null;
  try {
    // 浏览器重启后标签页 ID 会重新编号，可能正好撞上你自己的标签页，所以要核对窗口。
    const tab = await chrome.tabs.get(worker.tabId);
    if (!tab || tab.windowId !== worker.windowId) return null;
    const win = await chrome.windows.get(worker.windowId);
    return win && win.type === 'popup' ? worker : null;
  } catch {
    return null;
  }
}

function waitForComplete(tabId, timeoutMs) {
  return new Promise((resolve, reject) => {
    let finished = false;
    const timer = setTimeout(() => done(new Error('timeout')), timeoutMs || 40000);
    function listener(id, info) {
      if (id === tabId && info.status === 'complete') done();
    }
    function done(err) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      if (err) reject(err);
      else resolve();
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function openInWorker(url, opts) {
  const focused = !!(opts && opts.focused);
  let worker = await getWorker();
  if (!worker) {
    // 先开空白窗口再导航，这样每次打开页面都走同一条「等待加载完成」的路径。
    // 窄于 500 像素时 X 会切到手机版布局，左侧导航（用来识别账号）就没了，所以留足宽度。
    const win = await chrome.windows.create({ url: 'about:blank', type: 'popup', focused, width: 760, height: 900 });
    worker = { tabId: win.tabs[0].id, windowId: win.id };
    await store.set({ worker });
    await sleep(300);
  } else if (focused) {
    try { await chrome.windows.update(worker.windowId, { focused: true }); } catch { /* 忽略 */ }
  }
  const loaded = waitForComplete(worker.tabId);
  await chrome.tabs.update(worker.tabId, { url });
  await loaded;
  return worker.tabId;
}

// 只有正在处理一批时才保留工作窗口；批次间休息、等待确认、暂停时都关掉，下次需要再开。
async function closeWorkerIfIdle() {
  const job = await getJob();
  const collect = await getCollect();
  const busy = job.status === 'running' && (job.current || job.batch.length);
  if (busy || (collect && collect.status === 'running')) return;
  const worker = await getWorker();
  if (worker) {
    try { await chrome.windows.remove(worker.windowId); } catch { /* 已关闭 */ }
  }
  await store.set({ worker: null });
}

async function sendToTab(tabId, msg, timeoutMs) {
  const deadline = Date.now() + 8000;
  // 内容脚本可能还没注入完，"Receiving end does not exist" 时重试。
  for (;;) {
    try {
      return await Promise.race([
        chrome.tabs.sendMessage(tabId, msg),
        sleep(timeoutMs || 45000).then(() => ({ result: 'no_response' })),
      ]);
    } catch (e) {
      if (Date.now() > deadline) throw e;
      await sleep(500);
    }
  }
}

// ---------- 关注列表 ----------

const COLLECT_STALE_MS = 3 * 60 * 1000;

// 读取中的页面崩溃、被关闭或跳走时收不到「完成」消息，超过 3 分钟没有进度就当作已中断。
async function getCollect() {
  const { collect } = await store.get('collect');
  if (collect && collect.status === 'running') {
    const last = collect.lastProgressAt || collect.startedAt || 0;
    if (Date.now() - last > COLLECT_STALE_MS) {
      const stopped = { ...collect, status: 'stopped', message: '读取中断了（页面没有响应），可以重新读取' };
      await store.set({ collect: stopped });
      return stopped;
    }
  }
  return collect || null;
}

const mergeUsers = (users, runId) => withLock(async () => {
  const { users: stored } = await store.get('users');
  const map = stored || {};
  const now = Date.now();
  let added = 0;
  for (const u of users) {
    const key = S.userKey(u.handle);
    if (!key) continue;
    if (u.youFollow === false) continue;
    const prev = map[key];
    if (!prev) added++;
    const merged = { ...(prev || { firstSeen: now }) };
    // 接口数据比页面上读到的更准：已有接口数据时，页面数据只补空缺字段。
    const fillOnly = u.source === 'dom' && prev && prev.gql;
    for (const [k, v] of Object.entries(u)) {
      if (k === 'source' || v === undefined || v === null || v === '') continue;
      if (fillOnly && merged[k] !== undefined) continue;
      merged[k] = v;
    }
    if (u.source === 'graphql') merged.gql = true;
    merged.key = key;
    merged.lastSeen = now;
    if (runId) merged.runId = runId;
    map[key] = merged;
  }
  await store.set({ users: map });
  return { added, total: Object.keys(map).length };
});

async function startCollect() {
  const job = await getJob();
  if (['running', 'awaiting_confirm'].includes(job.status)) {
    throw new Error('取关任务进行中，请先暂停再读取关注列表。');
  }
  const current = await getCollect();
  if (current && current.status === 'running') throw new Error('正在读取中，请等它结束或先点「停止读取」。');
  const runId = `run-${Date.now()}`;
  await store.set({ collect: { status: 'running', runId, startedAt: Date.now(), lastProgressAt: Date.now(), count: 0, message: '正在打开 x.com…' } });
  try {
    // 窗口被完全挡住或最小化时，浏览器会暂停页面渲染，X 就不再往下加载列表，所以读取时放到前面。
    let tabId = await openInWorker('https://x.com/home', { focused: true });
    const who = await sendToTab(tabId, { type: 'xa:whoami' }, 20000);
    if (who && who.loggedOut) throw new Error('x.com 没有登录，请先在 Chrome 里登录 x.com。');
    // 页面上找不到账号入口时，用之前识别到的账号。
    const { me } = await store.get('me');
    const handle = (who && who.handle) || (me && me.handle);
    if (!handle) throw new Error('没有检测到已登录的账号，请先在 Chrome 里打开并登录 x.com。');
    // owner 记的是「这份关注列表属于谁」；me 会随你打开的任何 x.com 页面更新，不能拿来核对。
    await store.set({ me: { handle, at: Date.now() }, owner: { handle, at: Date.now() } });
    tabId = await openInWorker(`https://x.com/${handle}/following`, { focused: true });
    const r = await sendToTab(tabId, { type: 'xa:collect', runId }, 15000);
    if (!r || !r.started) throw new Error('页面没有开始读取，请刷新后重试。');
    await store.set({ collect: { status: 'running', runId, startedAt: Date.now(), lastProgressAt: Date.now(), count: 0, handle, message: '正在滚动读取…' } });
  } catch (e) {
    await store.set({ collect: { status: 'error', runId, message: e.message === 'timeout' ? '打开 x.com 超时' : e.message } });
    await closeWorkerIfIdle();
    throw e;
  }
}

async function finishCollect(msg) {
  const { collect } = await store.get('collect');
  if (!collect || collect.runId !== msg.runId) return;
  let removed = 0;
  let pruneSkipped = false;
  if (msg.complete && msg.seen > 0) {
    // 本次完整读取中没出现的人，说明你已经不再关注他们了。
    await withLock(async () => {
      const { users } = await store.get('users');
      const map = users || {};
      const stale = Object.keys(map).filter((k) => map[k].runId !== msg.runId);
      // 一次要删掉两成以上，更可能是列表没加载全，这时保留旧记录。
      if (stale.length > 20 && stale.length > Object.keys(map).length * 0.2) {
        pruneSkipped = true;
        return;
      }
      for (const k of stale) delete map[k];
      removed = stale.length;
      await store.set({ users: map });
    });
  }
  const { users } = await store.get('users');
  await store.set({
    collect: {
      ...collect,
      status: msg.complete ? 'done' : 'stopped',
      finishedAt: Date.now(),
      count: Object.keys(users || {}).length,
      removed,
      message: msg.complete
        ? (pruneSkipped ? '读取完成（这次读到的人比上次少很多，可能没加载全，旧记录先保留）' : '读取完成')
        : (msg.reason || '已停止'),
    },
  });
  await closeWorkerIfIdle();
}

// ---------- 取关调度 ----------

async function enqueue(keys, action, front) {
  return withLock(async () => {
    const { users, whitelist } = await store.get(['users', 'whitelist']);
    const map = users || {};
    const wl = whitelist || {};
    let queue = await getQueue();
    // 同一个人只保留最新的动作，避免取关和重新关注同时在队列里。
    const opposite = action === 'follow' ? 'unfollow' : 'follow';
    const incoming = new Set(keys.map((raw) => S.userKey(raw.handle || raw)));
    queue = queue.filter((q) => !(q.action === opposite && incoming.has(q.key)));
    const exists = new Set(queue.map((q) => `${q.action}:${q.key}`));
    const items = [];
    let skipped = 0;
    for (const raw of keys) {
      const key = S.userKey(raw.handle || raw);
      const u = map[key] || raw;
      const handle = u.handle || key;
      if (!handle) continue;
      if (action === 'unfollow' && wl[key]) { skipped++; continue; }
      if (exists.has(`${action}:${key}`)) continue;
      items.push({ key, handle, id: u.id || null, name: u.name || '', action, addedAt: Date.now() });
      exists.add(`${action}:${key}`);
    }
    const next = front ? items.concat(queue) : queue.concat(items);
    await store.set({ queue: next });
    return { added: items.length, skipped, total: next.length };
  });
}

async function removeFromQueue(keys) {
  return withLock(async () => {
    const drop = new Set(keys.map(S.userKey));
    const queue = (await getQueue()).filter((q) => !drop.has(q.key));
    const job = await getJob();
    job.batch = job.batch.filter((k) => !drop.has(k));
    await store.set({ queue, job });
    return { total: queue.length };
  });
}

function prepareBatch(job, queue, settings) {
  job.batch = queue.slice(0, settings.pace.batchSize).map((q) => q.key);
  job.batchNo += 1;
  job.batchConfirmed = false;
}

async function startJob() {
  const collect = await getCollect();
  if (collect && collect.status === 'running') throw new Error('正在读取关注列表，请等它结束。');
  const settings = await getSettings();
  const queue = await getQueue();
  if (!queue.length) throw new Error('队列是空的，先在「关注管理」里选人加入队列。');
  const job = await getJob();
  if (job.doneToday >= S.effectiveDailyCap(settings)) throw new Error('今天已经到上限了，明天再继续。');
  if (!job.batch.length) prepareBatch(job, queue, settings);
  job.status = 'running';
  job.batchConfirmed = true;
  job.consecutiveFail = 0;
  job.consecutiveAlready = 0;
  job.lastError = '';
  job.nextActionAt = Math.max(Date.now(), job.nextActionAt || 0);
  await saveJob(job);
  await kick();
}

// 加入队列后自动开始：只在任务空闲时启动；你手动暂停或被熔断时不会自动恢复。
async function maybeAutoStart(added) {
  const settings = await getSettings();
  const job = await getJob();
  if (!added || !settings.autoStart) return { started: false, status: job.status };
  if (job.status !== 'idle') return { started: false, status: job.status };
  try {
    await startJob();
    return { started: true, status: 'running' };
  } catch (e) {
    return { started: false, status: job.status, startError: e.message };
  }
}

async function confirmBatch() {
  const job = await getJob();
  if (job.status !== 'awaiting_confirm') throw new Error('当前没有等待确认的批次。');
  job.status = 'running';
  job.batchConfirmed = true;
  job.nextActionAt = Math.max(Date.now(), job.nextActionAt || 0);
  await saveJob(job);
  await kick();
}

async function pauseJob() {
  const job = await getJob();
  if (job.status === 'idle') return;
  job.status = 'paused';
  await saveJob(job);
  await kick();
  if (!job.current) await closeWorkerIfIdle(); // 执行中的那一个结束后由 step 关窗口
}

async function resumeJob(force) {
  const job = await getJob();
  if (job.status === 'tripped' && Date.now() < job.pausedUntil && !force) {
    throw new Error(`熔断保护中，建议 ${new Date(job.pausedUntil).toLocaleString()} 之后再继续。`);
  }
  if (!['paused', 'tripped', 'daily_cap', 'idle'].includes(job.status)) return;
  await startJob();
}

async function trip(job, reason, detail) {
  job.status = 'tripped';
  job.pausedUntil = Date.now() + 24 * 3600 * 1000;
  job.lastError = `${RESULT_LABELS[reason] || reason}${detail ? `：${detail}` : ''}`;
  await saveJob(job);
  notify('X 助手已自动暂停取关', `${job.lastError}。建议休息 24 小时后再继续。`);
  await closeWorkerIfIdle();
}

async function perform(item, settings) {
  const { owner, me } = await store.get(['owner', 'me']);
  const expected = (owner && owner.handle) || (me && me.handle);
  let tabId;
  try {
    tabId = await openInWorker(`https://x.com/${encodeURIComponent(item.handle)}`);
  } catch (e) {
    return { result: e.message === 'timeout' ? 'timeout' : 'error', detail: e.message };
  }
  try {
    const res = await sendToTab(
      tabId,
      { type: 'xa:act', action: item.action, handle: item.handle, id: item.id, dryRun: settings.dryRun, me: expected },
      60000,
    );
    return res || { result: 'no_response' };
  } catch (e) {
    return { result: 'no_response', detail: e.message };
  }
}

let ticking = false;

async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    await step();
  } catch (e) {
    console.error('[X 助手] tick 出错', e);
  } finally {
    ticking = false;
    await scheduleNext();
  }
}

async function step() {
  const settings = await getSettings();
  const job = await getJob();
  const now = Date.now();

  // 关掉「每批确认」后，原来停在等待确认的批次直接开始。
  if (job.status === 'awaiting_confirm' && !settings.confirmEachBatch) {
    job.status = 'running';
    job.batchConfirmed = true;
    job.nextActionAt = Math.max(now, job.nextActionAt || 0);
    await saveJob(job);
  }

  if (job.status === 'daily_cap' && now >= job.nextActionAt) {
    const queue = await getQueue();
    if (!queue.length) { job.status = 'idle'; await saveJob(job); return; }
    job.status = settings.confirmEachBatch ? 'awaiting_confirm' : 'running';
    if (!job.batch.length) prepareBatch(job, queue, settings);
    job.batchConfirmed = !settings.confirmEachBatch;
    await saveJob(job);
    if (settings.confirmEachBatch) notify('X 助手：新的一天', '今天的取关额度已恢复，确认后开始下一批。');
    return;
  }
  if (job.status !== 'running') return;
  if (now < job.nextActionAt) return;

  if (job.doneToday >= S.effectiveDailyCap(settings)) {
    job.status = 'daily_cap';
    job.nextActionAt = nextDayStart() + rand(5, 60) * 60000;
    await saveJob(job);
    notify('X 助手：今日额度已用完', `今天取关了 ${job.doneToday} 个，明天继续。`);
    await closeWorkerIfIdle();
    return;
  }

  let queue = await getQueue();
  if (!job.batch.length) {
    if (!queue.length) {
      job.status = 'idle';
      await saveJob(job);
      notify('X 助手：队列已完成', `今天共处理 ${job.doneToday} 个。`);
      await closeWorkerIfIdle();
      return;
    }
    prepareBatch(job, queue, settings);
    if (settings.confirmEachBatch) {
      job.status = 'awaiting_confirm';
      await saveJob(job);
      notify('X 助手：下一批已就绪', `共 ${job.batch.length} 个，打开管理页确认后开始。`);
      await closeWorkerIfIdle();
      return;
    }
    job.batchConfirmed = true;
  }
  if (!job.batchConfirmed) {
    if (settings.confirmEachBatch) {
      job.status = 'awaiting_confirm';
      await saveJob(job);
      return;
    }
    job.batchConfirmed = true;
  }

  const key = job.batch[0];
  const item = queue.find((q) => q.key === key);
  if (!item) {
    job.batch.shift();
    await saveJob(job);
    return;
  }
  job.current = item.key;
  await saveJob(job);

  const dryRun = !!settings.dryRun;
  const res = await perform(item, settings);
  const result = res.result || 'error';

  // 执行期间用户可能暂停了，以最新状态为准再写回。
  const latest = await getJob();
  latest.current = null;
  await appendLog([{
    t: Date.now(),
    key: item.key,
    handle: item.handle,
    name: item.name,
    action: item.action,
    result,
    label: RESULT_LABELS[result] || result,
    detail: res.detail || '',
    batchNo: latest.batchNo,
    dryRun,
  }]);

  if (TRIP_NOW.has(result)) {
    await trip(latest, result, res.detail);
    return;
  }
  if (result === 'wrong_account') {
    // 不是 X 的限制，不用冷却；队列原样保留，切回正确的账号后点继续即可。
    latest.status = 'paused';
    latest.lastError = `${res.detail || '登录的账号和关注列表不一致'}。请在 x.com 切换到正确的账号后点「继续取关」。`;
    await saveJob(latest);
    notify('X 助手已暂停取关', latest.lastError);
    await closeWorkerIfIdle();
    return;
  }

  latest.batch = latest.batch.filter((k) => k !== item.key);

  // 演练不改动队列：演练完一批就停下，关掉演练模式后同一批人还在队列里。
  if (!dryRun) {
    await withLock(async () => {
      const all = await getQueue();
      const idx = all.findIndex((q) => q.key === item.key && q.action === item.action);
      if (idx < 0) return;
      const [done] = all.splice(idx, 1);
      // 加载超时、没找到按钮这类偶发失败，放回队尾再试，最多重试 2 次。
      if (SOFT_FAIL.has(result) && (done.tries || 0) < 2) all.push({ ...done, tries: (done.tries || 0) + 1 });
      await store.set({ queue: all });
    });
  }

  if (result === 'ok') latest.doneToday += 1;
  if (!dryRun && item.action === 'unfollow' && result === 'ok') {
    await withLock(async () => {
      const { users } = await store.get('users');
      if (users && users[item.key]) {
        delete users[item.key];
        await store.set({ users });
      }
    });
  }

  // 连续很多人都显示「没在关注」，多半是登录的账号不对或列表过期了，先停下来。
  latest.consecutiveAlready = result === 'already' ? (latest.consecutiveAlready || 0) + 1 : 0;
  if (latest.consecutiveAlready >= 5 && latest.status === 'running') {
    latest.status = 'paused';
    latest.consecutiveAlready = 0;
    latest.lastError = '连续 5 个人都显示你没有关注他们。请确认 x.com 登录的是你要整理的账号，必要时重新读取关注列表，再继续。';
    await saveJob(latest);
    notify('X 助手已暂停取关', latest.lastError);
    await closeWorkerIfIdle();
    return;
  }

  if (SOFT_FAIL.has(result)) {
    latest.consecutiveFail += 1;
    const limit = result === 'not_applied' ? 2 : 3;
    if (latest.consecutiveFail >= limit) {
      if (dryRun) {
        // 演练没有真的点击，不会触发 X 的限制，用不着冷却 24 小时。
        latest.status = 'paused';
        latest.lastError = `演练中连续 ${latest.consecutiveFail} 次失败（${RESULT_LABELS[result] || result}），可能是 X 改版了页面，请把日志截图发给开发者。`;
        await saveJob(latest);
        await closeWorkerIfIdle();
        return;
      }
      await trip(latest, result, `连续 ${latest.consecutiveFail} 次失败`);
      return;
    }
  } else {
    latest.consecutiveFail = 0;
  }

  const p = settings.pace;
  if (!latest.batch.length) {
    latest.batchConfirmed = false;
    if (dryRun) {
      if (latest.status === 'running') {
        latest.status = 'idle';
        latest.lastError = '';
        notify('X 助手：演练完成', '队列保持不变。到「日志」看结果，没问题就关掉演练模式再开始。');
      }
      await saveJob(latest);
      await closeWorkerIfIdle();
      return;
    }
    latest.nextActionAt = Date.now() + rand(p.restMinMin, p.restMaxMin) * 60000;
  } else {
    latest.nextActionAt = Date.now() + rand(p.minDelaySec, p.maxDelaySec) * 1000;
  }
  await saveJob(latest);
  // 批次结束要休息很久，或者执行期间被暂停了：关掉工作窗口。
  if (!latest.batch.length || latest.status !== 'running') await closeWorkerIfIdle();
}

async function scheduleNext() {
  const job = await getJob();
  await updateBadge();
  if (job.status === 'running' || job.status === 'daily_cap') {
    const delay = Math.max(0, job.nextActionAt - Date.now());
    if (delay < 25000) setTimeout(tick, delay + 100);
    const existing = await chrome.alarms.get(TICK_ALARM);
    if (!existing) chrome.alarms.create(TICK_ALARM, { periodInMinutes: 0.5 });
  } else {
    await chrome.alarms.clear(TICK_ALARM);
  }
}

async function kick() {
  await scheduleNext();
  setTimeout(tick, 50);
}

// ---------- 推文体检 ----------

function hashText(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

// 等模型回复时 service worker 没有别的事件，30 秒后可能被浏览器结束；定时调一个扩展接口让它保持运行。
async function keepAlive(fn) {
  const timer = setInterval(() => { chrome.runtime.getPlatformInfo().catch(() => {}); }, 20000);
  try {
    return await fn();
  } finally {
    clearInterval(timer);
  }
}

function llmConfigured(cfg) {
  if (!cfg || !cfg.model) return false;
  if (cfg.provider === 'anthropic') return !!cfg.apiKey;
  return !!cfg.baseUrl;
}

async function cached(kind, text, cfg, fn) {
  const key = `${kind}:${cfg.provider}:${cfg.model}:${hashText(text)}`;
  const { cache } = await store.get('cache');
  const map = cache || {};
  if (map[key]) return map[key].v;
  const v = await fn();
  map[key] = { t: Date.now(), v };
  const entries = Object.entries(map).sort((a, b) => b[1].t - a[1].t).slice(0, 200);
  await store.set({ cache: Object.fromEntries(entries) });
  return v;
}

async function analyzeTweet(text, useLLM) {
  const clean = String(text || '').trim();
  if (!clean) throw new Error('没有读取到推文内容。');
  const settings = await getSettings();
  const rules = self.XARules.analyze(clean);
  const local = self.XAAlgo.localChecks(clean);
  const configured = llmConfigured(settings.llm);
  let llm = null;
  let llmError = '';
  if (useLLM !== false && configured) {
    try {
      llm = await cached('analyze', clean, settings.llm, () => keepAlive(() => self.XALLM.analyze(settings.llm, clean)));
    } catch (e) {
      llmError = e.message;
    }
  }
  const algo = llm ? self.XAAlgo.score(llm.engagement) : null;
  const aiScore = llm ? Math.round(0.4 * rules.score + 0.6 * llm.ai_score) : rules.score;
  return { text: clean, rules, local, llm, llmError, llmConfigured: configured, algo, aiScore, model: settings.llm.model };
}

async function rewriteTweet(text, analysis) {
  const settings = await getSettings();
  if (!llmConfigured(settings.llm)) throw new Error('改写需要先在设置页配置 LLM。');
  const rewrites = await keepAlive(() => self.XALLM.rewrite(settings.llm, text, analysis));
  return rewrites.map((r) => ({ ...r, rules: self.XARules.analyze(r.text), length: self.XARules.weightedLength(r.text) }));
}

// ---------- 消息路由 ----------

async function handle(msg, sender) {
  switch (msg && msg.type) {
    case 'xa:me':
      if (msg.handle) await store.set({ me: { handle: msg.handle, at: Date.now() } });
      return { ok: true };
    case 'xa:users':
      return mergeUsers(msg.users || [], msg.runId);
    case 'xa:collect-progress':
      await withCollectLock(async () => {
        const { collect } = await store.get('collect');
        if (collect && collect.runId === msg.runId && collect.status === 'running') {
          const { users } = await store.get('users');
          const message = msg.hidden
            ? `已读取 ${msg.seen} 个。读取窗口被挡住或最小化了，X 不会继续加载，请把那个小窗口露出来`
            : `已读取 ${msg.seen} 个`;
          await store.set({ collect: { ...collect, seen: msg.seen, lastProgressAt: Date.now(), count: Object.keys(users || {}).length, message } });
        }
      });
      return { ok: true };
    case 'xa:collect-done':
      await withCollectLock(() => finishCollect(msg));
      return { ok: true };
    case 'xa:collect':
      await startCollect();
      return { ok: true };
    case 'xa:stopCollect': {
      const worker = await getWorker();
      if (worker) {
        try { await chrome.tabs.sendMessage(worker.tabId, { type: 'xa:stopCollect' }); } catch { /* 页面已关闭 */ }
      }
      // 和进度消息排队，避免进度把「已停止」又改回「读取中」。
      await withCollectLock(async () => {
        const { collect } = await store.get('collect');
        if (collect && collect.status === 'running') {
          await store.set({ collect: { ...collect, status: 'stopped', message: '已停止' } });
        }
      });
      await closeWorkerIfIdle();
      return { ok: true };
    }
    case 'xa:enqueue': {
      const r = await enqueue(msg.keys || [], msg.action === 'follow' ? 'follow' : 'unfollow', !!msg.front);
      return { ...r, ...(await maybeAutoStart(r.added)) };
    }
    case 'xa:dequeue':
      return removeFromQueue(msg.keys || []);
    case 'xa:clearQueue':
      await withLock(async () => {
        await store.set({ queue: [] });
        const job = await getJob();
        job.batch = [];
        if (['running', 'awaiting_confirm'].includes(job.status)) job.status = 'idle';
        await saveJob(job);
      });
      await kick();
      return { ok: true };
    case 'xa:start':
      await startJob();
      return { ok: true };
    case 'xa:confirm':
      await confirmBatch();
      return { ok: true };
    case 'xa:pause':
      await pauseJob();
      return { ok: true };
    case 'xa:resume':
      await resumeJob(!!msg.force);
      return { ok: true };
    case 'xa:state': {
      const [job, queue, settings, rest] = await Promise.all([
        getJob(), getQueue(), getSettings(), store.get(['collect', 'me']),
      ]);
      return {
        job, queueLength: queue.length, cap: S.effectiveDailyCap(settings),
        collect: rest.collect || null, me: rest.me || null, dryRun: settings.dryRun,
        llmConfigured: llmConfigured(settings.llm),
      };
    }
    case 'xa:analyze':
      return analyzeTweet(msg.text, msg.useLLM);
    case 'xa:rewrite':
      return { rewrites: await rewriteTweet(msg.text, msg.analysis) };
    case 'xa:ping': {
      const settings = await getSettings();
      const cfg = { ...settings.llm, ...(msg.llm || {}) };
      return { ok: await keepAlive(() => self.XALLM.ping(cfg)) };
    }
    case 'xa:openOptions':
      await chrome.runtime.openOptionsPage();
      return { ok: true };
    default:
      return { error: `unknown message ${msg && msg.type}` };
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handle(msg, sender).then(
    (res) => sendResponse(res),
    (e) => sendResponse({ error: e && e.message ? e.message : String(e) }),
  );
  return true;
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === TICK_ALARM) tick();
});

chrome.windows.onRemoved.addListener(async (windowId) => {
  const worker = await getWorker().catch(() => null);
  const { worker: stored } = await store.get('worker');
  if (!stored || stored.windowId !== windowId) return;
  await store.set({ worker: null });
  if (worker) return;
  const job = await getJob();
  if (job.status === 'running') {
    job.status = 'paused';
    job.lastError = '工作窗口被关闭，任务已暂停。';
    await saveJob(job);
    await updateBadge();
  }
  const { collect } = await store.get('collect');
  if (collect && collect.status === 'running') {
    await store.set({ collect: { ...collect, status: 'stopped', message: '工作窗口被关闭' } });
  }
});

chrome.runtime.onInstalled.addListener(async (details) => {
  const { settings } = await store.get('settings');
  await store.set({ settings: S.mergeSettings(settings) });
  if (details.reason === 'install') chrome.runtime.openOptionsPage();
  await kick();
});

chrome.runtime.onStartup.addListener(async () => {
  // 上次的工作窗口已经不在了，记录作废。
  await store.set({ worker: null });
  await kick();
});

// 设置变了（比如关掉了「每批确认」）立刻按新设置跑一次。
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.settings) kick();
});
