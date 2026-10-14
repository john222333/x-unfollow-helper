// 本地规则层：离线计算推文的「AI 味」。
// 规则参考维基百科 "Signs of AI writing" 与 humanizer（MIT）整理的写作特征，中文部分为本项目自行补充。
// 同时用于 service worker、内容脚本和管理页，所以挂在 globalThis 上，不依赖模块系统。
(function (root) {
  'use strict';

  const CJK = /[㐀-鿿豈-﫿]/;

  // 每条规则：命中一次加 weight 分，同一规则最多加 cap 分。
  const RULES = [
    {
      id: 'not-x-but-y',
      label: '“不是 X，而是 Y” 句式',
      weight: 18, cap: 30,
      patterns: [
        /不(?:仅仅|仅|只|单单|单)?是[^。！？\n]{1,30}?[，,、]\s*(?:而|更|还)是/g,
        /与其说[^。！？\n]{1,30}?不如说/g,
        /\b(?:it'?s|this is|that'?s|this isn'?t|it isn'?t) not (?:just |only |merely |about )?[^.?!\n]{1,60}?[,;:—–-]+\s*(?:it'?s|but|this is)\b/gi,
        /\bnot (?:just|only|merely) [^.?!\n]{1,50}?,?\s*but (?:also )?\b/gi,
      ],
      advice: '直接说你的观点，删掉被否定的那一半。',
    },
    {
      id: 'staged-runup',
      label: '刻意铺垫（“说实话”“Here’s the thing”）',
      weight: 12, cap: 24,
      patterns: [
        /说实话|讲真|划重点|敲黑板|你没看错|很多人不知道|答案是[:：]?|这意味着什么[？?]|我想说的是|不得不说/g,
        /\b(?:here'?s the thing|here'?s why|honestly\?|let'?s be real|let'?s be honest|the truth is|let me explain|spoiler:|plot twist|hot take:|unpopular opinion:)/gi,
      ],
      advice: '去掉铺垫，第一句就给出信息。',
    },
    {
      id: 'closer',
      label: '金句式收尾',
      weight: 15, cap: 15,
      patterns: [
        /细思极恐|值得每个人深思|与君共勉|共勉[。！!]?$|你品[，,]?你细品|这才是真正的|一切才刚刚开始|未来已来/g,
        /\b(?:let that sink in|read that again|full stop\.|period\.$|that'?s it\. that'?s the (?:tweet|post)|think about that\.|the future is now|and that changes everything)/gi,
      ],
      advice: '结尾停在具体的事实或问题上，不要总结升华。',
    },
    {
      id: 'deep-saying',
      label: '空泛的“深刻”表达',
      weight: 10, cap: 20,
      patterns: [
        /归根结底|说到底|本质上|底层逻辑|一言以蔽之|真正重要的是|核心在于/g,
        /\b(?:at its core|at the end of the day|what really matters|the real question is|in essence|fundamentally,)/gi,
      ],
      advice: '换成具体的例子、数字或经历。',
    },
    {
      id: 'ai-vocab-zh',
      label: '中文 AI 高频套话',
      weight: 6, cap: 30,
      patterns: [
        /值得注意的是|总而言之|综上所述|总的来说|不可或缺|至关重要|赋能|助力|深度融合|全方位|多维度|抓手|闭环|颗粒度|打通|链路|无缝|深入探讨|让我们一起|开启[^。！？\n]{0,8}新篇章|扬帆起航|在当今[^。！？\n]{0,12}(?:时代|社会|世界)|随着[^。！？\n]{0,16}的(?:不断|快速|飞速)发展|日新月异|蓬勃发展|不断演进|引领未来|重塑/g,
      ],
      advice: '用你平时说话的词替换这些套话。',
    },
    {
      id: 'ai-vocab-en',
      label: '英文 AI 高频词',
      weight: 6, cap: 30,
      patterns: [
        /\b(?:delve|delves|delving|tapestry|testament|realm|landscape|navigate|navigating|leverage|leveraging|unlock|unlocking|elevate|seamless|seamlessly|robust|game[- ]changer|embark|crucial|pivotal|foster|harness|empower|revolutioni[sz]e|ever[- ]evolving|fast[- ]paced|it'?s worth noting|furthermore|moreover|in conclusion|underscore|underscores|showcase|showcasing|intricate|vibrant|bustling|meticulous|meticulously|paramount|multifaceted|synergy|holistic|transformative|cutting[- ]edge|groundbreaking)\b/gi,
      ],
      advice: '换成更普通、更具体的词。',
    },
    {
      id: 'sycophant',
      label: '营销腔开场',
      weight: 12, cap: 12,
      patterns: [
        /激动地宣布|非常高兴地宣布|重磅消息|震撼发布|隆重推出/g,
        /\b(?:i'?m (?:thrilled|excited|delighted) to|we'?re (?:thrilled|excited|delighted) to|great question|absolutely!|game[- ]changing news)/gi,
      ],
      advice: '直接说发生了什么。',
    },
    {
      id: 'no-one-argued',
      label: '和不存在的人争论',
      weight: 10, cap: 10,
      patterns: [
        /我不是说|有人会说|你可能会觉得|你也许会问|别误会/g,
        /\b(?:i'?m not saying|some will say|you might think|you may be wondering|don'?t get me wrong|let'?s be clear)/gi,
      ],
      advice: '删掉假想的反驳，直接陈述。',
    },
  ];

  function countEmoji(text) {
    const m = text.match(/\p{Extended_Pictographic}/gu);
    return m ? m.length : 0;
  }

  function sentences(text) {
    return text
      .split(/(?<=[.!?。！？])\s*|\n+/)
      .map((s) => s.trim())
      .filter((s) => s.replace(/[\s\p{P}\p{S}]/gu, '').length >= 4);
  }

  function unitLength(s) {
    // 中文按字计，英文按词计，方便比较句长是否过于均匀
    const cjk = (s.match(/[㐀-鿿]/g) || []).length;
    const words = (s.replace(/[㐀-鿿]/g, ' ').match(/[A-Za-z0-9']+/g) || []).length;
    return cjk + words;
  }

  function structuralRules(text) {
    const hits = [];
    const len = text.length;

    const emDash = (text.match(/——|—|–/g) || []).length;
    if (emDash >= 2 || (emDash >= 1 && len < 120)) {
      hits.push({
        id: 'em-dash',
        label: '破折号偏多',
        points: Math.min(12, 6 * emDash),
        matches: [`${emDash} 处破折号`],
        advice: '把破折号换成逗号、句号，或者拆成两句。',
      });
    }

    const emoji = countEmoji(text);
    if (emoji >= 3) {
      hits.push({
        id: 'emoji-stack',
        label: 'emoji 堆叠',
        points: Math.min(12, 3 * emoji),
        matches: [`${emoji} 个 emoji`],
        advice: 'emoji 留一个或不用，尤其别用 🚀✨👇 当装饰。',
      });
    }

    const tags = (text.match(/(^|\s)#[^\s#]+/g) || []).length;
    if (tags >= 3) {
      hits.push({
        id: 'hashtags',
        label: '话题标签过多',
        points: 6,
        matches: [`${tags} 个 #标签`],
        advice: '最多保留一个标签。',
      });
    }

    // 三段式排比："A、B 和 C" / "A, B, and C"
    const triads = (text.match(/[^，,、。\s]{1,8}、[^，,、。\s]{1,8}(?:和|与|以及|、)[^，,、。\s]{1,8}/g) || [])
      .concat(text.match(/\b\w+, \w+,? and \w+\b/gi) || []);
    if (triads.length >= 2) {
      hits.push({
        id: 'rule-of-three',
        label: '三段式排比',
        points: Math.min(12, 6 * triads.length),
        matches: triads.slice(0, 3),
        advice: '只留最重要的一项，或者换成具体例子。',
      });
    }

    const bullets = (text.match(/^\s*(?:[-•▪︎✅✔️👉➡️]|\d+[.)、])\s*/gmu) || []).length;
    if (bullets >= 3) {
      hits.push({
        id: 'listicle',
        label: '清单体',
        points: 8,
        matches: [`${bullets} 行列表`],
        advice: '推文里少用列表，挑一两点写透。',
      });
    }

    const sents = sentences(text);
    if (sents.length >= 4) {
      const lens = sents.map(unitLength);
      const mean = lens.reduce((a, b) => a + b, 0) / lens.length;
      const sd = Math.sqrt(lens.reduce((a, b) => a + (b - mean) ** 2, 0) / lens.length);
      const cv = mean ? sd / mean : 0;
      if (cv < 0.25) {
        hits.push({
          id: 'uniform-rhythm',
          label: '句子长度过于均匀',
          points: 10,
          matches: [`${sents.length} 句，长度波动 ${(cv * 100).toFixed(0)}%`],
          advice: '长短句混用，加一句很短的话。',
        });
      }
    }

    return hits;
  }

  function analyze(text) {
    const src = String(text || '').trim();
    const hits = [];
    for (const rule of RULES) {
      const matches = [];
      for (const re of rule.patterns) {
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(src)) !== null) {
          matches.push(m[0].trim());
          if (m[0].length === 0) re.lastIndex++;
        }
      }
      if (matches.length) {
        hits.push({
          id: rule.id,
          label: rule.label,
          points: Math.min(rule.cap, rule.weight * matches.length),
          matches: Array.from(new Set(matches)).slice(0, 5),
          advice: rule.advice,
        });
      }
    }
    hits.push(...structuralRules(src));
    hits.sort((a, b) => b.points - a.points);
    const raw = hits.reduce((a, h) => a + h.points, 0);
    return {
      score: Math.min(100, Math.round(raw)),
      hits,
      lang: CJK.test(src) ? 'zh' : 'en',
      length: weightedLength(src),
    };
  }

  // X 的计数方式（twitter-text v3）：拉丁字母、常用标点算 1，中日韩等其他文字算 2，
  // 每个 emoji 算 2，链接一律算 23，上限 280（非会员）。
  const LIGHT_RANGES = [[0x0000, 0x10ff], [0x2000, 0x200d], [0x2010, 0x201f], [0x2032, 0x2037]];
  const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>"']+/gi;
  const EMOJI_RE = /\p{Extended_Pictographic}|\p{Regional_Indicator}/u;
  const segmenter = typeof Intl !== 'undefined' && Intl.Segmenter ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;

  function codePointWeight(cp) {
    return LIGHT_RANGES.some(([lo, hi]) => cp >= lo && cp <= hi) ? 1 : 2;
  }

  function weightedLength(text) {
    let n = 0;
    const rest = String(text || '').normalize('NFC').replace(URL_RE, () => { n += 23; return ' '; });
    const graphemes = segmenter ? Array.from(segmenter.segment(rest), (g) => g.segment) : Array.from(rest);
    for (const g of graphemes) {
      if (EMOJI_RE.test(g)) { n += 2; continue; }
      for (const ch of g) n += codePointWeight(ch.codePointAt(0));
    }
    // 替换链接时补的空格不算
    return n - (String(text || '').match(URL_RE) || []).length;
  }

  root.XARules = { analyze, weightedLength, RULES };
})(typeof globalThis !== 'undefined' ? globalThis : self);
