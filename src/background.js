// Service worker：取关调度、关注列表合并、LLM 调用。
// 所有节奏控制都在这里做，内容脚本只负责在页面上读取和点击。
importScripts('lib/store.js', 'lib/rules.js', 'lib/algo.js', 'lib/llm.js', 'lib/xapi.js');

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
  logged_out: 'x.com 没有登录',
  blocked: '对方屏蔽了你，无法关注',
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
    chrome.notifications.create(`xa-${Date.now()}`, {
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
  // 鼠标停在插件图标上时显示一句话状态。
  const titles = {
    running: `X 助手：后台取关中，今天已处理 ${job.doneToday} 个`,
    awaiting_confirm: 'X 助手：下一批等你确认',
    tripped: `X 助手：已自动暂停（${job.lastError || 'X 的限制'}）`,
    daily_cap: 'X 助手：今天的额度用完了，明天自动继续',
    paused: 'X 助手：取关已暂停',
  };
  await chrome.action.setTitle({ title: titles[job.status] || 'X 助手' });
}

async function appendLog(entries) {
  const { log } = await store.get('log');
  const next = (Array.isArray(log) ? log : []).concat(entries);
  await store.set({ log: next.slice(-5000) });
}

// ---------- 执行环境 ----------
// 取关、重新关注、读取关注列表都不再弹出窗口：
// 1. 优先借用你已经打开的 x.com 页面，在里面调用 X 网页版自己的接口（和你点按钮时发出的请求一样）。
// 2. 你没开 x.com 时，在标签栏最左边放一个固定的后台标签页，任务休息或结束时自动关掉。
// 3. 接口不可用时（比如 X 改了接口），自动改成在这个后台标签页里打开主页点按钮。
// 只有「后台读取关注列表」也失败时，才会退回到打开一个读取窗口滚动列表（读取列表必须让页面可见）。

const CONTENT_FILES = ['src/lib/store.js', 'src/lib/rules.js', 'src/lib/algo.js', 'src/lib/xapi.js', 'src/lib/panel.js', 'src/content/x-dom.js', 'src/content/content.js'];
const API_RETRY_MS = 24 * 3600 * 1000;

async function getWorker() {
  const { worker } = await store.get('worker');
  if (!worker || worker.tabId == null) return null;
  try {
    // 浏览器重启后标签页 ID 会重新编号，可能正好撞上你自己的标签页，所以要核对。
    const tab = await chrome.tabs.get(worker.tabId);
    if (!tab || tab.windowId !== worker.windowId) return null;
    if (worker.kind === 'window') {
      const win = await chrome.windows.get(worker.windowId);
      return win && win.type === 'popup' ? worker : null;
    }
    return tab.pinned ? worker : null;
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

async function createWorker(visible) {
  if (visible) {
    // 读取列表的兜底方式需要页面可见：窄于 500 像素时 X 会切到手机布局，所以留足宽度。
    const win = await chrome.windows.create({ url: 'about:blank', type: 'popup', focused: true, width: 760, height: 900 });
    return { tabId: win.tabs[0].id, windowId: win.id, kind: 'window' };
  }
  let win = null;
  try { win = await chrome.windows.getLastFocused({ windowTypes: ['normal'] }); } catch { win = null; }
  if (!win) {
    const created = await chrome.windows.create({ url: 'about:blank', state: 'minimized' });
    const tab = created.tabs[0];
    await chrome.tabs.update(tab.id, { pinned: true, autoDiscardable: false });
    return { tabId: tab.id, windowId: created.id, kind: 'tab' };
  }
  const tab = await chrome.tabs.create({ windowId: win.id, url: 'about:blank', active: false, pinned: true, index: 0 });
  try { await chrome.tabs.update(tab.id, { autoDiscardable: false }); } catch { /* 老版本不支持 */ }
  return { tabId: tab.id, windowId: win.id, kind: 'tab' };
}

// 在自己的后台标签页（或兜底的读取窗口）里打开页面，等加载完。
async function openInWorker(url, opts) {
  const visible = !!(opts && opts.visible);
  let worker = await getWorker();
  if (worker && (worker.kind === 'window') !== visible) {
    await closeWorker();
    worker = null;
  }
  if (!worker) {
    worker = await createWorker(visible);
    await store.set({ worker });
    await sleep(300);
  } else if (visible) {
    try { await chrome.windows.update(worker.windowId, { focused: true }); } catch { /* 忽略 */ }
  }
  const loaded = waitForComplete(worker.tabId);
  await chrome.tabs.update(worker.tabId, { url });
  await loaded;
  return worker.tabId;
}

async function closeWorker() {
  const worker = await getWorker();
  // 先清掉记录再关，这样关闭事件不会被当成「你手动关掉了」。
  await store.set({ worker: null });
  if (!worker) return;
  try {
    if (worker.kind === 'window') await chrome.windows.remove(worker.windowId);
    else await chrome.tabs.remove(worker.tabId);
  } catch { /* 已关闭 */ }
}

// 只有正在处理一批或正在读取时才保留后台标签页；批次间休息、暂停、完成时都关掉，下次需要再开。
async function closeWorkerIfIdle() {
  const job = await getJob();
  const collect = await getCollect();
  const busy = job.status === 'running' && (job.current || job.batch.length);
  if (busy || (collect && collect.status === 'running' && !collect.waitingUntil)) return;
  await closeWorker();
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

async function pingTab(tabId) {
  try {
    return await Promise.race([chrome.tabs.sendMessage(tabId, { type: 'xa:ping-page' }), sleep(2500).then(() => null)]);
  } catch {
    return null;
  }
}

// 插件安装或更新前就打开的 x.com 页面里没有新脚本，补注入一次，免得你手动刷新。
async function injectInto(tabId) {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['src/content/page-hook.js'], world: 'MAIN' });
    await chrome.scripting.executeScript({ target: { tabId }, files: CONTENT_FILES });
    return true;
  } catch {
    return false;
  }
}

async function injectIntoOpenTabs() {
  const tabs = await chrome.tabs.query({ url: ['https://x.com/*'] });
  for (const t of tabs) {
    if (!t.discarded && t.status === 'complete') await injectInto(t.id);
  }
}

// 找一个能执行接口请求的 x.com 页面。allowCreate 为 false 时不会新开标签页。
async function getContextTab(allowCreate = true) {
  const worker = await getWorker();
  const tabs = await chrome.tabs.query({ url: ['https://x.com/*'] });
  const mine = worker && worker.kind === 'tab' ? worker.tabId : null;
  const yours = tabs.filter((t) => !t.discarded && !t.frozen && t.id !== mine && !(worker && t.id === worker.tabId));
  for (const t of yours) {
    if (await pingTab(t.id)) return t.id;
  }
  for (const t of yours.filter((x) => x.status === 'complete').slice(0, 2)) {
    if (await injectInto(t.id) && await pingTab(t.id)) return t.id;
  }
  if (mine && await pingTab(mine)) return mine;
  if (!allowCreate) return null;
  const tabId = await openInWorker('https://x.com/home');
  for (let i = 0; i < 10; i++) {
    if (await pingTab(tabId)) return tabId;
    await sleep(500);
  }
  return tabId;
}

async function getXmeta() {
  const { xmeta } = await store.get('xmeta');
  return xmeta || { bearer: null, ops: {}, features: {} };
}

// 在 x.com 页面里调用接口。页面被关掉或没响应时换一个页面再试一次。
async function apiCall(req) {
  const xmeta = await getXmeta();
  const full = { ...req, bearer: xmeta.bearer || self.XAPI.WEB_BEARER };
  for (let attempt = 0; attempt < 2; attempt++) {
    let tabId;
    try {
      tabId = await getContextTab(true);
    } catch (e) {
      return { status: 0, error: `no_context: ${e.message}` };
    }
    try {
      const r = await Promise.race([
        chrome.tabs.sendMessage(tabId, { type: 'xa:api', req: full }),
        sleep(30000).then(() => ({ status: 0, error: 'timeout' })),
      ]);
      if (r && !(r.error && /network/.test(r.error) && attempt === 0)) return r;
    } catch {
      // 页面刚被关掉或跳走了，换一个
    }
  }
  return { status: 0, error: 'no_context' };
}

let accountCache = null;

// 当前在 x.com 登录的是谁。先看页面左侧导航，看不到再问接口。
async function currentAccount(force) {
  if (!force && accountCache && Date.now() - accountCache.at < 5 * 60 * 1000) return accountCache;
  let info = null;
  try {
    const tabId = await getContextTab(true);
    info = await sendToTab(tabId, { type: 'xa:pageInfo' }, 10000);
  } catch {
    info = null;
  }
  let handle = info && info.handle;
  const loggedOut = !!(info && info.loggedOut);
  if (!handle && !loggedOut) {
    const r = await apiCall(self.XAPI.settingsRequest());
    if (r && r.status === 200 && r.json && r.json.screen_name) handle = r.json.screen_name;
  }
  accountCache = { handle: handle || null, loggedOut, userId: (info && info.userId) || null, scripts: (info && info.scripts) || [], at: Date.now() };
  await noteMe(handle);
  return accountCache;
}

// 记下最近在 x.com 上看到的登录账号。只在账号变了时写入，避免频繁写存储（管理页会监听这一项）。
async function noteMe(handle) {
  if (!handle) return;
  const { me } = await store.get('me');
  if (me && me.handle === handle && Date.now() - (me.at || 0) < 3600 * 1000) return;
  await store.set({ me: { handle, at: Date.now() } });
}

async function getExec() {
  const { exec } = await store.get('exec');
  return exec || {};
}

// ---------- 关注列表 ----------

const COLLECT_STALE_MS = 3 * 60 * 1000;

// 读取中的页面崩溃、被关闭或跳走时收不到「完成」消息，超过 3 分钟没有进度就当作已中断。
async function getCollect() {
  const { collect } = await store.get('collect');
  // 后台读取会从记下的位置自动续读（见 tick），只有窗口读取需要判定中断。
  if (collect && collect.status === 'running' && collect.mode === 'window') {
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
  // X 的关注列表是按关注时间从新到旧排的。浏览器存储会把键按字母重排，所以单独记一个序号保留这个顺序。
  // 每次完整读取都从头编号，新读到的人排在前面。
  const ordered = users.filter((u) => u.youFollow !== false);
  let seq = runId ? Object.values(map).filter((u) => u.runId === runId).reduce((m, u) => Math.max(m, u.seq || 0), 0) : 0;
  for (const u of ordered) {
    const key = S.userKey(u.handle);
    if (!key) continue;
    const prev = map[key];
    if (!prev) added++;
    const merged = { ...(prev || { firstSeen: now }) };
    if (runId && (!prev || prev.runId !== runId)) merged.seq = ++seq;
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
  await store.set({ collect: { status: 'running', mode: 'api', runId, startedAt: Date.now(), lastProgressAt: Date.now(), count: 0, seen: 0, message: '正在后台读取…' } });
  // 不等读取结束就返回，管理页通过存储的进度更新界面。
  collectViaApi(runId).catch((e) => console.error('[X 助手] 读取出错', e));
}

const collectErr = (message, fallback) => Object.assign(new Error(message), { fallback: !!fallback });

// 找到 Following 这个 GraphQL 操作的 queryId 和参数：页面上记下来的优先，没有就从 X 的前端代码里找。
async function getFollowingOp(scripts, refresh) {
  const xmeta = await getXmeta();
  const cached = xmeta.ops && xmeta.ops.Following;
  if (cached && cached.qid && !refresh) return cached;
  for (const src of scripts || []) {
    try {
      const text = await (await fetch(src)).text();
      const op = self.XAPI.findOperation(text, 'Following');
      if (op) {
        const found = {
          qid: op.qid,
          featureNames: op.featureNames,
          fieldToggles: op.fieldToggleNames.length ? Object.fromEntries(op.fieldToggleNames.map((n) => [n, false])) : null,
          at: Date.now(),
          from: 'bundle',
        };
        await saveXmeta({ ops: { Following: found } });
        return found;
      }
    } catch {
      // 换下一个文件
    }
  }
  return cached && cached.qid ? cached : null;
}

const saveXmeta = (patch) => withLock(async () => {
  const xmeta = await getXmeta();
  const next = {
    bearer: patch.bearer || xmeta.bearer || null,
    ops: { ...(xmeta.ops || {}), ...(patch.ops || {}) },
    features: { ...(xmeta.features || {}), ...(patch.features || {}) },
  };
  await store.set({ xmeta: next });
});

let apiCollectRunning = false;

const setCollect = (patch) => withCollectLock(async () => {
  const { collect } = await store.get('collect');
  if (!collect || collect.runId !== patch.runId || collect.status !== 'running') return false;
  await store.set({ collect: { ...collect, ...patch } });
  return true;
});

// 后台读取关注列表：在 x.com 页面里一页页调用 Following 接口，不需要滚动页面。
// 被 X 限制频率时记下位置，等限制解除后自动接着读。
async function collectViaApi(runId, resume) {
  if (apiCollectRunning) return;
  apiCollectRunning = true;
  try {
    const acct = await currentAccount(true);
    if (acct.loggedOut) throw collectErr('x.com 没有登录，请先在 Chrome 里登录 x.com。');
    const { me } = await store.get('me');
    const handle = acct.handle || (resume && resume.handle) || (me && me.handle);
    if (!handle) throw collectErr('没有检测到已登录的账号，请先在 Chrome 里打开并登录 x.com。');
    const userId = acct.userId || (resume && resume.userId);
    if (!userId) throw collectErr('没拿到账号 ID', true);
    // owner 记的是「这份关注列表属于谁」；me 会随你打开的任何 x.com 页面更新，不能拿来核对。
    await store.set({ owner: { handle, at: Date.now() } });
    let op = await getFollowingOp(acct.scripts);
    if (!op) throw collectErr('没找到读取接口', true);

    let cursor = (resume && resume.cursor) || null;
    let seen = (resume && resume.seen) || 0;
    let pages = 0;
    let refreshed = false;
    await setCollect({ runId, handle, userId, message: seen ? `已读取 ${seen} 个，继续读取…` : '正在后台读取…', waitingUntil: 0, lastProgressAt: Date.now() });

    for (;;) {
      const { collect } = await store.get('collect');
      if (!collect || collect.runId !== runId || collect.status !== 'running') {
        // 被停止了。停止时可能有一个请求正在路上，它为此新开的后台标签页要关掉。
        await closeWorkerIfIdle();
        return;
      }
      const xmeta = await getXmeta();
      const r = await apiCall(self.XAPI.followingRequest(op, userId, cursor, xmeta.features));
      const rate = (r && r.rate) || {};
      if (r && r.status === 429) {
        const until = Number(rate.reset) ? Number(rate.reset) * 1000 + 5000 : Date.now() + 15 * 60 * 1000;
        await setCollect({ runId, cursor, seen, waitingUntil: until, lastProgressAt: until, message: `X 限制了读取频率，已读取 ${seen} 个，${new Date(until).toLocaleTimeString()} 自动继续` });
        await closeWorkerIfIdle();
        await kick();
        return;
      }
      if (!r || r.error || r.status !== 200 || !r.json || (r.json.errors && !r.json.data)) {
        // 接口地址可能随 X 更新变了：重新找一次 queryId 再试。
        if (!refreshed && r && !r.error && [400, 404].includes(r.status)) {
          refreshed = true;
          op = await getFollowingOp(acct.scripts, true);
          if (op) continue;
        }
        if (pages === 0 && !seen) throw collectErr(`接口返回 ${r ? r.status || r.error : '无响应'}`, true);
        await finishCollectLocked({ runId, complete: false, seen, reason: `读取到 ${seen} 个时出错（${r ? r.status || r.error : '无响应'}），已保存，可以稍后重新读取` });
        return;
      }
      const users = self.XAPI.parseGraphQLUsers(r.json).filter((u) => u.youFollow !== false);
      const next = self.XAPI.bottomCursor(r.json);
      if (users.length) await mergeUsers(users, runId);
      seen += users.length;
      pages += 1;
      await setCollect({ runId, cursor: next, seen, lastProgressAt: Date.now(), message: `已读取 ${seen} 个` });
      if (!users.length || !next || next === cursor) {
        await finishCollectLocked({ runId, complete: true, seen });
        return;
      }
      cursor = next;
      // 额度快用完了就先等到重置，不去撞限制。
      if (rate.remaining !== null && rate.remaining !== undefined && Number(rate.remaining) <= 1 && Number(rate.reset)) {
        const until = Number(rate.reset) * 1000 + 5000;
        await setCollect({ runId, cursor, seen, waitingUntil: until, lastProgressAt: until, message: `已读取 ${seen} 个，为避免触发 X 的频率限制，${new Date(until).toLocaleTimeString()} 自动继续` });
        await closeWorkerIfIdle();
        await kick();
        return;
      }
      await sleep(rand(1200, 2600));
    }
  } catch (e) {
    if (e.fallback) {
      // 后台读取用不了，改成打开读取窗口滚动列表。
      apiCollectRunning = false;
      await collectViaWindow(runId, e.message);
      return;
    }
    await withCollectLock(async () => {
      const { collect } = await store.get('collect');
      if (collect && collect.runId === runId) await store.set({ collect: { ...collect, status: 'error', message: e.message } });
    });
    await closeWorkerIfIdle();
  } finally {
    apiCollectRunning = false;
  }
}

// 兜底：打开一个读取窗口，自动滚动「正在关注」页面（窗口被挡住时 X 不加载下一页，所以要放在前面）。
async function collectViaWindow(runId, why) {
  try {
    await setCollect({ runId, mode: 'window', lastProgressAt: Date.now(), message: `后台读取不可用（${why}），改用读取窗口…` });
    let tabId = await openInWorker('https://x.com/home', { visible: true });
    const who = await sendToTab(tabId, { type: 'xa:whoami' }, 20000);
    if (who && who.loggedOut) throw new Error('x.com 没有登录，请先在 Chrome 里登录 x.com。');
    const { me } = await store.get('me');
    const handle = (who && who.handle) || (me && me.handle);
    if (!handle) throw new Error('没有检测到已登录的账号，请先在 Chrome 里打开并登录 x.com。');
    await store.set({ me: { handle, at: Date.now() }, owner: { handle, at: Date.now() } });
    tabId = await openInWorker(`https://x.com/${handle}/following`, { visible: true });
    const r = await sendToTab(tabId, { type: 'xa:collect', runId }, 15000);
    if (!r || !r.started) throw new Error('页面没有开始读取，请刷新后重试。');
    await setCollect({ runId, handle, lastProgressAt: Date.now(), message: '正在读取窗口里滚动读取，请不要关闭或挡住它…' });
  } catch (e) {
    await withCollectLock(async () => {
      const { collect } = await store.get('collect');
      if (collect && collect.runId === runId) {
        await store.set({ collect: { ...collect, status: 'error', message: e.message === 'timeout' ? '打开 x.com 超时' : e.message } });
      }
    });
    await closeWorkerIfIdle();
  }
}

const finishCollectLocked = (msg) => withCollectLock(() => finishCollect(msg));

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
    const { users, whitelist, log } = await store.get(['users', 'whitelist', 'log']);
    const map = users || {};
    const wl = whitelist || {};
    // 取关成功的人会从本地列表里删掉；重新关注时从日志里找回他的 ID，这样也能走后台接口。
    const idFromLog = {};
    for (const l of Array.isArray(log) ? log : []) if (l.id) idFromLog[l.key] = l.id;
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
      items.push({ key, handle, id: u.id || idFromLog[key] || null, name: u.name || '', action, addedAt: Date.now() });
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
  job.lastError = `${RESULT_LABELS[reason] || reason}${detail ? `（${String(detail).replace(/[.。\s]+$/, '')}）` : ''}`;
  await saveJob(job);
  notify('X 助手已自动暂停取关', `${job.lastError}。建议休息 24 小时后再继续。`);
  await closeWorkerIfIdle();
}

// 执行一次取关或重新关注。默认走后台接口；接口不可用时自动改成在后台标签页里点按钮。
async function perform(item, settings) {
  const exec = await getExec();
  const apiOk = Date.now() >= (exec.apiBrokenUntil || 0);
  if (settings.execMode !== 'ui' && apiOk && item.id) {
    const r = await performApi(item, settings);
    if (r.result !== 'api_unavailable') {
      if (exec.lastVia !== 'api') await store.set({ exec: { ...exec, lastVia: 'api' } });
      return r;
    }
    // 这次不算失败：记下来，24 小时内都用备用方式，然后马上用备用方式重做这一个。
    await store.set({ exec: { ...exec, apiBrokenUntil: Date.now() + API_RETRY_MS, apiError: r.detail || '', lastVia: 'ui' } });
  }
  const r = await performUi(item, settings);
  return r;
}

async function performApi(item, settings) {
  const { owner, me } = await store.get(['owner', 'me']);
  const expected = (owner && owner.handle) || (me && me.handle);
  const acct = await currentAccount();
  if (acct.loggedOut) return { result: 'logged_out' };
  if (acct.handle && expected && acct.handle.toLowerCase() !== expected.toLowerCase()) {
    accountCache = null; // 下次重新确认
    return { result: 'wrong_account', detail: `现在登录的是 @${acct.handle}，关注列表是 @${expected} 的` };
  }
  if (settings.dryRun) {
    // 演练：只做一次只读请求，确认接口和登录状态都正常，不动关注关系。
    const c = self.XAPI.classifyFriendship('unfollow', await apiCall(self.XAPI.settingsRequest()));
    return c.result === 'ok' ? { result: 'dry_run', detail: '后台接口可用' } : c;
  }
  const r = await apiCall(self.XAPI.friendshipRequest(item.action, item.id));
  return self.XAPI.classifyFriendship(item.action, r);
}

async function performUi(item, settings) {
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
    await resumeCollectIfNeeded();
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
    id: item.id || null,
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
  const loggedOut = result === 'logged_out' || (result === 'auth' && /没有登录/.test(res.detail || ''));
  if (result === 'wrong_account' || loggedOut) {
    // 不是 X 的限制，不用冷却；队列原样保留，登录或切回正确的账号后点继续即可。
    latest.status = 'paused';
    latest.lastError = loggedOut
      ? 'x.com 没有登录。请在 Chrome 里登录 x.com 后点「继续取关」。'
      : `${res.detail || '登录的账号和关注列表不一致'}。请在 x.com 切换到正确的账号后点「继续取关」。`;
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
    if (!(await getQueue()).length && latest.status === 'running') {
      // 队列已经做完了，不用再等一轮批次休息才宣布完成。
      latest.status = 'idle';
      latest.lastError = '';
      await saveJob(latest);
      notify('X 助手：队列已完成', `今天共处理 ${latest.doneToday} 个。`);
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

async function resumeCollectIfNeeded() {
  if (apiCollectRunning) return;
  const { collect } = await store.get('collect');
  if (!collect || collect.status !== 'running' || collect.mode !== 'api') return;
  if (collect.waitingUntil && Date.now() < collect.waitingUntil) return;
  // 频率限制解除了，或者上次读取被浏览器中断了：从记下的位置接着读。
  collectViaApi(collect.runId, { cursor: collect.cursor, seen: collect.seen || 0, handle: collect.handle, userId: collect.userId })
    .catch((e) => console.error('[X 助手] 续读出错', e));
}

async function scheduleNext() {
  const job = await getJob();
  const { collect } = await store.get('collect');
  await updateBadge();
  const collecting = collect && collect.status === 'running' && collect.mode === 'api';
  if (job.status === 'running' || job.status === 'daily_cap' || collecting) {
    const delay = Math.max(0, job.nextActionAt - Date.now());
    if (job.status === 'running' && delay < 25000) setTimeout(tick, delay + 100);
    // 读取被限速、很快就能继续时不等下一次闹钟。
    const wait = collecting && collect.waitingUntil ? collect.waitingUntil - Date.now() : -1;
    if (wait >= 0 && wait < 25000) setTimeout(tick, wait + 100);
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
      await noteMe(msg.handle);
      return { ok: true };
    case 'xa:xmeta': {
      // 页面自己发请求时用的令牌和 GraphQL 参数，后台读取关注列表时照着用。
      const m = msg.meta || {};
      const patch = {};
      if (typeof m.bearer === 'string' && m.bearer.length > 20) patch.bearer = m.bearer;
      if (m.gql && m.gql.name && m.gql.qid) {
        if (m.gql.features && typeof m.gql.features === 'object') patch.features = m.gql.features;
        if (m.gql.name === 'Following') {
          const prev = (await getXmeta()).ops.Following || {};
          patch.ops = {
            Following: {
              ...prev,
              qid: m.gql.qid,
              featureNames: m.gql.features ? Object.keys(m.gql.features) : prev.featureNames || null,
              features: m.gql.features || prev.features || null,
              fieldToggles: m.gql.fieldToggles || prev.fieldToggles || null,
              at: Date.now(),
              from: 'page',
            },
          };
        }
      }
      if (Object.keys(patch).length) await saveXmeta(patch);
      return { ok: true };
    }
    case 'xa:account': {
      // 管理页显示「当前登录的账号」：只看已经打开的 x.com 页面，不为此新开标签页。
      const { owner, me } = await store.get(['owner', 'me']);
      let live = null;
      const tabId = await getContextTab(false).catch(() => null);
      if (tabId) {
        const info = await sendToTab(tabId, { type: 'xa:pageInfo' }, 5000).catch(() => null);
        if (info && (info.handle || info.loggedOut)) {
          live = { handle: info.handle || null, loggedOut: !!info.loggedOut };
          await noteMe(info.handle);
        }
      }
      return { live, owner: owner || null, me: me || null, hasTab: !!tabId };
    }
    case 'xa:resetExec':
      await store.set({ exec: {} });
      return { ok: true };
    case 'xa:users':
      return mergeUsers(msg.users || [], msg.runId);
    case 'xa:collect-progress':
      await withCollectLock(async () => {
        const { collect } = await store.get('collect');
        if (collect && collect.runId === msg.runId && collect.status === 'running') {
          const { users } = await store.get('users');
          const message = msg.hidden
            ? `已读取 ${msg.seen} 个。读取窗口被挡住或最小化了，X 不会继续加载，请把那个窗口露出来`
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
      const [job, queue, settings, rest, collect] = await Promise.all([
        getJob(), getQueue(), getSettings(), store.get(['me', 'owner', 'exec']), getCollect(),
      ]);
      const exec = rest.exec || {};
      return {
        job, queueLength: queue.length, cap: S.effectiveDailyCap(settings),
        queueCounts: { unfollow: queue.filter((q) => q.action !== 'follow').length, follow: queue.filter((q) => q.action === 'follow').length },
        collect, me: rest.me || null, owner: rest.owner || null, dryRun: settings.dryRun,
        llmConfigured: llmConfigured(settings.llm),
        exec: {
          mode: settings.execMode,
          apiBroken: Date.now() < (exec.apiBrokenUntil || 0),
          apiBrokenUntil: exec.apiBrokenUntil || 0,
          apiError: exec.apiError || '',
          lastVia: exec.lastVia || null,
        },
        eta: S.estimateFinish(job, queue.length, settings, Date.now()),
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

// 点通知打开管理页的「取关任务」。
chrome.notifications.onClicked.addListener((id) => {
  if (!String(id).startsWith('xa-')) return;
  chrome.tabs.create({ url: chrome.runtime.getURL('src/options/options.html#job') });
  chrome.notifications.clear(id);
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === TICK_ALARM) tick();
});

// 你手动关掉了插件的后台标签页（或兜底的读取窗口）：暂停，不在你眼前反复重新打开。
async function onWorkerClosed(match) {
  const { worker: stored } = await store.get('worker');
  if (!stored || !match(stored)) return;
  await store.set({ worker: null });
  const job = await getJob();
  if (job.status === 'running' && (job.current || job.batch.length)) {
    job.status = 'paused';
    job.lastError = stored.kind === 'window'
      ? '工作窗口被关闭，任务已暂停。'
      : '插件的后台标签页被关闭，任务已暂停。点「继续取关」即可恢复；保持任意一个 x.com 页面开着，插件就会借用它在后台运行，不再新开标签页。';
    await saveJob(job);
    await updateBadge();
  }
  const { collect } = await store.get('collect');
  if (collect && collect.status === 'running' && collect.mode === 'window') {
    await store.set({ collect: { ...collect, status: 'stopped', message: '读取窗口被关闭' } });
  }
}

chrome.windows.onRemoved.addListener((windowId) => {
  onWorkerClosed((w) => w.kind === 'window' && w.windowId === windowId).catch(() => {});
});

chrome.tabs.onRemoved.addListener((tabId, info) => {
  // 整个窗口关闭时一起关掉的标签页不算你手动关的；浏览器退出时下次启动会清掉记录。
  if (info && info.isWindowClosing) {
    store.get('worker').then(({ worker }) => {
      if (worker && worker.kind === 'tab' && worker.tabId === tabId) store.set({ worker: null });
    });
    return;
  }
  onWorkerClosed((w) => w.kind === 'tab' && w.tabId === tabId).catch(() => {});
});

chrome.runtime.onInstalled.addListener(async (details) => {
  const { settings } = await store.get('settings');
  await store.set({ settings: S.mergeSettings(settings) });
  // 更新后旧的执行环境记录作废：新版本可能修好了接口问题。
  if (details.reason === 'update') await store.set({ exec: {} });
  if (details.reason === 'install') chrome.runtime.openOptionsPage();
  // 已经打开的 x.com 页面补上新脚本，不用手动刷新。
  await injectIntoOpenTabs().catch(() => {});
  await kick();
});

chrome.runtime.onStartup.addListener(async () => {
  // 上次的工作标签页已经不在了，记录作废。
  await store.set({ worker: null });
  accountCache = null;
  await kick();
});

// 设置变了（比如关掉了「每批确认」）立刻按新设置跑一次。
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.settings) kick();
});
