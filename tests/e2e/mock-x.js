// 模拟 x.com 的几个页面，只复刻插件依赖的 data-testid 结构，用于端到端测试。
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

function followingPage(cursor) {
  const start = Number(cursor || 0);
  const slice = USERS.slice(start, start + 10);
  return {
    data: { user: { result: { timeline: { timeline: { instructions: [{
      type: 'TimelineAddEntries',
      entries: slice.map((u) => ({ entryId: `user-${u.id}`, content: { itemContent: { user_results: { result: gqlUser(u) } } } })),
    }] } } } } },
  };
}

const NAV = '<nav><a data-testid="AppTabBar_Profile_Link" href="/tester">Profile</a></nav>';

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
  return `<!doctype html><html><head><meta charset="utf-8"><title>X</title></head>
  <body style="background:#fff;margin:0">${NAV}<main><div data-testid="primaryColumn" style="width:600px">${body}</div></main>
  <script>${script || ''}</script></body></html>`;
}

function followingHtml() {
  // 首屏渲染 10 个；滚到底部时像 X 一样请求下一页 GraphQL 并追加单元格。
  return page(`<div id="list">${USERS.slice(0, 10).map(cellHtml).join('')}</div><div style="height:400px"></div>`, `
    const ALL = ${JSON.stringify(USERS)};
    const cell = ${cellHtml.toString()};
    let next = 10, busy = false;
    fetch('/i/api/graphql/abc/Following?variables=' + encodeURIComponent('{"cursor":0}')).then(r => r.json());
    addEventListener('scroll', async () => {
      if (busy || next >= ALL.length) return;
      if (scrollY + innerHeight < document.documentElement.scrollHeight - 300) return;
      busy = true;
      await fetch('/i/api/graphql/abc/Following?variables=' + encodeURIComponent(JSON.stringify({ cursor: next }))).then(r => r.json());
      document.getElementById('list').insertAdjacentHTML('beforeend', ALL.slice(next, next + 10).map(cell).join(''));
      next += 10; busy = false;
    });`);
}

function profileHtml(handle) {
  const u = USERS.find((x) => x.handle === handle);
  if (!u) return page('<div data-testid="emptyState">This account doesn’t exist</div>');
  const limited = handle === 'user29';
  return page(`<div data-testid="placementTracking"><button id="fb" data-testid="${u.id}-unfollow">Following</button></div>
    <div data-testid="UserName">${u.name}</div>`, `
    document.getElementById('fb').addEventListener('click', () => {
      const b = document.getElementById('fb');
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
          setTimeout(() => { b.dataset.testid = '${u.id}-follow'; b.textContent = 'Follow'; }, 300);
        });
      } else {
        setTimeout(() => { b.dataset.testid = '${u.id}-unfollow'; b.textContent = 'Following'; }, 300);
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

async function route(r) {
  const url = new URL(r.request().url());
  const p = url.pathname;
  const html = (body) => r.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body });
  if (p.startsWith('/i/api/graphql/')) {
    const vars = JSON.parse(url.searchParams.get('variables') || '{}');
    return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(followingPage(vars.cursor)) });
  }
  if (p === '/home' || p === '/') return html(homeHtml());
  if (p === '/tester/following') return html(followingHtml());
  const m = /^\/([A-Za-z0-9_]+)\/?$/.exec(p);
  if (m) return html(profileHtml(m[1]));
  return r.fulfill({ status: 404, body: '' });
}

module.exports = { route, USERS };
