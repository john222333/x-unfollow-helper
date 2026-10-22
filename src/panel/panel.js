// 侧边栏：AI / Web3 热点话题，点一下生成推文草稿，填进 X 的发推框（不会自动发出）。
(function () {
  'use strict';

  const T = window.XATrends;
  const send = window.XAMsg.send;
  const $ = (id) => document.getElementById(id);

  let topic = 'ai';
  let data = null; // { state, trends, llm }
  const open = new Set(); // 展开了全部内容的话题
  const busy = new Map(); // 正在生成草稿的 key → true
  const errs = new Map(); // 草稿生成失败的 key → 错误

  try { topic = localStorage.getItem('xa-topic') === 'web3' ? 'web3' : 'ai'; } catch { /* 忽略 */ }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  const safeUrl = (u) => (/^https:\/\//.test(String(u || '')) ? String(u) : '#');

  function ago(t) {
    if (!t) return '';
    const m = Math.max(0, Math.round((Date.now() - t) / 60000));
    if (m < 1) return '刚刚';
    if (m < 60) return `${m} 分钟前`;
    const h = Math.round(m / 60);
    if (h < 48) return `${h} 小时前`;
    return `${Math.round(h / 24)} 天前`;
  }

  function fmt(n) {
    const v = Number(n) || 0;
    if (v >= 10000) return `${(v / 10000).toFixed(v >= 100000 ? 0 : 1)} 万`;
    if (v >= 1000) return `${(v / 1000).toFixed(1)}k`;
    return String(v);
  }

  // 引用推文时，推文链接会附在正文后面，也占 24 个字符。
  const draftLength = (text, quoteUrl) => T.weightedLength(text) + (quoteUrl ? 24 : 0);

  function srcName(k) {
    if (k === 'x') return 'X 列表';
    if (k.startsWith('rss:')) return k.slice(4);
    if (k.startsWith('reddit:')) return `Reddit ${k.slice(7)}`;
    return T.SOURCE_LABELS[k] || k;
  }

  // 「为什么上榜」：有多少互相独立的来源在讲这件事。
  function whyLine(tp) {
    const w = tp.why || {};
    const parts = [];
    if (w.xPosts) parts.push(`X 趋势 ${fmt(w.xPosts)} 帖`);
    if (w.outlets) parts.push(`${w.outlets} 个媒体或社区`);
    if (w.authors) parts.push(`${w.authors} 位博主`);
    if (w.engagement) parts.push(`推文互动 ${fmt(w.engagement)}`);
    if (w.personalOnly) parts.push('只出现在你的关注圈');
    return parts.join(' · ');
  }

  // ---------- 数据 ----------

  async function load(auto) {
    data = await send({ type: 'xa:trends', auto: !!auto });
    render();
  }

  // 你正在改草稿时不重画界面（会丢掉改动），等离开输入框再更新。
  let pending = false;
  const editing = () => !!(document.activeElement && document.activeElement.matches('.draft textarea'));
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (!(changes.trends || changes.settings || changes.llmKey)) return;
    if (editing()) { pending = true; return; }
    load(false).catch(() => {});
  });
  document.addEventListener('focusout', () => {
    setTimeout(() => {
      if (pending && !editing()) { pending = false; load(false).catch(() => {}); }
    }, 0);
  });

  // ---------- 界面 ----------

  function renderStatus() {
    const st = data.state;
    const running = st.status === 'running';
    $('refreshBtn').disabled = running;
    const total = Object.values(st.counts || {}).reduce((a, b) => a + b, 0);
    if (running) $('status').innerHTML = `<span class="spin"></span>正在读取各个来源…`;
    else if (st.at) $('status').textContent = `更新于 ${ago(st.at)} · 共 ${total} 条内容`;
    else $('status').textContent = '还没有读取过，点「刷新」开始。';

    // 每个来源这次读到多少条：让你看清热度是从哪儿来的。
    const counts = Object.entries(st.counts || {}).sort((a, b) => b[1] - a[1]);
    $('sources').hidden = !counts.length;
    $('sourcesSum').textContent = `数据来源：${counts.length} 个`;
    $('sourceList').innerHTML = counts.map(([k, n]) => {
      const base = k.split(':')[0];
      const note = T.PERSONAL.has(base) ? '（取决于你关注了谁，权重较低）' : base === 'xtrend' ? '（X 全站统计，打开 x.com 首页或探索页时更新）' : '';
      return `<li>${esc(srcName(k))}：${n} 条${note}</li>`;
    }).join('') + (st.counts && st.counts.xtrend ? '' : '<li class="muted">X 趋势：还没读到。打开 x.com 首页（窗口宽一点，右侧有「有什么新鲜事」）或探索页就会记下来</li>');

    const errors = Object.entries(st.errors || {});
    $('errors').hidden = !errors.length;
    $('errorsSum').textContent = `${errors.length} 个来源这次没读到`;
    $('errorList').innerHTML = errors.map(([k, v]) => {
      const name = srcName(k);
      return `<li>${esc(name)}：${esc(v)}</li>`;
    }).join('');
  }

  function itemHtml(it, topicId, canDraft) {
    if (it.source === 'x' || it.source === 'home') {
      const stats = [`❤ ${fmt(it.likes)}`, `↻ ${fmt(it.retweets)}`, it.views ? `${fmt(it.views)} 浏览` : ''].filter(Boolean).join(' · ');
      return `<li>
        <div class="who"><a href="${safeUrl(`https://x.com/${it.author}`)}" target="_blank">@${esc(it.author)}</a><span>${stats}</span><span>${ago(it.t)}</span>
          ${canDraft ? `<button class="link quote" data-quote="${esc(it.id)}" data-topic="${esc(topicId)}" title="引用这条推文，写一段你的看法">引用</button>` : ''}</div>
        <a class="text" href="${safeUrl(it.url)}" target="_blank">${esc(it.text || it.title)}</a>
      </li>`;
    }
    const label = it.feed || T.SOURCE_LABELS[it.source] || it.source;
    const extra = it.source === 'hn' ? `${it.points} 分 · ${it.comments} 评论`
      : it.source === 'hf' ? `${it.upvotes} 赞`
        : it.source === 'gh' ? `★ ${fmt(it.stars)}` : '';
    return `<li>
      <div class="who"><span class="chip">${esc(label)}</span>${extra ? `<span>${esc(extra)}</span>` : ''}<span>${ago(it.t)}</span></div>
      <a class="text" href="${safeUrl(it.url)}" target="_blank">${esc(it.title)}</a>
    </li>`;
  }

  function draftsHtml(key) {
    const d = data.state.drafts && data.state.drafts[key];
    let html = '';
    if (busy.get(key)) html += '<div class="muted small"><span class="spin"></span>正在写草稿…</div>';
    if (errs.get(key)) html += `<div class="err">${esc(errs.get(key))}</div>`;
    if (d && !busy.get(key)) {
      html += d.summary ? `<div class="sum">${esc(d.summary)}</div>` : '';
      html += d.drafts.map((x, i) => {
        const n = draftLength(x.text, d.quoteUrl);
        return `<div class="draft" data-key="${esc(key)}" data-i="${i}">
          <div class="style">${esc(x.style || `草稿 ${i + 1}`)}</div>
          <textarea>${esc(x.text)}</textarea>
          <div class="bar"><span class="count ${n > 280 ? 'over' : ''}">${n} / 280</span><span class="spacer"></span>
            <button class="btn small" data-act="copy">复制</button>
            <button class="btn small primary" data-act="compose" title="在 X 的发推框里打开，确认后自己点发布">${d.quoteUrl ? '去引用' : '去发推'}</button></div>
        </div>`;
      }).join('');
      html += `<div class="row"><button class="btn small" data-regen="${esc(key)}">换一批</button><span class="muted small">${ago(d.at)}生成，可以先改再发</span></div>`;
    }
    return html;
  }

  function render() {
    if (!data) return;
    document.querySelectorAll('#topicTabs button').forEach((b) => b.classList.toggle('on', b.dataset.topic === topic));
    renderStatus();
    const { state, trends, llm } = data;
    $('offBanner').hidden = trends.enabled;
    $('keyBanner').hidden = !trends.enabled || llm.hasKey;
    $('listBanner').hidden = !trends.enabled || (trends.lists.ai.length + trends.lists.web3.length) > 0;
    const list = (state.topics && state.topics[topic]) || [];
    $('empty').hidden = !!list.length;
    $('empty').textContent = state.status === 'running' ? '读取中…' : state.at ? '这个领域暂时没有读到热点。打开 x.com 刷一刷首页，或者在设置里登记列表、加 RSS 来源。' : '';
    const canDraft = trends.enabled && llm.hasKey;
    $('topics').innerHTML = list.map((tp) => {
      const shown = open.has(tp.id) ? tp.items : tp.items.slice(0, 2);
      const chips = tp.sources.map((s) => `<span class="chip">${esc(T.SOURCE_LABELS[s] || s)}</span>`).join('');
      const postKey = `${tp.id}|post`;
      const quoteKeys = Object.keys(state.drafts || {}).filter((k) => k.startsWith(`${tp.id}|`) && k !== postKey);
      for (const k of busy.keys()) if (k.startsWith(`${tp.id}|`) && k !== postKey && !quoteKeys.includes(k)) quoteKeys.push(k);
      for (const k of errs.keys()) if (k.startsWith(`${tp.id}|`) && k !== postKey && !quoteKeys.includes(k)) quoteKeys.push(k);
      return `<div class="topic" data-id="${esc(tp.id)}">
        <div class="head"><span class="heat" title="热度：增速、跨来源讨论度综合打分">${tp.heat}</span>
          <a class="title" href="${safeUrl(tp.url)}" target="_blank">${esc(tp.title)}</a></div>
        <div class="meta">${chips}<span class="muted small">${tp.count} 条 · ${ago(tp.t)}</span></div>
        <div class="why muted small" title="热度看三件事：最热那条内容在它自己来源里的增长速度、有多少互相独立的来源在讲、是不是只出现在你的关注圈">${esc(whyLine(tp))}</div>
        <ul class="items">${shown.map((it) => itemHtml(it, tp.id, canDraft)).join('')}</ul>
        <div class="actions">
          <button class="btn small primary" data-draft="${esc(tp.id)}" ${canDraft ? '' : 'disabled title="先在设置里填写模型 API key"'}>写推文</button>
          ${tp.items.length > 2 ? `<button class="btn small ghost" data-more="${esc(tp.id)}">${open.has(tp.id) ? '收起' : `展开全部 ${tp.items.length} 条`}</button>` : ''}
        </div>
        <div class="drafts">${draftsHtml(postKey)}${quoteKeys.map((k) => {
          const it = tp.items.find((x) => `${tp.id}|${x.id}` === k);
          return `<div class="muted small" style="margin-top:6px">引用 @${esc(it ? it.author : '')}：</div>${draftsHtml(k)}`;
        }).join('')}</div>
      </div>`;
    }).join('');
  }

  async function makeDraft(topicId, itemId) {
    const key = `${topicId}|${itemId || 'post'}`;
    if (busy.get(key)) return;
    busy.set(key, true);
    errs.delete(key);
    render();
    try {
      await send({ type: 'xa:draft', topicId, mode: itemId ? 'quote' : 'post', itemId: itemId || null });
    } catch (e) {
      errs.set(key, e.message);
    } finally {
      busy.delete(key);
      if (editing()) pending = true; else await load(false).catch(() => render());
    }
  }

  // ---------- 事件 ----------

  $('topicTabs').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-topic]');
    if (!b) return;
    topic = b.dataset.topic;
    try { localStorage.setItem('xa-topic', topic); } catch { /* 忽略 */ }
    render();
  });

  $('refreshBtn').onclick = async () => {
    $('refreshBtn').disabled = true;
    $('status').innerHTML = '<span class="spin"></span>正在读取各个来源…';
    try {
      await send({ type: 'xa:trendsRefresh' });
    } catch (e) {
      $('status').textContent = `刷新失败：${e.message}`;
    }
    await load(false).catch(() => {});
  };

  const openSettings = () => chrome.tabs.create({ url: chrome.runtime.getURL('src/options/options.html#settings') });
  $('settingsBtn').onclick = openSettings;
  document.querySelectorAll('[data-go="settings"]').forEach((b) => { b.onclick = openSettings; });

  $('topics').addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.more) {
      if (open.has(b.dataset.more)) open.delete(b.dataset.more); else open.add(b.dataset.more);
      render();
      return;
    }
    if (b.dataset.draft) return makeDraft(b.dataset.draft, null);
    if (b.dataset.quote) return makeDraft(b.dataset.topic, b.dataset.quote);
    if (b.dataset.regen) {
      const [topicId, rest] = [b.dataset.regen.split('|')[0], b.dataset.regen.split('|').slice(1).join('|')];
      return makeDraft(topicId, rest === 'post' ? null : rest);
    }
    const box = b.closest('.draft');
    if (!box) return;
    const text = box.querySelector('textarea').value;
    if (b.dataset.act === 'copy') {
      try {
        await navigator.clipboard.writeText(text);
        b.textContent = '已复制';
      } catch {
        box.querySelector('textarea').select();
        document.execCommand('copy');
        b.textContent = '已复制';
      }
      setTimeout(() => { b.textContent = '复制'; }, 1500);
    }
    if (b.dataset.act === 'compose') {
      const d = data.state.drafts[box.dataset.key];
      chrome.tabs.create({ url: T.composeUrl(text, d && d.quoteUrl) });
    }
  });

  // 改草稿时实时更新字数。
  $('topics').addEventListener('input', (e) => {
    const ta = e.target.closest('.draft textarea');
    if (!ta) return;
    const box = ta.closest('.draft');
    const d = data.state.drafts && data.state.drafts[box.dataset.key];
    const n = draftLength(ta.value, d && d.quoteUrl);
    const c = box.querySelector('.count');
    c.textContent = `${n} / 280`;
    c.classList.toggle('over', n > 280);
  });

  load(true).catch((e) => { $('status').textContent = e.message; });
  // 「几分钟前」随时间更新。
  setInterval(() => { if (data && !document.activeElement.matches('textarea')) renderStatus(); }, 60000);
})();
