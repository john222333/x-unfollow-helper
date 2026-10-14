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

  // 设置结构的版本。改了默认值、需要迁移老用户已保存的设置时加 1。
  const SETTINGS_VERSION = 2;

  const DEFAULT_SETTINGS = {
    v: SETTINGS_VERSION,
    pace: {
      minDelaySec: 8,
      maxDelaySec: 20,
      batchSize: 15,
      restMinMin: 15,
      restMaxMin: 30,
      dailyCap: 100,
    },
    newAccountMode: false, // 新号或刚解除限制：每天最多 30 个
    autoStart: true, // 加入队列后自动开始，不用再去点「开始」
    confirmEachBatch: false, // 每批开始前是否要手动确认
    dryRun: false, // 演练模式：检查登录和执行通道是否正常，但不真的取关
    // 执行方式：auto = 后台调用 X 网页版接口，不可用时自动改为后台标签页点按钮；ui = 只用后台标签页点按钮
    execMode: 'auto',
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

  // 老版本保存的设置升级到当前结构。
  function migrateSettings(s) {
    const src = { ...(s || {}) };
    const v = Number(src.v) || 1;
    // v1 默认每批都要手动确认；v2 起默认自动执行。
    if (v < 2) src.confirmEachBatch = false;
    src.v = SETTINGS_VERSION;
    return src;
  }

  function mergeSettings(s) {
    const src = s ? migrateSettings(s) : {};
    return {
      ...DEFAULT_SETTINGS,
      ...src,
      pace: normalizePace(src.pace),
      llm: { ...DEFAULT_SETTINGS.llm, ...(src.llm || {}) },
      ui: { ...DEFAULT_SETTINGS.ui, ...(src.ui || {}) },
      execMode: src.execMode === 'ui' ? 'ui' : 'auto',
    };
  }

  function effectiveDailyCap(settings) {
    return settings.newAccountMode ? Math.min(30, settings.pace.dailyCap) : settings.pace.dailyCap;
  }

  // 粗略估计队列什么时候能处理完：每个人按平均间隔算，每批之间加平均休息时间，超过当天额度的顺延到之后几天。
  // 返回 { at, days }：at 是预计完成时间，days 是还要跨几天（0 表示今天能完成）。
  function estimateFinish(job, queueLength, settings, now) {
    const t0 = now || Date.now();
    const n = Number(queueLength) || 0;
    if (!n || !settings) return null;
    const p = settings.pace;
    const cap = effectiveDailyCap(settings);
    const perItem = ((p.minDelaySec + p.maxDelaySec) / 2 + 3) * 1000;
    const rest = ((p.restMinMin + p.restMaxMin) / 2) * 60000;
    const span = (k) => k * perItem + Math.max(0, Math.ceil(k / p.batchSize) - 1) * rest;
    const doneToday = job && job.day === dayKey(t0) ? job.doneToday || 0 : 0;
    const leftToday = Math.max(0, cap - doneToday);
    let start = t0;
    if (job && job.status === 'running' && job.nextActionAt > t0) start = job.nextActionAt;
    if (n <= leftToday) {
      const at = start + span(n);
      return { at, days: dayKey(at) === dayKey(t0) ? 0 : 1 };
    }
    const after = n - leftToday;
    const days = Math.ceil(after / cap);
    const lastDay = after - (days - 1) * cap;
    const d = new Date(t0);
    d.setHours(24 * days, 30, 0, 0); // 每天额度恢复后不久开始
    return { at: d.getTime() + span(lastDay), days };
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
    LIMITS, DEFAULT_SETTINGS, SETTINGS_VERSION, normalizePace, mergeSettings, effectiveDailyCap, estimateFinish, dayKey, userKey, tagsFor, TAG_LABELS,
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
