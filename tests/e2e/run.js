// 端到端冒烟测试：加载插件，用模拟的 x.com 页面和模拟的 LLM 接口跑一遍主要流程。
// 运行：node tests/e2e/run.js   （需要 playwright 和 Chromium）
'use strict';

const path = require('path');
const http = require('http');
const fs = require('fs');
const os = require('os');
const { chromium } = require('playwright');
const { route } = require('./mock-x');

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
      res.writeHead(ok ? 200 : 401, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
      res.end(JSON.stringify(ok
        ? { content: [{ type: 'text', text: JSON.stringify(out) }], stop_reason: 'end_turn' }
        : { error: { message: 'bad key' } }));
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
  const errors = [];
  context.on('page', (p) => {
    p.on('pageerror', (e) => errors.push(`${p.url()} ${e.message}`));
    p.on('console', (m) => { if (m.type() === 'error' && !/favicon|Failed to load resource/.test(m.text())) errors.push(`${p.url()} ${m.text()}`); });
  });
  await context.route('https://x.com/**', route);
  await context.route('https://pbs.twimg.com/**', (r) => r.fulfill({ status: 200, contentType: 'image/png', body: Buffer.alloc(0) }));
  await context.route('https://abs.twimg.com/**', (r) => r.fulfill({ status: 200, contentType: 'image/png', body: Buffer.alloc(0) }));

  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent('serviceworker');
  const extId = sw.url().split('/')[2];
  console.log('扩展 ID', extId);

  const opts = context.pages().find((p) => p.url().includes(extId)) || await context.newPage();
  await opts.goto(`chrome-extension://${extId}/src/options/options.html`);
  const get = (k) => opts.evaluate((key) => chrome.storage.local.get(key).then((r) => r[key]), k);

  // 设置：最快允许的节奏、每批确认、模拟 LLM
  await opts.evaluate((port) => chrome.storage.local.get('settings').then(({ settings }) => chrome.storage.local.set({ settings: {
    ...settings,
    pace: { minDelaySec: 5, maxDelaySec: 5, batchSize: 5, restMinMin: 10, restMaxMin: 10, dailyCap: 100 },
    confirmEachBatch: true,
    llm: { provider: 'anthropic', baseUrl: `http://127.0.0.1:${port}`, model: 'claude-opus-5-5', effort: 'low', apiKey: 'test-key' },
  } })), port);
  await opts.reload();

  // 1. 读取关注列表
  console.log('▶ 读取关注列表');
  await opts.click('#collectBtn');
  const collect = await until(async () => { const c = await get('collect'); return c && c.status !== 'running' ? c : null; }, 120000, '读取完成');
  const users = await get('users');
  console.log('  结果', JSON.stringify(collect), Object.keys(users || {}).length, '人');
  if (!users) throw new Error('没有读取到任何人');
  if (Object.keys(users).length !== 30) throw new Error('应该读取到 30 人');
  console.log('  样例', JSON.stringify([users.user4, users.user3, users.user1]));
  if (users.user4.followers !== 3 || users.user3.followsYou !== true || users.user1.followsYou !== false) throw new Error('字段解析不对');
  if ((await get('me')).handle !== 'tester') throw new Error('没有识别账号');

  // 2. 筛选「不回关」
  await opts.click('#tabs button[data-tab="users"]');
  await opts.click('#tagFilters label[data-tag="notFollowBack"]');
  const summary = await opts.textContent('#userSummary');
  console.log('  筛选', summary);
  if (!summary.includes('筛选出 20 人')) throw new Error('不回关筛选结果不对');
  await opts.screenshot({ path: path.join(OUT, 'users.png'), fullPage: false });

  // 3. 分批取关：user1、user2 成功，user29 触发限制后熔断
  console.log('▶ 分批取关');
  await opts.evaluate(() => chrome.storage.local.set({ whitelist: { user5: true } }));
  const enq = await opts.evaluate(() => chrome.runtime.sendMessage({ type: 'xa:enqueue', keys: ['user1', 'user2', 'user29', 'user5'], action: 'unfollow' }));
  if (enq.added !== 3 || enq.skipped !== 1) throw new Error('白名单没有生效');
  await opts.click('#tabs button[data-tab="job"]');
  await until(() => opts.$('#jobButtons [data-do="start"]'), 5000, '开始按钮');
  await opts.click('#jobButtons [data-do="start"]');
  const job = await until(async () => { const j = await get('job'); return j && j.status === 'tripped' ? j : null; }, 120000, '熔断');
  const log = await get('log');
  console.log('  日志', log.map((l) => `${l.handle}:${l.result}`).join(' '));
  console.log('  状态', job.status, job.lastError);
  const res = Object.fromEntries(log.map((l) => [l.handle, l.result]));
  if (res.user1 !== 'ok' || res.user2 !== 'ok' || res.user29 !== 'rate_limited') throw new Error('取关结果不对');
  const users2 = await get('users');
  if (users2.user1 || users2.user2) throw new Error('取关成功的人应该从本地列表移除');
  const gap = log[1].t - log[0].t;
  console.log('  两次取关间隔', Math.round(gap / 1000), '秒');
  if (gap < 5000) throw new Error('间隔低于 5 秒');
  await opts.screenshot({ path: path.join(OUT, 'job.png') });

  // 4. 撤销：从日志重新关注 user1
  console.log('▶ 重新关注');
  await opts.evaluate(() => chrome.runtime.sendMessage({ type: 'xa:enqueue', keys: ['user1'], action: 'follow', front: true }));
  const q = await get('queue');
  if (q[0].handle !== 'user1' || q[0].action !== 'follow') throw new Error('撤销没有排到队首');

  // 5. 推文体检：发推框按钮、模型评审、改写并替换
  console.log('▶ 推文体检');
  const home = await context.newPage();
  await home.goto('https://x.com/home');
  await home.waitForSelector('[data-testid="toolBar"] .xa-check-btn', { timeout: 15000 });
  await home.click('[data-testid="tweetTextarea_0"]');
  await home.keyboard.type('说实话，这不仅仅是一个工具，更是一种全新的工作方式——它赋能每一个创作者。🚀✨🔥');
  await home.click('[data-testid="toolBar"] .xa-check-btn');
  const panel = home.locator('#xa-panel-host');
  await panel.locator('.tile .v').first().waitFor({ timeout: 20000 });
  const scores = await panel.locator('.tile .v').allTextContents();
  console.log('  分数', scores.join(' / '));
  if (!(Number(scores[0]) >= 60)) throw new Error('AI 味分数应该很高');
  if (!/^\d+$/.test(scores[1].trim())) throw new Error('应该有算法分');
  await panel.locator('[data-act="rewrite"]').click();
  await panel.locator('.card').first().waitFor({ timeout: 20000 });
  await home.screenshot({ path: path.join(OUT, 'panel.png') });
  await panel.locator('[data-act="use"]').nth(2).click();
  await sleep(800);
  const edited = await home.$eval('[data-testid="tweetTextarea_0"]', (e) => e.innerText);
  console.log('  替换后', edited);
  if (!edited.includes('你们平时写推')) throw new Error('改写没有替换进输入框');
  if (!(await home.$('article [role="group"] .xa-check-btn'))) throw new Error('推文下没有体检按钮');

  // 6. 管理页粘贴体检
  await opts.click('#tabs button[data-tab="check"]');
  await opts.fill('#checkText', 'Here\'s the thing: it\'s not just a tool, it\'s a game-changer. Let that sink in.');
  await opts.click('#checkBtn');
  await opts.locator('#checkOut .tile .v').first().waitFor({ timeout: 20000 });
  await opts.screenshot({ path: path.join(OUT, 'check.png'), fullPage: true });

  // 7. 弹窗
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extId}/src/popup/popup.html`);
  await popup.waitForSelector('#status');
  await sleep(500);
  console.log('  弹窗状态', await popup.textContent('#status'));
  await popup.setViewportSize({ width: 300, height: 380 });
  await popup.screenshot({ path: path.join(OUT, 'popup.png') });

  const serious = errors.filter((e) => !/net::ERR|404/.test(e));
  if (serious.length) {
    console.log('页面错误：\n' + serious.join('\n'));
    throw new Error('页面有报错');
  }
  console.log('✅ 全部通过');
  await context.close();
  llm.close();
})().catch((e) => {
  console.error('❌', e);
  process.exit(1);
});
