// 推文体检报告面板。内容脚本里以浮层显示，管理页里嵌入显示；都放在 Shadow DOM 里，不受页面样式影响。
(function (root) {
  'use strict';

  const CSS = `
:host { all: initial; }
* { box-sizing: border-box; }
.wrap {
  --bg: #ffffff; --fg: #0f1419; --muted: #536471; --line: #eff3f4; --soft: #f7f9f9;
  --accent: #1d9bf0; --good: #00a35c; --warn: #c77700; --bad: #e0245e;
  font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
  color: var(--fg); background: var(--bg);
}
.wrap.dark { --bg: #15202b; --fg: #e7e9ea; --muted: #8b98a5; --line: #2f3336; --soft: #1e2732; }
.wrap.floating {
  position: fixed; top: 64px; right: 16px; width: 400px; max-width: calc(100vw - 32px);
  max-height: calc(100vh - 88px); overflow: auto; z-index: 2147483000;
  border: 1px solid var(--line); border-radius: 16px; box-shadow: 0 8px 28px rgba(0,0,0,.18);
}
.head { display: flex; align-items: center; gap: 8px; padding: 12px 16px; border-bottom: 1px solid var(--line);
  position: sticky; top: 0; background: var(--bg); z-index: 1; }
.head h2 { font-size: 16px; margin: 0; flex: 1; }
.x { border: 0; background: none; color: var(--muted); font-size: 20px; cursor: pointer; line-height: 1; padding: 4px 8px; border-radius: 999px; }
.x:hover { background: var(--soft); }
.body { padding: 12px 16px 16px; }
.orig { color: var(--muted); font-size: 13px; white-space: pre-wrap; max-height: 96px; overflow: auto;
  background: var(--soft); border-radius: 8px; padding: 8px 10px; margin-bottom: 12px; }
.scores { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-bottom: 12px; }
.tile { border: 1px solid var(--line); border-radius: 12px; padding: 10px 12px; }
.tile .k { font-size: 12px; color: var(--muted); }
.tile .v { font-size: 28px; font-weight: 700; line-height: 1.2; }
.tile .s { font-size: 12px; color: var(--muted); }
.good { color: var(--good); } .warn { color: var(--warn); } .bad { color: var(--bad); }
h3 { font-size: 13px; margin: 16px 0 6px; color: var(--muted); font-weight: 600; }
.verdict { font-weight: 600; margin: 4px 0 8px; }
.item { border-top: 1px solid var(--line); padding: 8px 0; }
.item:first-of-type { border-top: 0; }
.quote { background: rgba(224,36,94,.08); border-radius: 4px; padding: 0 4px; }
.sugg { color: var(--good); }
.chip { display: inline-block; font-size: 12px; background: var(--soft); border-radius: 999px; padding: 1px 8px; margin: 2px 4px 2px 0; }
.label { font-weight: 600; }
.pts { color: var(--muted); font-size: 12px; margin-left: 4px; }
.note { font-size: 12px; color: var(--muted); }
table { width: 100%; border-collapse: collapse; font-size: 12px; }
th, td { text-align: left; padding: 4px 4px; border-bottom: 1px solid var(--line); }
td.n, th.n { text-align: right; font-variant-numeric: tabular-nums; }
.tips { margin: 0; padding-left: 18px; }
.tips li { margin: 3px 0; }
.btn { border: 1px solid var(--line); background: var(--bg); color: var(--fg); border-radius: 999px;
  padding: 5px 12px; font: inherit; font-size: 13px; cursor: pointer; }
.btn:hover { background: var(--soft); }
.btn.primary { background: var(--fg); color: var(--bg); border-color: var(--fg); }
.btn[disabled] { opacity: .5; cursor: default; }
.row { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
.card { border: 1px solid var(--line); border-radius: 12px; padding: 10px 12px; margin: 8px 0; }
.card .t { white-space: pre-wrap; margin: 6px 0; }
.banner { border-radius: 8px; padding: 8px 10px; font-size: 13px; margin-bottom: 10px; background: var(--soft); }
.banner.err { background: rgba(224,36,94,.1); }
.spin { display: inline-block; width: 12px; height: 12px; border: 2px solid var(--line); border-top-color: var(--accent);
  border-radius: 50%; animation: s 0.8s linear infinite; vertical-align: -2px; margin-right: 6px; }
@keyframes s { to { transform: rotate(360deg); } }
a { color: var(--accent); }
`;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

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

  function aiClass(v) { return v <= 30 ? 'good' : v <= 60 ? 'warn' : 'bad'; }
  function aiWord(v) { return v <= 30 ? '像人写的' : v <= 60 ? '有点 AI 味' : 'AI 味很重'; }
  function algoClass(v) { return v >= 65 ? 'good' : v >= 40 ? 'warn' : 'bad'; }
  function algoWord(d) {
    if (d <= -1) return '负反馈风险高，可能被少推荐';
    const n = Math.round(Math.abs(d) * 100);
    if (n < 5) return '和普通推文差不多';
    return d > 0 ? `比普通推文高约 ${n}%` : `比普通推文低约 ${n}%`;
  }
  function pct(p) {
    if (p >= 0.1) return `${(p * 100).toFixed(0)}%`;
    if (p >= 0.001) return `${(p * 100).toFixed(1)}%`;
    return `${(p * 100).toFixed(3)}%`;
  }

  function isDarkPage() {
    const bg = getComputedStyle(document.body).backgroundColor || '';
    const m = bg.match(/\d+/g);
    if (!m || m.length < 3) return false;
    const [r, g, b] = m.map(Number);
    return (0.299 * r + 0.587 * g + 0.114 * b) < 100;
  }

  function renderReport(res) {
    const parts = [];
    const ai = res.aiScore;
    const algo = res.algo;
    parts.push(`<div class="scores">
      <div class="tile"><div class="k">AI 味（越低越好）</div>
        <div class="v ${aiClass(ai)}">${ai}</div>
        <div class="s">${aiWord(ai)} · 规则 ${res.rules.score}${res.llm ? ` · 模型 ${res.llm.ai_score}` : ''}</div></div>
      <div class="tile"><div class="k">算法友好度（推算）</div>
        ${algo
          ? `<div class="v ${algoClass(algo.score)}">${algo.score}</div><div class="s">${algoWord(algo.delta)}</div>`
          : `<div class="v" style="color:var(--muted)">—</div><div class="s">需要配置 LLM</div>`}
      </div></div>`);

    if (res.llmError) {
      parts.push(`<div class="banner err">模型评审失败：${esc(res.llmError)} <a href="#" data-act="settings">打开设置</a></div>`);
    } else if (!res.llmConfigured) {
      parts.push(`<div class="banner">现在只用了本地规则。配置 LLM 后可以得到逐句评审、算法推算和改写。<a href="#" data-act="settings">去设置</a></div>`);
    }

    if (res.llm) {
      if (res.llm.verdict) parts.push(`<div class="verdict">${esc(res.llm.verdict)}</div>`);
      if (res.llm.issues.length) {
        parts.push('<h3>逐句问题与修改建议</h3>');
        for (const i of res.llm.issues) {
          parts.push(`<div class="item"><span class="quote">${esc(i.quote)}</span><div>${esc(i.problem)}</div><div class="sugg">→ ${esc(i.suggestion)}</div></div>`);
        }
      }
    }

    if (res.rules.hits.length) {
      parts.push('<h3>本地规则命中</h3>');
      for (const h of res.rules.hits) {
        parts.push(`<div class="item"><span class="label">${esc(h.label)}</span><span class="pts">+${h.points}</span>
          <div>${h.matches.map((m) => `<span class="chip">${esc(m)}</span>`).join('')}</div>
          <div class="note">${esc(h.advice)}</div></div>`);
      }
    } else {
      parts.push('<h3>本地规则命中</h3><div class="note">没有命中常见的 AI 写作特征。</div>');
    }

    const tips = [];
    for (const t of res.local.tips) tips.push(`<li class="${t.level === 'warn' ? 'warn' : t.level === 'good' ? 'good' : ''}">${esc(t.text)}</li>`);
    if (res.llm) for (const t of res.llm.algo_tips) tips.push(`<li>${esc(t)}</li>`);
    parts.push(`<h3>提高推荐分的建议</h3><ul class="tips">${tips.join('')}</ul>`);

    if (algo) {
      const rows = algo.parts.slice(0, 8).map((p) => `<tr><td>${esc(p.label)}</td><td class="n">${pct(p.p)}</td>
        <td class="n">${p.weight}</td><td class="n ${p.contribution < 0 ? 'bad' : ''}">${p.contribution.toFixed(3)}</td></tr>`).join('');
      parts.push(`<h3>算法推算明细（贡献最大的 8 项）</h3>
        <table><thead><tr><th>行为</th><th class="n">预测概率</th><th class="n">权重</th><th class="n">贡献</th></tr></thead><tbody>${rows}</tbody></table>
        <div class="note">总分 ${algo.total.toFixed(3)}，普通推文基线 ${algo.baseline.toFixed(3)}。概率由模型估计，权重来自
        <a href="${esc(root.XAAlgo.WEIGHTS_SOURCE)}" target="_blank" rel="noopener">x-algorithm 开源代码</a>（${esc(root.XAAlgo.WEIGHTS_AS_OF)} 读取），是推算值，不代表真实曝光。</div>`);
    }

    parts.push(`<h3>改写</h3><div class="row"><button class="btn primary" data-act="rewrite" ${res.llmConfigured ? '' : 'disabled'}>生成 3 个改写版本</button></div><div class="rewrites"></div>`);
    return parts.join('');
  }

  function renderRewrites(list, canReplace) {
    if (!list.length) return '<div class="note">模型没有给出改写。</div>';
    return list.map((r, i) => `<div class="card">
      <div class="row"><span class="label">${esc(r.style || `版本 ${i + 1}`)}</span>
        <span class="chip ${aiClass(r.rules.score)}">规则 AI 味 ${r.rules.score}</span><span class="chip">计数 ${r.length}</span></div>
      <div class="t">${esc(r.text)}</div>
      <div class="note">${esc(r.change_note)}</div>
      <div class="row" style="margin-top:6px">
        ${canReplace ? `<button class="btn primary" data-act="use" data-i="${i}">替换到输入框</button>` : ''}
        <button class="btn" data-act="copy" data-i="${i}">复制</button>
        <button class="btn" data-act="recheck" data-i="${i}">体检这一版</button>
      </div></div>`).join('');
  }

  // opts: { text, floating, onReplace(text) => Promise<boolean>, container }
  function open(opts) {
    let host = opts.container;
    if (!host) {
      const old = document.getElementById('xa-panel-host');
      if (old) old.remove();
      host = document.createElement('div');
      host.id = 'xa-panel-host';
      document.documentElement.appendChild(host);
    }
    const shadow = host.shadowRoot || host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `<style>${CSS}</style><div class="wrap ${opts.floating ? 'floating' : ''} ${opts.floating && isDarkPage() ? 'dark' : ''} ${opts.dark ? 'dark' : ''}">
      ${opts.floating ? '<div class="head"><h2>推文体检</h2><button class="x" data-act="close" title="关闭">×</button></div>' : ''}
      <div class="body"></div></div>`;
    const body = shadow.querySelector('.body');
    let current = { text: opts.text, report: null, rewrites: [] };

    async function run(text) {
      current = { text, report: null, rewrites: [] };
      body.innerHTML = `<div class="orig">${esc(text)}</div><div class="note"><span class="spin"></span>正在体检…</div>`;
      try {
        const res = await send({ type: 'xa:analyze', text });
        current.report = res;
        body.innerHTML = `<div class="orig">${esc(text)}</div>${renderReport(res)}`;
      } catch (e) {
        body.innerHTML = `<div class="orig">${esc(text)}</div><div class="banner err">${esc(e.message)}</div>`;
      }
    }

    shadow.addEventListener('click', async (ev) => {
      const el = ev.target.closest('[data-act]');
      if (!el) return;
      ev.preventDefault();
      const act = el.getAttribute('data-act');
      const i = Number(el.getAttribute('data-i'));
      if (act === 'close') host.remove();
      if (act === 'settings') send({ type: 'xa:openOptions' }).catch(() => {});
      if (act === 'rewrite') {
        const box = shadow.querySelector('.rewrites');
        el.disabled = true;
        box.innerHTML = '<div class="note"><span class="spin"></span>正在改写…</div>';
        try {
          const r = await send({ type: 'xa:rewrite', text: current.text, analysis: current.report && current.report.llm });
          current.rewrites = r.rewrites;
          box.innerHTML = renderRewrites(r.rewrites, !!opts.onReplace);
        } catch (e) {
          box.innerHTML = `<div class="banner err">${esc(e.message)}</div>`;
        } finally {
          el.disabled = false;
        }
      }
      const rw = current.rewrites[i];
      if (act === 'copy' && rw) {
        await navigator.clipboard.writeText(rw.text).catch(() => {});
        el.textContent = '已复制';
      }
      if (act === 'use' && rw && opts.onReplace) {
        const ok = await opts.onReplace(rw.text);
        if (!ok) await navigator.clipboard.writeText(rw.text).catch(() => {});
        el.textContent = ok ? '已替换' : '替换失败，已复制';
      }
      if (act === 'recheck' && rw) run(rw.text);
    });

    run(opts.text);
    return { host, run };
  }

  root.XAPanel = { open, send };
})(typeof globalThis !== 'undefined' ? globalThis : self);
