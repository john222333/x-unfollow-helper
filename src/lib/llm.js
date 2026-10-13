// LLM 接入：只在 service worker 里运行，API Key 不会进入网页。
// 支持 Anthropic Messages API 和任意 OpenAI 兼容接口（DeepSeek、通义、Ollama 等）。
// 插件没有构建步骤，无法打包官方 SDK，所以这里直接用 fetch 调 HTTP 接口。
(function (root) {
  'use strict';

  const ACTION_KEYS = Object.keys(root.XAAlgo.ACTIONS);

  const ANALYSIS_SCHEMA = {
    type: 'object',
    properties: {
      ai_score: { type: 'integer', description: '0-100，越高越像 AI 写的' },
      verdict: { type: 'string', description: '一句话结论' },
      issues: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            quote: { type: 'string', description: '原文中出问题的片段，逐字引用' },
            problem: { type: 'string' },
            suggestion: { type: 'string' },
          },
          required: ['quote', 'problem', 'suggestion'],
          additionalProperties: false,
        },
      },
      engagement: {
        type: 'object',
        properties: Object.fromEntries(ACTION_KEYS.map((k) => [k, { type: 'number' }])),
        required: ACTION_KEYS,
        additionalProperties: false,
      },
      algo_tips: { type: 'array', items: { type: 'string' } },
    },
    required: ['ai_score', 'verdict', 'issues', 'engagement', 'algo_tips'],
    additionalProperties: false,
  };

  const REWRITE_SCHEMA = {
    type: 'object',
    properties: {
      rewrites: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            style: { type: 'string' },
            text: { type: 'string' },
            change_note: { type: 'string' },
          },
          required: ['style', 'text', 'change_note'],
          additionalProperties: false,
        },
      },
    },
    required: ['rewrites'],
    additionalProperties: false,
  };

  function baselineList() {
    return Object.entries(root.XAAlgo.ACTIONS)
      .map(([k, [label, w, base]]) => `- ${k}（${label}，权重 ${w}）：普通推文约 ${base}`)
      .join('\n');
  }

  const ANALYSIS_SYSTEM = `你是一位社交媒体编辑，帮用户检查一条准备发到 X（推特）的推文。你要做两件事。

一、判断「AI 味」：这条推文读起来有多像 AI 生成的。参考这些常见特征：
“不是 X 而是 Y”句式；“说实话”“Here's the thing”之类的铺垫；金句式收尾和总结升华；空泛的“本质上”“at its core”；
赋能、闭环、底层逻辑、delve、tapestry、seamless 这类套话；三段式排比；破折号和 emoji 堆叠；清单体；每句话长度都差不多；
语气过分积极、没有个人经历和具体细节。反过来，具体的人名地名数字、口语、有情绪、句子长短不一、有一点不完美，都是人写的特征。
ai_score 给 0 到 100 的整数，越高越像 AI。issues 列出最多 6 处具体问题，quote 必须逐字引用原文片段，suggestion 给出可以直接替换的写法，用和原文相同的语言。
verdict 用中文一句话说结论。

二、估计互动：设想这条推文出现在一群对该话题有兴趣的陌生人的「为你推荐」里，估计每个看到它的人做出下列行为的概率（0 到 1 的小数）。
下面是普通推文的参考值，比普通推文好就给更高，差就给更低，不要全部照抄：
${baselineList()}
algo_tips 用中文给出最多 4 条能提高推荐分的具体修改建议，要结合上面的权重（比如回复和复制链接分享权重高，举报和不感兴趣是很大的负分）。

只输出 JSON。`;

  const REWRITE_SYSTEM = `你是一位社交媒体编辑。把用户的推文改写成读起来像真人写的版本，意思和事实不变，语言与原文相同。
去掉 AI 腔：不用“不是 X 而是 Y”、铺垫句、金句收尾、套话、三段式排比、破折号、装饰性 emoji。
保留作者的观点和具体信息，不要编造经历、数字或引语。
给出 3 个版本，style 分别是“最小改动”“更口语”“更容易引发回复”。第三个版本可以在结尾加一个具体、容易回答的问题。
如果原文计数长度不超过 280（中日韩字符算 2），每个版本也不要超过 280。
change_note 用中文一句话说改了什么。只输出 JSON。`;

  function anthropicExtras(model) {
    // 服务端拒答回退（fallbacks: "default"）只在部分新模型上可用，其他模型不加，避免 400。
    const supportsFallback = /^claude-(opus-5|fable-5-1|sonnet-5-5)/.test(model);
    const supportsEffort = /^claude-(opus-[45]|sonnet-5|haiku-5|fable)/.test(model) && !/^claude-opus-4-[015]/.test(model);
    return { supportsFallback, supportsEffort };
  }

  async function fetchJson(url, init, timeoutMs) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs || 120000);
    let res;
    try {
      res = await fetch(url, { ...init, signal: ctrl.signal });
    } catch (e) {
      if (e.name === 'AbortError') throw new Error('请求超时，请稍后重试或换一个更快的模型。');
      throw new Error(`无法连接 ${new URL(url).host}：${e.message}。如果是自定义地址，请到设置页点「保存」授权访问。`);
    } finally {
      clearTimeout(timer);
    }
    const text = await res.text();
    let body;
    try { body = JSON.parse(text); } catch { body = null; }
    if (!res.ok) {
      const msg = (body && (body.error && (body.error.message || body.error))) || text.slice(0, 300);
      const err = new Error(`接口返回 ${res.status}：${typeof msg === 'string' ? msg : JSON.stringify(msg)}`);
      err.status = res.status;
      err.body = text;
      throw err;
    }
    return body;
  }

  function parseLooseJson(text) {
    const s = String(text || '').replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
    try { return JSON.parse(s); } catch { /* 继续尝试截取 */ }
    const start = s.indexOf('{');
    const end = s.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(s.slice(start, end + 1));
    throw new Error('模型没有返回有效的 JSON。');
  }

  async function callAnthropic(cfg, system, user, schema) {
    const base = (cfg.baseUrl || 'https://api.anthropic.com').replace(/\/+$/, '');
    const { supportsFallback, supportsEffort } = anthropicExtras(cfg.model);
    const headers = {
      'content-type': 'application/json',
      'x-api-key': cfg.apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    };
    if (supportsFallback) headers['anthropic-beta'] = 'server-side-fallback-2026-07-01';
    const body = {
      model: cfg.model,
      max_tokens: 16000,
      system,
      messages: [{ role: 'user', content: user }],
      output_config: { format: { type: 'json_schema', schema } },
    };
    if (supportsEffort && cfg.effort) body.output_config.effort = cfg.effort;
    if (supportsFallback) body.fallbacks = 'default';

    let res;
    try {
      res = await fetchJson(`${base}/v1/messages`, { method: 'POST', headers, body: JSON.stringify(body) });
    } catch (e) {
      // 老模型或代理不支持结构化输出时，退回到提示词约束 JSON。
      if (e.status === 400 && /output_config|format|json_schema|effort|fallbacks/i.test(e.body || '')) {
        delete body.output_config;
        delete body.fallbacks;
        delete headers['anthropic-beta'];
        res = await fetchJson(`${base}/v1/messages`, { method: 'POST', headers, body: JSON.stringify(body) });
      } else {
        throw e;
      }
    }
    if (res.stop_reason === 'refusal') throw new Error('模型拒绝处理这段内容。');
    if (res.stop_reason === 'max_tokens') throw new Error('模型输出被截断，请重试。');
    const block = (res.content || []).find((b) => b.type === 'text');
    if (!block) throw new Error('模型没有返回文本。');
    return parseLooseJson(block.text);
  }

  async function callOpenAICompatible(cfg, system, user, schema) {
    const base = (cfg.baseUrl || '').replace(/\/+$/, '');
    if (!base) throw new Error('请先在设置页填写接口地址。');
    const headers = { 'content-type': 'application/json' };
    if (cfg.apiKey) headers.authorization = `Bearer ${cfg.apiKey}`;
    const body = {
      model: cfg.model,
      messages: [
        { role: 'system', content: `${system}\n\nJSON 结构：${JSON.stringify(schema)}` },
        { role: 'user', content: user },
      ],
      response_format: { type: 'json_object' },
    };
    let res;
    try {
      res = await fetchJson(`${base}/chat/completions`, { method: 'POST', headers, body: JSON.stringify(body) });
    } catch (e) {
      if (e.status === 400 && /response_format|json_object/i.test(e.body || '')) {
        delete body.response_format;
        res = await fetchJson(`${base}/chat/completions`, { method: 'POST', headers, body: JSON.stringify(body) });
      } else {
        throw e;
      }
    }
    const content = res && res.choices && res.choices[0] && res.choices[0].message && res.choices[0].message.content;
    if (!content) throw new Error('模型没有返回内容。');
    return parseLooseJson(content);
  }

  function call(cfg, system, user, schema) {
    if (!cfg || !cfg.model) return Promise.reject(new Error('还没有配置 LLM，请到设置页填写。'));
    if (cfg.provider === 'anthropic') {
      if (!cfg.apiKey) return Promise.reject(new Error('还没有填写 Anthropic API Key。'));
      return callAnthropic(cfg, system, user, schema);
    }
    return callOpenAICompatible(cfg, system, user, schema);
  }

  function clampProbs(eng) {
    const out = {};
    for (const k of ACTION_KEYS) {
      const v = Number(eng && eng[k]);
      out[k] = Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : root.XAAlgo.ACTIONS[k][2];
    }
    return out;
  }

  async function analyze(cfg, text) {
    const raw = await call(cfg, ANALYSIS_SYSTEM, `推文：\n"""\n${text}\n"""`, ANALYSIS_SCHEMA);
    return {
      ai_score: Math.max(0, Math.min(100, Math.round(Number(raw.ai_score) || 0))),
      verdict: String(raw.verdict || ''),
      issues: Array.isArray(raw.issues) ? raw.issues.slice(0, 8) : [],
      engagement: clampProbs(raw.engagement),
      algo_tips: Array.isArray(raw.algo_tips) ? raw.algo_tips.map(String).slice(0, 6) : [],
    };
  }

  async function rewrite(cfg, text, analysis) {
    const notes = analysis && analysis.issues && analysis.issues.length
      ? `\n\n体检发现的问题：\n${analysis.issues.map((i) => `- 「${i.quote}」${i.problem}`).join('\n')}`
      : '';
    const raw = await call(cfg, REWRITE_SYSTEM, `原推文：\n"""\n${text}\n"""${notes}`, REWRITE_SCHEMA);
    return (Array.isArray(raw.rewrites) ? raw.rewrites : [])
      .filter((r) => r && r.text)
      .slice(0, 4)
      .map((r) => ({ style: String(r.style || ''), text: String(r.text), change_note: String(r.change_note || '') }));
  }

  async function ping(cfg) {
    const raw = await call(
      cfg,
      '你是连通性测试。只输出 JSON。',
      '返回 {"ok": true}',
      { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false },
    );
    return !!raw.ok;
  }

  root.XALLM = { analyze, rewrite, ping, parseLooseJson, ANALYSIS_SCHEMA, REWRITE_SCHEMA };
})(typeof globalThis !== 'undefined' ? globalThis : self);
