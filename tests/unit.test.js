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
  assert.strictEqual(XARules.weightedLength('看 https://example.com/a/very/long/path?x=1 吧'), 2 + 1 + 23 + 1 + 2);
  assert.strictEqual(XARules.weightedLength('ok👍🏽'), 4);
  assert.strictEqual(XARules.weightedLength('你好，世界'), 10);
  assert.strictEqual(XARules.weightedLength('a—b'), 3);
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

test('老版本设置迁移：默认改为不用每批确认，之后尊重用户的选择', () => {
  const old = XAStore.mergeSettings({ confirmEachBatch: true, dryRun: true });
  assert.strictEqual(old.confirmEachBatch, false);
  assert.strictEqual(old.dryRun, true);
  assert.strictEqual(old.autoStart, true);
  assert.strictEqual(old.v, XAStore.SETTINGS_VERSION);
  const chosen = XAStore.mergeSettings({ ...old, confirmEachBatch: true });
  assert.strictEqual(chosen.confirmEachBatch, true);
  assert.strictEqual(XAStore.mergeSettings().confirmEachBatch, false);
});

test('流式回复：拼出 Anthropic 的文本，换模型时丢掉前一个模型的半截内容', async () => {
  const sse = [
    'event: message_start\ndata: {"type":"message_start","message":{}}\n\n',
    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}\n\n',
    'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"{\\"ok\\": "}}\n\n',
    'event: content_block_delta\r\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"true}"}}\r\n\r\n',
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n',
  ];
  const res = new Response(new ReadableStream({ start(c) { for (const x of sse) c.enqueue(new TextEncoder().encode(x)); c.close(); } }), { headers: { 'content-type': 'text/event-stream' } });
  const out = await XALLM.readAnthropic(res);
  assert.deepStrictEqual(XALLM.parseLooseJson(out.text), { ok: true });
  assert.strictEqual(out.stopReason, 'end_turn');

  const withFallback = [
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":"半截"}}\n\n',
    'data: {"type":"content_block_start","index":1,"content_block":{"type":"fallback"}}\n\n',
    'data: {"type":"content_block_start","index":2,"content_block":{"type":"text","text":""}}\n\n',
    'data: {"type":"content_block_delta","index":2,"delta":{"type":"text_delta","text":"完整"}}\n\n',
  ];
  const res2 = new Response(withFallback.join(''), { headers: { 'content-type': 'text/event-stream' } });
  assert.strictEqual((await XALLM.readAnthropic(res2)).text, '完整');

  const oa = new Response('data: {"choices":[{"delta":{"content":"{\\"a\\":"}}]}\n\ndata: {"choices":[{"delta":{"content":"1}"}}]}\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
  assert.strictEqual(await XALLM.readOpenAI(oa), '{"a":1}');
  const plain = new Response(JSON.stringify({ choices: [{ message: { content: '{"b":2}' } }] }), { headers: { 'content-type': 'application/json' } });
  assert.strictEqual(await XALLM.readOpenAI(plain), '{"b":2}');
});
