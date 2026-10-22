// 推文草稿用的大模型：请求的构造、返回值解析和提示词。真正发请求在 service worker 里。
// key 由你自己填写，只保存在这台电脑的浏览器里，请求直接发给你选的服务商，不经过任何其他服务器。
(function (root) {
  'use strict';

  const PROVIDERS = {
    anthropic: { label: 'Claude（Anthropic）', base: 'https://api.anthropic.com', model: 'claude-haiku-5-5', keyHint: 'sk-ant-…' },
    openai: { label: 'OpenAI', base: 'https://api.openai.com/v1', model: 'gpt-5-mini', keyHint: 'sk-…' },
    deepseek: { label: 'DeepSeek', base: 'https://api.deepseek.com', model: 'deepseek-chat', keyHint: 'sk-…' },
    custom: { label: '其他（兼容 OpenAI 接口）', base: '', model: '', keyHint: '' },
  };

  const DEFAULT_LLM = {
    provider: 'anthropic',
    model: '',
    baseUrl: '',
    lang: 'zh', // zh | en | both
    persona: '', // 你的账号定位和说话风格
  };

  function normalizeLLM(l) {
    const src = l || {};
    const provider = PROVIDERS[src.provider] ? src.provider : DEFAULT_LLM.provider;
    return {
      provider,
      model: String(src.model || '').trim().slice(0, 100),
      baseUrl: String(src.baseUrl || '').trim().replace(/\/+$/, '').slice(0, 300),
      lang: ['zh', 'en', 'both'].includes(src.lang) ? src.lang : 'zh',
      persona: String(src.persona || '').slice(0, 1000),
    };
  }

  function endpoint(cfg) {
    const c = normalizeLLM(cfg);
    const base = c.baseUrl || PROVIDERS[c.provider].base;
    if (!/^https:\/\/[^\s/]+/.test(base)) return null;
    return c.provider === 'anthropic' ? `${base}/v1/messages` : `${base}/chat/completions`;
  }

  function modelOf(cfg) {
    const c = normalizeLLM(cfg);
    return c.model || PROVIDERS[c.provider].model;
  }

  // 申请访问权限用：模型服务商的网站。
  function originOf(cfg) {
    const url = endpoint(cfg);
    try { return url ? `${new URL(url).origin}/*` : null; } catch { return null; }
  }

  // 构造请求。不传 temperature 这类采样参数：新版 Claude 接口已经不接受，其他家也用默认值。
  function buildRequest(cfg, key, system, user, maxTokens) {
    const c = normalizeLLM(cfg);
    const url = endpoint(c);
    if (!url) throw new Error('模型接口地址不对，请在设置里检查。');
    if (!key) throw new Error('还没有填写模型的 API key，请先到设置里填写。');
    const model = modelOf(c);
    if (!model) throw new Error('请在设置里填写模型名称。');
    if (c.provider === 'anthropic') {
      return {
        url,
        init: {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-api-key': key,
            'anthropic-version': '2026-10-21',
            // 插件后台直接调用接口需要这个头，key 只在你自己的浏览器里。
            'anthropic-dangerous-direct-browser-access': 'true',
          },
          body: JSON.stringify({
            model,
            max_tokens: maxTokens || 4000,
            system,
            messages: [{ role: 'user', content: user }],
            // 写草稿不需要深度思考，用低档省钱、出结果快。
            output_config: { effort: 'low' },
          }),
        },
      };
    }
    return {
      url,
      init: {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model,
          messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
        }),
      },
    };
  }

  // 解析返回值，统一成 { text } 或抛出看得懂的错误。
  function parseResponse(cfg, status, json) {
    const c = normalizeLLM(cfg);
    const apiMsg = json && json.error && (json.error.message || json.error.type || (typeof json.error === 'string' ? json.error : ''));
    if (status === 401 || status === 403) throw new Error(`API key 无效或没有权限（${status}${apiMsg ? `：${apiMsg}` : ''}）`);
    if (status === 429) throw new Error(`模型服务商限流或额度不足，请稍后再试${apiMsg ? `（${apiMsg}）` : ''}`);
    if (status === 404) throw new Error(`找不到这个模型或接口地址（${modelOf(c)}）${apiMsg ? `：${apiMsg}` : ''}`);
    if (!(status >= 200 && status < 300) || !json) throw new Error(`模型接口出错（${status}${apiMsg ? `：${apiMsg}` : ''}）`);
    if (c.provider === 'anthropic') {
      if (json.stop_reason === 'refusal') throw new Error('模型拒绝了这个请求，换个话题试试。');
      const text = (json.content || []).filter((b) => b && b.type === 'text').map((b) => b.text).join('');
      if (!text) throw new Error(json.stop_reason === 'max_tokens' ? '模型输出被截断了，请重试。' : '模型没有返回内容。');
      return { text, usage: json.usage || null };
    }
    const choice = json.choices && json.choices[0];
    const text = choice && choice.message && (typeof choice.message.content === 'string' ? choice.message.content : '');
    if (!text) throw new Error('模型没有返回内容。');
    return { text, usage: json.usage || null };
  }

  // 从模型的回答里取出 JSON（有的模型会包一层 ```json 代码块或在前后加说明）。
  function extractJson(text) {
    const s = String(text || '').trim();
    const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(s);
    const body = fenced ? fenced[1] : s;
    const start = body.indexOf('{');
    const end = body.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    try { return JSON.parse(body.slice(start, end + 1)); } catch { return null; }
  }

  const LANG_RULE = {
    zh: '三条草稿都用简体中文写。专有名词、产品名、代币符号保留英文原文。',
    en: 'Write all three drafts in natural, native-sounding English.',
    both: '第一、二条用简体中文，第三条用英文。',
  };

  // 写推文草稿的提示词。mode：post = 就这个话题发一条；quote = 引用某条推文发表看法。
  function draftPrompt(opts) {
    const o = opts || {};
    const c = normalizeLLM(o.llm);
    const topicName = o.topic === 'web3' ? 'Web3 / 加密' : 'AI';
    const system = [
      `你是一位熟悉 ${topicName} 圈子的 X（推特）写手，帮用户把正在发生的热点写成值得发的推文。`,
      '要求：',
      '1. 只基于给你的资料写，不要编造数字、引言、发布时间或内幕；资料里没有的细节宁可不写。',
      '2. 每条都要有自己的观点或信息增量（解读、影响、对比、可操作的提醒），不要只是转述标题，也不要空洞的感叹。',
      '3. 长度：X 按「中文字和表情算 2、英文字母算 1」计数，每条加起来不超过 270。中文大约 120 字以内。',
      '4. 少用话题标签，最多 1 个；不用表情包堆砌；不要「家人们」「赶紧冲」之类的喊单话术；不构成投资建议的内容不要写成像投资建议。',
      '5. 三条风格要明显不同：「观点」给出有立场的判断；「科普」用通俗的话讲清楚这件事是什么、为什么重要；「轻松」口语化，可以带一点幽默。',
      `6. ${LANG_RULE[c.lang]}`,
      c.persona ? `7. 用户的账号定位和说话风格：${c.persona}` : '',
      '只输出一个 JSON 对象，不要其他文字，格式：',
      '{"summary":"用一句中文概括这件事（30 字以内）","drafts":[{"style":"观点","text":"..."},{"style":"科普","text":"..."},{"style":"轻松","text":"..."}]}',
    ].filter(Boolean).join('\n');

    const lines = [];
    if (o.mode === 'quote' && o.quote) {
      lines.push('任务：用户想「引用」下面这条推文发表自己的看法。草稿是引用时配的文字，不用复述原推。', '');
      lines.push(`原推 @${o.quote.author}：${o.quote.text}`);
      lines.push(`互动：${o.quote.likes || 0} 赞，${o.quote.retweets || 0} 转发，${o.quote.replies || 0} 回复`);
      if (o.context && o.context.length) lines.push('', '同一话题的其他资料：');
    } else {
      lines.push(`任务：围绕下面这个正在升温的 ${topicName} 话题，写三条可以直接发的推文。`, '');
      lines.push(`话题：${o.title || ''}`, '', '资料：');
    }
    for (const it of (o.context || []).slice(0, 8)) {
      const who = it.author ? `@${it.author}（${it.likes || 0} 赞）：` : `[${it.sourceLabel || it.source}] `;
      const body = it.text || it.title || '';
      lines.push(`- ${who}${String(body).replace(/\s+/g, ' ').slice(0, 500)}${it.summary ? `\n  摘要：${String(it.summary).slice(0, 300)}` : ''}${it.url && !it.author ? `\n  链接：${it.url}` : ''}`);
    }
    return { system, user: lines.join('\n') };
  }

  // 检查模型返回的草稿，去掉空的，最多保留三条。
  function parseDrafts(text) {
    const j = extractJson(text);
    if (!j || !Array.isArray(j.drafts)) throw new Error('模型返回的格式不对，请重试。');
    const drafts = j.drafts
      .map((d) => ({ style: String((d && d.style) || '').slice(0, 10), text: String((d && d.text) || '').trim() }))
      .filter((d) => d.text)
      .slice(0, 3);
    if (!drafts.length) throw new Error('模型没有写出草稿，请重试。');
    return { summary: String(j.summary || '').slice(0, 80), drafts };
  }

  root.XALLM = { PROVIDERS, DEFAULT_LLM, normalizeLLM, endpoint, modelOf, originOf, buildRequest, parseResponse, extractJson, draftPrompt, parseDrafts };
})(typeof globalThis !== 'undefined' ? globalThis : self);
