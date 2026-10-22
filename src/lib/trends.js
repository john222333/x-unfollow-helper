// 热点：各个来源的数据解析、热度打分、把讲同一件事的内容归成一个话题。
// 这里只放不依赖浏览器的纯逻辑，service worker、侧边栏和单元测试共用。
(function (root) {
  'use strict';

  const TOPICS = ['ai', 'web3'];
  const TOPIC_LABELS = { ai: 'AI', web3: 'Web3' };

  const SOURCE_LABELS = {
    xtrend: 'X 趋势',
    x: 'X 列表',
    home: 'X 首页',
    hn: 'Hacker News',
    reddit: 'Reddit',
    hf: 'HF 论文',
    hfm: 'HF 热门模型',
    gh: 'GitHub',
    cg: 'CoinGecko',
    rss: 'RSS',
  };
  // 不同来源的信号强弱不一样。X 趋势是全站的统计，最客观；你的列表和首页取决于你关注了谁，
  // 偏个人口味，权重调低，单靠它们撑起来的话题还会再打折（见 cluster）。
  const SOURCE_WEIGHT = { xtrend: 1, x: 0.85, home: 0.6, hn: 0.9, reddit: 0.8, hf: 0.75, hfm: 0.75, gh: 0.7, cg: 0.8, rss: 0.65 };
  const PERSONAL = new Set(['x', 'home']);

  // Reddit 上各领域的主要社区，按热度排序的公开数据。
  const SUBREDDITS = { ai: ['LocalLLaMA', 'MachineLearning'], web3: ['CryptoCurrency'] };

  // 外部来源的地址。都是公开接口，不需要账号或 key。
  const ENDPOINTS = {
    hn: 'https://hn.algolia.com/api/v1/search?tags=front_page&hitsPerPage=50',
    hf: 'https://huggingface.co/api/daily_papers?limit=30',
    gh: (since) => `https://api.github.com/search/repositories?q=${encodeURIComponent(`topic:llm created:>${since}`)}&sort=stars&order=desc&per_page=20`,
    cg: 'https://api.coingecko.com/api/v3/search/trending',
    hfm: 'https://huggingface.co/api/models?sort=trendingScore&direction=-1&limit=30',
    reddit: (sub) => `https://www.reddit.com/r/${sub}/hot.json?limit=30&raw_json=1`,
  };

  const DEFAULT_RSS = {
    ai: [],
    web3: ['https://cointelegraph.com/rss', 'https://decrypt.co/feed'],
  };

  const DEFAULT_TRENDS = {
    enabled: true,
    lists: { ai: [], web3: [] }, // X 列表的 ID
    sources: { xtrend: true, home: true, hn: true, reddit: true, hf: true, hfm: true, gh: true, cg: true, rss: true },
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
    // 后面可以紧跟版本号：GPT6、Llama4、Qwen3 也算。
    KW_RE[t] = { en: new RegExp(`(?:^|[^a-z0-9])(?:${en.join('|')})(?![a-z])`, 'gi'), zh };
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
        keys: [`tk:${sym.toLowerCase()}`, sym.length >= 3 ? sym.toLowerCase() : null, String(c.name || '').toLowerCase().replace(/\s+/g, '')].filter((k) => k && k.length >= 3),
      };
    });
  }

  // Hugging Face 热门模型榜：按 trendingScore（最近的点赞和下载增长）排序。
  function parseHFModels(json, now) {
    const list = Array.isArray(json) ? json : [];
    return list.filter((m) => m && (m.id || m.modelId)).map((m, i) => {
      const id = m.id || m.modelId;
      const base = String(id).split('/').pop();
      return {
        id: `hfm:${id}`, source: 'hfm', topic: 'ai',
        title: `${id} 冲上 Hugging Face 热门模型榜${m.pipeline_tag ? `（${m.pipeline_tag}）` : ''}`,
        url: `https://huggingface.co/${id}`,
        t: now || Date.now(),
        trending: Number(m.trendingScore) || Math.max(1, 30 - i), likes: Number(m.likes) || 0, downloads: Number(m.downloads) || 0,
        keys: [modelKey(base)].filter(Boolean),
      };
    });
  }

  // 模型名里能代表「这个模型」的那个词：Qwen4-7B-Instruct → qwen4，Llama-4-Scout → llama4。
  function modelKey(name) {
    const parts = String(name || '').toLowerCase().split(/[-_ ]+/).filter(Boolean);
    if (!parts.length) return null;
    const key = /\d/.test(parts[0]) || parts.length === 1 ? parts[0] : `${parts[0]}${parts[1]}`;
    const norm = key.replace(/[.]/g, '');
    return norm.length >= 4 ? norm : null;
  }

  function parseReddit(json, sub, topic) {
    const children = (json && json.data && Array.isArray(json.data.children)) ? json.data.children : [];
    const out = [];
    for (const c of children) {
      const d = c && c.data;
      if (!d || !d.id || !d.title || d.stickied || d.over_18) continue;
      const tp = topic || classify(d.title);
      if (!tp) continue;
      const external = d.url && !/reddit\.com|redd\.it/.test(d.url) ? d.url : null;
      out.push({
        id: `reddit:${d.id}`, source: 'reddit', topic: tp, title: d.title,
        url: `https://www.reddit.com${d.permalink || `/r/${sub}/comments/${d.id}`}`,
        links: external ? [external] : [],
        summary: clip(d.selftext || '', 300),
        t: (Number(d.created_utc) || 0) * 1000,
        points: Number(d.score) || 0, comments: Number(d.num_comments) || 0, feed: `r/${sub}`,
      });
    }
    return out;
  }

  // X 自己的趋势榜（首页右侧「有什么新鲜事」和探索页）。这是 X 全站的统计，不受你关注了谁影响。
  // 「1.2万 帖子」「12.3K posts」这样的帖子数换成数字。
  function parsePostCount(s) {
    const m = /([\d.,]+)\s*(万|亿|[KkMm])?/.exec(String(s || ''));
    if (!m) return 0;
    const n = Number(m[1].replace(/,/g, ''));
    if (!Number.isFinite(n)) return 0;
    const mul = { 万: 1e4, 亿: 1e8, K: 1e3, k: 1e3, M: 1e6, m: 1e6 }[m[2]] || 1;
    return Math.round(n * mul);
  }

  function xTrendItem(tr, now) {
    const name = String(tr.name || '').trim();
    if (!name) return null;
    const domain = String(tr.domain || '');
    let topic = /crypto|加密|币/i.test(domain) ? 'web3' : classify(`${name} ${domain}`);
    if (!topic && /^(technology|科技|science)/i.test(domain) && classify(name)) topic = classify(name);
    if (!topic) return null;
    const posts = parsePostCount(tr.meta);
    return {
      id: `xt:${name.toLowerCase()}`, source: 'xtrend', topic,
      title: posts ? `${name}（X 趋势，${tr.meta}）` : `${name}（X 趋势）`,
      url: `https://x.com/search?q=${encodeURIComponent(name)}`,
      t: tr.seenAt || now || Date.now(),
      posts, rank: Number(tr.rank) || 0, name,
    };
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
        // 粉丝多的大号天然互动多：按粉丝数打个折，让「小号写出的爆款」也能排上来。
        const fans = 1 + (item.followers || 0) / 50000;
        return engagement(item) / (h + 1) ** 0.8 / fans ** 0.35;
      }
      case 'xtrend': return item.posts || Math.max(1, 30 - (item.rank || 0));
      case 'hn':
      case 'reddit': return (item.points + item.comments * 0.5) / (h + 2) ** 1.2;
      case 'hfm': return item.trending;
      case 'hf': return (item.upvotes + item.comments) / (h + 2) ** 0.6;
      case 'gh': return item.stars / (h / 24 + 1);
      case 'cg': return 20 - Math.min(19, item.rank || 0);
      default: return 1 / (h + 1);
    }
  }

  const engagement = (it) => (it.likes || 0) + 2 * (it.retweets || 0) + 2 * (it.quotes || 0) + (it.replies || 0) + (it.views || 0) / 200;

  // 多久以内的内容算「热点」。GitHub 新项目涨星慢，放宽到一周；X 趋势是看到时的榜单，只认最近 6 小时。
  const MAX_AGE_H = { gh: 24 * 7, cg: 48, xtrend: 6 };
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
        const age = ['gh', 'hfm', 'cg', 'xtrend'].includes(it.source) ? 0 : hours(it, t0);
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
      // GPT-6、gpt6、#GPT6 当成同一个词。
      const x = w.replace(/[.+-]+$/, '').replace(/[.-]/g, '');
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

  function sigKeys(item) {
    if (item.source === 'xtrend') {
      const t = [...tokens({ title: item.name })];
      // 单个很短的英文词（比如「AI」已被排除，「Sam」这种）太容易误配，至少 4 个字母或者是代币符号。
      return t.length && !(t.length === 1 && t[0].length < 4 && !t[0].startsWith('tk:')) ? [t] : null;
    }
    return item.keys && item.keys.length ? item.keys.slice() : null;
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

  // 短条目（X 趋势词、热门币、热门模型）只有几个字，按「关键词出现在对方内容里」来认。
  function keyHit(a, b) {
    if (!a.keys || !a.keys.length) return false;
    return a.keys.some((k) => (Array.isArray(k) ? k.length && k.every((t) => b.tokens.has(t)) : b.tokens.has(k)));
  }

  function similar(a, b) {
    for (const k of a.links) if (b.links.has(k)) return true;
    if (keyHit(a, b) || keyHit(b, a)) return true;
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
      const sig = { tokens: tokens(it), links: linkKeys(it), keys: sigKeys(it) };
      const g = groups.find((x) => x.topic === it.topic && similar(x.sig, sig));
      if (g) {
        g.items.push(it);
        if (sig.keys) g.sig.keys = (g.sig.keys || []).concat(sig.keys);
        for (const t of sig.tokens) g.sig.tokens.add(t);
        for (const l of sig.links) g.sig.links.add(l);
      } else {
        groups.push({ topic: it.topic, items: [it], sig });
      }
    }
    return groups.map((g) => summarize(g)).sort((a, b) => b.heat - a.heat || b.t - a.t);
  }

  // 话题热度：最热那条的分数，加上「有多少互相独立的来源在讲」。
  // 同一个博主发十条只算一个声音；只有一个声音、或者只出现在你自己的关注圈里的话题会打折。
  function summarize(g) {
    const top = g.items[0];
    const sources = [...new Set(g.items.map((x) => x.source))];
    const authors = new Set(g.items.filter((x) => x.author).map((x) => x.author.toLowerCase()));
    const outlets = new Set(g.items.filter((x) => !x.author && x.source !== 'xtrend').map((x) => x.feed || x.source));
    const voices = authors.size + outlets.size;
    const personalOnly = sources.every((s) => PERSONAL.has(s));
    let heat = (top.score || 0) + Math.min(0.3, 0.07 * (voices - 1)) + Math.min(0.2, 0.08 * (sources.length - 1));
    if (voices <= 1) heat *= 0.75;
    if (personalOnly) heat *= 0.85;
    const tweets = g.items.filter((x) => x.source === 'x' || x.source === 'home');
    const xt = g.items.find((x) => x.source === 'xtrend');
    // 有新闻、社区帖子的标题时用它当话题名，比推文原文、趋势词更像「一件事」。
    const headline = g.items.find((x) => !PERSONAL.has(x.source) && !['xtrend', 'cg', 'hfm'].includes(x.source))
      || g.items.find((x) => !PERSONAL.has(x.source)) || top;
    return {
      id: `tp:${top.id}`,
      topic: g.topic,
      title: headline.title,
      url: headline.url,
      // 换算成 0–100，越往上越难涨，几个大话题不会都挤在 100。
      heat: Math.round(100 * (1 - Math.exp(-1.6 * heat))),
      sources,
      t: Math.max(...g.items.map((x) => x.t || 0)),
      items: g.items.slice(0, 8),
      count: g.items.length,
      // 「为什么上榜」：给侧边栏显示依据用。
      why: {
        authors: authors.size,
        outlets: outlets.size,
        engagement: Math.round(tweets.reduce((n, x) => n + engagement(x), 0)),
        xPosts: xt ? xt.posts : 0,
        personalOnly,
      },
    };
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
    if (t.sources.hf || t.sources.hfm) out.add('https://huggingface.co/*');
    if (t.sources.reddit) out.add('https://www.reddit.com/*');
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
    TOPICS, TOPIC_LABELS, SOURCE_LABELS, SOURCE_WEIGHT, PERSONAL, SUBREDDITS, ENDPOINTS, DEFAULT_TRENDS, DEFAULT_RSS, KEYWORDS,
    classify, parseListRef, stripHtml, decodeEntities, parseHN, parseHF, parseGitHub, parseCoinGecko, parseRSS, tweetItem,
    parseHFModels, modelKey, parseReddit, parsePostCount, xTrendItem, engagement,
    velocity, scoreItems, tokens, cluster, buildTopics, weightedLength, composeUrl, normalizeTrends, originsFor, clip,
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
