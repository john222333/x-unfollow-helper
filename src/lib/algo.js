// 算法友好度推算。
// 权重取自 xai-org/x-algorithm（Apache-2.0）home-mixer/params/param.rs，2026-10-13 读取。
// 线上排序的最终分 = Σ 权重 × 模型预测的行为概率。插件拿不到 X 的模型，
// 所以由 LLM 估计这条推文引发各行为的概率，再乘以同一套权重，得到「相对普通推文」的推算分。
(function (root) {
  'use strict';

  const WEIGHTS_SOURCE = 'https://github.com/xai-org/x-algorithm/blob/main/home-mixer/params/param.rs';
  const WEIGHTS_AS_OF = '2026-10-13';

  // key: [中文名, 权重, 普通推文的参考概率]
  // 参考概率是本项目设定的经验基线，只用来把分数换算成「相对普通推文」的倍数，不是 X 公布的数据。
  const ACTIONS = {
    share_via_copy_link: ['复制链接分享', 20.0, 0.0005],
    reply: ['回复', 5.0, 0.003],
    quote: ['引用转发', 5.0, 0.0005],
    share_via_dm: ['私信分享', 5.0, 0.0005],
    follow_author: ['关注作者', 4.0, 0.0005],
    share: ['分享', 2.0, 0.001],
    retweet: ['转发', 1.0, 0.002],
    favorite: ['喜欢', 0.6, 0.02],
    click: ['点开帖子', 0.3, 0.05],
    open_link: ['打开外链', 0.2, 0.01],
    dwell: ['停留阅读', 0.05, 0.3],
    not_dwelled: ['划走不看', -0.02, 0.6],
    not_interested: ['不感兴趣', -47.52, 0.002],
    block_author: ['拉黑作者', -31.2, 0.0002],
    mute_author: ['屏蔽作者', -58.8, 0.0003],
    report: ['举报', -234.0, 0.00005],
  };

  function rawScore(probs) {
    let total = 0;
    const parts = [];
    for (const [key, [label, w, base]] of Object.entries(ACTIONS)) {
      let p = Number(probs && probs[key]);
      if (!Number.isFinite(p)) p = base;
      p = Math.max(0, Math.min(1, p));
      const c = w * p;
      total += c;
      parts.push({ key, label, weight: w, p, base, contribution: c });
    }
    return { total, parts };
  }

  const BASE = rawScore(Object.fromEntries(Object.entries(ACTIONS).map(([k, v]) => [k, v[2]])));
  const BASELINE = BASE.total;
  // 负向行为权重很大，基线总分可能是负数，所以不用比值，而用「普通推文正向得分」作为单位衡量差值。
  const UNIT = BASE.parts.filter((p) => p.contribution > 0).reduce((a, p) => a + p.contribution, 0);

  // 持平普通推文 50 分；正向得分多出一个普通推文的量 +25 分；举报、不感兴趣等负向行为会迅速拉低分数。
  function score(probs) {
    const { total, parts } = rawScore(probs);
    const delta = (total - BASELINE) / UNIT;
    const s = Math.round(Math.max(0, Math.min(100, 50 + 25 * delta)));
    parts.sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution));
    return { score: s, delta, total, baseline: BASELINE, parts };
  }

  // 不依赖 LLM 的本地检查：基于公开的排序机制给出可执行的提示。
  function localChecks(text) {
    const t = String(text || '');
    const tips = [];
    const hasLink = /https?:\/\/\S+|\b[a-z0-9-]+\.(?:com|cn|io|ai|net|org|co|me|xyz|app)\/?\S*/i.test(t);
    if (hasLink) {
      tips.push({ level: 'warn', text: '带外链：打开外链的权重只有 0.2，远低于回复（5）和复制链接分享（20）。可以把链接放到第一条回复里。' });
    }
    const len = root.XARules ? root.XARules.weightedLength(t) : t.length;
    if (len > 280) {
      tips.push({ level: 'info', text: `计数长度 ${len}，超过 280（非会员上限）。长文停留时间高，但正文要在前两行抓住人。` });
    } else if (len < 40) {
      tips.push({ level: 'info', text: '内容很短：停留和点开的概率偏低，可以补一个具体细节。' });
    }
    if (/[?？]\s*$/.test(t.trim()) || /你(?:们)?(?:怎么看|觉得呢|会怎么|遇到过)|what do you think|have you ever|would you/i.test(t)) {
      tips.push({ level: 'good', text: '结尾有可回答的问题：回复权重 5，和互关好友的回复还有额外 15 的加成。' });
    } else {
      tips.push({ level: 'info', text: '可以留一个具体、容易回答的问题，争取回复（权重 5）。' });
    }
    const tags = (t.match(/(^|\s)#[^\s#]+/g) || []).length;
    if (tags >= 3) tips.push({ level: 'warn', text: '标签过多容易被当作营销内容，触发「不感兴趣」（−47.52）。' });
    if (/^@\w+/.test(t.trim())) tips.push({ level: 'warn', text: '以 @ 开头的帖子多数人当作回复，曝光有限。' });
    if (/(关注|转发|点赞)[^。！？\n]{0,6}(抽奖|送)|follow\s*(?:&|and)\s*(?:rt|retweet)|like\s*(?:&|and)\s*rt/i.test(t)) {
      tips.push({ level: 'warn', text: '求关注、求转发类话术容易招来「不感兴趣」和举报，负权重远大于正权重。' });
    }
    return { tips, hasLink, length: len };
  }

  root.XAAlgo = { ACTIONS, BASELINE, score, localChecks, WEIGHTS_SOURCE, WEIGHTS_AS_OF };
})(typeof globalThis !== 'undefined' ? globalThis : self);
