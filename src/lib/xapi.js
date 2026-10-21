// X 网页版自己使用的接口：后台取关、重新关注、读取关注列表都走这里，不需要打开页面去点按钮。
// 请求总是在一个已登录的 x.com 页面里发出（同源、带 cookie），和网页版点按钮发出的请求一样。
// 这里只放请求的构造和结果解析，service worker 和内容脚本共用。
(function (root) {
  'use strict';

  // 网页版内置的公开应用令牌（写在 X 自己的前端代码里，不是你的账号凭据）。
  // 页面实际使用的令牌会被 page-hook 记下来优先使用，这里只是兜底。
  const WEB_BEARER = 'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';

  // 网页版取关、关注时附带的参数。
  const FRIENDSHIP_FORM = {
    include_profile_interstitial_type: '1',
    include_blocking: '1',
    include_blocked_by: '1',
    include_followed_by: '1',
    include_want_retweets: '1',
    include_mute_edge: '1',
    include_can_dm: '1',
    include_can_media_tag: '1',
    include_ext_is_blue_verified: '1',
    include_ext_verified_type: '1',
    include_ext_profile_image_shape: '1',
    skip_status: '1',
  };

  // GraphQL 请求必须带齐 features。页面上抓到的值优先，其次用这份常见默认值，都没有的填 false。
  const DEFAULT_FEATURES = {
    rweb_tipjar_consumption_enabled: true,
    responsive_web_graphql_exclude_directive_enabled: true,
    verified_phone_label_enabled: false,
    creator_subscriptions_tweet_preview_api_enabled: true,
    responsive_web_graphql_timeline_navigation_enabled: true,
    responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
    communities_web_enable_tweet_community_results_fetch: true,
    c9s_tweet_anatomy_moderator_badge_enabled: true,
    articles_preview_enabled: true,
    responsive_web_edit_tweet_api_enabled: true,
    graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
    view_counts_everywhere_api_enabled: true,
    longform_notetweets_consumption_enabled: true,
    responsive_web_twitter_article_tweet_consumption_enabled: true,
    tweet_awards_web_tipping_enabled: false,
    creator_subscriptions_quote_tweet_preview_enabled: false,
    freedom_of_speech_not_reach_fetch_enabled: true,
    standardized_nudges_misinfo: true,
    tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
    rweb_video_timestamps_enabled: true,
    longform_notetweets_rich_text_read_enabled: true,
    longform_notetweets_inline_media_enabled: true,
    responsive_web_enhance_cards_enabled: false,
  };

  function friendshipRequest(action, userId) {
    const path = action === 'follow' ? '/i/api/1.1/friendships/create.json' : '/i/api/1.1/friendships/destroy.json';
    return { method: 'POST', path, form: { ...FRIENDSHIP_FORM, user_id: String(userId) } };
  }

  function settingsRequest() {
    return { method: 'GET', path: '/i/api/1.1/account/settings.json', query: { include_mention_filter: 'true', include_nsfw_user_flag: 'true' } };
  }

  function buildFeatures(names, seen) {
    const out = {};
    const known = { ...DEFAULT_FEATURES, ...(seen || {}) };
    const list = names && names.length ? names : Object.keys(known);
    for (const n of list) out[n] = typeof known[n] === 'boolean' ? known[n] : false;
    return out;
  }

  function followingRequest(op, userId, cursor, seenFeatures) {
    const variables = { userId: String(userId), count: 50, includePromotedContent: false };
    if (cursor) variables.cursor = cursor;
    const query = {
      variables: JSON.stringify(variables),
      features: JSON.stringify(buildFeatures(op.featureNames, { ...(seenFeatures || {}), ...(op.features || {}) })),
    };
    if (op.fieldToggles) query.fieldToggles = JSON.stringify(op.fieldToggles);
    return { method: 'GET', path: `/i/api/graphql/${op.qid}/Following`, query };
  }

  // 从 X 的前端代码里找某个 GraphQL 操作的 queryId 和需要的 features 名单。
  function findOperation(jsText, name) {
    const re = new RegExp(`queryId:"([\\w-]+)",operationName:"${name}",operationType:"\\w+",metadata:\\{featureSwitches:\\[([^\\]]*)\\],fieldToggles:\\[([^\\]]*)\\]`);
    const m = re.exec(jsText || '');
    if (!m) {
      const short = new RegExp(`queryId:"([\\w-]+)",operationName:"${name}"`).exec(jsText || '');
      return short ? { qid: short[1], featureNames: null, fieldToggleNames: [] } : null;
    }
    const names = (s) => (s.match(/"([^"]+)"/g) || []).map((x) => x.slice(1, -1));
    return { qid: m[1], featureNames: names(m[2]), fieldToggleNames: names(m[3]) };
  }

  // ---------- 解析用户 ----------

  function fromGraphQLUser(o) {
    const L = o.legacy || {};
    const C = o.core || {};
    const R = o.relationship_perspectives || {};
    const handle = C.screen_name || L.screen_name;
    if (!handle) return null;
    const avatar = (o.avatar && o.avatar.image_url) || L.profile_image_url_https;
    const pick = (...vals) => vals.find((v) => v !== undefined && v !== null);
    return {
      id: String(o.rest_id),
      handle,
      name: pick(C.name, L.name),
      bio: pick(o.profile_bio && o.profile_bio.description, L.description),
      avatar,
      defaultAvatar: pick(L.default_profile_image, avatar ? /default_profile/.test(avatar) : undefined),
      followers: pick(L.followers_count),
      following: pick(L.friends_count),
      tweets: pick(L.statuses_count),
      followsYou: pick(R.followed_by, L.followed_by),
      youFollow: pick(R.following, L.following),
      verified: !!(o.is_blue_verified || (o.verification && o.verification.verified) || L.verified) || undefined,
      protected: pick(o.privacy && o.privacy.protected, L.protected),
      createdAt: pick(C.created_at, L.created_at),
      source: 'graphql',
    };
  }

  // 递归找出响应里所有 User 对象，对接口结构的小改动不敏感。
  function parseGraphQLUsers(data) {
    const out = [];
    const seen = new Set();
    (function walk(o, depth) {
      if (!o || typeof o !== 'object' || depth > 60) return;
      if (Array.isArray(o)) {
        for (const x of o) walk(x, depth + 1);
        return;
      }
      // 带 timeline 的 User 是「你自己」这个外层容器，关注的人在它里面，要继续往下找。
      if (o.__typename === 'User' && o.rest_id && !o.timeline) {
        const u = fromGraphQLUser(o);
        if (u && !seen.has(u.handle.toLowerCase())) {
          seen.add(u.handle.toLowerCase());
          out.push(u);
        }
        return;
      }
      for (const k of Object.keys(o)) walk(o[k], depth + 1);
    })(data, 0);
    return out;
  }

  // 下一页的游标：entryId 以 cursor-bottom 开头的条目。
  function bottomCursor(data) {
    let found = null;
    (function walk(o, depth) {
      if (found || !o || typeof o !== 'object' || depth > 40) return;
      if (Array.isArray(o)) { for (const x of o) walk(x, depth + 1); return; }
      if (typeof o.entryId === 'string' && o.entryId.startsWith('cursor-bottom')) {
        const c = o.content || {};
        found = c.value || (c.itemContent && c.itemContent.value) || null;
        return;
      }
      if (o.cursorType === 'Bottom' && o.value) { found = o.value; return; }
      for (const k of Object.keys(o)) walk(o[k], depth + 1);
    })(data, 0);
    return found;
  }

  // 响应里有没有时间线结构（instructions）。X 出错时有时只返回 data:{user:{}}，不能当成「列表读完了」。
  function hasTimeline(data) {
    let found = false;
    (function walk(o, depth) {
      if (found || !o || typeof o !== 'object' || depth > 20) return;
      if (Array.isArray(o)) { for (const x of o) walk(x, depth + 1); return; }
      if (Array.isArray(o.instructions)) { found = true; return; }
      for (const k of Object.keys(o)) walk(o[k], depth + 1);
    })(data, 0);
    return found;
  }

  // ---------- 结果判断 ----------

  function errorsOf(r) {
    return r && r.json && Array.isArray(r.json.errors) ? r.json.errors : [];
  }

  // 接口本身不可用（地址变了、需要新的校验头等），不是账号层面的问题：换成备用方式。
  // 页面被关掉、请求超时这类偶发问题不算（r.error），下次换个页面再试就行。
  function apiUnavailable(r) {
    if (!r || r.error) return false;
    return !errorsOf(r).length && [400, 403, 404, 410].includes(r.status);
  }

  // 把取关、关注接口的返回值归类成调度器认识的结果。
  function classifyFriendship(action, r) {
    if (!r) return { result: 'no_response' };
    if (r.error === 'no_csrf') return { result: 'auth', detail: '没有读取到 x.com 的登录信息，请确认已登录' };
    if (r.error) return { result: 'no_response', detail: r.error };
    const errs = errorsOf(r);
    const code = errs.length ? Number(errs[0].code) : null;
    const msg = errs.length ? String(errs[0].message || '') : '';
    if (r.status >= 200 && r.status < 300 && !errs.length) {
      const u = r.json || {};
      if (action === 'follow' && (u.follow_request_sent || (u.protected && u.following === false))) return { result: 'pending' };
      return { result: 'ok' };
    }
    const detail = `${r.status}${code ? ` / ${code}` : ''}${msg ? ` ${msg}` : ''}`;
    if (r.status === 429 || [88, 161, 205, 344].includes(code)) return { result: 'rate_limited', detail };
    if (code === 326) return { result: 'locked', detail };
    if (code === 226) return { result: 'captcha', detail: `X 怀疑是自动操作：${detail}` };
    if ([32, 89, 215, 239, 353].includes(code) || r.status === 401) return { result: 'auth', detail };
    if ([34, 50, 63, 108].includes(code)) return { result: 'gone', detail };
    if (code === 160) return { result: 'pending', detail };
    if (code === 162) return { result: 'blocked', detail };
    if (apiUnavailable(r)) return { result: 'api_unavailable', detail };
    return { result: 'error', detail };
  }

  root.XAPI = {
    WEB_BEARER, DEFAULT_FEATURES, friendshipRequest, settingsRequest, followingRequest, buildFeatures, findOperation, hasTimeline,
    fromGraphQLUser, parseGraphQLUsers, bottomCursor, classifyFriendship, apiUnavailable,
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
