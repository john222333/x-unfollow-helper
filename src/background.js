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
    const tab = await chrome.tabs.get(worker.tabId);
    return tab ? worker : null;
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

async function openInWorker(url) {
  let worker = await getWorker();
  if (!worker) {
    // 先开空白窗口再导航，这样每次打开页面都走同一条「等待加载完成」的路径。
    const win = await chrome.windows.create({ url: 'about:blank', type: 'popup', focused: false, width: 520, height: 900 });
    worker = { tabId: win.tabs[0].id, windowId: win.id };
    await store.set({ worker });
    await sleep(300);
  }
  const loaded = waitForComplete(worker.tabId);
  await chrome.tabs.update(worker.tabId, { url });
  await loaded;
  return worker.tabId;
}

async function closeWorkerIfIdle() {
  const job = await getJob();
  const { collect } = await store.get('collect');
  if (['running', 'awaiting_confirm'].includes(job.status) || (collect && collect.status === 'running')) return;
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
  const runId = `run-${Date.now()}`;
  await store.set({ collect: { status: 'running', runId, startedAt: Date.now(), count: 0, message: '正在打开 x.com…' } });
  try {
    let tabId = await openInWorker('https://x.com/home');
    const who = await sendToTab(tabId, { type: 'xa:whoami' }, 20000);
    const handle = who && who.handle;
    if (!handle) throw new Error('没有检测到已登录的账号，请先在 Chrome 里登录 x.com。');
    await store.set({ me: { handle, at: Date.now() } });
    tabId = await openInWorker(`https://x.com/${handle}/following`);
    const r = await sendToTab(tabId, { type: 'xa:collect', runId }, 15000);
    if (!r || !r.started) throw new Error('页面没有开始读取，请刷新后重试。');
    await store.set({ collect: { status: 'running', runId, startedAt: Date.now(), count: 0, handle, message: '正在滚动读取…' } });
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
  if (msg.complete && msg.seen > 0) {
    // 本次完整读取中没出现的人，说明你已经不再关注他们了。
    await withLock(async () => {
      const { users } = await store.get('users');
      const map = users || {};
      for (const [k, u] of Object.entries(map)) {
        if (u.runId !== msg.runId) {
          delete map[k];
          removed++;
        }
      }
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
      message: msg.complete ? '读取完成' : (msg.reason || '已停止'),
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
    const queue = await getQueue();
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
  const { collect } = await store.get('collect');
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
  job.lastError = '';
  job.nextActionAt = Math.max(Date.now(), job.nextActionAt || 0);
  await saveJob(job);
  await kick();
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
}

async function perform(item, settings) {
  let tabId;
  try {
    tabId = await openInWorker(`https://x.com/${encodeURIComponent(item.handle)}`);
  } catch (e) {
    return { result: e.message === 'timeout' ? 'timeout' : 'error', detail: e.message };
  }
  try {
    const res = await sendToTab(
      tabId,
      { type: 'xa:act', action: item.action, handle: item.handle, id: item.id, dryRun: settings.dryRun },
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
  if (job.status !== 'running') { await saveJob(job); return; }
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
      return;
    }
    job.batchConfirmed = true;
  }
  if (!job.batchConfirmed) {
    job.status = 'awaiting_confirm';
    await saveJob(job);
    return;
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
    dryRun: !!settings.dryRun,
  }]);

  if (TRIP_NOW.has(result)) {
    await trip(latest, result, res.detail);
    return;
  }

  await withLock(async () => {
    queue = (await getQueue()).filter((q) => !(q.key === item.key && q.action === item.action));
    await store.set({ queue });
  });
  latest.batch = latest.batch.filter((k) => k !== item.key);

  if (result === 'ok') {
    latest.doneToday += 1;
    if (item.action === 'unfollow') {
      await withLock(async () => {
        const { users } = await store.get('users');
        if (users && users[item.key]) {
          delete users[item.key];
          await store.set({ users });
        }
      });
    }
  }

  if (SOFT_FAIL.has(result)) {
    latest.consecutiveFail += 1;
    const limit = result === 'not_applied' ? 2 : 3;
    if (latest.consecutiveFail >= limit) {
      await trip(latest, result, `连续 ${latest.consecutiveFail} 次失败`);
      return;
    }
  } else {
    latest.consecutiveFail = 0;
  }

  const p = settings.pace;
  if (!latest.batch.length) {
    latest.batchConfirmed = false;
    latest.nextActionAt = Date.now() + rand(p.restMinMin, p.restMaxMin) * 60000;
  } else {
    latest.nextActionAt = Date.now() + rand(p.minDelaySec, p.maxDelaySec) * 1000;
  }
  await saveJob(latest);
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
      llm = await cached('analyze', clean, settings.llm, () => self.XALLM.analyze(settings.llm, clean));
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
  const rewrites = await self.XALLM.rewrite(settings.llm, text, analysis);
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
          await store.set({ collect: { ...collect, seen: msg.seen, count: Object.keys(users || {}).length, message: `已读取 ${msg.seen} 个` } });
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
      const { collect } = await store.get('collect');
      if (collect && collect.status === 'running') {
        await store.set({ collect: { ...collect, status: 'stopped', message: '已停止' } });
      }
      await closeWorkerIfIdle();
      return { ok: true };
    }
    case 'xa:enqueue':
      return enqueue(msg.keys || [], msg.action === 'follow' ? 'follow' : 'unfollow', !!msg.front);
    case 'xa:dequeue':
      return removeFromQueue(msg.keys || []);
    case 'xa:clearQueue':
      await store.set({ queue: [] });
      await withLock(async () => {
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
      return { ok: await self.XALLM.ping(cfg) };
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

chrome.runtime.onStartup.addListener(() => kick());
