// 运行：node --test tests/
const test = require('node:test');
const assert = require('node:assert');
require('../src/lib/trends.js');
require('../src/lib/llm.js');
require('../src/lib/store.js');
require('../src/lib/xapi.js');
const { XAStore, XAPI, XATrends, XALLM } = globalThis;

test('节奏硬性边界不能被突破', () => {
  const p = XAStore.normalizePace({ minDelaySec: 1, maxDelaySec: 2, batchSize: 500, restMinMin: 0, restMaxMin: 1, dailyCap: 9999 });
  assert.deepStrictEqual(p, { minDelaySec: 5, maxDelaySec: 8, batchSize: 30, restMinMin: 10, restMaxMin: 15, dailyCap: 200 });
  assert.strictEqual(XAStore.effectiveDailyCap(XAStore.mergeSettings({ newAccountMode: true })), 30);
});

test('标签', () => {
  const tags = XAStore.tagsFor({ followsYou: false, defaultAvatar: true, followers: 3, following: 10, tweets: 0 }, { fewFollowers: 50 });
  for (const t of ['notFollowBack', 'defaultAvatar', 'noTweets', 'suspectBot', 'fewFollowers']) assert.ok(tags.includes(t), t);
  assert.deepStrictEqual(XAStore.tagsFor({ followsYou: true }, {}), []);
});

test('老版本设置迁移：默认改为不用每批确认，之后尊重用户的选择；去掉推文体检的设置', () => {
  const old = XAStore.mergeSettings({ confirmEachBatch: true, dryRun: true });
  assert.strictEqual(old.confirmEachBatch, false);
  assert.strictEqual(old.dryRun, true);
  assert.strictEqual(old.autoStart, true);
  assert.strictEqual(old.v, XAStore.SETTINGS_VERSION);
  const chosen = XAStore.mergeSettings({ ...old, confirmEachBatch: true });
  assert.strictEqual(chosen.confirmEachBatch, true);
  assert.strictEqual(XAStore.mergeSettings().confirmEachBatch, false);
  const v2 = XAStore.mergeSettings({ v: 2, llm: { apiKey: 'k', provider: 'openai' }, ui: { composer: true }, keepAwake: false });
  assert.strictEqual(v2.llm.apiKey, undefined); // 老版本存在设置里的 key 删掉
  assert.strictEqual(v2.llm.provider, 'anthropic');
  assert.strictEqual(v2.ui, undefined);
  assert.strictEqual(v2.keepAwake, false);
  assert.strictEqual(XAStore.mergeSettings().keepAwake, true);
});

test('取关接口返回值归类', () => {
  const c = (action, r) => XAPI.classifyFriendship(action, r).result;
  assert.strictEqual(c('unfollow', { status: 200, json: { id_str: '1' } }), 'ok');
  assert.strictEqual(c('follow', { status: 200, json: { protected: true, following: false, follow_request_sent: true } }), 'pending');
  assert.strictEqual(c('unfollow', { status: 429, json: null }), 'rate_limited');
  assert.strictEqual(c('follow', { status: 403, json: { errors: [{ code: 161 }] } }), 'rate_limited');
  assert.strictEqual(c('unfollow', { status: 403, json: { errors: [{ code: 326 }] } }), 'locked');
  assert.strictEqual(c('unfollow', { status: 403, json: { errors: [{ code: 226 }] } }), 'captcha');
  assert.strictEqual(c('unfollow', { status: 401, json: { errors: [{ code: 32 }] } }), 'auth');
  assert.strictEqual(c('unfollow', { status: 403, json: { errors: [{ code: 353 }] } }), 'auth');
  assert.strictEqual(c('unfollow', { status: 404, json: { errors: [{ code: 50 }] } }), 'gone');
  assert.strictEqual(c('follow', { status: 403, json: { errors: [{ code: 162 }] } }), 'blocked');
  // 接口本身不可用（没有错误码的 404/403）才换备用方式；页面没响应只是偶发问题。
  assert.strictEqual(c('unfollow', { status: 404, json: null }), 'api_unavailable');
  assert.strictEqual(c('unfollow', { status: 0, error: 'timeout' }), 'no_response');
  assert.strictEqual(c('unfollow', { status: 0, error: 'no_csrf' }), 'auth');
  assert.strictEqual(c('unfollow', { status: 500, json: null }), 'error');
  assert.strictEqual(XAPI.apiUnavailable({ status: 0, error: 'no_context' }), false);
});

test('从前端代码里找 GraphQL 操作', () => {
  const js = 'x={queryId:"q1",operationName:"Followers",operationType:"query",metadata:{featureSwitches:["a"],fieldToggles:[]}},'
    + 'y={queryId:"Q-2_x",operationName:"Following",operationType:"query",metadata:{featureSwitches:["f1","f2"],fieldToggles:["t1"]}}';
  assert.deepStrictEqual(XAPI.findOperation(js, 'Following'), { qid: 'Q-2_x', featureNames: ['f1', 'f2'], fieldToggleNames: ['t1'] });
  assert.deepStrictEqual(XAPI.findOperation('queryId:"z9",operationName:"Following"', 'Following'), { qid: 'z9', featureNames: null, fieldToggleNames: [] });
  assert.strictEqual(XAPI.findOperation(js, 'Nope'), null);
});

test('读取关注列表的请求和解析', () => {
  const op = { qid: 'abc', featureNames: ['rweb_tipjar_consumption_enabled', 'unknown_flag'], fieldToggles: { withAuxiliaryUserLabels: false } };
  const req = XAPI.followingRequest(op, 42, 'c-20', { unknown_flag: true });
  assert.strictEqual(req.path, '/i/api/graphql/abc/Following');
  assert.deepStrictEqual(JSON.parse(req.query.variables), { userId: '42', count: 50, includePromotedContent: false, cursor: 'c-20' });
  assert.deepStrictEqual(JSON.parse(req.query.features), { rweb_tipjar_consumption_enabled: true, unknown_flag: true });
  assert.ok(req.query.fieldToggles);

  const user = (id, handle) => ({ __typename: 'User', rest_id: id, core: { screen_name: handle, name: handle.toUpperCase() },
    legacy: { followers_count: 5, friends_count: 7, statuses_count: 0 }, relationship_perspectives: { following: true, followed_by: false } });
  const data = { data: { user: { result: { __typename: 'User', rest_id: '1', timeline: { timeline: { instructions: [{ type: 'TimelineAddEntries', entries: [
    { entryId: 'user-2', content: { itemContent: { user_results: { result: user('2', 'alice') } } } },
    { entryId: 'user-3', content: { itemContent: { user_results: { result: user('3', 'bob') } } } },
    { entryId: 'cursor-top-1', content: { value: 'top', cursorType: 'Top' } },
    { entryId: 'cursor-bottom-1', content: { value: 'next-page', cursorType: 'Bottom' } },
  ] }] } } } } } };
  const users = XAPI.parseGraphQLUsers(data);
  assert.deepStrictEqual(users.map((u) => u.handle), ['alice', 'bob']); // 外层「你自己」不算
  assert.strictEqual(users[0].id, '2');
  assert.strictEqual(users[0].followsYou, false);
  assert.strictEqual(users[0].tweets, 0);
  assert.strictEqual(XAPI.bottomCursor(data), 'next-page');
  assert.strictEqual(XAPI.bottomCursor({ data: {} }), null);
  // X 部分出错时只返回 data:{user:{}}，没有时间线，不能当成「读完了」
  assert.strictEqual(XAPI.hasTimeline(data), true);
  assert.strictEqual(XAPI.hasTimeline({ errors: [{ message: 'Timeout' }], data: { user: {} } }), false);
});

test('取关请求带上用户 ID', () => {
  const r = XAPI.friendshipRequest('unfollow', 123);
  assert.strictEqual(r.path, '/i/api/1.1/friendships/destroy.json');
  assert.strictEqual(r.form.user_id, '123');
  assert.strictEqual(XAPI.friendshipRequest('follow', 1).path, '/i/api/1.1/friendships/create.json');
});

test('预计完成时间', () => {
  const s = XAStore.mergeSettings();
  const now = new Date(2026, 9, 14, 9, 0, 0).getTime();
  const day = XAStore.dayKey(now);
  const today = XAStore.estimateFinish({ status: 'running', doneToday: 0, day, nextActionAt: now }, 20, s, now);
  assert.strictEqual(today.days, 0);
  assert.ok(today.at > now && today.at < now + 3 * 3600 * 1000);
  const later = XAStore.estimateFinish({ status: 'idle', doneToday: 90, day }, 250, s, now);
  assert.strictEqual(later.days, 3); // 今天还能 10 个，之后每天 100 个
  assert.strictEqual(XAStore.estimateFinish(null, 0, s, now), null);
  assert.strictEqual(XAStore.mergeSettings({ execMode: 'weird' }).execMode, 'auto');
});

test('重新读取后：日志里取关成功、X 上仍在关注的人', () => {
  const before = 1000;
  const users = { a: {}, b: {}, c: {}, d: {}, e: {} };
  const log = [
    { key: 'a', action: 'unfollow', result: 'ok', t: 100 }, // 取关成功但还在列表里
    { key: 'b', action: 'unfollow', result: 'ok', t: 100 },
    { key: 'b', action: 'follow', result: 'ok', t: 200 }, // 之后又重新关注了，不算
    { key: 'c', action: 'unfollow', result: 'no_response', t: 100 }, // 没成功，不算
    { key: 'd', action: 'unfollow', result: 'ok', t: 100, dryRun: true }, // 演练，不算
    { key: 'e', action: 'unfollow', result: 'ok', t: 1500 }, // 读取开始后才取关，不算
    { key: 'gone', action: 'unfollow', result: 'ok', t: 100 }, // 已经不在列表里，不算
  ];
  assert.deepStrictEqual(XAStore.unfollowsNotApplied(log, users, before), { a: 100 });
  assert.deepStrictEqual(XAStore.unfollowsNotApplied(null, users, before), {});
  assert.deepStrictEqual(XAStore.unfollowsNotApplied(log, users, before, 150), {}); // 只看 150 之后的取关
  assert.deepStrictEqual(XAStore.tagsFor({ unfollowFailed: 100, followsYou: true }, {}), ['unfollowFailed']);
});

// ---------- 热点与推文建议 ----------

test('设置迁移：v3 升级后有热点和模型设置的默认值，模型 key 不放在设置里', () => {
  const s = XAStore.mergeSettings({ v: 3, keepAwake: false });
  assert.strictEqual(s.v, 4);
  assert.strictEqual(s.trends.enabled, true);
  assert.deepStrictEqual(s.trends.lists, { ai: [], web3: [] });
  assert.ok(s.trends.rss.web3.length > 0);
  assert.strictEqual(s.llm.provider, 'anthropic');
  assert.strictEqual(s.llm.apiKey, undefined);
  // v4 保存的模型设置不能被当成老版本的推文体检删掉
  const kept = XAStore.mergeSettings({ v: 4, llm: { provider: 'deepseek', persona: '理性' } });
  assert.strictEqual(kept.llm.provider, 'deepseek');
  assert.strictEqual(kept.llm.persona, '理性');
  // 列表链接和 ID 都认，去重，非 https 的 RSS 丢掉
  const t = XATrends.normalizeTrends({ lists: { ai: ['https://x.com/i/lists/123456', '123456', 'abc'] }, rss: { web3: ['http://a.com/rss', 'https://b.com/feed'] }, autoRefreshMin: 1 });
  assert.deepStrictEqual(t.lists.ai, ['123456']);
  assert.deepStrictEqual(t.rss.web3, ['https://b.com/feed']);
  assert.strictEqual(t.autoRefreshMin, 10);
});

test('判断内容属于 AI 还是 Web3', () => {
  assert.strictEqual(XATrends.classify('Anthropic ships a new Claude model'), 'ai');
  assert.strictEqual(XATrends.classify('国产大模型又发布了'), 'ai');
  assert.strictEqual(XATrends.classify('比特币 ETF 净流入'), 'web3');
  assert.strictEqual(XATrends.classify('$PEPE is pumping'), 'web3');
  assert.strictEqual(XATrends.classify('今天天气不错'), null);
  assert.strictEqual(XATrends.classify('my real estate agent said'), null);
  assert.strictEqual(XATrends.classify('available now'), null); // ai 要是独立的词
});

function tweetResult(id, text, opts) {
  const o = opts || {};
  return {
    __typename: 'Tweet', rest_id: id,
    core: { user_results: { result: { __typename: 'User', rest_id: '1', core: { screen_name: o.handle || 'kol', name: 'KOL' }, legacy: { followers_count: 1000 } } } },
    views: { count: '5000' },
    legacy: { full_text: text, created_at: 'Wed Oct 22 03:00:00 +0000 2026', favorite_count: 100, retweet_count: 10, reply_count: 5, quote_count: 2,
      entities: { urls: [{ expanded_url: 'https://openai.com/x' }] }, ...(o.legacy || {}) },
  };
}

test('解析时间线里的推文：转推算原推、长推文用全文、去掉 t.co 短链', () => {
  const data = { data: { list: { tweets_timeline: { timeline: { instructions: [{ entries: [
    { content: { itemContent: { tweet_results: { result: tweetResult('1', 'hello AI https://t.co/abc') } } } },
    { content: { itemContent: { tweet_results: { result: { __typename: 'TweetWithVisibilityResults', tweet: tweetResult('2', 'limited') } } } } },
    { content: { itemContent: { tweet_results: { result: tweetResult('3', 'RT', { legacy: { retweeted_status_result: { result: tweetResult('1', 'hello AI https://t.co/abc') } } }) } } } },
    { content: { itemContent: { tweet_results: { result: { ...tweetResult('4', 'short…'), note_tweet: { note_tweet_results: { result: { text: 'the full long text' } } } } } } } },
  ] }] } } } } };
  const tw = XAPI.parseTweets(data);
  assert.deepStrictEqual(tw.map((t) => t.id), ['1', '2', '4']);
  assert.strictEqual(tw[0].text, 'hello AI');
  assert.strictEqual(tw[0].likes, 100);
  assert.strictEqual(tw[0].views, 5000);
  assert.strictEqual(tw[0].handle, 'kol');
  assert.deepStrictEqual(tw[0].urls, ['https://openai.com/x']);
  assert.strictEqual(tw[2].text, 'the full long text');
  assert.ok(tw[0].createdAt > 0);
  const req = XAPI.listTweetsRequest({ qid: 'Q', featureNames: ['a'] }, '123', {});
  assert.strictEqual(req.path, '/i/api/graphql/Q/ListLatestTweetsTimeline');
  assert.deepStrictEqual(JSON.parse(req.query.variables), { listId: '123', count: 100 });
});

test('外部来源解析', () => {
  const hn = XATrends.parseHN({ hits: [
    { objectID: '1', title: 'OpenAI releases GPT-6', url: 'https://openai.com/gpt6', points: 500, num_comments: 200, created_at_i: 1760000000 },
    { objectID: '2', title: 'A Rust web server', url: 'https://x.dev', points: 900, num_comments: 10, created_at_i: 1760000000 },
  ] });
  assert.deepStrictEqual(hn.map((x) => x.id), ['hn:1']);
  assert.strictEqual(hn[0].topic, 'ai');
  const hf = XATrends.parseHF([{ paper: { id: '2610.1', title: 'Paper', summary: 's', upvotes: 9 }, publishedAt: '2026-10-21T00:00:00Z' }]);
  assert.strictEqual(hf[0].url, 'https://huggingface.co/papers/2610.1');
  const cg = XATrends.parseCoinGecko({ coins: [{ item: { id: 'bitcoin', name: 'Bitcoin', symbol: 'btc', score: 0, data: { price_change_percentage_24h: { usd: 3.456 } } } }] }, 1);
  assert.match(cg[0].title, /\$BTC.*\+3\.5%/);
  const gh = XATrends.parseGitHub({ items: [{ id: 5, full_name: 'a/b', description: 'agent kit', html_url: 'https://github.com/a/b', stargazers_count: 10, created_at: '2026-10-20T00:00:00Z' }] });
  assert.strictEqual(gh[0].title, 'a/b：agent kit');
  const rss = XATrends.parseRSS(`<rss><channel>
    <item><title><![CDATA[Bitcoin ETF &amp; flows]]></title><link>https://n.com/a</link><pubDate>Wed, 22 Oct 2026 01:00:00 GMT</pubDate><description>&lt;p&gt;Record &#8220;inflows&#8221;&lt;/p&gt;</description></item>
    <item><title>no link</title></item>
  </channel></rss>`, 'https://www.n.com/rss', 'web3');
  assert.strictEqual(rss.length, 1);
  assert.strictEqual(rss[0].title, 'Bitcoin ETF & flows');
  assert.strictEqual(rss[0].summary, 'Record “inflows”');
  assert.strictEqual(rss[0].feed, 'n.com');
  const atom = XATrends.parseRSS('<feed><entry><title>Claude news</title><link rel="alternate" href="https://a.com/1"/><updated>2026-10-22T00:00:00Z</updated></entry></feed>', 'https://a.com/atom');
  assert.strictEqual(atom[0].url, 'https://a.com/1');
  assert.strictEqual(atom[0].topic, 'ai');
});

test('热度打分和话题归并：同一个链接或同一件事归成一个话题，旧内容和回复不算', () => {
  const now = Date.parse('2026-10-22T06:00:00Z');
  const h = (n) => now - n * 3600000;
  // 列表里的推文直接按列表的领域算，不用每条都带关键词。
  const tw = (id, text, likes, hrs, url, extra) => XATrends.tweetItem({ id, handle: `u${id}`, text, likes, retweets: likes / 10, replies: 0, quotes: 0, views: 0, createdAt: h(hrs), urls: url ? [url] : [], ...(extra || {}) }, id === '7' ? 'web3' : 'ai', 'x');
  const items = [
    tw('1', 'OpenAI GPT-6 launches with reasoning mode', 5000, 2, 'https://openai.com/gpt-6'),
    tw('2', 'Hot take on the new release', 800, 1, 'https://openai.com/gpt-6/'),
    tw('3', 'Qwen4 open weights drop, inference speed doubled, local deploy easier', 300, 3),
    tw('4', 'Qwen4 open weights: inference speed doubled for local deploy', 100, 2),
    tw('5', 'old AI news', 99999, 100),
    tw('6', 'AI reply', 99999, 1, null, { isReply: true }),
    { id: 'hn:1', source: 'hn', topic: 'ai', title: 'GPT-6', url: 'https://openai.com/gpt-6', t: h(3), points: 500, comments: 100 },
    tw('7', '比特币 ETF 单日净流入创新高', 2000, 1),
  ];
  const topics = XATrends.buildTopics(items, now);
  const ai = topics.ai;
  assert.strictEqual(ai[0].count, 3);
  assert.deepStrictEqual(ai[0].sources.sort(), ['hn', 'x']);
  assert.strictEqual(ai[0].title, 'GPT-6'); // 有新闻标题时用标题
  assert.ok(ai.some((t) => t.count === 2 && /Qwen4/.test(t.title)));
  assert.ok(!ai.some((t) => t.items.some((i) => i.id === 'x:5' || i.id === 'x:6')));
  assert.strictEqual(topics.web3.length, 1);
  assert.ok(ai[0].heat > ai[ai.length - 1].heat);
  assert.ok(ai.every((t) => t.heat >= 0 && t.heat <= 100));
});

test('X 的字数算法和发推链接', () => {
  assert.strictEqual(XATrends.weightedLength('abc'), 3);
  assert.strictEqual(XATrends.weightedLength('你好'), 4);
  assert.strictEqual(XATrends.weightedLength('看 https://example.com/a/very/long/path'), 2 + 1 + 23);
  assert.strictEqual(XATrends.weightedLength('“引号”'), 4 + 2); // 弯引号算 1，中文算 2
  const u = new URL(XATrends.composeUrl('你好 #AI', 'https://x.com/a/status/1'));
  assert.strictEqual(u.origin + u.pathname, 'https://x.com/intent/post');
  assert.strictEqual(u.searchParams.get('text'), '你好 #AI');
  assert.strictEqual(u.searchParams.get('url'), 'https://x.com/a/status/1');
});

test('需要授权的网站', () => {
  const o = XATrends.originsFor({ sources: { hn: true, hf: false, hfm: false, reddit: false, gh: false, cg: true, rss: true }, rss: { ai: ['https://a.com/feed'], web3: [] } });
  assert.deepStrictEqual(o.sort(), ['https://a.com/*', 'https://api.coingecko.com/*', 'https://hn.algolia.com/*']);
  const all = XATrends.originsFor({});
  assert.ok(all.includes('https://www.reddit.com/*') && all.includes('https://huggingface.co/*'));
  assert.strictEqual(XALLM.originOf({ provider: 'deepseek' }), 'https://api.deepseek.com/*');
  assert.strictEqual(XALLM.originOf({ provider: 'custom', baseUrl: 'http://insecure' }), null);
});

test('模型请求：Claude 用新版接口、不带采样参数；兼容 OpenAI 的接口用 Bearer', () => {
  const a = XALLM.buildRequest({ provider: 'anthropic' }, 'k1', 'sys', 'hi');
  assert.strictEqual(a.url, 'https://api.anthropic.com/v1/messages');
  assert.strictEqual(a.init.headers['anthropic-version'], '2026-10-21');
  assert.strictEqual(a.init.headers['x-api-key'], 'k1');
  const body = JSON.parse(a.init.body);
  assert.strictEqual(body.model, 'claude-haiku-5-5');
  assert.strictEqual(body.system, 'sys');
  assert.ok(!('temperature' in body) && !('top_p' in body));
  const d = XALLM.buildRequest({ provider: 'deepseek' }, 'k2', 's', 'u');
  assert.strictEqual(d.url, 'https://api.deepseek.com/chat/completions');
  assert.strictEqual(d.init.headers.authorization, 'Bearer k2');
  assert.strictEqual(JSON.parse(d.init.body).messages[0].role, 'system');
  const c = XALLM.buildRequest({ provider: 'custom', baseUrl: 'https://api.moonshot.cn/v1/', model: 'kimi' }, 'k', 's', 'u');
  assert.strictEqual(c.url, 'https://api.moonshot.cn/v1/chat/completions');
  assert.throws(() => XALLM.buildRequest({ provider: 'anthropic' }, '', 's', 'u'), /API key/);
  assert.throws(() => XALLM.buildRequest({ provider: 'custom', baseUrl: 'https://a.com' }, 'k', 's', 'u'), /模型名称/);
});

test('模型返回值解析和草稿提取', () => {
  const r = XALLM.parseResponse({ provider: 'anthropic' }, 200, { stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: 'hi' }] });
  assert.strictEqual(r.text, 'hi');
  assert.throws(() => XALLM.parseResponse({ provider: 'anthropic' }, 200, { stop_reason: 'refusal', content: [] }), /拒绝/);
  assert.throws(() => XALLM.parseResponse({ provider: 'openai' }, 401, { error: { message: 'bad key' } }), /API key 无效.*bad key/);
  assert.throws(() => XALLM.parseResponse({ provider: 'openai' }, 429, {}), /限流/);
  assert.strictEqual(XALLM.parseResponse({ provider: 'openai' }, 200, { choices: [{ message: { content: 'yo' } }] }).text, 'yo');
  const out = XALLM.parseDrafts('好的：\n```json\n{"summary":"s","drafts":[{"style":"观点","text":" a "},{"style":"x","text":""},{"text":"b"},{"text":"c"},{"text":"d"}]}\n```');
  assert.strictEqual(out.summary, 's');
  assert.deepStrictEqual(out.drafts.map((x) => x.text), ['a', 'b', 'c']);
  assert.throws(() => XALLM.parseDrafts('not json'), /格式不对/);
});

test('提示词带上资料、语言和账号定位', () => {
  const p = XALLM.draftPrompt({ llm: { lang: 'en', persona: '理性派' }, topic: 'web3', title: 'BTC ETF', context: [{ source: 'rss', sourceLabel: 'coindesk.com', title: 'ETF inflows', url: 'https://c.com/a' }] });
  assert.match(p.system, /Web3/);
  assert.match(p.system, /English/);
  assert.match(p.system, /理性派/);
  assert.match(p.user, /BTC ETF/);
  assert.match(p.user, /coindesk\.com.*ETF inflows/);
  const q = XALLM.draftPrompt({ llm: {}, topic: 'ai', mode: 'quote', quote: { author: 'kol', text: 'GPT-6!', likes: 5 }, context: [] });
  assert.match(q.user, /引用/);
  assert.match(q.user, /@kol：GPT-6!/);
});


test('新来源：X 趋势榜、Hugging Face 热门模型、Reddit', () => {
  const data = { data: { explore_sidebar: { timeline: { instructions: [{ entries: [
    { content: { items: [
      { item: { itemContent: { itemType: 'TimelineTrend', name: '#GPT6', trend_metadata: { domain_context: 'Technology · Trending', meta_description: '12.3K posts' } } } },
      { item: { itemContent: { itemType: 'TimelineTrend', name: 'Bitcoin', trend_metadata: { domain_context: 'Cryptocurrency · Trending', meta_description: '1.2万 帖子' } } } },
      { item: { itemContent: { itemType: 'TimelineTrend', name: 'Taylor Swift', trend_metadata: { domain_context: 'Music · Trending', meta_description: '80K posts' } } } },
    ] } },
  ] }] } } } };
  const trends = XAPI.parseTrends(data);
  assert.deepStrictEqual(trends.map((t) => [t.name, t.rank]), [['#GPT6', 1], ['Bitcoin', 2], ['Taylor Swift', 3]]);
  const items = trends.map((t) => XATrends.xTrendItem(t, 1)).filter(Boolean);
  assert.deepStrictEqual(items.map((i) => [i.name, i.topic, i.posts]), [['#GPT6', 'ai', 12300], ['Bitcoin', 'web3', 12000]]);
  assert.strictEqual(XATrends.parsePostCount('1,234 posts'), 1234);
  assert.strictEqual(XATrends.parsePostCount('2.5M posts'), 2500000);

  const m = XATrends.parseHFModels([{ id: 'Qwen/Qwen4-7B-Instruct', trendingScore: 300, likes: 10, pipeline_tag: 'text-generation' }, { id: 'meta-llama/Llama-4-Scout' }], 1);
  assert.deepStrictEqual(m.map((x) => x.keys), [['qwen4'], ['llama4']]);
  assert.strictEqual(m[0].url, 'https://huggingface.co/Qwen/Qwen4-7B-Instruct');

  const r = XATrends.parseReddit({ data: { children: [
    { data: { id: 'a', title: 'Qwen4 7B beats everything locally', permalink: '/r/LocalLLaMA/comments/a/x/', url: 'https://qwenlm.github.io/blog/qwen4', score: 900, num_comments: 300, created_utc: 1760000000 } },
    { data: { id: 'b', title: 'Weekly thread', stickied: true } },
  ] } }, 'LocalLLaMA', 'ai');
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].url, 'https://www.reddit.com/r/LocalLLaMA/comments/a/x/');
  assert.deepStrictEqual(r[0].links, ['https://qwenlm.github.io/blog/qwen4']);
  assert.strictEqual(r[0].feed, 'r/LocalLLaMA');
});

test('打分去偏：大号打折、同一博主只算一个声音、只在关注圈里的话题打折、趋势词能和推文归到一起', () => {
  const now = Date.parse('2026-10-22T06:00:00Z');
  const h = (n) => now - n * 3600000;
  const tw = (id, handle, text, likes, followers, src) => XATrends.tweetItem({ id, handle, text, likes, retweets: 0, replies: 0, quotes: 0, views: 0, followers, createdAt: h(2), urls: [] }, 'ai', src || 'x');
  // 粉丝 500 万的大号 1 万赞，不一定比粉丝 2000 的小号 3000 赞更「热」
  const big = tw('1', 'big', 'aaa', 10000, 5000000);
  const small = tw('2', 'small', 'bbb', 3000, 2000);
  assert.ok(XATrends.velocity(small, now) > XATrends.velocity(big, now));

  // 同一个博主刷屏：不比两个不同的人讲同一件事更热
  const spam = ['11', '12', '13'].map((id) => tw(id, 'same', 'Gemini 4 Ultra launches today with video understanding', 500, 1000));
  const two = [tw('21', 'p1', 'Claude Opus agentic coding upgrade lands for teams', 500, 1000), tw('22', 'p2', 'Claude Opus agentic coding upgrade is impressive for teams', 500, 1000)];
  const ts = XATrends.buildTopics([...spam, ...two], now).ai;
  const spamT = ts.find((t) => /Gemini/.test(t.title));
  const twoT = ts.find((t) => /Claude/.test(t.title));
  assert.strictEqual(spamT.why.authors, 1);
  assert.strictEqual(twoT.why.authors, 2);
  assert.ok(twoT.heat > spamT.heat);
  assert.ok(spamT.why.personalOnly);

  // X 趋势词 #GPT6 和讲 GPT-6 的推文、新闻是同一件事
  const xt = XATrends.xTrendItem({ name: '#GPT6', domain: 'Technology', meta: '50K posts', rank: 1, seenAt: h(1) }, now);
  const items = [xt, tw('31', 'a1', 'GPT-6 is out and the reasoning mode is great', 800, 10000),
    { id: 'reddit:x', source: 'reddit', topic: 'ai', title: 'OpenAI GPT-6 discussion', url: 'https://www.reddit.com/r/x', t: h(2), points: 500, comments: 200, feed: 'r/LocalLLaMA' }];
  const g = XATrends.buildTopics(items, now).ai;
  assert.strictEqual(g.length, 1);
  assert.strictEqual(g[0].why.xPosts, 50000);
  assert.ok(!g[0].why.personalOnly);
  assert.strictEqual(g[0].title, 'OpenAI GPT-6 discussion'); // 有社区帖子标题时用它
  // 太短的趋势词不乱配
  assert.strictEqual(XATrends.buildTopics([XATrends.xTrendItem({ name: 'Sam', domain: 'Technology AI' }, now), tw('41', 'z', 'sam altman says AI', 10, 10)], now).ai.length, 2);
});

// ---------- 多久没发推 ----------

function userTweetsPage(entries, pinned) {
  const mk = (id, author, created, extra) => ({ entryId: `tweet-${id}`, content: { itemContent: { tweet_results: { result: {
    __typename: 'Tweet', rest_id: id, core: { user_results: { result: { __typename: 'User', rest_id: author } } },
    legacy: { created_at: created, full_text: 'x', ...(extra || {}) },
  } } } } });
  const instructions = [];
  if (pinned) instructions.push({ type: 'TimelinePinEntry', entry: mk(...pinned) });
  instructions.push({ type: 'TimelineAddEntries', entries: entries.map((e) => mk(...e)) });
  return { data: { user: { result: { __typename: 'User', timeline: { timeline: { instructions } } } } } };
}

test('最近发推时间：取本人推文的最大时间，置顶旧推和别人的推文不影响', () => {
  const data = userTweetsPage([
    ['1', '42', 'Mon Mar 02 10:00:00 +0000 2026'],
    ['2', '77', 'Mon Oct 19 10:00:00 +0000 2026'], // 回复串里别人的推文
    ['3', '42', 'Sun Feb 01 10:00:00 +0000 2026'],
  ], ['9', '42', 'Fri Jan 03 10:00:00 +0000 2020']);
  const r = XAPI.lastActivity(data, '42');
  assert.strictEqual(r.state, 'ok');
  assert.strictEqual(r.count, 3);
  assert.strictEqual(r.lastAt, Date.parse('Mon Mar 02 10:00:00 +0000 2026'));
  // 置顶的推文比时间线里的都新时，也算数（它确实是最近发的）。
  const pinNewest = XAPI.lastActivity(userTweetsPage([['1', '42', 'Mon Mar 02 10:00:00 +0000 2026']], ['9', '42', 'Mon Oct 19 10:00:00 +0000 2026']), '42');
  assert.strictEqual(pinNewest.lastAt, Date.parse('Mon Oct 19 10:00:00 +0000 2026'));
});

test('最近发推时间：看不到推文、账号不可用、返回不是时间线', () => {
  assert.strictEqual(XAPI.lastActivity(userTweetsPage([['2', '77', 'Mon Oct 19 10:00:00 +0000 2026']]), '42').state, 'empty');
  assert.strictEqual(XAPI.lastActivity({ data: { user: { result: { __typename: 'UserUnavailable' } } } }, '42').state, 'unavailable');
  assert.strictEqual(XAPI.lastActivity({ data: { user: {} } }, '42').state, 'unavailable');
  assert.strictEqual(XAPI.lastActivity({ errors: [{ message: 'x' }] }, '42').state, 'bad');
});

test('时间线里每个作者最近一次发帖的时间；主页资料判断账号还在不在', () => {
  const data = userTweetsPage([
    ['1', '42', 'Mon Mar 02 10:00:00 +0000 2026'],
    ['2', '77', 'Mon Oct 19 10:00:00 +0000 2026'],
    ['3', '42', 'Sun Feb 01 10:00:00 +0000 2026'],
  ]);
  assert.deepStrictEqual(XAPI.postTimes(data), { 42: Date.parse('Mon Mar 02 10:00:00 +0000 2026'), 77: Date.parse('Mon Oct 19 10:00:00 +0000 2026') });
  assert.deepStrictEqual(XAPI.profileUser({ data: { user: { result: { __typename: 'User', rest_id: '42' } } } }), { unavailable: false, userId: '42' });
  assert.strictEqual(XAPI.profileUser({ data: { user: { result: { __typename: 'UserUnavailable' } } } }).unavailable, true);
  assert.strictEqual(XAPI.profileUser({ data: {} }).unavailable, true);
});

test('刷到的帖子只会让人显得更活跃', () => {
  const now = Date.parse('2026-10-24T00:00:00Z');
  const day = 86400000;
  // 没查过的人：一个月内发过 → 直接算查过；更早的帖子不能说明 TA 之后没发过，不记。
  assert.deepStrictEqual(XAStore.seenPostPatch({ id: '1' }, now - 3 * day, now), { activity: 'ok', lastTweetAt: now - 3 * day, activityAt: now, activityApprox: false });
  assert.strictEqual(XAStore.seenPostPatch({ id: '1' }, now - 90 * day, now), null);
  // 查过的人：比记录的新才更新；比记录的旧不动。
  const checked = { id: '1', activity: 'ok', lastTweetAt: now - 200 * day, activityAt: now - day };
  assert.deepStrictEqual(XAStore.seenPostPatch(checked, now - 100 * day, now), { lastTweetAt: now - 100 * day, activityApprox: false });
  assert.strictEqual(XAStore.seenPostPatch(checked, now - 300 * day, now), null);
  assert.strictEqual(XAStore.seenPostPatch(checked, NaN, now), null);
});

test('多久没发推：天数、显示文字、要不要重新检查', () => {
  const now = Date.parse('2026-10-24T00:00:00Z');
  const day = 86400000;
  const u = { id: '1', activity: 'ok', lastTweetAt: now - 200 * day, activityAt: now - day, tweets: 10 };
  assert.strictEqual(XAStore.inactiveDays(u, now), 200);
  assert.strictEqual(XAStore.activityText(u, now), '6 个月前');
  assert.strictEqual(XAStore.needsActivityCheck(u, now), false);
  assert.strictEqual(XAStore.needsActivityCheck({ ...u, activityAt: now - 20 * day }, now), true);
  assert.strictEqual(XAStore.needsActivityCheck({ id: '1', tweets: 5 }, now), true);
  // 没检查过、看不到推文的人不算「不活跃」，避免误取关。
  assert.strictEqual(XAStore.inactiveDays({ id: '1', tweets: 5 }, now), null);
  assert.strictEqual(XAStore.inactiveDays({ id: '1', tweets: 5, activity: 'empty', activityAt: now }, now), null);
  // 推文数为 0：不用查，按注册了多久算。
  const never = { id: '2', tweets: 0, createdAt: 'Mon Jan 01 00:00:00 +0000 2024' };
  assert.strictEqual(XAStore.needsActivityCheck(never, now), false);
  assert.ok(XAStore.inactiveDays(never, now) > 365);
  assert.strictEqual(XAStore.activityText(never, now), '从没发过');
  assert.strictEqual(XAStore.activityText({ ...u, lastTweetAt: now - 400 * day }, now), '1.1 年前');
  assert.strictEqual(XAStore.activityText({ ...u, lastTweetAt: now - 3 * day, activityApprox: true }, now), '3 天内');
});
