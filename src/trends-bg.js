// Service worker 里的热点功能：收集各来源的数据、算出话题、调用你自己的模型写推文草稿。
// 由 background.js 用 importScripts 载入，借用它的 store、apiCall、getContextTab 等工具。
// 不会替你发推：草稿只会填进 X 的发推框，发不发由你决定。
(function () {
  'use strict';

  const T = self.XATrends;
  const L = self.XALLM;
  const TWEET_KEEP_MS = 72 * 3600 * 1000;
  const TWEET_CAP = 1500;
  const FETCH_TIMEOUT_MS = 15000;

  const tweetLock = makeLock();
  let refreshing = null; // 正在进行的刷新（同一时间只跑一次）

  async function trendSettings() {
    const settings = await getSettings();
    return { trends: settings.trends, llm: settings.llm };
  }

  // ---------- 你在网页上刷到的推文 ----------

  // 列表 ID → 领域。你在设置里登记过的列表，里面的推文直接算这个领域；其他推文按内容判断。
  function listTopic(trends, listId) {
    if (!listId) return null;
    for (const t of T.TOPICS) if (trends.lists[t].includes(String(listId))) return t;
    return null;
  }

  async function addTweets(tweets, how) {
    const { trends } = await trendSettings();
    if (!trends.enabled || !Array.isArray(tweets) || !tweets.length) return { added: 0 };
    const topic = listTopic(trends, how.listId);
    const source = topic ? 'x' : 'home';
    if (source === 'home' && !how.fromApi && !trends.sources.home) return { added: 0 };
    return tweetLock(async () => {
      const { trendTweets } = await store.get('trendTweets');
      const map = trendTweets || {};
      const now = Date.now();
      let added = 0;
      for (const tw of tweets) {
        if (!tw || !tw.id || tw.isReply) continue;
        const tp = topic || T.classify(tw.text);
        if (!tp) continue; // 和 AI / Web3 无关的推文不保存
        if (!map[tw.id]) added++;
        const prev = map[tw.id];
        // 同一条推文在列表和首页都看到时，按列表算。
        map[tw.id] = { ...tw, topic: (prev && prev.source === 'x' && prev.topic) || tp, source: (prev && prev.source === 'x') ? 'x' : source, seenAt: now };
      }
      // 只留最近 3 天、最多 1500 条。
      const kept = Object.values(map)
        .filter((x) => now - (x.createdAt || x.seenAt || 0) < TWEET_KEEP_MS)
        .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
        .slice(0, TWEET_CAP);
      await store.set({ trendTweets: Object.fromEntries(kept.map((x) => [x.id, x])) });
      return { added };
    });
  }

  // ---------- 外部来源 ----------

  async function fetchWithTimeout(url, init, ms) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), ms || FETCH_TIMEOUT_MS);
    try {
      return await fetch(url, { ...(init || {}), signal: ctl.signal, credentials: 'omit' });
    } catch (e) {
      throw new Error(e.name === 'AbortError' ? '连接超时' : `连接失败（${e.message}）`);
    } finally {
      clearTimeout(timer);
    }
  }

  async function granted(url) {
    try {
      return await chrome.permissions.contains({ origins: [`${new URL(url).origin}/*`] });
    } catch {
      return false;
    }
  }

  async function getJson(url, headers) {
    if (!(await granted(url))) throw new Error('还没有授权访问这个网站，到设置里点一次「保存」即可授权');
    const res = await fetchWithTimeout(url, { headers: { accept: 'application/json', ...(headers || {}) } });
    if (res.status === 429 || res.status === 403) throw new Error(`对方限制了访问频率（${res.status}），稍后再刷新`);
    if (!res.ok) throw new Error(`返回 ${res.status}`);
    return res.json();
  }

  async function getText(url) {
    if (!(await granted(url))) throw new Error('还没有授权访问这个网站，到设置里点一次「保存」即可授权');
    const res = await fetchWithTimeout(url, { headers: { accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*' } });
    if (!res.ok) throw new Error(`返回 ${res.status}`);
    return res.text();
  }

  function sinceDate(days) {
    const d = new Date(Date.now() - days * 86400000);
    return d.toISOString().slice(0, 10);
  }

  // 每个外部来源一个任务，返回 { key, items } 或 { key, error }。一个来源出错不影响其他来源。
  function externalJobs(trends, now) {
    const jobs = [];
    const s = trends.sources;
    if (s.hn) jobs.push(['hn', async () => T.parseHN(await getJson(T.ENDPOINTS.hn))]);
    if (s.hf) jobs.push(['hf', async () => T.parseHF(await getJson(T.ENDPOINTS.hf))]);
    if (s.gh) jobs.push(['gh', async () => T.parseGitHub(await getJson(T.ENDPOINTS.gh(sinceDate(7)), { accept: 'application/vnd.github+json' }))]);
    if (s.cg) jobs.push(['cg', async () => T.parseCoinGecko(await getJson(T.ENDPOINTS.cg), now)]);
    if (s.rss) {
      for (const tp of T.TOPICS) {
        for (const url of trends.rss[tp]) {
          let host = url;
          try { host = new URL(url).hostname.replace(/^www\./, ''); } catch { /* 原样显示 */ }
          jobs.push([`rss:${host}`, async () => T.parseRSS(await getText(url), url, tp)]);
        }
      }
    }
    return jobs.map(([key, fn]) => fn().then((items) => ({ key, items }), (e) => ({ key, error: e.message || String(e) })));
  }

  // ---------- X 列表 ----------

  // 借用已经打开的 x.com 页面读取你登记的列表。没有打开的页面就跳过，不为此新开标签页。
  async function readLists(trends) {
    const ids = T.TOPICS.flatMap((tp) => trends.lists[tp].map((id) => ({ id, tp })));
    if (!ids.length) return { read: 0 };
    const tabId = await getContextTab(false).catch(() => null);
    if (!tabId) return { error: '没有打开的 x.com 页面。打开 x.com（登录状态）后再刷新，就能读取你登记的列表' };
    const info = await sendToTab(tabId, { type: 'xa:pageInfo' }, 8000).catch(() => null);
    if (info && info.loggedOut) return { error: 'x.com 没有登录' };
    let op = await getGqlOp('ListLatestTweetsTimeline', info && info.scripts);
    if (!op) return { error: '没找到读取列表的接口。在 x.com 上打开任意一个列表页面后再刷新试试' };
    let read = 0;
    const errors = [];
    let refreshed = false;
    for (let i = 0; i < ids.length; i++) {
      const { id } = ids[i];
      if (i) await sleep(rand(1200, 2500));
      const xmeta = await getXmeta();
      let r = await apiCall(self.XAPI.listTweetsRequest(op, id, xmeta.features), { noCreate: true });
      if (self.XAPI.apiUnavailable(r) && !refreshed) {
        // 接口参数可能过期了，从 X 的前端代码里重新找一次。
        refreshed = true;
        const fresh = await getGqlOp('ListLatestTweetsTimeline', info && info.scripts, true);
        if (fresh) {
          op = fresh;
          r = await apiCall(self.XAPI.listTweetsRequest(op, id, xmeta.features), { noCreate: true });
        }
      }
      if (!r || r.error) { errors.push(`列表 ${id}：页面没有响应`); continue; }
      if (r.status === 429) { errors.push('X 限制了读取频率，过一会儿再刷新'); break; }
      if (r.status !== 200) {
        const e = r.json && r.json.errors && r.json.errors[0];
        errors.push(`列表 ${id}：${r.status}${e && e.message ? ` ${e.message}` : ''}`);
        continue;
      }
      const tweets = self.XAPI.parseTweets(r.json);
      await addTweets(tweets, { listId: id, fromApi: true });
      read += tweets.length;
    }
    return { read, error: errors.join('；') || undefined };
  }

  // ---------- 刷新 ----------

  async function getState() {
    const { trends } = await store.get('trends');
    return trends || { at: 0, topics: { ai: [], web3: [] }, errors: {}, counts: {}, status: 'idle' };
  }

  function refresh() {
    if (refreshing) return refreshing;
    refreshing = doRefresh().finally(() => { refreshing = null; });
    return refreshing;
  }

  async function doRefresh() {
    const { trends } = await trendSettings();
    const prev = await getState();
    if (!trends.enabled) return prev;
    await store.set({ trends: { ...prev, status: 'running', startedAt: Date.now() } });
    const now = Date.now();
    const errors = {};
    const counts = {};
    const [ext, x] = await Promise.all([Promise.all(externalJobs(trends, now)), readLists(trends).catch((e) => ({ error: e.message }))]);
    const items = [];
    for (const r of ext) {
      if (r.error) errors[r.key] = r.error;
      else {
        items.push(...r.items);
        counts[r.key] = r.items.length;
      }
    }
    if (x.error) errors.x = x.error;
    const { trendTweets } = await store.get('trendTweets');
    for (const tw of Object.values(trendTweets || {})) {
      const it = T.tweetItem(tw, tw.topic, tw.source);
      if (it) {
        items.push(it);
        counts[it.source] = (counts[it.source] || 0) + 1;
      }
    }
    const topics = T.buildTopics(items, Date.now(), 30);
    const state = { at: Date.now(), topics, errors, counts, status: 'done', drafts: prev.drafts || {} };
    await store.set({ trends: state });
    return state;
  }

  // ---------- 推文草稿 ----------

  async function llmKey() {
    const { llmKey: k } = await store.get('llmKey');
    return typeof k === 'string' ? k.trim() : '';
  }

  async function callLLM(cfg, system, user, maxTokens) {
    const key = await llmKey();
    const { url, init } = L.buildRequest(cfg, key, system, user, maxTokens);
    if (!(await granted(url))) throw new Error('还没有授权访问模型服务商的网站，到设置里点一次「保存」即可授权。');
    const res = await fetchWithTimeout(url, init, 90000);
    let json = null;
    try { json = await res.json(); } catch { json = null; }
    return L.parseResponse(cfg, res.status, json);
  }

  function findTopic(state, topicId) {
    for (const tp of T.TOPICS) {
      const hit = (state.topics[tp] || []).find((x) => x.id === topicId);
      if (hit) return hit;
    }
    return null;
  }

  async function draft(msg) {
    const { llm } = await trendSettings();
    const state = await getState();
    const topic = findTopic(state, msg.topicId);
    if (!topic) throw new Error('这个话题已经不在列表里了，请刷新后再试。');
    const quote = msg.mode === 'quote' ? topic.items.find((x) => x.id === msg.itemId) : null;
    if (msg.mode === 'quote' && !quote) throw new Error('找不到要引用的推文。');
    const context = topic.items
      .filter((x) => !quote || x.id !== quote.id)
      .map((x) => ({ ...x, sourceLabel: x.feed || T.SOURCE_LABELS[x.source] || x.source }));
    const prompt = L.draftPrompt({ llm, topic: topic.topic, title: topic.title, mode: quote ? 'quote' : 'post', quote, context });
    const r = await callLLM(llm, prompt.system, prompt.user, 4000);
    const out = L.parseDrafts(r.text);
    const result = {
      ...out,
      drafts: out.drafts.map((d) => ({ ...d, length: T.weightedLength(d.text) })),
      quoteUrl: quote ? quote.url : null,
      at: Date.now(),
    };
    // 记下最近的草稿，关掉侧边栏再打开还在。
    const key = `${topic.id}|${quote ? quote.id : 'post'}`;
    const latest = await getState();
    const drafts = { ...(latest.drafts || {}), [key]: result };
    const keys = Object.keys(drafts).sort((a, b) => drafts[b].at - drafts[a].at).slice(0, 40);
    await store.set({ trends: { ...latest, drafts: Object.fromEntries(keys.map((k) => [k, drafts[k]])) } });
    return { key, ...result };
  }

  async function llmTest() {
    const { llm } = await trendSettings();
    const r = await callLLM(llm, '你是一个连通性测试。', '只回复两个字母：OK', 200);
    return { ok: true, reply: r.text.slice(0, 40), model: L.modelOf(llm) };
  }

  // ---------- 消息 ----------

  async function handle(msg) {
    switch (msg.type) {
      case 'xa:tweets':
        return addTweets(msg.tweets, { listId: msg.listId });
      case 'xa:trends': {
        const [{ trends, llm }, state, key] = await Promise.all([trendSettings(), getState(), llmKey()]);
        // 侧边栏打开时：数据过期了就在后台刷新，先把旧数据给它显示。
        const stale = Date.now() - (state.at || 0) > trends.autoRefreshMin * 60000;
        const running = !!refreshing;
        if (msg.auto && trends.enabled && stale && !running) refresh().catch((e) => console.error('[X 取关助手] 刷新热点出错', e));
        return { state: { ...state, status: refreshing ? 'running' : (state.status === 'running' ? 'done' : state.status) }, trends, llm: { ...llm, model: L.modelOf(llm), hasKey: !!key } };
      }
      case 'xa:trendsRefresh':
        return { state: await refresh() };
      case 'xa:draft':
        return draft(msg);
      case 'xa:llmTest':
        return llmTest();
      default:
        return { error: `unknown message ${msg.type}` };
    }
  }

  self.XATrendsBG = { handle, refresh, addTweets };
})();
