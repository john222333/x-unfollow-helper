// 存储结构与默认值。service worker 和管理页共用。
(function (root) {
  'use strict';

  // 节奏的硬性边界：用户可以调，但不能低于/高于这些值。
  const LIMITS = {
    minDelaySec: [5, 120],
    maxDelaySec: [8, 300],
    batchSize: [5, 30],
    restMinMin: [10, 240],
    restMaxMin: [15, 480],
    dailyCap: [10, 200],
  };

  const DEFAULT_SETTINGS = {
    pace: {
      minDelaySec: 8,
      maxDelaySec: 20,
      batchSize: 15,
      restMinMin: 15,
      restMaxMin: 30,
      dailyCap: 100,
    },
    newAccountMode: false, // 新号或刚解除限制：每天最多 30 个
    confirmEachBatch: true,
    dryRun: false, // 演练模式：打开主页、找到按钮，但不点击
    llm: {
      provider: 'anthropic',
      baseUrl: 'https://api.anthropic.com',
      model: 'claude-opus-5-5',
      effort: 'low',
      apiKey: '',
    },
    ui: { composeButton: true, tweetButtons: true },
  };

  function clamp(v, [lo, hi]) {
    const n = Number(v);
    if (!Number.isFinite(n)) return lo;
    return Math.max(lo, Math.min(hi, n));
  }

  function normalizePace(p) {
    const out = { ...DEFAULT_SETTINGS.pace, ...(p || {}) };
    for (const k of Object.keys(LIMITS)) out[k] = Math.round(clamp(out[k], LIMITS[k]));
    if (out.maxDelaySec < out.minDelaySec) out.maxDelaySec = out.minDelaySec;
    if (out.restMaxMin < out.restMinMin) out.restMaxMin = out.restMinMin;
    return out;
  }

  function mergeSettings(s) {
    const src = s || {};
    return {
      ...DEFAULT_SETTINGS,
      ...src,
      pace: normalizePace(src.pace),
      llm: { ...DEFAULT_SETTINGS.llm, ...(src.llm || {}) },
      ui: { ...DEFAULT_SETTINGS.ui, ...(src.ui || {}) },
    };
  }

  function effectiveDailyCap(settings) {
    return settings.newAccountMode ? Math.min(30, settings.pace.dailyCap) : settings.pace.dailyCap;
  }

  function dayKey(t) {
    const d = new Date(t || Date.now());
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  function userKey(handle) {
    return String(handle || '').replace(/^@/, '').toLowerCase();
  }

  // 根据已知字段给关注对象打标签。字段缺失时不打。
  function tagsFor(u, opts) {
    const tags = [];
    if (u.followsYou === false) tags.push('notFollowBack');
    if (u.defaultAvatar) tags.push('defaultAvatar');
    if (u.tweets === 0) tags.push('noTweets');
    if (u.protected) tags.push('protected');
    if (u.verified) tags.push('verified');
    const f = u.followers;
    const g = u.following;
    if (Number.isFinite(f) && Number.isFinite(g)) {
      if ((u.defaultAvatar && f < 10) || (g > 2000 && f < g / 20)) tags.push('suspectBot');
      if (opts && Number.isFinite(opts.fewFollowers) && f < opts.fewFollowers) tags.push('fewFollowers');
    }
    return tags;
  }

  const TAG_LABELS = {
    notFollowBack: '不回关',
    defaultAvatar: '默认头像',
    noTweets: '零推文',
    protected: '受保护',
    verified: '已认证',
    suspectBot: '疑似机器人',
    fewFollowers: '粉丝少',
  };

  root.XAStore = {
    LIMITS, DEFAULT_SETTINGS, normalizePace, mergeSettings, effectiveDailyCap, dayKey, userKey, tagsFor, TAG_LABELS,
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
