// 运行：node --test tests/
const test = require('node:test');
const assert = require('node:assert');
require('../src/lib/store.js');
require('../src/lib/rules.js');
require('../src/lib/algo.js');
require('../src/lib/llm.js');
const { XARules, XAAlgo, XAStore, XALLM } = globalThis;

test('AI 腔中文推文得分高', () => {
  const r = XARules.analyze('说实话，这不仅仅是一个工具，更是一种全新的工作方式——它赋能每一个创作者，打通内容链路，形成闭环。归根结底，未来已来。🚀✨🔥 #AI #效率 #创作');
  assert.ok(r.score >= 60, `score=${r.score}`);
  const ids = r.hits.map((h) => h.id);
  for (const id of ['not-x-but-y', 'staged-runup', 'ai-vocab-zh', 'emoji-stack', 'hashtags', 'closer']) assert.ok(ids.includes(id), id);
});

test('AI 腔英文推文得分高', () => {
  const r = XARules.analyze("Here's the thing: it's not just a tool, it's a game-changer. We delve into the ever-evolving landscape to unlock seamless workflows. Let that sink in.");
  assert.ok(r.score >= 60, `score=${r.score}`);
});

test('口语化推文得分低', () => {
  const r = XARules.analyze('昨天把家里那台 2015 年的 MacBook 拆了，风扇里全是猫毛。清完以后温度降了 12 度，早该弄了。');
  assert.ok(r.score <= 15, `score=${r.score} ${JSON.stringify(r.hits)}`);
  const e = XARules.analyze('Spent 3 hours debugging a timezone bug. It was a missing Z in one ISO string. I need a walk.');
  assert.ok(e.score <= 15, `score=${e.score} ${JSON.stringify(e.hits)}`);
});

test('X 的计数长度：中文算 2', () => {
  assert.strictEqual(XARules.weightedLength('abc'), 3);
  assert.strictEqual(XARules.weightedLength('你好a'), 5);
});

test('算法推算：基线 50 分，更好更高，带举报风险更低', () => {
  const base = Object.fromEntries(Object.entries(XAAlgo.ACTIONS).map(([k, v]) => [k, v[2]]));
  assert.strictEqual(XAAlgo.score(base).score, 50);
  const better = { ...base, reply: 0.012, share_via_copy_link: 0.002 };
  assert.ok(XAAlgo.score(better).score > 60);
  const risky = { ...base, report: 0.003, not_interested: 0.02 };
  assert.ok(XAAlgo.score(risky).score < 30, String(XAAlgo.score(risky).score));
});

test('本地检查识别外链和提问', () => {
  const c = XAAlgo.localChecks('新文章写好了 https://example.com/post 你们怎么看？');
  assert.ok(c.hasLink);
  assert.ok(c.tips.some((t) => t.level === 'good'));
});

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

test('宽松解析模型返回的 JSON', () => {
  assert.deepStrictEqual(XALLM.parseLooseJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepStrictEqual(XALLM.parseLooseJson('好的：{"a":2} 完'), { a: 2 });
});
