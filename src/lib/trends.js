// 热点：各个来源的数据解析、热度打分、把讲同一件事的内容归成一个话题。
// 这里只放不依赖浏览器的纯逻辑，service worker、侧边栏和单元测试共用。
(function (root) {
  'use strict';

  const TOPICS = ['ai', 'web3'];
  const TOPIC_LABELS = { ai: 'AI', web3: 'Web3' };

  const SOURCE_LABELS = {
    x: 'X 列表',
    home: 'X 首页',
    hn: 'Hacker News',
    hf: 'Hugging Face',
    gh: 'GitHub',
    cg: 'CoinGecko',
    rss: 'RSS',
  };
  // 不同来源的信号强弱不一样：X 上的互动最直接，RSS 只有发布时间。
  const SOURCE_WEIGHT = { x: 1, home: 0.9, hn: 0.9, hf: 0.8, gh: 0.7, cg: 0.75, rss: 0.6 };

  // 外部来源的地址。都是公开接口，不需要账号或 key。
  const ENDPOINTS = {
    hn: 'https://hn.algolia.com/api/v1/search?tags=front_page&hitsPerPage=50',
    hf: 'https://huggingface.co/api/daily_papers?limit=30',
    gh: (since) => `https://api.github.com/search/repositories?q=${encodeURIComponent(`topic:llm created:>${since}`)}&sort=stars&order=desc&per_page=20`,
    cg: 'https://api.coingecko.com/api/v3/search/trending',
  };

  const DEFAULT_RSS = {
    ai: [],
    web3: ['https://cointelegraph.com/rss', 'https://decrypt.co/feed'],
  };

  const DEFAULT_TRENDS = {
    enabled: true,
    lists: { ai: [], web3: [] }, // X 列表的 ID
    sources: { home: true, hn: true, hf: true, gh: true, cg: true, rss: true },
    rss: DEFAULT_RSS,
    autoRefreshMin: 30, // 打开侧边栏时，数据超过这么久就自动刷新
  };

  // ---------- 判断属于哪个领域 ----------

  const KEYWORDS = {
    ai: [
      'ai', 'agi', 'llm', 'llms', 'gpt', 'chatgpt', 'openai', 'anthropic', 'claude', 'gemini', 'deepmind', 'mistral', 'llama',
      'deepseek', 'qwen', 'kimi', 'grok', 'xai', 'copilot', 'cursor', 'midjourney', 'sora', 'diffusion', 'transformer',
      'ai agent', 'ai agents', 'agentic', 'rag', 'inference', 'fine-tuning', 'finetune', 'benchmark', 'nvidia', 'gpu', 'gpus',
      'machine learning', 'deep learning', 'neural', 'multimodal', 'reasoning model', 'open-source model', 'hugging face', 'huggingface',
      '人工智能', '大模型', '模型', '智能体', '机器学习', '深度学习', '算力', '推理', '多模态', '开源模型', '生成式',
    ],
    web3: [
      'web3', 'crypto', 'cryptocurrency', 'bitcoin', 'btc', 'ethereum', 'eth', 'solana', 'sol', 'defi', 'nft', 'nfts', 'dao',
      'blockchain', 'onchain', 'on-chain', 'airdrop', 'stablecoin', 'stablecoins', 'usdt', 'usdc', 'etf', 'binance', 'coinbase',
      'layer2', 'rollup', 'memecoin', 'meme coin', 'tge', 'staking', 'restaking', 'dex', 'cex', 'wallet',
      'base chain', 'polymarket', 'hyperliquid', 'altcoin', 'altcoins', 'halving',
      '加密', '比特币', '以太坊', '区块链', '币圈', '空投', '稳定币', '链上', '交易所', '代币', '公链', '钱包', '铭文', '撸毛', '牛市', '熊市',
    ],
  };

  const KW_RE = {};
  for (const t of TOPICS) {
    const en = KEYWORDS[t].filter((k) => /^[\x20-\x7e]+$/.test(k)).map((k) => k.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&'));
    const zh = KEYWORDS[t].filter((k) => !/^[\x20-\x7e]+$/.test(k));
    KW_RE[t] = { en: new RegExp(`(?:^|[^a-z0-9])(?:${en.join('|')})(?![a-z0-9])`, 'gi'), zh };
  }

  // 一段文字属于 AI 还是 Web3。都不沾边返回 null。$BTC 这种代币符号算 Web3。
  function classify(text) {
    const s = String(text || '').toLowerCase();
    const score = {};
    for (const t of TOPICS) {
      const m = s.match(KW_RE[t].en);
      score[t] = (m ? m.length : 0) + KW_RE[t].zh.filter((k) => s.includes(k)).length;
    }
    if (/\$[a-z]{2,8}\b/.test(s)) score.web3 += 1;
    if (!score.ai && !score.web3) return null;
    return score.ai >= score.web3 ? 'ai' : 'web3';
  }

  // 「https://x.com/i/lists/123」或直接写 ID。
  function parseListRef(s) {
    const str = String(s || '').trim();
    const m = /lists\/(\d{3,})/.exec(str) || /^(\d{3,})$/.exec(str);
    return m ? m[1] : null;
  }

  // ---------- 各来源解析 ----------

  function stripHtml(s) {
    // RSS 的摘要常常是转义过的 HTML：先还原转义，再去掉标签。
    const raw = String(s || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
    return decodeEntities(decodeEntities(raw).replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
  }

  function decodeEntities(s) {
    const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
    return String(s || '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, e) => {
      if (e[0] === '#') {
        const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : all;
      }
      return named[e.toLowerCase()] || all;
    });
  }

  const clip = (s, n) => {
    const str = String(s || '');
    return str.length > n ? `${str.slice(0, n - 1)}…` : str;
  };

  function parseHN(json) {
    const hits = (json && Array.isArray(json.hits)) ? json.hits : [];
    const out = [];
    for (const h of hits) {
      const title = h.title || h.story_title;
      if (!title || !h.objectID) continue;
      const topic = classify(title);
      if (!topic) continue;
      out.push({
        id: `hn:${h.objectID}`, source: 'hn', topic, title,
        url: h.url || `https://news.ycombinator.com/item?id=${h.objectID}`,
        discuss: `https://news.ycombinator.com/item?id=${h.objectID}`,
        t: (Number(h.created_at_i) || 0) * 1000,
        points: Number(h.points) || 0, comments: Number(h.num_comments) || 0,
      });
    }
    return out;
  }

  function parseHF(json) {
    const list = Array.isArray(json) ? json : [];
    const out = [];
    for (const d of list) {
      const p = d.paper || d;
      if (!p || !p.id || !(p.title || d.title)) continue;
      const t = Date.parse(d.publishedAt || p.publishedAt || '');
      out.push({
        id: `hf:${p.id}`, source: 'hf', topic: 'ai', title: p.title || d.title,
        url: `https://huggingface.co/papers/${p.id}`,
        summary: clip(p.summary || d.summary || '', 400),
        t: Number.isFinite(t) ? t : 0,
        upvotes: Number(p.upvotes) || 0, comments: Number(d.numComments) || 0,
      });
    }
    return out;
  }

  function parseGitHub(json) {
    const items = (json && Array.isArray(json.items)) ? json.items : [];
    return items.filter((r) => r && r.full_name).map((r) => {
      const t = Date.parse(r.created_at || '');
      return {
        id: `gh:${r.id || r.full_name}`, source: 'gh', topic: 'ai',
        title: r.description ? `${r.full_name}：${clip(r.description, 120)}` : r.full_name,
        url: r.html_url || `https://github.com/${r.full_name}`,
        t: Number.isFinite(t) ? t : 0,
        stars: Number(r.stargazers_count) || 0,
      };
    });
  }

  function parseCoinGecko(json, now) {
    const coins = (json && Array.isArray(json.coins)) ? json.coins : [];
    return coins.map((c, i) => c && c.item).filter((c) => c && c.id).map((c, i) => {
      const chg = c.data && c.data.price_change_percentage_24h && Number(c.data.price_change_percentage_24h.usd);
      const sym = String(c.symbol || '').toUpperCase();
      const move = Number.isFinite(chg) ? `，24 小时 ${chg >= 0 ? '+' : ''}${chg.toFixed(1)}%` : '';
      return {
        id: `cg:${c.id}`, source: 'cg', topic: 'web3',
        title: `${c.name}（$${sym}）上了 CoinGecko 热搜${move}`,
        url: `https://www.coingecko.com/en/coins/${c.id}`,
        t: now || Date.now(),
        rank: Number.isFinite(Number(c.score)) ? Number(c.score) : i,
        symbol: sym, mcapRank: c.market_cap_rank || null,
      };
    });
  }

  // 不依赖 DOMParser 的 RSS / Atom 解析（service worker 里没有 DOMParser）。
  function parseRSS(xml, feedUrl, topicHint) {
    const text = String(xml || '');
    const blocks = text.match(/<item\b[\s\S]*?<\/item>/gi) || text.match(/<entry\b[\s\S]*?<\/entry>/gi) || [];
    const tag = (b, names) => {
      for (const n of names) {
        const m = new RegExp(`<${n}\\b[^>]*>([\\s\\S]*?)</${n}>`, 'i').exec(b);
        if (m) return m[1];
      }
      return '';
    };
    let host = '';
    try { host = new URL(feedUrl).hostname.replace(/^www\./, ''); } catch { host = ''; }
    const out = [];
    for (const b of blocks.slice(0, 40)) {
      const title = stripHtml(tag(b, ['title']));
      let link = stripHtml(tag(b, ['link']));
      if (!link) {
        const m = /<link\b[^>]*href="([^"]+)"/i.exec(b);
        link = m ? decodeEntities(m[1]) : '';
      }
      if (!title || !/^https?:\/\//.test(link)) continue;
      const t = Date.parse(stripHtml(tag(b, ['pubDate', 'published', 'updated', 'dc:date'])));
      const summary = clip(stripHtml(tag(b, ['description', 'summary', 'content:encoded', 'content'])), 300);
      const topic = topicHint || classify(`${title} ${summary}`);
      if (!topic) continue;
      out.push({ id: `rss:${link}`, source: 'rss', topic, title, url: link, summary, t: Number.isFinite(t) ? t : 0, feed: host });
    }
    return out;
  }

  // X 上的一条推文变成热点条目。topic 为空时按内容判断（首页上的推文）。
  function tweetItem(tw, topic, source) {
    const tp = topic || classify(tw.text);
    if (!tp || !tw.text) return null;
    return {
      id: `x:${tw.id}`, source: source || 'x', topic: tp,
      title: clip(tw.text.replace(/\s+/g, ' '), 120),
      text: tw.text,
      url: `https://x.com/${tw.handle}/status/${tw.id}`,
      links: tw.urls || [],
      t: tw.createdAt || 0,
      author: tw.handle, authorName: tw.name, followers: tw.followers || 0,
      likes: tw.likes || 0, retweets: tw.retweets || 0, replies: tw.replies || 0, quotes: tw.quotes || 0, views: tw.views || 0,
      isReply: !!tw.isReply,
    };
  }

  // ---------- 热度 ----------

  const hours = (item, now) => Math.max(0, ((now || Date.now()) - (item.t || now || Date.now())) / 3600000);

  // 每个来源自己的「增速」：单位时间里获得的关注度。只在同一来源内部比较。
  function velocity(item, now) {
    const h = hours(item, now);
    switch (item.source) {
      case 'x':
      case 'home': {
        const eng = item.likes + 2 * item.retweets + 2 * item.quotes + item.replies + (item.views || 0) / 200;
        return eng / (h + 1) ** 0.8;
      }
      case 'hn': return (item.points + item.comments * 0.5) / (h + 2) ** 1.2;
      case 'hf': return (item.upvotes + item.comments) / (h + 2) ** 0.6;
      case 'gh': return item.stars / (h / 24 + 1);
      case 'cg': return 20 - Math.min(19, item.rank || 0);
      default: return 1 / (h + 1);
    }
  }

  // 多久以内的内容算「热点」。GitHub 新项目涨星慢，放宽到一周。
  const MAX_AGE_H = { gh: 24 * 7, cg: 48 };
  const maxAge = (src) => MAX_AGE_H[src] || 48;

  // 给每条内容打 0–1 的分：同一来源内按增速排名，再乘来源权重和新鲜度。
  function scoreItems(items, now) {
    const t0 = now || Date.now();
    const fresh = items.filter((it) => it && !(it.isReply) && (!it.t || hours(it, t0) <= maxAge(it.source)));
    const bySource = {};
    for (const it of fresh) (bySource[it.source] || (bySource[it.source] = [])).push(it);
    for (const list of Object.values(bySource)) {
      const v = list.map((it) => ({ it, v: velocity(it, t0) })).sort((a, b) => a.v - b.v);
      v.forEach(({ it }, i) => {
        const pct = v.length > 1 ? i / (v.length - 1) : 0.6;
        const age = it.source === 'gh' ? 0 : hours(it, t0);
        const recency = 0.5 ** (age / 36);
        it.score = (SOURCE_WEIGHT[it.source] || 0.5) * (0.3 + 0.7 * pct) * (0.4 + 0.6 * recency);
      });
    }
    return fresh;
  }

  // ---------- 归并成话题 ----------

  const STOP = new Set(('the and for with that this from have has are was were will your you our their they its into about after over new more than just what when how why who all can not but out now via its his her get got '
    + 'one two use using used make made like also been being here there today week year says said amp http https www com').split(' '));
  const CJK_STOP = new Set(['我们', '你们', '他们', '这个', '那个', '一个', '没有', '什么', '就是', '可以', '因为', '所以', '如果', '已经', '现在', '今天', '自己', '时候', '还是', '不是', '这样']);
  // 太泛的领域词不能用来判断「是不是同一件事」。
  const GENERIC = new Set(['ai', 'llm', 'llms', 'crypto', 'web3', 'model', 'models', 'agent', 'agents', 'token', 'tokens', 'blockchain', '模型', '加密', '区块', '块链']);

  function tokens(item) {
    const out = new Set();
    const text = `${item.title || ''} ${item.summary || ''} ${item.text || ''}`.toLowerCase();
    for (const w of text.match(/[a-z][a-z0-9.+-]{2,}/g) || []) {
      const x = w.replace(/[.+-]+$/, '');
      if (x.length > 2 && !STOP.has(x) && !GENERIC.has(x)) out.add(x);
    }
    for (const t of text.match(/\$[a-z]{2,8}\b/g) || []) out.add(`tk:${t.slice(1)}`);
    for (const run of text.match(/[一-鿿]{2,}/g) || []) {
      for (let i = 0; i < run.length - 1; i++) {
        const bg = run.slice(i, i + 2);
        if (!CJK_STOP.has(bg) && !GENERIC.has(bg)) out.add(bg);
      }
    }
    return out;
  }

  function linkKeys(item) {
    const keys = new Set();
    for (const u of [item.url, ...(item.links || [])]) {
      try {
        const x = new URL(u);
        // 推文自己的链接每条都不一样，不能用来判断「同一件事」。
        if (/(^|\.)(x|twitter)\.com$/.test(x.hostname)) continue;
        keys.add(`${x.hostname.replace(/^www\./, '')}${x.pathname.replace(/\/$/, '')}`);
      } catch { /* 不是网址 */ }
    }
    return keys;
  }

  function similar(a, b) {
    for (const k of a.links) if (b.links.has(k)) return true;
    let shared = 0;
    for (const t of a.tokens) if (b.tokens.has(t)) shared++;
    const small = Math.min(a.tokens.size, b.tokens.size) || 1;
    return shared >= 3 && shared / small >= 0.34;
  }

  // 按分数从高到低，把讲同一件事的内容并到一起（同一个链接，或关键词大量重合）。
  function cluster(items) {
    const sorted = items.slice().sort((a, b) => (b.score || 0) - (a.score || 0));
    const groups = [];
    for (const it of sorted) {
      const sig = { tokens: tokens(it), links: linkKeys(it) };
      const g = groups.find((x) => x.topic === it.topic && similar(x.sig, sig));
      if (g) {
        g.items.push(it);
        for (const t of sig.tokens) g.sig.tokens.add(t);
        for (const l of sig.links) g.sig.links.add(l);
      } else {
        groups.push({ topic: it.topic, items: [it], sig });
      }
    }
    return groups.map((g) => {
      const top = g.items[0];
      const sources = [...new Set(g.items.map((x) => x.source))];
      // 有新闻标题时用标题当话题名，比推文原文更像「一件事」。
      const headline = g.items.find((x) => x.source !== 'x' && x.source !== 'home') || top;
      const heat = Math.min(1, (top.score || 0) + 0.06 * (g.items.length - 1) + 0.1 * (sources.length - 1));
      return {
        id: `tp:${top.id}`,
        topic: g.topic,
        title: headline.title,
        url: headline.url,
        heat: Math.round(heat * 100),
        sources,
        t: Math.max(...g.items.map((x) => x.t || 0)),
        items: g.items.slice(0, 8),
        count: g.items.length,
      };
    }).sort((a, b) => b.heat - a.heat || b.t - a.t);
  }

  function buildTopics(items, now, limit) {
    const scored = scoreItems(items, now);
    const out = {};
    for (const t of TOPICS) out[t] = cluster(scored.filter((x) => x.topic === t)).slice(0, limit || 30);
    return out;
  }

  // ---------- 发推相关 ----------

  // X 计算长度的方式：中日韩文字、表情算 2，网址固定算 23，上限 280。
  function weightedLength(text) {
    const s = String(text || '');
    let n = 0;
    const rest = s.replace(/https?:\/\/\S+/g, () => { n += 23; return ''; });
    for (const ch of rest) {
      const c = ch.codePointAt(0);
      const light = (c <= 4351) || (c >= 8192 && c <= 8205) || (c >= 8208 && c <= 8223) || (c >= 8242 && c <= 8247);
      n += light ? 1 : 2;
    }
    return n;
  }

  // 在 X 的发推框里打开草稿（只是填好内容，发不发由你决定）。quoteUrl 会作为引用的推文附上。
  function composeUrl(text, quoteUrl) {
    const q = new URLSearchParams({ text: String(text || '') });
    if (quoteUrl) q.set('url', quoteUrl);
    return `https://x.com/intent/post?${q.toString()}`;
  }

  function normalizeTrends(t) {
    const src = t || {};
    const listsIn = src.lists || {};
    const rssIn = src.rss || {};
    const ids = (arr) => [...new Set((Array.isArray(arr) ? arr : []).map(parseListRef).filter(Boolean))].slice(0, 5);
    const urls = (arr) => [...new Set((Array.isArray(arr) ? arr : []).map((u) => String(u || '').trim()).filter((u) => /^https:\/\/[^\s]+$/.test(u)))].slice(0, 10);
    const min = Number(src.autoRefreshMin);
    return {
      enabled: src.enabled !== false,
      lists: { ai: ids(listsIn.ai), web3: ids(listsIn.web3) },
      sources: { ...DEFAULT_TRENDS.sources, ...(src.sources || {}) },
      rss: { ai: rssIn.ai ? urls(rssIn.ai) : DEFAULT_RSS.ai.slice(), web3: rssIn.web3 ? urls(rssIn.web3) : DEFAULT_RSS.web3.slice() },
      autoRefreshMin: Number.isFinite(min) ? Math.max(10, Math.min(240, Math.round(min))) : DEFAULT_TRENDS.autoRefreshMin,
    };
  }

  // 刷新热点时要访问哪些外部网站（用于申请权限）。
  function originsFor(trends) {
    const t = normalizeTrends(trends);
    const out = new Set();
    if (t.sources.hn) out.add('https://hn.algolia.com/*');
    if (t.sources.hf) out.add('https://huggingface.co/*');
    if (t.sources.gh) out.add('https://api.github.com/*');
    if (t.sources.cg) out.add('https://api.coingecko.com/*');
    if (t.sources.rss) {
      for (const u of [...t.rss.ai, ...t.rss.web3]) {
        try { out.add(`${new URL(u).origin}/*`); } catch { /* 忽略 */ }
      }
    }
    return [...out];
  }

  root.XATrends = {
    TOPICS, TOPIC_LABELS, SOURCE_LABELS, SOURCE_WEIGHT, ENDPOINTS, DEFAULT_TRENDS, DEFAULT_RSS, KEYWORDS,
    classify, parseListRef, stripHtml, decodeEntities, parseHN, parseHF, parseGitHub, parseCoinGecko, parseRSS, tweetItem,
    velocity, scoreItems, tokens, cluster, buildTopics, weightedLength, composeUrl, normalizeTrends, originsFor, clip,
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
