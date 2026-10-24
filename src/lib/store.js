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
  const SETTINGS_VERSION = 4;

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
    keepAwake: true, // 取关进行中不让电脑自动休眠（屏幕照常关闭；合上笔记本盖子仍会休眠）
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
    // v3 去掉了推文体检，连同保存的 LLM 接口密钥一起删掉。v4 的热点功能重新用到 llm（key 另外存放）。
    if (v < 3) {
      delete src.llm;
      delete src.ui;
    }
    src.v = SETTINGS_VERSION;
    return src;
  }

  function mergeSettings(s) {
    const src = s ? migrateSettings(s) : {};
    return {
      ...DEFAULT_SETTINGS,
      ...src,
      pace: normalizePace(src.pace),
      execMode: src.execMode === 'ui' ? 'ui' : 'auto',
      keepAwake: src.keepAwake !== false,
      // 热点与推文建议（v4）。管理页、弹窗里没加载这两个文件时原样保留。
      trends: root.XATrends ? root.XATrends.normalizeTrends(src.trends) : src.trends,
      llm: root.XALLM ? root.XALLM.normalizeLLM(src.llm) : src.llm,
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
    if (u.unfollowFailed) tags.push('unfollowFailed');
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
    unfollowFailed: '取关未生效',
    notFollowBack: '不回关',
    defaultAvatar: '默认头像',
    noTweets: '零推文',
    protected: '受保护',
    verified: '已认证',
    suspectBot: '疑似机器人',
    fewFollowers: '粉丝少',
  };

  // ---------- 多久没发推 ----------

  const DAY_MS = 86400000;
  // 筛选档位（天）。
  const INACTIVE_PERIODS = { '1m': 30, '3m': 90, '6m': 180, '1y': 365 };
  const INACTIVE_LABELS = { '1m': '1 个月', '3m': '3 个月', '6m': '半年', '1y': '1 年' };
  // 检查结果多久之内算新鲜，不用重新检查。
  const ACTIVITY_FRESH_DAYS = 14;

  // 这个人有多少天没发推了。没检查过、看不到推文、账号不可用时返回 null（不确定的人不参与「不活跃」筛选）。
  // 从没发过推的人按注册了多久算。
  function inactiveDays(u, now) {
    const t = now || Date.now();
    if (!u) return null;
    if (u.activity === 'ok' && u.lastTweetAt > 0) return Math.max(0, Math.floor((t - u.lastTweetAt) / DAY_MS));
    if (u.tweets === 0 && u.activity !== 'ok') {
      const c = Date.parse(u.createdAt);
      return Number.isFinite(c) ? Math.max(0, Math.floor((t - c) / DAY_MS)) : null;
    }
    return null;
  }

  // 需不需要（重新）检查：从没检查过，或者结果已经超过两周（避免拿过期的结果去取关刚回来发推的人）。
  function needsActivityCheck(u, now) {
    if (!u || !u.id) return false;
    if (u.tweets === 0) return false; // 推文数是 0，不用查
    if (!u.activityAt) return true;
    return (now || Date.now()) - u.activityAt > ACTIVITY_FRESH_DAYS * DAY_MS;
  }

  // 列表里显示的「最近发推」。
  function activityText(u, now) {
    if (!u) return '';
    if (u.tweets === 0 && u.activity !== 'ok') return '从没发过';
    if (u.activity === 'unavailable') return '账号不可用';
    if (u.activity === 'empty') return '看不到推文';
    const d = inactiveDays(u, now);
    if (d === null) return '';
    const approx = u.activityApprox ? '内' : '前';
    if (d < 1) return u.activityApprox ? '最近' : '今天';
    if (d < 30) return `${d} 天${approx}`;
    if (d < 365) return `${Math.floor(d / 30)} 个月${approx}`;
    return `${(d / 365).toFixed(d < 3650 ? 1 : 0).replace(/\.0$/, '')} 年${approx}`;
  }

  // 找出「日志里最后一次操作是取关成功、但这次读取时 X 上仍在关注」的人。
  // log 是取关日志，users 是这次读取到的人，before 是读取开始的时间，since 之前的取关不算。返回 { key: 取关时间 }。
  function unfollowsNotApplied(log, users, before, since) {
    const last = {};
    for (const l of Array.isArray(log) ? log : []) {
      if (!l || l.dryRun || !['ok', 'pending'].includes(l.result) || !(l.t < before)) continue;
      if (!last[l.key] || l.t >= last[l.key].t) last[l.key] = l;
    }
    const out = {};
    for (const [k, l] of Object.entries(last)) {
      if (l.action === 'unfollow' && l.t >= (since || 0) && users && users[k]) out[k] = l.t;
    }
    return out;
  }

  root.XAStore = {
    LIMITS, DEFAULT_SETTINGS, SETTINGS_VERSION, normalizePace, mergeSettings, effectiveDailyCap, estimateFinish, dayKey, userKey, tagsFor, TAG_LABELS,
    unfollowsNotApplied, INACTIVE_PERIODS, INACTIVE_LABELS, ACTIVITY_FRESH_DAYS, inactiveDays, needsActivityCheck, activityText,
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
