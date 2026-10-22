// 模拟热点功能用到的外部网站（新闻源、模型接口），端到端测试和商店截图共用。不访问真实网站。
'use strict';

async function install(context) {
  const llmCalls = [];
  const H = 3600;
  const nowS = Math.floor(Date.now() / 1000);
  const cors = { 'access-control-allow-origin': '*' };
  await context.route('https://hn.algolia.com/**', (r) => r.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: JSON.stringify({ hits: [
    { objectID: '1', title: 'OpenAI releases GPT-6', url: 'https://openai.com/index/gpt-6', points: 800, num_comments: 400, created_at_i: nowS - 3 * H },
    { objectID: '2', title: 'Show HN: a tiny Rust web server', url: 'https://example.com/rust', points: 300, num_comments: 50, created_at_i: nowS - 2 * H },
  ] }) }));
  await context.route('https://huggingface.co/api/models**', (r) => r.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: JSON.stringify([
    { id: 'Qwen/Qwen4-7B-Instruct', trendingScore: 320, likes: 900, downloads: 50000, pipeline_tag: 'text-generation' },
    { id: 'black-forest-labs/FLUX.3', trendingScore: 200, likes: 500, pipeline_tag: 'text-to-image' },
  ]) }));
  await context.route('https://www.reddit.com/**', (r) => {
    const sub = (/\/r\/(\w+)\//.exec(r.request().url()) || [])[1];
    const posts = {
      LocalLLaMA: [{ id: 'l1', title: 'Qwen4 7B runs great on a laptop, open weights are out', permalink: '/r/LocalLLaMA/comments/l1/q/', url: 'https://qwenlm.github.io/blog/qwen4', score: 1500, num_comments: 400, created_utc: nowS - 4 * H }],
      MachineLearning: [{ id: 'm1', title: '[D] GPT-6 reasoning mode: what changed?', permalink: '/r/MachineLearning/comments/m1/g/', url: 'https://openai.com/index/gpt-6', score: 600, num_comments: 250, created_utc: nowS - 2 * H }],
      CryptoCurrency: [{ id: 'c1', title: 'Bitcoin ETF inflows hit a record today', permalink: '/r/CryptoCurrency/comments/c1/b/', url: 'https://www.coindesk.com/markets/btc-etf-inflow', score: 2000, num_comments: 800, created_utc: nowS - 1 * H },
        { id: 'c0', title: 'Daily discussion', stickied: true, permalink: '/r/CryptoCurrency/comments/c0/d/', score: 5, num_comments: 1, created_utc: nowS }],
    }[sub] || [];
    return r.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: JSON.stringify({ data: { children: posts.map((d) => ({ kind: 't3', data: d })) } }) });
  });
  await context.route('https://huggingface.co/api/daily_papers**', (r) => r.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: JSON.stringify([
    { paper: { id: '2610.00001', title: 'Scaling test-time compute for small models', summary: 'We show...', upvotes: 120 }, publishedAt: new Date(Date.now() - 10 * H * 1000).toISOString(), numComments: 4 },
  ]) }));
  await context.route('https://api.github.com/**', (r) => r.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: JSON.stringify({ items: [
    { id: 1, full_name: 'acme/agent-kit', description: 'Build LLM agents fast', html_url: 'https://github.com/acme/agent-kit', stargazers_count: 4200, created_at: new Date(Date.now() - 3 * 86400000).toISOString() },
  ] }) }));
  await context.route('https://api.coingecko.com/**', (r) => r.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: JSON.stringify({ coins: [
    { item: { id: 'bitcoin', name: 'Bitcoin', symbol: 'btc', score: 0, market_cap_rank: 1, data: { price_change_percentage_24h: { usd: 4.2 } } } },
    { item: { id: 'dogwifhat', name: 'dogwifhat', symbol: 'wif', score: 1, market_cap_rank: 80, data: { price_change_percentage_24h: { usd: -3.1 } } } },
  ] }) }));
  const rss = (items) => `<?xml version="1.0"?><rss><channel>${items.map((i) => `<item><title><![CDATA[${i.t}]]></title><link>${i.l}</link><pubDate>${new Date(Date.now() - i.h * H * 1000).toUTCString()}</pubDate><description>${i.d}</description></item>`).join('')}</channel></rss>`;
  await context.route('https://cointelegraph.com/**', (r) => r.fulfill({ status: 200, contentType: 'application/rss+xml', headers: cors, body: rss([
    { t: 'Bitcoin ETF inflows hit record as BTC rallies', l: 'https://www.coindesk.com/markets/btc-etf-inflow', h: 2, d: 'Spot bitcoin ETFs saw &amp; record inflows.' },
  ]) }));
  await context.route('https://decrypt.co/**', (r) => r.fulfill({ status: 500, body: '' }));
  await context.route('https://api.anthropic.com/**', async (r) => {
    const req = r.request();
    llmCalls.push({ headers: await req.allHeaders(), body: JSON.parse(req.postData() || '{}') });
    const drafts = [
      { style: '观点', text: 'GPT-6 的推理模式值得关注：价格没涨，编码能力明显提升。' },
      { style: '科普', text: '一句话讲清 GPT-6 新推理模式：先想再答，复杂任务更稳。' },
      { style: '轻松', text: '又到了把周末计划换成跑 benchmark 的时候 😂' },
    ];
    const body = llmCalls[llmCalls.length - 1].body;
    const text = /连通性测试/.test(body.system || '') ? 'OK' : '```json\n' + JSON.stringify({ summary: 'OpenAI 发布 GPT-6', drafts }) + '\n```';
    await r.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: JSON.stringify({ id: 'msg_1', type: 'message', role: 'assistant', stop_reason: 'end_turn',
      content: [{ type: 'thinking', thinking: '', signature: 'x' }, { type: 'text', text }], usage: { input_tokens: 10, output_tokens: 10 } }) });
  });
  return llmCalls;
}

module.exports = { install };
