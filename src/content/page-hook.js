// 运行在 x.com 页面自身的环境（MAIN world）。
// 只「旁听」页面自己发出的关注列表请求，把返回的数据转交给插件；不发任何额外请求，也不修改请求。
(function () {
  'use strict';
  if (window.__xaHookInstalled) return;
  window.__xaHookInstalled = true;

  const WATCH = /\/graphql\/[^/]+\/(Following|Followers|UserByScreenName)\b/;

  // 插件的内容脚本比这里晚加载，先到的数据缓存几份，等它来要时再发一遍。
  const buffer = [];

  function post(msg) {
    window.postMessage(msg, window.location.origin);
  }

  function forward(url, text) {
    const m = WATCH.exec(url);
    if (!m) return;
    try {
      const msg = { source: 'xa-hook', op: m[1], data: JSON.parse(text) };
      if (msg.op === 'Following') {
        buffer.push(msg);
        if (buffer.length > 5) buffer.shift();
      }
      post(msg);
    } catch (e) {
      // 不是 JSON，忽略
    }
  }

  // 记下页面自己用的应用令牌和 GraphQL 参数（queryId、features），后台读取关注列表时照着用。
  // 只记接口参数，不碰你的 cookie 和登录凭据。
  const metaSeen = new Set();
  let lastMeta = null;
  function noteRequest(url, getHeader) {
    try {
      if (!/\/i\/api\//.test(url)) return;
      const meta = {};
      const auth = getHeader('authorization');
      if (auth && /^Bearer\s/.test(auth) && !metaSeen.has('bearer')) {
        metaSeen.add('bearer');
        meta.bearer = auth.replace(/^Bearer\s+/, '');
      }
      const m = /\/i\/api\/graphql\/([\w-]+)\/(\w+)/.exec(url);
      if (m && !metaSeen.has(`${m[2]}:${m[1]}`)) {
        metaSeen.add(`${m[2]}:${m[1]}`);
        const u = new URL(url, location.origin);
        const parse = (k) => { try { return JSON.parse(u.searchParams.get(k) || 'null'); } catch { return null; } };
        meta.gql = { name: m[2], qid: m[1], features: parse('features'), fieldToggles: parse('fieldToggles') };
      }
      if (meta.bearer || meta.gql) {
        lastMeta = { ...(lastMeta || {}), ...meta };
        post({ source: 'xa-hook', op: 'meta', meta });
      }
    } catch (e) {
      // 忽略
    }
  }

  window.addEventListener('message', (ev) => {
    if (ev.source !== window || !ev.data || ev.data.source !== 'xa-content' || ev.data.op !== 'replay') return;
    buffer.splice(0).forEach(post);
    if (lastMeta) post({ source: 'xa-hook', op: 'meta', meta: lastMeta });
  });

  const origFetch = window.fetch;
  window.fetch = function (input, init) {
    const p = origFetch.apply(this, arguments);
    try {
      const url = typeof input === 'string' ? input : (input && input.url) || String(input || '');
      noteRequest(url, (name) => {
        const h = (init && init.headers) || (input && input.headers);
        if (!h) return null;
        if (typeof h.get === 'function') return h.get(name);
        const key = Object.keys(h).find((k) => k.toLowerCase() === name);
        return key ? h[key] : null;
      });
      if (WATCH.test(url)) {
        p.then((res) => res.clone().text().then((t) => forward(url, t))).catch(() => {});
      }
    } catch (e) {
      // 旁听失败不能影响页面
    }
    return p;
  };

  const origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__xaUrl = String(url || '');
    return origOpen.apply(this, arguments);
  };
  const origSetHeader = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
    try {
      (this.__xaHeaders || (this.__xaHeaders = {}))[String(name).toLowerCase()] = value;
    } catch (e) {
      // 忽略
    }
    return origSetHeader.apply(this, arguments);
  };
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function () {
    const headers = this.__xaHeaders || {};
    noteRequest(this.__xaUrl || '', (name) => headers[name] || null);
    if (WATCH.test(this.__xaUrl || '')) {
      this.addEventListener('load', () => {
        try {
          if (this.responseType === '' || this.responseType === 'text') forward(this.__xaUrl, this.responseText);
          else if (this.responseType === 'json') forward(this.__xaUrl, JSON.stringify(this.response));
        } catch (e) {
          // 忽略
        }
      });
    }
    return origSend.apply(this, arguments);
  };
})();
