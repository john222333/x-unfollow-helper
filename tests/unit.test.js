// 运行：node --test tests/
const test = require('node:test');
const assert = require('node:assert');
require('../src/lib/store.js');
require('../src/lib/xapi.js');
const { XAStore, XAPI } = globalThis;

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
  const v2 = XAStore.mergeSettings({ v: 2, llm: { apiKey: 'k' }, ui: { composer: true }, keepAwake: false });
  assert.strictEqual(v2.llm, undefined);
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
