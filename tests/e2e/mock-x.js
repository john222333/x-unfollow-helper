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
  calls: { destroy: 0, create: 0, following: 0, settings: 0 },
};

function reset() {
  state.following = new Set(USERS.map((u) => u.id));
  state.apiBroken = false;
  state.friendshipsDown = false;
  state.collectApiBroken = false;
  state.rateLimitOnce = false;
  state.calls = { destroy: 0, create: 0, following: 0, settings: 0 };
}

const followed = () => USERS.filter((u) => state.following.has(u.id));

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

function profileHtml(handle) {
  const u = USERS.find((x) => x.handle === handle);
  if (!u) return page('<div data-testid="emptyState">This account doesn’t exist</div>');
  const limited = handle === 'user29';
  const on = state.following.has(u.id);
  return page(`<div data-testid="placementTracking"><button id="fb" data-testid="${u.id}-${on ? 'unfollow' : 'follow'}">${on ? 'Following' : 'Follow'}</button></div>
    <div data-testid="UserName">${u.name}</div>`, `
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
  return page(`<div>
    <div data-testid="tweetTextarea_0" contenteditable="true" role="textbox" style="min-height:60px;border:1px solid #ccc"></div>
    <div data-testid="toolBar"><div data-testid="ScrollSnap-List"><button>图片</button></div></div>
  </div>
  <article data-testid="tweet"><div data-testid="tweetText">说实话，这不仅仅是一个工具，更是一种全新的工作方式——它赋能每一个创作者。🚀✨🔥</div>
    <div role="group"><button>回复</button></div></article>`, `
    // 简化的 Draft.js 粘贴行为
    const ed = document.querySelector('[data-testid="tweetTextarea_0"]');
    ed.addEventListener('paste', (e) => { e.preventDefault(); ed.innerText = e.clipboardData.getData('text/plain'); });`);
}

// X 前端代码里登记 GraphQL 操作的写法（这里写成合法的 JS，页面加载时不会报错）。
const MAIN_JS_BODY = `window.__mockOps = [
  {queryId:"zzz",operationName:"Followers",operationType:"query",metadata:{featureSwitches:["rweb_tipjar_consumption_enabled"],fieldToggles:[]}},
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
    if (!m || m[1] !== QID || m[2] !== 'Following') return json(r, 404, { errors: [{ message: 'Query not found' }] });
    if (fromPlugin && state.collectApiBroken) return r.fulfill({ status: 404, body: '' });
    if (!url.searchParams.get('features')) return json(r, 400, { errors: [{ message: 'The following features cannot be null: rweb_tipjar_consumption_enabled' }] });
    const vars = JSON.parse(url.searchParams.get('variables') || '{}');
    state.calls.following++;
    if (fromPlugin && state.rateLimitOnce && vars.cursor) {
      state.rateLimitOnce = false;
      return json(r, 429, { errors: [{ code: 88, message: 'Rate limit exceeded' }] }, { 'x-rate-limit-remaining': '0', 'x-rate-limit-reset': String(Math.floor(Date.now() / 1000) + 2) });
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
    if (fm[1] === 'destroy') state.following.delete(u.id); else state.following.add(u.id);
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
  if (p === `/${ME.handle}/following`) return html(followingHtml());
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

module.exports = { route, routeStatic, USERS, ME, state, reset, COOKIES };
