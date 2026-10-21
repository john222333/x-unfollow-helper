// 管理页、弹窗和内容脚本给后台发消息的小工具：把 Chrome 的回调和错误统一成 Promise。
(function (root) {
  'use strict';

  function send(msg) {
    return new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage(msg, (res) => {
          const err = chrome.runtime.lastError;
          if (err) return reject(new Error(err.message.includes('context invalidated') ? '插件已更新，请刷新页面。' : err.message));
          if (res && res.error) return reject(new Error(res.error));
          resolve(res);
        });
      } catch (e) {
        reject(new Error('插件已更新，请刷新页面。'));
      }
    });
  }

  root.XAMsg = { send };
})(typeof globalThis !== 'undefined' ? globalThis : self);
