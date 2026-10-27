// 模拟 x.com：只复刻插件依赖的页面结构（data-testid）和网页版接口，用于端到端测试。
// 有状态：取关、关注会真的改变「正在关注」列表，测试可以通过 state 打开各种故障。
'use strict';

const USERS = Array.from({ length: 30 }, (_, i) => ({
  id: String(1000 + i),
  handle: `user${i}`,
  name: `测试用户 ${i}`,
  bio: i % 5 === 0 ? '加密货币 空投 互关' : `普通简介 ${i}`,
  followsYou: i % 3 === 0,
  followers: i % 4 === 0 ? 3 : 1000 + i,
  following: 200,
  tweets: i % 7 === 0 ? 0 : 50,
  defaultAvatar: i % 4 === 0,
}));

const ME = { id: '999', handle: 'tester' };
const CSRF = 'csrf-token-123';
const QID = 'abc';
const MAIN_JS = 'https://abs.twimg.com/responsive-web/client-web/main.test123.js';

const state = {
  following: new Set(USERS.map((u) => u.id)),
  apiBroken: false, // 取关、关注、账号接口返回 404（模拟 X 改了接口）
  friendshipsDown: false, // 取关、关注请求直接断开（模拟页面那边请求发不出去）
  collectApiBroken: false, // 插件自己发的关注列表请求返回 404（模拟后台读取不可用）
  rateLimitOnce: false, // 下一次读取第二页时返回一次 429
  ignoreUnfollow: false, // 取关接口返回成功，但实际没有取关（模拟 X 悄悄不执行）
  partialPages: 0, // 接下来几次读取后续页时返回「部分出错」的空数据（模拟 X 中途超时）
  domOnly: new Set(), // 这些人的主页不请求推文接口，只把推文显示在页面上（模拟旁听不到数据）
  calls: { destroy: 0, create: 0, following: 0, settings: 0, list: 0, userTweets: 0, userTweets404: 0, profileTimelines: 0 },
};

function reset() {
  state.following = new Set(USERS.map((u) => u.id));
  state.apiBroken = false;
  state.friendshipsDown = false;
  state.collectApiBroken = false;
  state.rateLimitOnce = false;
  state.ignoreUnfollow = false;
  state.partialPages = 0;
  state.domOnly = new Set();
  state.calls = { destroy: 0, create: 0, following: 0, settings: 0, list: 0, userTweets: 0, userTweets404: 0, profileTimelines: 0 };
}

const followed = () => USERS.filter((u) => state.following.has(u.id));

// 热点功能用的推文。时间按「现在往前推几小时」生成，和 X 一样的 created_at 格式。
const LIST_IDS = { ai: '1111111111', web3: '2222222222' };
function twDate(hoursAgo) {
  const d = new Date(Date.now() - hoursAgo * 3600000);
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getUTCDay()];
  const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()];
  const p2 = (n) => String(n).padStart(2, '0');
  return `${day} ${mon} ${p2(d.getUTCDate())} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())} +0000 ${d.getUTCFullYear()}`;
}
const TWEETS = {
  ai: [
    { id: '7001', handle: 'ai_kol1', text: 'OpenAI just released GPT-6 with a new reasoning mode. Benchmarks look wild https://t.co/abc', url: 'https://openai.com/index/gpt-6', likes: 5200, rts: 900, h: 3 },
    { id: '7002', handle: 'ai_kol2', text: 'GPT-6 reasoning mode tested: coding benchmarks jump, pricing stays the same', url: 'https://openai.com/index/gpt-6', likes: 1800, rts: 300, h: 2 },
    { id: '7003', handle: 'ai_kol3', text: '开源大模型 Qwen4 发布，推理速度翻倍，本地部署门槛更低', url: '', likes: 600, rts: 120, h: 5 },
  ],
  web3: [
    { id: '8001', handle: 'web3_kol1', text: '比特币 ETF 单日净流入创新高，$BTC 站上新台阶', url: 'https://www.coindesk.com/markets/btc-etf-inflow', likes: 3000, rts: 700, h: 1 },
    { id: '8002', handle: 'web3_kol2', text: 'Solana memecoin season is back, DEX volume up 3x this week', url: '', likes: 900, rts: 150, h: 6 },
  ],
  home: [
    { id: '9001', handle: 'friend1', text: 'Anthropic Claude update ships agentic coding features for teams', url: 'https://www.anthropic.com/news/x', likes: 400, rts: 60, h: 4 },
    { id: '9002', handle: 'friend2', text: '今天天气不错，出去走走', url: '', likes: 10, rts: 0, h: 1 },
    { id: '9003', handle: 'user5', uid: '1005', text: '周末去爬山了', url: '', likes: 3, rts: 0, h: 5 }, // 你关注的人：刷首页时顺带记下 TA 的发帖时间
  ],
};

function gqlTweet(t) {
  return {
    __typename: 'Tweet',
    rest_id: t.id,
    core: { user_results: { result: { __typename: 'User', rest_id: t.uid || `u${t.id}`, core: { screen_name: t.handle, name: t.handle }, legacy: { followers_count: 50000 } } } },
    views: { count: String(t.likes * 40) },
    legacy: {
      full_text: t.text, created_at: twDate(t.h), lang: 'en', id_str: t.id,
      favorite_count: t.likes, retweet_count: t.rts, reply_count: Math.round(t.likes / 20), quote_count: Math.round(t.rts / 5),
      entities: { urls: t.url ? [{ expanded_url: t.url, url: 'https://t.co/abc' }] : [] },
    },
  };
}

// 首页右侧「有什么新鲜事」：X 全站趋势榜。
const X_TRENDS = [
  { name: '#GPT6', domain: 'Technology · Trending', meta: '52.1K posts' },
  { name: 'Bitcoin', domain: 'Cryptocurrency · Trending', meta: '1.2万 帖子' },
  { name: 'Champions League', domain: 'Sports · Trending', meta: '200K posts' },
];
function exploreSidebar() {
  const items = X_TRENDS.map((t) => ({ item: { itemContent: { itemType: 'TimelineTrend', name: t.name, trend_metadata: { domain_context: t.domain, meta_description: t.meta } } } }));
  return { data: { explore_sidebar: { timeline: { instructions: [{ type: 'TimelineAddEntries', entries: [{ entryId: 'trends', content: { entryType: 'TimelineTimelineModule', items } }] }] } } } };
}

// 多久没发推：每个人最近一次发推是几天前。user13 的账号已冻结。
const LAST_DAYS = [2, 40, 100, 200, 400];
const lastDays = (u) => LAST_DAYS[Number(u.id) % 5];
function userTweets(userId) {
  const u = USERS.find((x) => x.id === userId);
  if (!u || u.handle === 'user13') return { data: { user: { result: { __typename: 'UserUnavailable', reason: 'Suspended' } } } };
  const tw = (id, author, h) => ({ entryId: `tweet-${id}`, content: { entryType: 'TimelineTimelineItem', itemContent: { itemType: 'TimelineTweet', tweet_results: { result: {
    __typename: 'Tweet', rest_id: id, core: { user_results: { result: { __typename: 'User', rest_id: author } } }, legacy: { created_at: twDate(h), full_text: 't' },
  } } } } });
  const d = lastDays(u);
  return { data: { user: { result: { __typename: 'User', timeline: { timeline: { instructions: [
    { type: 'TimelinePinEntry', entry: tw(`p${u.id}`, u.id, 24 * 900) }, // 很久以前的置顶推文
    { type: 'TimelineAddEntries', entries: [
      tw(`o${u.id}`, '555', 1), // 回复串里别人的推文，昨天发的
      tw(`a${u.id}`, u.id, 24 * d),
      tw(`b${u.id}`, u.id, 24 * (d + 30)),
    ] },
  ] } } } } } };
}

function timeline(tweets) {
  const entries = tweets.map((t) => ({ entryId: `tweet-${t.id}`, content: { entryType: 'TimelineTimelineItem', itemContent: { itemType: 'TimelineTweet', tweet_results: { result: gqlTweet(t) } } } }));
  return { data: { list: { tweets_timeline: { timeline: { instructions: [{ type: 'TimelineAddEntries', entries }] } } } } };
}

function gqlUser(u) {
  return {
    __typename: 'User',
    rest_id: u.id,
    core: { screen_name: u.handle, name: u.name, created_at: 'Mon Jan 01 00:00:00 +0000 2020' },
    avatar: { image_url: u.defaultAvatar ? 'https://abs.twimg.com/sticky/default_profile_images/default_profile_normal.png' : `https://pbs.twimg.com/profile_images/${u.id}/a_normal.jpg` },
    legacy: { description: u.bio, followers_count: u.followers, friends_count: u.following, statuses_count: u.tweets, default_profile_image: u.defaultAvatar },
    relationship_perspectives: { following: true, followed_by: u.followsYou },
  };
}

// 和真实接口一样：外层是「你自己」这个带 timeline 的 User，每页末尾有 cursor-bottom，最后一页之后返回空列表。
function followingPage(cursor, size) {
  const start = Number(String(cursor || '0').replace(/^c-/, '')) || 0;
  const list = followed();
  const slice = list.slice(start, start + size);
  const entries = slice.map((u) => ({ entryId: `user-${u.id}`, sortIndex: String(start), content: { entryType: 'TimelineTimelineItem', itemContent: { itemType: 'TimelineUser', user_results: { result: gqlUser(u) } } } }));
  entries.push({ entryId: `cursor-bottom-${start + size}`, content: { entryType: 'TimelineTimelineCursor', value: `c-${start + size}`, cursorType: 'Bottom' } });
  entries.push({ entryId: `cursor-top-${start}`, content: { entryType: 'TimelineTimelineCursor', value: `t-${start}`, cursorType: 'Top' } });
  return {
    data: { user: { result: { __typename: 'User', rest_id: ME.id, timeline: { timeline: { instructions: [
      { type: 'TimelineClearCache' },
      { type: 'TimelineAddEntries', entries },
    ] } } } } },
  };
}

const NAV = `<nav><a data-testid="AppTabBar_Profile_Link" href="/${ME.handle}">Profile</a></nav>`;

function cellHtml(u) {
  return `<div data-testid="cellInnerDiv"><div data-testid="UserCell" role="button" style="height:90px;border-bottom:1px solid #eee">
    <a href="/${u.handle}" role="link"><img src="https://pbs.twimg.com/profile_images/${u.id}/a_normal.jpg"></a>
    <a href="/${u.handle}" role="link"><span>${u.name}</span></a>
    <a href="/${u.handle}" role="link"><span>@${u.handle}</span></a>
    ${u.followsYou ? '<div data-testid="userFollowIndicator"><span>Follows you</span></div>' : ''}
    <button data-testid="${u.id}-unfollow" role="button">Following</button>
    <div dir="auto">${u.bio}</div></div></div>`;
}

function page(body, script) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>X</title>
  <script src="${MAIN_JS}"></script></head>
  <body style="background:#fff;margin:0">${NAV}<main><div data-testid="primaryColumn" style="width:600px">${body}</div></main>
  <script>${script || ''}</script></body></html>`;
}

function followingHtml() {
  // 首屏渲染 10 个；滚到底部时像 X 一样请求下一页 GraphQL 并追加单元格（兜底的窗口读取用）。
  const all = followed();
  return page(`<div id="list">${all.slice(0, 10).map(cellHtml).join('')}</div><div style="height:400px"></div>`, `
    const ALL = ${JSON.stringify(all)};
    const cell = ${cellHtml.toString()};
    let next = 10, busy = false;
    const q = (c) => '/i/api/graphql/${QID}/Following?variables=' + encodeURIComponent(JSON.stringify({ userId: '${ME.id}', count: 10, cursor: 'c-' + c })) + '&features=' + encodeURIComponent('{"rweb_tipjar_consumption_enabled":true}');
    fetch(q(0)).then(r => r.json());
    addEventListener('scroll', async () => {
      if (busy || next >= ALL.length) return;
      if (scrollY + innerHeight < document.documentElement.scrollHeight - 300) return;
      busy = true;
      await fetch(q(next)).then(r => r.json());
      document.getElementById('list').insertAdjacentHTML('beforeend', ALL.slice(next, next + 10).map(cell).join(''));
      next += 10; busy = false;
    });`);
}

// 和真实主页一样：页面自己请求账号资料（UserByScreenName），账号正常再请求推文时间线。
// 页面自己发的请求带着网页生成的校验头；插件直接调用推文接口会像真实情况一样被拒（404）。
function profileData(handle, replies) {
  const v = (o) => encodeURIComponent(JSON.stringify(o));
  return `fetch('/i/api/graphql/ubs/UserByScreenName?variables=${v({ screen_name: handle })}', { headers: { 'x-client-transaction-id': 'page' } })
    .then(r => r.json()).then(d => {
      const u = d.data && d.data.user && d.data.user.result;
      if (!u || u.__typename !== 'User') return;
      if (${state.domOnly.has(handle)}) return;
      const op = ${replies ? "'utr/UserTweetsAndReplies'" : "'ut/UserTweets'"};
      fetch('/i/api/graphql/' + op + '?variables=' + encodeURIComponent(JSON.stringify({ userId: u.rest_id, count: 20 })), { headers: { 'x-client-transaction-id': 'page' } });
    });`;
}

// 页面上显示的推文：TA 自己的两条，加一条 TA 转推的别人昨天的推文（时间是原推的，不能算 TA 的）。
function articlesHtml(u) {
  if (u.handle === 'user13') return '';
  const iso = (days) => new Date(Date.now() - days * 86400000).toISOString();
  const art = (who, id, days) => `<article data-testid="tweet"><a href="/${who}/status/${id}"><time datetime="${iso(days)}">t</time></a></article>`;
  const d = lastDays(u);
  return art('someone', `r${u.id}`, 1) + art(u.handle, `a${u.id}`, d) + art(u.handle, `b${u.id}`, d + 30);
}

function profileHtml(handle, replies) {
  const u = USERS.find((x) => x.handle === handle);
  if (!u) return page('<div data-testid="emptyState">This account doesn’t exist</div>', profileData(handle, replies));
  const limited = handle === 'user29';
  const on = state.following.has(u.id);
  return page(`<div data-testid="placementTracking"><button id="fb" data-testid="${u.id}-${on ? 'unfollow' : 'follow'}">${on ? 'Following' : 'Follow'}</button></div>
    <div data-testid="UserName">${u.name}</div>${articlesHtml(u)}`, `${profileData(handle, replies)}
    const b = document.getElementById('fb');
    const set = (v) => fetch('/__mock/follow?id=${u.id}&on=' + v).then(() => {
      b.dataset.testid = '${u.id}-' + (v ? 'unfollow' : 'follow'); b.textContent = v ? 'Following' : 'Follow';
    });
    b.addEventListener('click', () => {
      if (b.dataset.testid.endsWith('-unfollow')) {
        const sheet = document.createElement('div');
        sheet.innerHTML = '<button data-testid="confirmationSheetConfirm">Unfollow</button>';
        document.body.appendChild(sheet);
        sheet.firstChild.addEventListener('click', () => {
          sheet.remove();
          if (${limited}) {
            document.body.insertAdjacentHTML('beforeend', '<div data-testid="toast" role="alert">You are unable to unfollow more people at this time.</div>');
            return;
          }
          setTimeout(() => set(0), 300);
        });
      } else {
        setTimeout(() => set(1), 300);
      }
    });`);
}

function homeHtml() {
  // 像真实首页一样请求时间线，插件旁听到后把 AI / Web3 推文算进热点。
  return page('<div data-testid="tweet">首页</div>', `fetch('/i/api/graphql/home/HomeTimeline?variables=' + encodeURIComponent('{"count":20}')).then(r => r.json());
    fetch('/i/api/graphql/side/ExploreSidebar').then(r => r.json());`);
}

// X 前端代码里登记 GraphQL 操作的写法（这里写成合法的 JS，页面加载时不会报错）。
const MAIN_JS_BODY = `window.__mockOps = [
  {queryId:"zzz",operationName:"Followers",operationType:"query",metadata:{featureSwitches:["rweb_tipjar_consumption_enabled"],fieldToggles:[]}},
  {queryId:"utr",operationName:"UserTweetsAndReplies",operationType:"query",metadata:{featureSwitches:["rweb_tipjar_consumption_enabled"],fieldToggles:["withArticlePlainText"]}},
  {queryId:"lst",operationName:"ListLatestTweetsTimeline",operationType:"query",metadata:{featureSwitches:["rweb_tipjar_consumption_enabled"],fieldToggles:[]}},
  {queryId:"${QID}",operationName:"Following",operationType:"query",metadata:{featureSwitches:["rweb_tipjar_consumption_enabled","verified_phone_label_enabled","responsive_web_graphql_exclude_directive_enabled"],fieldToggles:["withAuxiliaryUserLabels"]}}
];`;

function json(r, status, body, headers) {
  return r.fulfill({ status, contentType: 'application/json', headers: headers || {}, body: body === undefined ? '' : JSON.stringify(body) });
}

function rateHeaders(remaining) {
  return { 'x-rate-limit-limit': '50', 'x-rate-limit-remaining': String(remaining), 'x-rate-limit-reset': String(Math.floor(Date.now() / 1000) + 900) };
}

async function apiRoute(r, url, p) {
  const req = r.request();
  const h = await req.allHeaders();
  const cookies = Object.fromEntries((h.cookie || '').split(/;\s*/).filter(Boolean).map((c) => { const i = c.indexOf('='); return [c.slice(0, i), c.slice(i + 1)]; }));
  const fromPlugin = !!h['x-csrf-token'];
  // 和真实接口一样：要有应用令牌，防伪令牌要和 cookie 一致。
  if (fromPlugin) {
    if (!/^Bearer\s+\S+/.test(h.authorization || '')) return json(r, 400, { errors: [{ code: 215, message: 'Bad Authentication data.' }] });
    if (h['x-csrf-token'] !== cookies.ct0) return json(r, 403, { errors: [{ code: 353, message: 'This request requires a matching csrf cookie and header.' }] });
  }

  if (p.startsWith('/i/api/graphql/')) {
    const m = /^\/i\/api\/graphql\/([\w-]+)\/(\w+)$/.exec(p);
    if (m && m[1] === 'home' && m[2] === 'HomeTimeline') return json(r, 200, timeline(TWEETS.home));
    if (m && m[1] === 'side' && m[2] === 'ExploreSidebar') return json(r, 200, exploreSidebar());
    if (m && m[1] === 'ubs' && m[2] === 'UserByScreenName') {
      const { screen_name: sn } = JSON.parse(url.searchParams.get('variables') || '{}');
      const u = USERS.find((x) => x.handle === sn);
      if (!u || u.handle === 'user13') return json(r, 200, { data: { user: u ? { result: { __typename: 'UserUnavailable', reason: 'Suspended' } } : {} } });
      return json(r, 200, { data: { user: { result: gqlUser(u) } } });
    }
    if (m && (m[1] === 'utr' || m[1] === 'ut') && /^UserTweets/.test(m[2])) {
      state.calls.userTweets++;
      // 真实的 X 要求推文接口带网页自己生成的 x-client-transaction-id，没有就返回 404。
      if (!h['x-client-transaction-id']) { state.calls.userTweets404++; return r.fulfill({ status: 404, body: '' }); }
      const { userId } = JSON.parse(url.searchParams.get('variables') || '{}');
      state.calls.profileTimelines++;
      return json(r, 200, userTweets(String(userId)));
    }
    if (m && m[1] === 'lst' && m[2] === 'ListLatestTweetsTimeline') {
      state.calls.list++;
      if (!url.searchParams.get('features')) return json(r, 400, { errors: [{ message: 'features cannot be null' }] });
      const { listId } = JSON.parse(url.searchParams.get('variables') || '{}');
      const tp = Object.keys(LIST_IDS).find((k) => LIST_IDS[k] === listId);
      if (!tp) return json(r, 404, { errors: [{ code: 34, message: 'List not found' }] });
      return json(r, 200, timeline(TWEETS[tp]));
    }
    if (!m || m[1] !== QID || m[2] !== 'Following') return json(r, 404, { errors: [{ message: 'Query not found' }] });
    if (fromPlugin && state.collectApiBroken) return r.fulfill({ status: 404, body: '' });
    if (!url.searchParams.get('features')) return json(r, 400, { errors: [{ message: 'The following features cannot be null: rweb_tipjar_consumption_enabled' }] });
    const vars = JSON.parse(url.searchParams.get('variables') || '{}');
    state.calls.following++;
    if (fromPlugin && state.rateLimitOnce && vars.cursor) {
      state.rateLimitOnce = false;
      return json(r, 429, { errors: [{ code: 88, message: 'Rate limit exceeded' }] }, { 'x-rate-limit-remaining': '0', 'x-rate-limit-reset': String(Math.floor(Date.now() / 1000) + 2) });
    }
    if (fromPlugin && state.partialPages > 0 && vars.cursor) {
      state.partialPages--;
      return json(r, 200, { errors: [{ message: 'Timeout: Unspecified' }], data: { user: {} } });
    }
    return json(r, 200, followingPage(vars.cursor, fromPlugin ? 20 : 10), rateHeaders(40));
  }

  if (p === '/i/api/1.1/account/settings.json') {
    state.calls.settings++;
    if (state.apiBroken) return r.fulfill({ status: 404, body: '' });
    return json(r, 200, { screen_name: ME.handle, language: 'zh-cn' });
  }

  const fm = /^\/i\/api\/1\.1\/friendships\/(destroy|create)\.json$/.exec(p);
  if (fm && req.method() === 'POST') {
    state.calls[fm[1]]++;
    if (state.friendshipsDown) return r.abort('failed');
    if (state.apiBroken) return r.fulfill({ status: 404, body: '' });
    const form = new URLSearchParams(req.postData() || '');
    const u = USERS.find((x) => x.id === form.get('user_id'));
    if (!u) return json(r, 404, { errors: [{ code: 50, message: 'User not found.' }] });
    if (u.handle === 'user29') return json(r, 403, { errors: [{ code: 161, message: 'You are unable to follow more people at this time.' }] });
    if (fm[1] === 'destroy') { if (!state.ignoreUnfollow) state.following.delete(u.id); } else state.following.add(u.id);
    return json(r, 200, { id_str: u.id, screen_name: u.handle, following: fm[1] === 'create' });
  }

  return r.fulfill({ status: 404, body: '' });
}

async function route(r) {
  const url = new URL(r.request().url());
  const p = url.pathname;
  const html = (body) => r.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body });
  if (p.startsWith('/i/api/')) return apiRoute(r, url, p);
  if (p === '/__mock/follow') {
    const id = url.searchParams.get('id');
    if (url.searchParams.get('on') === '1') state.following.add(id); else state.following.delete(id);
    return json(r, 200, { ok: true });
  }
  if (p === '/home' || p === '/') return html(homeHtml());
  if (p === '/intent/post') return html(page('<div data-testid="tweetTextarea_0">发推框</div>'));
  if (p === `/${ME.handle}/following`) return html(followingHtml());
  const wr = /^\/([A-Za-z0-9_]+)\/with_replies\/?$/.exec(p);
  if (wr) return html(profileHtml(wr[1], true));
  const m = /^\/([A-Za-z0-9_]+)\/?$/.exec(p);
  if (m) return html(profileHtml(m[1]));
  return r.fulfill({ status: 404, body: '' });
}

// abs.twimg.com：前端代码和静态图片。
async function routeStatic(r) {
  const url = r.request().url();
  if (url === MAIN_JS) return r.fulfill({ status: 200, contentType: 'application/javascript', body: MAIN_JS_BODY });
  return r.fulfill({ status: 200, contentType: 'image/png', body: Buffer.alloc(0) });
}

const COOKIES = [
  { name: 'auth_token', value: 'auth-abc', domain: '.x.com', path: '/', secure: true, httpOnly: true, sameSite: 'None' },
  { name: 'ct0', value: CSRF, domain: '.x.com', path: '/', secure: true, sameSite: 'Lax' },
  { name: 'twid', value: `u%3D${ME.id}`, domain: '.x.com', path: '/', secure: true, sameSite: 'None' },
];

module.exports = { route, routeStatic, USERS, ME, state, reset, COOKIES, LIST_IDS, TWEETS, lastDays };
