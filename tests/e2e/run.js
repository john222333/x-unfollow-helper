// 端到端冒烟测试：加载插件，用模拟的 x.com（页面 + 网页版接口）和模拟的 LLM 接口跑一遍主要流程。
// 运行：node tests/e2e/run.js   （需要 playwright 和 Chromium）
'use strict';

// 让 Playwright 也能拦截 service worker 发出的请求（插件后台会去下载 X 的前端代码找接口参数）。
process.env.PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS = '1';

const path = require('path');
const http = require('http');
const fs = require('fs');
const os = require('os');
const { chromium } = require('playwright');
const mock = require('./mock-x');

const EXT = path.resolve(__dirname, '../..');
const OUT = path.resolve(__dirname, 'out');
fs.mkdirSync(OUT, { recursive: true });

function startMockLLM() {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const j = JSON.parse(body || '{}');
      const props = (((j.output_config || {}).format || {}).schema || {}).properties || {};
      let out;
      if (props.rewrites) {
        out = { rewrites: [
          { style: '最小改动', text: '这个工具改变了我写东西的方式，每天能省一个小时。', change_note: '去掉了“不仅仅是”和破折号' },
          { style: '更口语', text: '用了两周，写稿快了不少，主要是省掉了反复改格式的时间。', change_note: '换成具体经历' },
          { style: '更容易引发回复', text: '用了两周，写稿快了不少。你们平时写推最花时间的是哪一步？', change_note: '结尾加了一个问题' },
        ] };
      } else if (props.ai_score) {
        out = {
          ai_score: 82, verdict: '套话和排比太多，读起来像宣传稿。',
          issues: [{ quote: '这不仅仅是一个工具', problem: '典型的“不是 X 而是 Y”句式', suggestion: '这个工具' }],
          engagement: { favorite: 0.015, reply: 0.002, retweet: 0.001, quote: 0.0003, share: 0.0005, share_via_dm: 0.0002,
            share_via_copy_link: 0.0002, follow_author: 0.0002, click: 0.04, open_link: 0.005, dwell: 0.2, not_dwelled: 0.7,
            not_interested: 0.006, block_author: 0.0003, mute_author: 0.0005, report: 0.0001 },
          algo_tips: ['删掉 3 个 emoji 和破折号', '结尾加一个具体的问题'],
        };
      } else {
        out = { ok: true };
      }
      const ok = req.headers['x-api-key'] === 'test-key';
      if (!ok) {
        res.writeHead(401, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
        res.end(JSON.stringify({ error: { message: 'bad key' } }));
        return;
      }
      if (!j.stream) {
        res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
        res.end(JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(out) }], stop_reason: 'end_turn' }));
        return;
      }
      // 和真实接口一样按 SSE 分块返回，而且故意拖到 35 秒以上，确认 service worker 不会中途被结束。
      res.writeHead(200, { 'content-type': 'text/event-stream', 'access-control-allow-origin': '*' });
      const text = JSON.stringify(out);
      const chunks = text.match(/[\s\S]{1,40}/g);
      const ev = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
      ev('message_start', { message: { id: 'm', model: j.model } });
      ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
      const slow = props.rewrites;
      let i = 0;
      const timer = setInterval(() => {
        if (i < chunks.length) {
          ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: chunks[i++] } });
          return;
        }
        clearInterval(timer);
        ev('content_block_stop', { index: 0 });
        ev('message_delta', { delta: { stop_reason: 'end_turn' } });
        ev('message_stop', {});
        res.end();
      }, slow ? Math.ceil(36000 / chunks.length) : 20);
    });
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server)));
}

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
  const llm = await startMockLLM();
  const port = llm.address().port;
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

  // 设置：最快允许的节奏、模拟 LLM
  await opts.evaluate((port) => chrome.storage.local.get('settings').then(({ settings }) => chrome.storage.local.set({ settings: {
    ...settings,
    pace: { minDelaySec: 5, maxDelaySec: 5, batchSize: 5, restMinMin: 10, restMaxMin: 10, dailyCap: 100 },
    llm: { provider: 'anthropic', baseUrl: `http://127.0.0.1:${port}`, model: 'claude-opus-5-5', effort: 'low', apiKey: 'test-key' },
  } })), port);
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

  // 9. 推文体检：发推框按钮、模型评审、改写并替换
  console.log('▶ 推文体检');
  const tweet = await context.newPage();
  await tweet.goto('https://x.com/home');
  await tweet.waitForSelector('[data-testid="toolBar"] .xa-check-btn', { timeout: 15000 });
  await tweet.click('[data-testid="tweetTextarea_0"]');
  await tweet.keyboard.type('说实话，这不仅仅是一个工具，更是一种全新的工作方式——它赋能每一个创作者。🚀✨🔥');
  await tweet.click('[data-testid="toolBar"] .xa-check-btn');
  const panel = tweet.locator('#xa-panel-host');
  await panel.locator('.tile .v').first().waitFor({ timeout: 20000 });
  const scores = await panel.locator('.tile .v').allTextContents();
  console.log('  分数', scores.join(' / '));
  if (!(Number(scores[0]) >= 60)) throw new Error('AI 味分数应该很高');
  if (!/^\d+$/.test(scores[1].trim())) throw new Error('应该有算法分');
  await panel.locator('[data-act="rewrite"]').click();
  await panel.locator('.card').first().waitFor({ timeout: 60000 });
  await tweet.screenshot({ path: path.join(OUT, 'panel.png') });
  await panel.locator('[data-act="use"]').nth(2).click();
  await sleep(800);
  const edited = await tweet.$eval('[data-testid="tweetTextarea_0"]', (e) => e.innerText);
  console.log('  替换后', edited);
  if (!edited.includes('你们平时写推')) throw new Error('改写没有替换进输入框');
  if (!(await tweet.$('article [role="group"] .xa-check-btn'))) throw new Error('推文下没有体检按钮');

  // 10. 管理页粘贴体检
  await opts.bringToFront();
  await opts.click('#tabs button[data-tab="check"]');
  await opts.fill('#checkText', 'Here\'s the thing: it\'s not just a tool, it\'s a game-changer. Let that sink in.');
  await opts.click('#checkBtn');
  await opts.locator('#checkOut .tile .v').first().waitFor({ timeout: 20000 });
  await opts.screenshot({ path: path.join(OUT, 'check.png'), fullPage: true });

  // 11. 预计完成时间：队列里放 150 人，按每天 100 个应该要跨天
  await send({ type: 'xa:pause' }).catch(() => {});
  await opts.click('#tabs button[data-tab="job"]');
  await opts.evaluate(() => chrome.storage.local.set({ queue: Array.from({ length: 150 }, (_, i) => ({ key: `fake${i}`, handle: `fake${i}`, id: String(5000 + i), action: 'unfollow', addedAt: Date.now() })) }));
  const etaText = await until(async () => { const t = await opts.textContent('#etaLine'); return /天/.test(t) ? t : null; }, 5000, '预计完成时间');
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
  llm.close();
})().catch((e) => {
  if (errors.length) console.error('页面错误：\n' + errors.join('\n'));
  console.error('❌', e);
  process.exit(1);
});
