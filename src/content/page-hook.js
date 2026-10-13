// 运行在 x.com 页面自身的环境（MAIN world）。
// 只「旁听」页面自己发出的关注列表请求，把返回的数据转交给插件；不发任何额外请求，也不修改请求。
(function () {
  'use strict';
  if (window.__xaHookInstalled) return;
  window.__xaHookInstalled = true;

  const WATCH = /\/graphql\/[^/]+\/(Following|Followers|UserByScreenName)\b/;

  function forward(url, text) {
    const m = WATCH.exec(url);
    if (!m) return;
    try {
      const data = JSON.parse(text);
      window.postMessage({ source: 'xa-hook', op: m[1], data }, window.location.origin);
    } catch (e) {
      // 不是 JSON，忽略
    }
  }

  const origFetch = window.fetch;
  window.fetch = function (input, init) {
    const p = origFetch.apply(this, arguments);
    try {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
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
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function () {
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
