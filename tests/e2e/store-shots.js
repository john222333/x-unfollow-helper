// 生成 Chrome 应用商店用的截图（1280×800）和宣传图（440×280），输出到 docs/store/。
// 用的是模拟的 x.com 和虚构的账号，不访问真实网站。
// 运行：node tests/e2e/store-shots.js   （需要 playwright 和 Chromium）
'use strict';

process.env.PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS = '1';

const path = require('path');
const fs = require('fs');
const os = require('os');
const { chromium } = require('playwright');
const mock = require('./mock-x');
const mockSources = require('./mock-sources');

const EXT = path.resolve(__dirname, '../..');
const OUT = path.resolve(EXT, 'docs/store');
fs.mkdirSync(OUT, { recursive: true });

// 截图里换成看起来更真实的虚构账号。
const PEOPLE = [
  ['林小满', 'xiaoman_lin'], ['Morning Brew Bot', 'morningbrewbot'], ['阿杰的日常', 'ajie_daily'], ['空投日报', 'airdrop_888'],
  ['Design Weekly', 'designweekly'], ['王一一', 'wangyiyi'], ['Tech Daily CN', 'techdaily_cn'], ['旅行的猫', 'travelcat'],
  ['Hannah Lee', 'hannahlee'], ['每日一图', 'onepicaday'], ['growth_hacker', 'growth_hacker'], ['老周说数码', 'laozhou_tech'],
  ['Sam Carter', 'samcarter'], ['读书笔记', 'reading_notes'], ['NFT Alpha Calls', 'nftalphacalls'], ['咖啡与代码', 'coffee_code'],
  ['Lucy Wang', 'lucywang'], ['摄影小白', 'photo_newbie'], ['follow4follow', 'f4f_daily'], ['产品经理日记', 'pm_diary'],
  ['Kenji', 'kenji_t'], ['深夜食堂', 'midnightdiner'], ['Mia Chen', 'miachen'], ['基金定投', 'fund_dca'],
  ['deal_alerts_bot', 'deal_alerts_bot'], ['跑步的人', 'runner_cn'], ['Leo', 'leo_builds'], ['独立开发者', 'indie_dev_cn'],
  ['Ava Brooks', 'avabrooks'], ['城市观察', 'city_watch'],
];
const BIOS = ['写代码，也写字', '分享每天看到的好东西', '摄影 / 旅行 / 咖啡', '产品、增长和一点点生活', '记录日常'];
mock.USERS.forEach((u, i) => {
  [u.name, u.handle] = PEOPLE[i % PEOPLE.length];
  u.bio = i % 5 === 0 ? '空投 互关 必回 每天抽奖' : BIOS[i % 5];
});

const COLORS = ['#1d9bf0', '#f91880', '#00ba7c', '#ffd400', '#7856ff', '#ff7a00'];
function avatarSvg(id) {
  const n = Number(id) || 0;
  const u = mock.USERS.find((x) => x.id === String(id));
  const ch = u ? Array.from(u.name)[0].toUpperCase() : '?';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48"><rect width="48" height="48" fill="${COLORS[n % COLORS.length]}"/>`
    + `<text x="24" y="31" font-size="22" text-anchor="middle" fill="#fff" font-family="sans-serif">${ch}</text></svg>`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms, label) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`等待超时：${label}`);
    await sleep(300);
  }
}

(async () => {
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xa-shots-'));
  const context = await chromium.launchPersistentContext(userDir, {
    channel: 'chromium',
    headless: true,
    viewport: { width: 1280, height: 800 },
    locale: 'zh-CN',
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  });
  await context.addCookies(mock.COOKIES);
  await context.route('https://x.com/**', mock.route);
  await context.route('https://abs.twimg.com/**', (r) => {
    if (/default_profile/.test(r.request().url())) {
      return r.fulfill({ status: 200, contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48"><rect width="48" height="48" fill="#cfd9de"/><circle cx="24" cy="19" r="9" fill="#fff"/><rect x="10" y="32" width="28" height="16" rx="8" fill="#fff"/></svg>' });
    }
    return mock.routeStatic(r);
  });
  await context.route('https://pbs.twimg.com/**', (r) => {
    const m = /profile_images\/(\d+)\//.exec(r.request().url());
    r.fulfill({ status: 200, contentType: 'image/svg+xml', body: avatarSvg(m ? m[1] : 0) });
  });

  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent('serviceworker');
  const extId = sw.url().split('/')[2];
  const opts = context.pages().find((p) => p.url().includes(extId)) || await context.newPage();
  await opts.goto(`chrome-extension://${extId}/src/options/options.html`);
  for (const p of context.pages()) if (p !== opts) await p.close();
  const get = (k) => opts.evaluate((key) => chrome.storage.local.get(key).then((r) => r[key]), k);
  const send = (msg) => opts.evaluate((m) => chrome.runtime.sendMessage(m), msg);

  // 1. 关注管理：读取列表后筛选「不回关」，勾几个人
  await opts.click('#collectBtn');
  await until(async () => { const c = await get('collect'); return c && c.status === 'done' ? c : null; }, 90000, '读取完成');
  await opts.click('#tabs button[data-tab="users"]');
  await opts.click('#tagFilters label[data-tag="notFollowBack"]');
  await sleep(500);
  // 每次勾选都会重新渲染表格，所以每次重新找元素。
  for (const i of [1, 2, 4, 5]) {
    await opts.locator('#userRows input[type="checkbox"]').nth(i).click();
    await sleep(200);
  }
  await sleep(800);
  await opts.screenshot({ path: path.join(OUT, 'screenshot-1-users.png') });

  // 2. 取关任务进行中：先按最快节奏跑几个，再把间隔调长，让任务停在进行中
  const setPace = (min, max) => opts.evaluate(([a, b]) => chrome.storage.local.get('settings').then(({ settings }) => chrome.storage.local.set({ settings: {
    ...settings, pace: { ...settings.pace, minDelaySec: a, maxDelaySec: b },
  } })), [min, max]);
  await setPace(5, 6);
  const keys = mock.USERS.filter((u) => !u.followsYou).slice(0, 14).map((u) => u.handle);
  await send({ type: 'xa:enqueue', keys, action: 'unfollow' });
  await until(async () => (await get('log') || []).filter((l) => l.result === 'ok').length >= 4, 90000, '前几个取关');
  await setPace(60, 90);
  await opts.click('#tabs button[data-tab="job"]');
  await sleep(1000);
  await opts.screenshot({ path: path.join(OUT, 'screenshot-2-job.png') });

  // 3. 日志
  await opts.click('#tabs button[data-tab="log"]');
  await sleep(800);
  await opts.screenshot({ path: path.join(OUT, 'screenshot-3-log.png') });

  // 4. 设置
  await send({ type: 'xa:pause' });
  await opts.click('#tabs button[data-tab="settings"]');
  await sleep(800);
  await opts.screenshot({ path: path.join(OUT, 'screenshot-4-settings.png') });
  fs.mkdirSync(path.join(__dirname, 'out'), { recursive: true });
  await opts.screenshot({ path: path.join(__dirname, 'out', 'settings-full.png'), fullPage: true });

  // 5. 热点侧边栏：左边说明，右边是侧边栏（同一个插件的页面可以嵌进来）
  await mockSources.install(context);
  // 截图里不要出现「来源读取失败」：测试里故意出错的源这里换成正常的。
  await context.route('https://decrypt.co/**', (r) => r.fulfill({ status: 200, contentType: 'application/rss+xml', headers: { 'access-control-allow-origin': '*' }, body: '<rss><channel></channel></rss>' }));
  await sw.evaluate(() => { chrome.permissions.contains = async () => true; });
  await opts.evaluate((ids) => chrome.storage.local.get('settings').then(({ settings }) => chrome.storage.local.set({
    settings: { ...settings, trends: { ...settings.trends, lists: { ai: [ids.ai], web3: [ids.web3] } } },
    llmKey: 'sk-demo',
  })), mock.LIST_IDS);
  const xHome = await context.newPage();
  await xHome.goto('https://x.com/home');
  await sleep(1500);
  await send({ type: 'xa:trendsRefresh' });
  const st = await send({ type: 'xa:trends' });
  await send({ type: 'xa:draft', topicId: st.state.topics.ai[0].id, mode: 'post' });
  await xHome.close();
  await opts.evaluate((url) => {
    document.body.innerHTML = `<div style="display:flex;height:800px;background:#0f1419;color:#fff;font-family:-apple-system,'PingFang SC','Noto Sans CJK SC',sans-serif">
      <div style="flex:1;padding:120px 64px 0">
        <div style="font-size:40px;font-weight:700;line-height:1.25">AI / Web3 热点<br>一键写推文草稿</div>
        <ul style="font-size:20px;line-height:1.9;color:#cfd9de;margin-top:32px;padding-left:22px">
          <li>汇总你的 X 列表、首页推文和新闻源</li><li>同一件事自动合并，按热度排序</li>
          <li>用你自己的模型 key，三种风格可改可发</li><li>只填进发推框，从不自动发推</li></ul></div>
      <iframe src="${url}" style="width:420px;height:800px;border:0;background:#f7f9f9"></iframe></div>`;
    document.body.style.margin = '0';
  }, `chrome-extension://${extId}/src/panel/panel.html`);
  await sleep(2500);
  await opts.screenshot({ path: path.join(OUT, 'screenshot-5-trends.png') });

  // 宣传图 440×280
  const icon = fs.readFileSync(path.join(EXT, 'icons/icon128.png')).toString('base64');
  const tile = await context.newPage();
  await tile.setViewportSize({ width: 440, height: 280 });
  await tile.setContent(`<!doctype html><html><body style="margin:0;width:440px;height:280px;background:#0f1419;color:#fff;
    font-family:-apple-system,'PingFang SC','Noto Sans CJK SC','Microsoft YaHei',sans-serif;display:flex;align-items:center;gap:24px;padding:0 36px;box-sizing:border-box">
    <img src="data:image/png;base64,${icon}" width="96" height="96" style="border-radius:22px">
    <div><div style="font-size:30px;font-weight:700;line-height:1.2">X 取关助手</div>
    <div style="font-size:15px;color:#8b98a5;margin-top:4px">Unfollow Helper for X</div>
    <div style="font-size:16px;margin-top:16px;line-height:1.5">后台分批慢速取关<br>AI / Web3 热点写推文</div></div></body></html>`);
  await tile.screenshot({ path: path.join(OUT, 'promo-small-440x280.png') });

  await send({ type: 'xa:clearQueue' });
  await context.close();
  console.log('已生成：', fs.readdirSync(OUT).join(', '));
})().catch((e) => {
  console.error('❌', e);
  process.exit(1);
});
