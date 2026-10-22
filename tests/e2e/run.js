// 端到端冒烟测试：加载插件，用模拟的 x.com（页面 + 网页版接口）跑一遍主要流程。
// 运行：node tests/e2e/run.js   （需要 playwright 和 Chromium）
'use strict';

// 让 Playwright 也能拦截 service worker 发出的请求（插件后台会去下载 X 的前端代码找接口参数）。
process.env.PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS = '1';

const path = require('path');
const fs = require('fs');
const os = require('os');
const { chromium } = require('playwright');
const mock = require('./mock-x');
const mockSources = require('./mock-sources');

const EXT = path.resolve(__dirname, '../..');
const OUT = path.resolve(__dirname, 'out');
fs.mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms, label) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`等待超时：${label}`);
    await sleep(500);
  }
}

const errors = [];

(async () => {
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xa-e2e-'));
  const context = await chromium.launchPersistentContext(userDir, {
    channel: 'chromium',
    headless: true,
    viewport: { width: 1280, height: 900 },
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  });
  context.on('page', (p) => {
    p.on('pageerror', (e) => errors.push(`${p.url()} ${e.message}`));
    p.on('console', (m) => { if (m.type() === 'error' && !/favicon|Failed to load resource/.test(m.text())) errors.push(`${p.url()} ${m.text()}`); });
  });
  await context.addCookies(mock.COOKIES);
  await context.route('https://x.com/**', mock.route);
  await context.route('https://pbs.twimg.com/**', (r) => r.fulfill({ status: 200, contentType: 'image/png', body: Buffer.alloc(0) }));
  await context.route('https://abs.twimg.com/**', mock.routeStatic);

  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent('serviceworker');
  const extId = sw.url().split('/')[2];
  console.log('扩展 ID', extId);

  const opts = context.pages().find((p) => p.url().includes(extId)) || await context.newPage();
  opts.on('pageerror', (e) => errors.push(`${opts.url()} ${e.message}`));
  opts.on('console', (m) => { if (m.type() === 'error' && !/favicon|Failed to load resource/.test(m.text())) errors.push(`${opts.url()} ${m.text()}`); });
  await opts.goto(`chrome-extension://${extId}/src/options/options.html`);
  // 安装时打开的其他页面关掉，确保一开始没有任何 x.com 标签页。
  for (const p of context.pages()) if (p !== opts) await p.close();
  const get = (k) => opts.evaluate((key) => chrome.storage.local.get(key).then((r) => r[key]), k);
  const send = (msg) => opts.evaluate((m) => chrome.runtime.sendMessage(m), msg);

  // 默认设置：加入队列自动开始、批次之间不用确认、后台接口、任务中不让电脑休眠
  if (await sw.evaluate(() => typeof chrome.power.requestKeepAwake) !== 'function') throw new Error('缺少防休眠权限');
  const defaults = await get('settings');
  if (!defaults.keepAwake) throw new Error('默认应该开启防休眠');
  if (!defaults.autoStart || defaults.confirmEachBatch) throw new Error('默认应该自动开始、不用每批确认');
  if (defaults.execMode !== 'auto') throw new Error('默认执行方式应该是后台接口');

  if (defaults.ui || (defaults.llm && defaults.llm.apiKey)) throw new Error('推文体检的设置应该已经去掉，模型 key 不能放在设置里');

  // 设置：最快允许的节奏
  await opts.evaluate(() => chrome.storage.local.get('settings').then(({ settings }) => chrome.storage.local.set({ settings: {
    ...settings,
    pace: { minDelaySec: 5, maxDelaySec: 5, batchSize: 5, restMinMin: 10, restMaxMin: 10, dailyCap: 100 },
  } })));
  await opts.reload();
  await opts.evaluate(() => { window.__errs = []; window.addEventListener('error', (e) => window.__errs.push(String(e.message) + ' ' + (e.error && e.error.stack))); window.addEventListener('unhandledrejection', (e) => window.__errs.push('rej ' + (e.reason && e.reason.stack))); });

  // 记录插件有没有弹出窗口、有没有开后台标签页。
  const watch = () => opts.evaluate(() => {
    window.__seen = { popups: 0, workers: [] };
    if (window.__watching) return;
    window.__watching = true;
    chrome.windows.onCreated.addListener((w) => { if (w.type === 'popup') window.__seen.popups += 1; });
    chrome.storage.onChanged.addListener((c) => { if (c.worker && c.worker.newValue) window.__seen.workers.push(c.worker.newValue.kind); });
  });
  const seen = () => opts.evaluate(() => window.__seen);
  const pinnedTabs = () => opts.evaluate(() => chrome.tabs.query({ pinned: true }).then((t) => t.length));

  // 1. 后台读取关注列表：没开 x.com 时用固定的后台标签页，中途被限速一次，自动等待后续读，全程不弹窗口
  console.log('▶ 后台读取关注列表');
  await watch();
  mock.state.rateLimitOnce = true;
  await opts.click('#collectBtn');
  const sawWait = until(async () => { const c = await get('collect'); return c && c.waitingUntil ? c : null; }, 60000, '限速等待');
  const waiting = await sawWait;
  console.log('  ', waiting.message);
  const collect = await until(async () => { const c = await get('collect'); return c && c.status !== 'running' ? c : null; }, 90000, '读取完成');
  const users = await get('users');
  console.log('  结果', collect.status, collect.message, Object.keys(users || {}).length, '人');
  if (collect.status !== 'done' || collect.mode !== 'api') throw new Error(`应该在后台读取完成：${JSON.stringify(collect)}`);
  if (Object.keys(users).length !== 30) throw new Error('应该读取到 30 人');
  if (users.user4.followers !== 3 || users.user3.followsYou !== true || users.user1.followsYou !== false || users.user1.id !== '1001') throw new Error('字段解析不对');
  if ((await get('me')).handle !== 'tester' || (await get('owner')).handle !== 'tester') throw new Error('没有识别账号');
  const xmeta = await get('xmeta');
  if (!xmeta.ops.Following || xmeta.ops.Following.qid !== 'abc') throw new Error('没有从前端代码里找到读取接口');
  let s1 = await seen();
  console.log('  弹出窗口', s1.popups, '个，后台标签页', s1.workers.join(',') || '无');
  if (s1.popups) throw new Error('后台读取不应该弹出窗口');
  if (!s1.workers.includes('tab')) throw new Error('没开 x.com 时应该用后台标签页');
  await sleep(500);
  if (await get('worker') || await pinnedTabs()) throw new Error('读取完成后应该关掉后台标签页');

  // 2. 筛选「不回关」
  await opts.click('#tabs button[data-tab="users"]');
  if (!(await opts.isHidden('#onboard'))) throw new Error('有数据后应该隐藏新手引导');
  await opts.click('#tagFilters label[data-tag="notFollowBack"]');
  const summary = await opts.textContent('#userSummary');
  console.log('  筛选', summary);
  if (!summary.includes('筛选出 20 人')) throw new Error('不回关筛选结果不对');
  await opts.screenshot({ path: path.join(OUT, 'users.png'), fullPage: false });

  // 之后的步骤模拟「你自己开着 x.com」：插件应该借用这个页面，不新开任何标签页或窗口。
  const home = await context.newPage();
  await home.goto('https://x.com/home');
  await opts.bringToFront();
  await watch();

  // 3. 演练：加入队列后自动开始，跑完一批就停，队列保持不变
  console.log('▶ 演练');
  const setSetting = (patch) => opts.evaluate((p) => chrome.storage.local.get('settings').then(({ settings }) => chrome.storage.local.set({ settings: { ...settings, ...p } })), patch);
  await setSetting({ dryRun: true });
  await opts.evaluate(() => chrome.storage.local.set({ whitelist: { user5: true } }));
  const enq = await send({ type: 'xa:enqueue', keys: ['user1', 'user2', 'user29', 'user5'], action: 'unfollow' });
  if (enq.added !== 3 || enq.skipped !== 1) throw new Error('白名单没有生效');
  if (!enq.started) throw new Error(`加入队列后应该自动开始：${JSON.stringify(enq)}`);
  await until(async () => { const j = await get('job'); return j && j.status === 'idle' && !j.current ? j : null; }, 60000, '演练结束');
  const dryLog = await get('log');
  console.log('  演练日志', dryLog.map((l) => `${l.handle}:${l.result}(${l.detail})`).join(' '));
  if (dryLog.length !== 3 || dryLog.some((l) => l.result !== 'dry_run')) throw new Error('演练结果不对');
  if ((await get('queue')).length !== 3) throw new Error('演练不应该改动队列');
  if (mock.state.calls.destroy) throw new Error('演练不应该调用取关接口');

  // 4. 后台分批取关：user1、user2 成功，user29 被 X 拒绝（限额）后熔断
  console.log('▶ 后台分批取关');
  await setSetting({ dryRun: false });
  await opts.click('#tabs button[data-tab="job"]');
  await until(() => opts.$('#jobButtons [data-do="start"]'), 5000, '开始按钮');
  await opts.click('#jobButtons [data-do="start"]');
  const job = await until(async () => { const j = await get('job'); return j && j.status === 'tripped' ? j : null; }, 60000, '熔断');
  const log = (await get('log')).filter((l) => !l.dryRun);
  console.log('  日志', log.map((l) => `${l.handle}:${l.result}`).join(' '));
  console.log('  状态', job.status, job.lastError);
  const res = Object.fromEntries(log.map((l) => [l.handle, l.result]));
  if (res.user1 !== 'ok' || res.user2 !== 'ok' || res.user29 !== 'rate_limited') throw new Error('取关结果不对');
  if (mock.state.following.has('1001') || mock.state.following.has('1002')) throw new Error('X 那边应该已经取关');
  const users2 = await get('users');
  if (users2.user1 || users2.user2) throw new Error('取关成功的人应该从本地列表移除');
  const gap = log[1].t - log[0].t;
  console.log('  两次取关间隔', Math.round(gap / 1000), '秒');
  if (gap < 5000) throw new Error('间隔低于 5 秒');
  const s2 = await seen();
  console.log('  弹出窗口', s2.popups, '个，后台标签页', s2.workers.join(',') || '无');
  if (s2.popups || s2.workers.length) throw new Error('开着 x.com 时应该借用那个页面，不新开窗口或标签页');
  if ((await get('exec')).lastVia !== 'api') throw new Error('应该走后台接口');
  await opts.screenshot({ path: path.join(OUT, 'job.png') });

  // 5. 撤销：从日志重新关注 user1（ID 从日志里找回）
  console.log('▶ 重新关注');
  await send({ type: 'xa:enqueue', keys: ['user1'], action: 'follow', front: true });
  const q = await get('queue');
  if (q[0].handle !== 'user1' || q[0].action !== 'follow' || q[0].id !== '1001') throw new Error(`撤销没有排到队首或丢了 ID：${JSON.stringify(q[0])}`);

  // 6. 登录的账号和关注列表不是同一个时，不能动手，任务暂停
  console.log('▶ 账号核对');
  await opts.evaluate(() => chrome.storage.local.set({ owner: { handle: 'someone_else', at: Date.now() } }));
  await until(async () => !(await opts.isHidden('#acctWarnJob')), 10000, '账号不一致提醒');
  await send({ type: 'xa:resume', force: true });
  const wrong = await until(async () => { const j = await get('job'); return j && j.status === 'paused' ? j : null; }, 60000, '账号不对时暂停');
  console.log('  ', wrong.lastError);
  if (!wrong.lastError.includes('@tester')) throw new Error('应该提示登录的账号不对');
  if ((await get('log')).pop().result !== 'wrong_account') throw new Error('日志应该记录账号不对');
  if ((await get('queue'))[0].handle !== 'user1') throw new Error('账号不对时不应该改动队列');
  await opts.evaluate(() => chrome.storage.local.set({ owner: { handle: 'tester', at: Date.now() } }));

  // 7. X 改了接口：自动改为在后台标签页里点按钮，同样不弹窗口
  console.log('▶ 接口不可用时自动换成后台标签页');
  await home.close();
  await watch();
  mock.state.apiBroken = true;
  await send({ type: 'xa:clearQueue' });
  await send({ type: 'xa:enqueue', keys: ['user1'], action: 'follow' });
  await send({ type: 'xa:enqueue', keys: ['user3'], action: 'unfollow' });
  await send({ type: 'xa:resume' });
  await until(async () => { const j = await get('job'); return j && j.status === 'idle' && !j.current ? j : null; }, 90000, '备用方式执行完');
  const log7 = (await get('log')).slice(-2);
  console.log('  日志', log7.map((l) => `${l.handle}:${l.action}:${l.result}`).join(' '));
  if (log7.some((l) => l.result !== 'ok')) throw new Error('备用方式没有成功');
  if (!mock.state.following.has('1001') || mock.state.following.has('1003')) throw new Error('X 那边的关注状态不对');
  const exec = await get('exec');
  if (!(exec.apiBrokenUntil > Date.now()) || exec.lastVia !== 'ui') throw new Error(`应该记下接口不可用：${JSON.stringify(exec)}`);
  const s3 = await seen();
  console.log('  弹出窗口', s3.popups, '个，后台标签页', s3.workers.join(',') || '无');
  if (s3.popups) throw new Error('备用方式不应该弹出窗口');
  if (!s3.workers.includes('tab')) throw new Error('备用方式应该用后台标签页');
  await sleep(500);
  if (await pinnedTabs()) throw new Error('队列完成后应该关掉后台标签页');
  await until(async () => /接口暂不可用/.test(await opts.textContent('#execPill')), 5000, '顶部显示备用方式');
  await opts.screenshot({ path: path.join(OUT, 'fallback.png') });
  await send({ type: 'xa:resetExec' });
  mock.state.apiBroken = false;

  // 页面那边请求发不出去：不是 X 的限制，不能熔断 24 小时，而是等一会儿自动重试
  console.log('▶ 页面没有响应时自动退避');
  mock.state.friendshipsDown = true;
  const before = (await get('log')).length;
  const enq3 = await send({ type: 'xa:enqueue', keys: ['user6', 'user7', 'user8'], action: 'unfollow' });
  if (!enq3.started) throw new Error(`应该自动开始：${JSON.stringify(enq3)}`);
  const backed = await until(async () => {
    const j = await get('job');
    return j && !j.current && (await get('log')).length >= before + 3 ? j : null;
  }, 90000, '连续 3 次没有响应');
  const log8 = (await get('log')).slice(before);
  console.log('  日志', log8.map((l) => `${l.handle}:${l.result}`).join(' '));
  console.log('  状态', backed.status, Math.round((backed.nextActionAt - Date.now()) / 60000), '分钟后重试 |', backed.lastError);
  if (log8.some((l) => l.result !== 'no_response')) throw new Error('应该记成页面没有响应');
  if (backed.status !== 'running' || backed.nextActionAt - Date.now() < 14 * 60000 || !/自动重试/.test(backed.lastError)) throw new Error('应该等 15 分钟自动重试，而不是熔断');
  if ((await get('queue')).length !== 3) throw new Error('没响应的人应该还在队列里');
  await send({ type: 'xa:clearQueue' }); // 清空队列，任务回到空闲
  mock.state.friendshipsDown = false;

  // 8. 后台读取也不可用时，退回到读取窗口滚动列表
  console.log('▶ 兜底：读取窗口');
  mock.state.collectApiBroken = true;
  await send({ type: 'xa:collect' });
  const c2 = await until(async () => { const c = await get('collect'); return c && c.status !== 'running' ? c : null; }, 120000, '窗口读取完成');
  console.log('  结果', c2.mode, c2.status, c2.message, c2.count, '人');
  if (c2.mode !== 'window' || c2.status !== 'done' || c2.count !== mock.state.following.size) throw new Error('兜底读取不对');
  mock.state.collectApiBroken = false;

  // 9. 重新读取：在别处取关的人从列表里移除；日志显示取关成功、X 上却还在关注的人标出来，可以一键重新取关
  console.log('▶ 重新读取后更新列表');
  mock.state.following.delete('1010'); // user10 在手机上取关了
  mock.state.ignoreUnfollow = true; // X 对 user11 的取关返回成功，但实际没执行
  const enq9 = await send({ type: 'xa:enqueue', keys: ['user11'], action: 'unfollow' });
  if (!enq9.started) throw new Error(`应该自动开始：${JSON.stringify(enq9)}`);
  await until(async () => { const j = await get('job'); return j && j.status === 'idle' && !j.current ? j : null; }, 60000, '取关 user11');
  mock.state.ignoreUnfollow = false;
  if ((await get('log')).pop().result !== 'ok' || (await get('users')).user11) throw new Error('user11 应该记成取关成功并从本地移除');
  await opts.click('#tabs button[data-tab="users"]');
  await opts.click('#collectBtn');
  const c3 = await until(async () => { const c = await get('collect'); return c && c.status !== 'running' && c.startedAt > c2.finishedAt ? c : null; }, 90000, '重新读取完成');
  const users9 = await get('users');
  console.log('  结果', c3.mode, c3.status, c3.message);
  if (c3.mode !== 'api' || c3.status !== 'done') throw new Error('应该在后台读取完成');
  if (users9.user10) throw new Error('在别处取关的人应该从列表移除');
  if (Object.keys(users9).length !== mock.state.following.size) throw new Error('本地列表应该和 X 上一致');
  if (!users9.user11 || !users9.user11.unfollowFailed || c3.stillFollowing !== 1) throw new Error('取关没生效的人应该标出来');
  if (!/移除了 1 个/.test(c3.message)) throw new Error('读取结果应该说明移除了几个人');
  await until(async () => !(await opts.isHidden('#failedBanner')), 5000, '取关未生效提醒');
  console.log('  ', await opts.textContent('#failedText'));
  await opts.screenshot({ path: path.join(OUT, 'reread.png') });
  await opts.click('#requeueFailed');
  await until(async () => { const j = await get('job'); return j && j.status === 'idle' && !j.current && !(await get('queue')).length ? j : null; }, 60000, '重新取关 user11');
  if (mock.state.following.has('1011') || (await get('users')).user11) throw new Error('重新取关后 user11 应该不在列表里');
  await until(async () => opts.isHidden('#failedBanner'), 5000, '提醒消失');

  // 切换账号：任务进行中在 x.com 切到另一个账号（页面上的用户名一时还没变），后台不能在新账号上取关
  console.log('▶ 中途切换账号');
  if ((await get('owner')).userId !== '999') throw new Error('读取时应该记下列表主人的账号 ID');
  const twid = (id) => context.addCookies([{ ...mock.COOKIES.find((c) => c.name === 'twid'), value: `u%3D${id}` }]);
  await twid('555');
  const destroyBefore = mock.state.calls.destroy;
  await send({ type: 'xa:enqueue', keys: ['user12'], action: 'unfollow' });
  const switched = await until(async () => { const j = await get('job'); return j && j.status === 'paused' ? j : null; }, 60000, '切换账号后暂停');
  console.log('  ', switched.lastError);
  if (mock.state.calls.destroy !== destroyBefore || !mock.state.following.has('1012')) throw new Error('切换账号后不应该发出取关请求');
  if ((await get('log')).pop().result !== 'wrong_account') throw new Error('日志应该记录账号不对');
  // 队列不空时不能读取另一个账号的列表
  await opts.evaluate(() => chrome.storage.local.set({ owner: { handle: 'someone_else', userId: '777', at: Date.now() } }));
  await send({ type: 'xa:collect' });
  const refused = await until(async () => { const c = await get('collect'); return c && c.status === 'error' ? c : null; }, 30000, '拒绝读取');
  console.log('  ', refused.message);
  if (!/清空队列/.test(refused.message) || !(await get('users')).user12) throw new Error('队列不空时换账号读取应该被拒绝，且不动原来的列表');
  await opts.evaluate(() => chrome.storage.local.set({ owner: { handle: 'tester', userId: '999', at: Date.now() } }));
  await twid('999');
  await send({ type: 'xa:resume' });
  await until(async () => { const j = await get('job'); return j && j.status === 'idle' && !j.current ? j : null; }, 60000, '切回账号后继续');
  if (mock.state.following.has('1012')) throw new Error('切回原来的账号后应该继续取关');

  // X 中途返回出错的一页：重试，偶尔一次能自己恢复；一直出错就按没读完处理，不能把没读到的人删掉
  console.log('▶ X 中途返回出错的一页');
  const readOnce = async () => {
    const prev = (await get('collect')).startedAt;
    await send({ type: 'xa:collect' });
    return until(async () => { const c = await get('collect'); return c && c.startedAt > prev && c.status !== 'running' ? c : null; }, 90000, '读取结束');
  };
  const countBefore = Object.keys(await get('users')).length;
  mock.state.partialPages = 1;
  const c5 = await readOnce();
  console.log('  出错一次', c5.status, c5.message);
  if (c5.status !== 'done' || Object.keys(await get('users')).length !== countBefore) throw new Error('出错一次应该重试后读完');
  mock.state.partialPages = 3;
  const c6 = await readOnce();
  console.log('  一直出错', c6.status, c6.message);
  if (c6.status !== 'stopped' || Object.keys(await get('users')).length !== countBefore) throw new Error('一直出错应该按没读完处理，不删人');

  // 停止读取后马上重新读取：上一轮还没退出，新的一轮也要能读完
  console.log('▶ 停止后马上重新读取');
  await send({ type: 'xa:collect' });
  await sleep(300);
  await send({ type: 'xa:stopCollect' });
  const c7 = await readOnce();
  console.log('  ', c7.status, c7.message);
  if (c7.status !== 'done') throw new Error('停止后重新读取应该能读完');

  // 10. 预计完成时间：队列里放 150 人，按每天 100 个应该要跨天
  await send({ type: 'xa:pause' }).catch(() => {});
  await opts.click('#tabs button[data-tab="job"]');
  await opts.evaluate(() => chrome.storage.local.set({ queue: Array.from({ length: 150 }, (_, i) => ({ key: `fake${i}`, handle: `fake${i}`, id: String(5000 + i), action: 'unfollow', addedAt: Date.now() })) }));
  const etaText = await until(async () => { const t = await opts.textContent('#etaLine'); return /150 人/.test(t) && /\d+ 天/.test(t) ? t : null; }, 5000, '预计完成时间');
  console.log('  ', etaText);
  await opts.screenshot({ path: path.join(OUT, 'eta.png') });
  await send({ type: 'xa:clearQueue' });
  const st = await send({ type: 'xa:state' });
  if (st.exec.mode !== 'auto' || st.exec.apiBroken) throw new Error('重新尝试接口后应该恢复后台接口');
  const eta = await opts.evaluate(() => {
    const S = window.XAStore;
    const s = S.mergeSettings();
    return S.estimateFinish({ status: 'idle', doneToday: 0, day: S.dayKey() }, 150, s, Date.now());
  });
  if (!(eta.days >= 1)) throw new Error('150 人应该要跨天');

  // 11. 热点与推文建议
  console.log('▶ 热点与推文建议');
  const llmCalls = await mockSources.install(context);
  // 测试里没法点浏览器的授权对话框，直接当作已经授权。
  await sw.evaluate(() => { chrome.permissions.contains = async () => true; });

  const tdefaults = await get('settings');
  if (!tdefaults.trends || !tdefaults.trends.enabled || tdefaults.llm.provider !== 'anthropic') throw new Error('热点设置的默认值不对');
  await opts.evaluate((ids) => chrome.storage.local.get('settings').then(({ settings }) => chrome.storage.local.set({
    settings: { ...settings, trends: { ...settings.trends, lists: { ai: [`https://x.com/i/lists/${ids.ai}`], web3: [ids.web3] } } },
    llmKey: 'sk-ant-test',
  })), mock.LIST_IDS);
  const sTrends = (await get('settings')).trends;
  console.log('  列表', JSON.stringify(sTrends.lists));

  // 先测试连接
  const test1 = await send({ type: 'xa:llmTest' });
  if (!test1 || !test1.ok || test1.model !== 'claude-haiku-5-5') throw new Error(`测试连接失败 ${JSON.stringify(test1)}`);

  // 打开一个 x.com 首页：插件借用它读取列表，同时旁听到首页时间线。
  const xHome = await context.newPage();
  await xHome.goto('https://x.com/home');
  await until(async () => Object.keys((await get('trendTweets')) || {}).length >= 1, 15000, '旁听首页推文');
  const homeTweets = await get('trendTweets');
  if (!homeTweets['9001'] || homeTweets['9002']) throw new Error('首页推文应该只保留 AI / Web3 相关的');
  const refreshed = await send({ type: 'xa:trendsRefresh' });
  const tstate = refreshed.state;
  console.log('  来源', JSON.stringify(tstate.counts), '出错', JSON.stringify(tstate.errors));
  if (tstate.errors.x || tstate.errors.hn || tstate.errors.cg || tstate.errors.hfm || Object.keys(tstate.errors).some((k) => k.startsWith('reddit'))) throw new Error('列表或外部来源不应该出错');
  if (tstate.counts.xtrend !== 2) throw new Error(`应该记下 2 个和 AI / Web3 有关的 X 趋势，实际 ${tstate.counts.xtrend}`);
  if (tstate.counts['reddit:r/CryptoCurrency'] !== 1) throw new Error('Reddit 置顶帖不应该算进来');
  if (!tstate.errors['rss:decrypt.co']) throw new Error('出错的 RSS 应该单独记下来');
  const aiTop = tstate.topics.ai.find((t) => t.items.some((i) => i.id === 'x:7001'));
  console.log('  AI 排行', tstate.topics.ai.map((t) => `${t.heat} ${t.title.slice(0, 30)}`).join(' | '));
  console.log('  GPT-6', aiTop.heat, aiTop.title, aiTop.sources.join(','), aiTop.count);
  console.log('  依据', JSON.stringify(aiTop.why));
  if (!/GPT-6/.test(aiTop.title) || !['hn', 'x', 'xtrend', 'reddit'].every((k) => aiTop.sources.includes(k))) throw new Error('同一件事的推文、X 趋势、社区和新闻应该归成一个话题');
  if (aiTop.why.xPosts !== 52100 || aiTop.why.authors !== 2 || aiTop.why.outlets < 2 || aiTop.why.personalOnly) throw new Error('上榜依据不对');
  const qwen = tstate.topics.ai.find((t) => t.items.some((i) => i.source === 'hfm' && /Qwen4/.test(i.title)));
  if (!qwen || !qwen.sources.includes('reddit') || !qwen.sources.includes('x')) throw new Error('热门模型应该和讨论它的帖子归到一起');
  if (tstate.topics.ai.some((t) => /Rust/.test(t.title))) throw new Error('和 AI 无关的 HN 内容不应该出现');
  if (!tstate.topics.ai.some((t) => t.items.some((i) => i.id === 'x:9001'))) throw new Error('首页刷到的 AI 推文应该算进来');
  const w3 = tstate.topics.web3.find((t) => /ETF/.test(t.title));
  if (!w3 || !w3.sources.includes('rss') || !w3.sources.includes('x')) throw new Error('Web3 的 ETF 话题应该合并推文和 RSS');
  if (mock.state.calls.list !== 2) throw new Error(`应该读取 2 个列表，实际 ${mock.state.calls.list}`);

  // 侧边栏
  const panel = await context.newPage();
  panel.on('pageerror', (e) => errors.push(`侧边栏 ${e.message}`));
  await panel.setViewportSize({ width: 400, height: 900 });
  await panel.goto(`chrome-extension://${extId}/src/panel/panel.html`);
  await panel.waitForSelector('.topic');
  if (await panel.isVisible('#keyBanner')) throw new Error('已经填了 key，不应该提示去填');
  const why = await panel.textContent('.topic .why');
  console.log('  侧边栏依据', why);
  if (!/X 趋势/.test(why) || !/位博主/.test(why)) throw new Error('侧边栏应该显示上榜依据');
  await panel.click('.topic button[data-draft]');
  await panel.waitForSelector('.draft textarea', { timeout: 20000 });
  const draftsShown = await panel.$$eval('.draft textarea', (els) => els.map((e) => e.value));
  console.log('  草稿', draftsShown.length, draftsShown[0]);
  if (draftsShown.length !== 3) throw new Error('应该生成 3 条草稿');
  const call = llmCalls[llmCalls.length - 1];
  if (call.headers['anthropic-version'] !== '2026-10-21' || call.headers['x-api-key'] !== 'sk-ant-test') throw new Error('模型请求头不对');
  if ('temperature' in call.body || call.body.model !== 'claude-haiku-5-5') throw new Error('模型请求体不对');
  if (!/GPT-6/.test(call.body.messages[0].content)) throw new Error('提示词里应该带上话题资料');
  await panel.screenshot({ path: path.join(OUT, 'panel.png') });
  // 新标签页打开得太快，Playwright 来不及拦截它的请求，所以只记下要打开的地址。
  await panel.evaluate(() => { window.__opened = []; chrome.tabs.create = (o) => { window.__opened.push(o.url); return Promise.resolve({}); }; });
  await panel.click('.draft button[data-act="compose"]');
  const cu = new URL(await panel.evaluate(() => window.__opened[0]));
  if (cu.origin !== 'https://x.com' || cu.pathname !== '/intent/post' || !/GPT-6/.test(cu.searchParams.get('text'))) throw new Error(`发推链接不对 ${cu}`);
  // 引用一条推文
  await panel.click('.topic button[data-quote]');
  await until(async () => (await panel.$$('.draft')).length >= 6, 20000, '引用草稿');
  const st2 = await send({ type: 'xa:trends' });
  const quoteDraft = Object.entries(st2.state.drafts).find(([k]) => !k.endsWith('|post'));
  if (!quoteDraft || !/^https:\/\/x\.com\/.+\/status\//.test(quoteDraft[1].quoteUrl)) throw new Error('引用草稿应该带上原推链接');
  // 设置页能显示登记的列表
  await opts.reload();
  await opts.click('#tabs button[data-tab="settings"]');
  const listsShown = await opts.inputValue('#listsAi');
  if (!listsShown.includes(mock.LIST_IDS.ai)) throw new Error('设置页应该显示登记的列表');
  if (!/已保存/.test(await opts.textContent('#llmKeyHint'))) throw new Error('设置页应该显示 key 已保存');
  await opts.evaluate(() => { window.__errs = window.__errs || []; });
  const exported = await opts.evaluate(() => chrome.storage.local.get(null).then((a) => Object.keys(a)));
  if (!exported.includes('llmKey')) throw new Error('key 应该保存在本地');
  await panel.close();
  await xHome.close();

  // 12. 弹窗
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extId}/src/popup/popup.html`);
  await popup.waitForSelector('#status');
  await sleep(500);
  console.log('  弹窗', await popup.textContent('#me'), '|', await popup.textContent('#status'));
  await popup.setViewportSize({ width: 300, height: 400 });
  await popup.screenshot({ path: path.join(OUT, 'popup.png') });

  // 管理页没有挂在 Playwright 的页面事件上（安装时就打开了），它的报错单独收集。
  errors.push(...(await opts.evaluate(() => window.__errs || [])).map((e) => `管理页 ${e}`));
  const serious = errors.filter((e) => !/net::ERR|404/.test(e));
  if (serious.length) {
    console.log('页面错误：\n' + serious.join('\n'));
    throw new Error('页面有报错');
  }
  console.log('✅ 全部通过');
  await context.close();
})().catch((e) => {
  if (errors.length) console.error('页面错误：\n' + errors.join('\n'));
  console.error('❌', e);
  process.exit(1);
});
