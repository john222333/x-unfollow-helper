// 管理页：关注列表筛选、取关队列、日志、推文体检、设置。
(function () {
  'use strict';

  const S = window.XAStore;
  const send = window.XAPanel.send;
  const $ = (id) => document.getElementById(id);
  const PAGE = 100;

  const data = { users: {}, whitelist: {}, queue: [], job: null, collect: null, me: null, log: [], settings: S.mergeSettings() };
  let cap = 100;
  const selected = new Set();
  const logSelected = new Set();
  let page = 0;
  const tagOn = new Set();

  const STATUS = {
    idle: '空闲', running: '进行中', awaiting_confirm: '等待确认', paused: '已暂停', tripped: '已熔断', daily_cap: '今日已达上限',
  };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  const fmtNum = (n) => (Number.isFinite(n) ? n.toLocaleString() : '—');
  const fmtTime = (t) => new Date(t).toLocaleString();

  function flash(el, text, ms) {
    el.textContent = text;
    if (ms) setTimeout(() => { if (el.textContent === text) el.textContent = ''; }, ms);
  }

  async function act(btn, fn) {
    if (btn) btn.disabled = true;
    try {
      await fn();
    } catch (e) {
      alert(e.message);
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  // ---------- 标签页 ----------
  function showTab(name) {
    document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === name));
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('on', t.id === `tab-${name}`));
    if (location.hash !== `#${name}`) history.replaceState(null, '', `#${name}`);
  }
  $('tabs').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-tab]');
    if (b) showTab(b.dataset.tab);
  });

  // ---------- 数据加载与监听 ----------
  async function loadAll() {
    const got = await chrome.storage.local.get(['users', 'whitelist', 'queue', 'job', 'collect', 'me', 'log', 'settings']);
    data.users = got.users || {};
    data.whitelist = got.whitelist || {};
    data.queue = got.queue || [];
    data.job = got.job || null;
    data.collect = got.collect || null;
    data.me = got.me || null;
    data.log = got.log || [];
    data.settings = S.mergeSettings(got.settings);
    await refreshState();
  }

  async function refreshState() {
    try {
      const st = await send({ type: 'xa:state' });
      data.job = st.job;
      cap = st.cap;
    } catch (e) {
      console.warn(e);
    }
  }

  let renderTimer = null;
  chrome.storage.onChanged.addListener(async (changes, area) => {
    if (area !== 'local') return;
    for (const [k, v] of Object.entries(changes)) {
      if (k in data) data[k] = k === 'settings' ? S.mergeSettings(v.newValue) : (v.newValue || (Array.isArray(data[k]) ? [] : k === 'users' || k === 'whitelist' ? {} : null));
    }
    if (changes.job || changes.settings) await refreshState();
    clearTimeout(renderTimer);
    renderTimer = setTimeout(() => {
      renderHeader();
      if (changes.users || changes.whitelist) renderUsers();
      if (changes.collect) renderCollect();
      if (changes.job || changes.queue || changes.settings) renderJob();
      if (changes.log) renderLog();
    }, 150);
  });

  // ---------- 顶部 ----------
  function renderHeader() {
    $('ver').textContent = `v${chrome.runtime.getManifest().version}`;
    $('me').textContent = data.me && data.me.handle ? `@${data.me.handle}` : '未检测到账号（打开 x.com 后会自动识别）';
    const st = (data.job && data.job.status) || 'idle';
    const pill = $('statusPill');
    pill.textContent = `取关：${STATUS[st] || st}`;
    pill.className = `pill ${st}`;
  }

  // ---------- 关注管理 ----------
  function renderTagFilters() {
    $('tagFilters').innerHTML = Object.entries(S.TAG_LABELS)
      .map(([k, label]) => `<label class="${tagOn.has(k) ? 'on' : ''}" data-tag="${k}"><input type="checkbox" ${tagOn.has(k) ? 'checked' : ''}>${esc(label)}</label>`)
      .join('');
  }
  $('tagFilters').addEventListener('click', (e) => {
    const l = e.target.closest('label[data-tag]');
    if (!l) return;
    e.preventDefault();
    const k = l.dataset.tag;
    if (tagOn.has(k)) tagOn.delete(k); else tagOn.add(k);
    page = 0;
    renderTagFilters();
    renderUsers();
  });

  function filteredUsers() {
    const few = Number($('fewN').value);
    const q = $('q').value.trim().toLowerCase();
    const kws = $('kw').value.split(/[,，]/).map((s) => s.trim().toLowerCase()).filter(Boolean);
    const hideWl = $('hideWl').checked;
    let list = Object.values(data.users).map((u) => ({ ...u, tags: S.tagsFor(u, { fewFollowers: few }) }));
    if (hideWl) list = list.filter((u) => !data.whitelist[u.key]);
    if (q) list = list.filter((u) => `${u.name || ''} ${u.handle} ${u.bio || ''}`.toLowerCase().includes(q));
    if (tagOn.size) list = list.filter((u) => [...tagOn].every((t) => u.tags.includes(t)));
    if (kws.length) list = list.filter((u) => kws.some((k) => `${u.name || ''} ${u.bio || ''}`.toLowerCase().includes(k)));
    const num = (v, d) => (Number.isFinite(v) ? v : d);
    const sorters = {
      order: (a, b) => (a.firstSeen || 0) - (b.firstSeen || 0),
      followersAsc: (a, b) => num(a.followers, 1e12) - num(b.followers, 1e12),
      followersDesc: (a, b) => num(b.followers, -1) - num(a.followers, -1),
      tweetsAsc: (a, b) => num(a.tweets, 1e12) - num(b.tweets, 1e12),
    };
    list.sort(sorters[$('sort').value] || sorters.order);
    return list;
  }

  function renderUsers() {
    const list = filteredUsers();
    const total = Object.keys(data.users).length;
    const pages = Math.max(1, Math.ceil(list.length / PAGE));
    if (page >= pages) page = pages - 1;
    const slice = list.slice(page * PAGE, page * PAGE + PAGE);
    $('userSummary').textContent = total
      ? `共 ${total} 人，筛选出 ${list.length} 人，已选 ${selected.size} 人`
      : '还没有数据，先点「读取关注列表」';
    $('enqueueBtn').textContent = `加入取关队列（${selected.size}）`;
    $('pageInfo').textContent = `${page + 1} / ${pages}`;
    $('pageAll').checked = slice.length > 0 && slice.every((u) => selected.has(u.key));
    $('userRows').innerHTML = slice.map((u) => {
      const wl = !!data.whitelist[u.key];
      const avatar = u.avatar ? `<img src="${esc(u.avatar)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : '<img alt="">';
      return `<tr data-key="${esc(u.key)}">
        <td><input type="checkbox" class="sel" ${selected.has(u.key) ? 'checked' : ''}></td>
        <td><div class="acct">${avatar}<div style="min-width:0">
          <a href="https://x.com/${esc(u.handle)}" target="_blank" rel="noopener"><span class="nm">${esc(u.name || u.handle)}</span> <span class="muted">@${esc(u.handle)}</span></a>
          <div class="bio">${esc(u.bio || '')}</div></div></div></td>
        <td class="n">${fmtNum(u.followers)}</td><td class="n">${fmtNum(u.following)}</td><td class="n">${fmtNum(u.tweets)}</td>
        <td>${u.tags.map((t) => `<span class="chip ${t}">${esc(S.TAG_LABELS[t] || t)}</span>`).join('')}</td>
        <td><button class="star ${wl ? 'on' : ''}" title="白名单里的人永远不会被取关">${wl ? '★' : '☆'}</button></td></tr>`;
    }).join('');
  }

  ['q', 'fewN', 'kw'].forEach((id) => $(id).addEventListener('input', () => { page = 0; renderUsers(); }));
  ['hideWl', 'sort'].forEach((id) => $(id).addEventListener('change', () => { page = 0; renderUsers(); }));
  $('prevPage').onclick = () => { if (page > 0) { page--; renderUsers(); } };
  $('nextPage').onclick = () => { page++; renderUsers(); };

  $('userRows').addEventListener('click', async (e) => {
    const tr = e.target.closest('tr[data-key]');
    if (!tr) return;
    const key = tr.dataset.key;
    if (e.target.classList.contains('sel')) {
      if (e.target.checked) selected.add(key); else selected.delete(key);
      renderUsers();
    }
    if (e.target.classList.contains('star')) {
      const wl = { ...data.whitelist };
      if (wl[key]) delete wl[key]; else { wl[key] = true; selected.delete(key); }
      await chrome.storage.local.set({ whitelist: wl });
    }
  });
  $('pageAll').addEventListener('change', (e) => {
    const list = filteredUsers().slice(page * PAGE, page * PAGE + PAGE);
    list.forEach((u) => (e.target.checked ? selected.add(u.key) : selected.delete(u.key)));
    renderUsers();
  });
  $('selAll').onclick = () => { filteredUsers().forEach((u) => selected.add(u.key)); renderUsers(); };
  $('selNone').onclick = () => { selected.clear(); renderUsers(); };
  $('wlAdd').onclick = async () => {
    const wl = { ...data.whitelist };
    selected.forEach((k) => { wl[k] = true; });
    selected.clear();
    await chrome.storage.local.set({ whitelist: wl });
  };
  $('wlRemove').onclick = async () => {
    const wl = { ...data.whitelist };
    selected.forEach((k) => delete wl[k]);
    await chrome.storage.local.set({ whitelist: wl });
  };
  $('enqueueBtn').onclick = () => act($('enqueueBtn'), async () => {
    if (!selected.size) throw new Error('先勾选要取关的人。');
    const keys = [...selected].map((k) => data.users[k] || k).map((u) => (typeof u === 'string' ? u : u.handle));
    const r = await send({ type: 'xa:enqueue', keys, action: 'unfollow' });
    selected.clear();
    renderUsers();
    flash($('userSummary'), `已加入 ${r.added} 人${r.skipped ? `，跳过白名单 ${r.skipped} 人` : ''}，队列共 ${r.total} 人。到「取关任务」开始执行。`);
  });

  function renderCollect() {
    const c = data.collect;
    const running = c && c.status === 'running';
    $('collectBtn').disabled = !!running;
    $('stopCollectBtn').hidden = !running;
    if (!c) { $('collectMsg').textContent = ''; return; }
    const when = c.finishedAt ? `，${fmtTime(c.finishedAt)}` : '';
    const extra = c.status === 'done' && c.removed ? `，移除了 ${c.removed} 个已不再关注的人` : '';
    $('collectMsg').textContent = `${c.message || ''}${c.count != null ? `（本地共 ${c.count} 人${extra}）` : ''}${when}`;
  }
  $('collectBtn').onclick = () => act($('collectBtn'), () => send({ type: 'xa:collect' }));
  $('stopCollectBtn').onclick = () => act($('stopCollectBtn'), () => send({ type: 'xa:stopCollect' }));

  // ---------- 取关任务 ----------
  function nextText(job) {
    const now = Date.now();
    if (!job) return '—';
    if (job.status === 'awaiting_confirm') return '等待你确认';
    if (job.status === 'daily_cap') return `${new Date(job.nextActionAt).toLocaleString()} 恢复`;
    if (job.status !== 'running') return '—';
    if (job.current) return `正在处理 @${job.current}`;
    const left = Math.max(0, Math.round((job.nextActionAt - now) / 1000));
    if (!job.batch.length) return left > 0 ? `批次休息，${Math.floor(left / 60)} 分 ${left % 60} 秒后准备下一批` : '准备下一批…';
    return left > 0 ? `${left} 秒后` : '马上';
  }

  function renderJob() {
    const job = data.job || { status: 'idle', batch: [], doneToday: 0 };
    const s = data.settings;
    $('dryBanner').hidden = !s.dryRun;
    $('jobStatus').textContent = STATUS[job.status] || job.status;
    $('jobToday').textContent = `${job.doneToday || 0} / ${cap}`;
    $('jobQueue').textContent = data.queue.length;
    $('jobNext').textContent = nextText(job);
    const err = $('jobError');
    err.hidden = !job.lastError;
    err.textContent = job.lastError ? `${job.lastError}${job.status === 'tripped' && job.pausedUntil ? `。建议 ${fmtTime(job.pausedUntil)} 之后再继续。` : ''}` : '';

    const btns = [];
    if (['idle', 'paused'].includes(job.status)) btns.push(`<button class="btn primary" data-do="start" ${data.queue.length ? '' : 'disabled'}>开始取关</button>`);
    if (job.status === 'awaiting_confirm') btns.push(`<button class="btn primary" data-do="confirm">确认执行这一批（${job.batch.length} 个）</button>`);
    if (['running', 'awaiting_confirm', 'daily_cap'].includes(job.status)) btns.push('<button class="btn" data-do="pause">暂停</button>');
    if (job.status === 'tripped') btns.push('<button class="btn danger" data-do="force">仍然继续（不建议）</button>');
    $('jobButtons').innerHTML = btns.join('');

    const p = s.pace;
    $('paceSummary').textContent = `当前节奏：每次间隔 ${p.minDelaySec}–${p.maxDelaySec} 秒，每批 ${p.batchSize} 个，批间休息 ${p.restMinMin}–${p.restMaxMin} 分钟，每天最多 ${cap} 个。${s.confirmEachBatch ? '每批开始前需要你确认。' : ''}`;

    const byKey = Object.fromEntries(data.queue.map((q) => [q.key, q]));
    $('batchList').innerHTML = job.batch && job.batch.length
      ? job.batch.map((k) => `<span class="chip">${job.current === k ? '▶ ' : ''}@${esc((byKey[k] && byKey[k].handle) || k)}</span>`).join('')
      : '没有进行中的批次';

    const rows = data.queue.slice(0, 200).map((q, i) => `<tr data-key="${esc(q.key)}"><td>${i + 1}</td>
      <td><a href="https://x.com/${esc(q.handle)}" target="_blank" rel="noopener">${esc(q.name || q.handle)} <span class="muted">@${esc(q.handle)}</span></a></td>
      <td>${q.action === 'follow' ? '重新关注' : '取关'}</td><td><button class="btn small" data-rm="1">移出</button></td></tr>`);
    $('queueRows').innerHTML = rows.join('');
    $('queueMore').textContent = data.queue.length > 200 ? `只显示前 200 个，共 ${data.queue.length} 个。` : '';
  }

  $('jobButtons').addEventListener('click', (e) => {
    const b = e.target.closest('[data-do]');
    if (!b) return;
    const what = b.dataset.do;
    act(b, async () => {
      if (what === 'start') await send({ type: 'xa:start' });
      if (what === 'confirm') await send({ type: 'xa:confirm' });
      if (what === 'pause') await send({ type: 'xa:pause' });
      if (what === 'force') {
        if (!confirm('X 刚刚提示了限制或异常。现在继续，被锁号的风险更高。确定继续吗？')) return;
        await send({ type: 'xa:resume', force: true });
      }
    });
  });
  $('queueRows').addEventListener('click', (e) => {
    if (!e.target.dataset.rm) return;
    const key = e.target.closest('tr').dataset.key;
    act(e.target, () => send({ type: 'xa:dequeue', keys: [key] }));
  });
  $('clearQueue').onclick = () => act($('clearQueue'), async () => {
    if (!confirm('清空整个队列？')) return;
    await send({ type: 'xa:clearQueue' });
  });

  setInterval(() => {
    if (data.job && ['running', 'daily_cap'].includes(data.job.status)) $('jobNext').textContent = nextText(data.job);
  }, 1000);

  // ---------- 推文体检 ----------
  $('checkText').addEventListener('input', () => {
    const t = $('checkText').value;
    $('checkCount').textContent = t ? `计数长度 ${window.XARules.weightedLength(t)} / 280` : '';
  });
  $('checkBtn').onclick = () => {
    const text = $('checkText').value.trim();
    if (!text) return;
    const out = $('checkOut');
    out.innerHTML = '';
    const box = document.createElement('div');
    out.appendChild(box);
    window.XAPanel.open({ text, container: box, floating: false, dark: matchMedia('(prefers-color-scheme: dark)').matches });
  };

  // ---------- 日志 ----------
  const OK = new Set(['ok', 'dry_run', 'pending']);
  const SKIP = new Set(['already', 'gone', 'mismatch']);
  function filteredLog() {
    const f = $('logFilter').value;
    let list = data.log.map((l, i) => ({ ...l, i })).reverse();
    if (f === 'ok') list = list.filter((l) => OK.has(l.result));
    if (f === 'fail') list = list.filter((l) => !OK.has(l.result));
    return list;
  }
  function renderLog() {
    const list = filteredLog();
    const okCount = data.log.filter((l) => l.result === 'ok').length;
    $('logSummary').textContent = `共 ${data.log.length} 条，成功 ${okCount} 条${list.length > 500 ? '，只显示最近 500 条' : ''}`;
    $('logRows').innerHTML = list.slice(0, 500).map((l) => {
      const cls = OK.has(l.result) ? 'res-ok' : SKIP.has(l.result) ? 'res-skip' : 'res-fail';
      const canRefollow = l.result === 'ok' && l.action === 'unfollow';
      return `<tr data-i="${l.i}"><td>${canRefollow ? `<input type="checkbox" class="lsel" ${logSelected.has(l.i) ? 'checked' : ''}>` : ''}</td>
        <td class="small">${esc(fmtTime(l.t))}</td>
        <td><a href="https://x.com/${esc(l.handle)}" target="_blank" rel="noopener">@${esc(l.handle)}</a></td>
        <td>${l.action === 'follow' ? '重新关注' : '取关'}${l.dryRun ? '（演练）' : ''}</td>
        <td class="${cls}" title="${esc(l.detail || '')}">${esc(l.label || l.result)}</td><td class="n">${l.batchNo || ''}</td></tr>`;
    }).join('');
  }
  $('logFilter').onchange = renderLog;
  $('logRows').addEventListener('change', (e) => {
    if (!e.target.classList.contains('lsel')) return;
    const i = Number(e.target.closest('tr').dataset.i);
    if (e.target.checked) logSelected.add(i); else logSelected.delete(i);
  });
  $('logAll').addEventListener('change', (e) => {
    filteredLog().slice(0, 500).filter((l) => l.result === 'ok' && l.action === 'unfollow')
      .forEach((l) => (e.target.checked ? logSelected.add(l.i) : logSelected.delete(l.i)));
    renderLog();
  });
  $('refollowBtn').onclick = () => act($('refollowBtn'), async () => {
    const handles = [...logSelected].map((i) => data.log[i] && data.log[i].handle).filter(Boolean);
    if (!handles.length) throw new Error('先勾选成功取关的记录。');
    const r = await send({ type: 'xa:enqueue', keys: handles, action: 'follow', front: true });
    logSelected.clear();
    renderLog();
    alert(`已把 ${r.added} 个重新关注加到队列最前面，会按同样的节奏执行。`);
  });
  $('exportCsv').onclick = () => {
    const head = ['时间', '用户名', '名字', '动作', '结果', '说明', '批次', '演练'];
    const rows = data.log.map((l) => [fmtTime(l.t), l.handle, l.name || '', l.action, l.label || l.result, l.detail || '', l.batchNo || '', l.dryRun ? '是' : '']);
    const csv = [head, ...rows].map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\r\n');
    download(`x-assistant-log-${S.dayKey()}.csv`, `﻿${csv}`, 'text/csv');
  };
  $('clearLog').onclick = async () => {
    if (!confirm('清空所有日志？清空后就不能从日志里重新关注了。')) return;
    await chrome.storage.local.set({ log: [] });
  };

  function download(name, content, type) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([content], { type }));
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  // ---------- 设置 ----------
  const PRESETS = {
    anthropic: { provider: 'anthropic', baseUrl: 'https://api.anthropic.com', model: 'claude-opus-5-5' },
    deepseek: { provider: 'openai', baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat' },
    qwen: { provider: 'openai', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
    ollama: { provider: 'openai', baseUrl: 'http://localhost:11434/v1', model: 'qwen2.5:7b' },
    openai: { provider: 'openai', baseUrl: 'https://api.openai.com/v1', model: '' },
  };
  const PRESET_LABELS = { anthropic: 'Claude 官方', deepseek: 'DeepSeek', qwen: '通义千问', ollama: '本机 Ollama', openai: 'OpenAI' };
  $('preset').innerHTML += Object.entries(PRESET_LABELS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('');
  $('preset').onchange = () => {
    const p = PRESETS[$('preset').value];
    if (!p) return;
    $('provider').value = p.provider;
    $('baseUrl').value = p.baseUrl;
    $('model').value = p.model;
    $('effortRow').hidden = p.provider !== 'anthropic';
    $('preset').value = '';
  };
  $('provider').onchange = () => {
    const isA = $('provider').value === 'anthropic';
    $('effortRow').hidden = !isA;
    if (isA) { $('baseUrl').value = PRESETS.anthropic.baseUrl; $('model').value = PRESETS.anthropic.model; }
    else if (/anthropic\.com/.test($('baseUrl').value)) { $('baseUrl').value = ''; $('model').value = ''; }
  };

  function fillSettings() {
    const s = data.settings;
    for (const k of Object.keys(S.LIMITS)) $(k).value = s.pace[k];
    $('newAccountMode').checked = !!s.newAccountMode;
    $('confirmEachBatch').checked = !!s.confirmEachBatch;
    $('dryRun').checked = !!s.dryRun;
    $('provider').value = s.llm.provider;
    $('baseUrl').value = s.llm.baseUrl;
    $('model').value = s.llm.model;
    $('effort').value = s.llm.effort || '';
    $('apiKey').value = s.llm.apiKey || '';
    $('effortRow').hidden = s.llm.provider !== 'anthropic';
    $('composeButton').checked = !!s.ui.composeButton;
    $('tweetButtons').checked = !!s.ui.tweetButtons;
    for (const k of Object.keys(S.LIMITS)) $(k).title = `范围 ${S.LIMITS[k][0]}–${S.LIMITS[k][1]}`;
  }

  function formLlm() {
    return {
      provider: $('provider').value,
      baseUrl: $('baseUrl').value.trim(),
      model: $('model').value.trim(),
      effort: $('effort').value,
      apiKey: $('apiKey').value.trim(),
    };
  }

  async function ensureHostPermission(baseUrl) {
    if (!baseUrl) return true;
    let origin;
    try { origin = new URL(baseUrl).origin; } catch { throw new Error('接口地址格式不对。'); }
    const pattern = `${origin}/*`;
    if (await chrome.permissions.contains({ origins: [pattern] })) return true;
    const ok = await chrome.permissions.request({ origins: [pattern] });
    if (!ok) throw new Error(`没有授权访问 ${origin}，体检时无法调用这个接口。`);
    return true;
  }

  $('saveBtn').onclick = () => act($('saveBtn'), async () => {
    const llm = formLlm();
    await ensureHostPermission(llm.baseUrl);
    const pace = {};
    for (const k of Object.keys(S.LIMITS)) pace[k] = Number($(k).value);
    const next = S.mergeSettings({
      ...data.settings,
      pace,
      newAccountMode: $('newAccountMode').checked,
      confirmEachBatch: $('confirmEachBatch').checked,
      dryRun: $('dryRun').checked,
      llm,
      ui: { composeButton: $('composeButton').checked, tweetButtons: $('tweetButtons').checked },
    });
    await chrome.storage.local.set({ settings: next });
    data.settings = next;
    fillSettings();
    const adjusted = Object.keys(S.LIMITS).some((k) => next.pace[k] !== pace[k]);
    flash($('saveMsg'), adjusted ? '已保存。部分节奏超出安全范围，已自动调整。' : '已保存。', 4000);
  });

  $('pingBtn').onclick = () => act($('pingBtn'), async () => {
    const llm = formLlm();
    await ensureHostPermission(llm.baseUrl);
    $('pingMsg').textContent = '测试中…';
    try {
      await send({ type: 'xa:ping', llm });
      $('pingMsg').textContent = '连接成功。记得点「保存设置」。';
    } catch (e) {
      $('pingMsg').textContent = `失败：${e.message}`;
    }
  });

  $('exportAll').onclick = async () => {
    const all = await chrome.storage.local.get(null);
    if (all.settings && all.settings.llm) all.settings.llm.apiKey = all.settings.llm.apiKey ? '（已隐去）' : '';
    delete all.cache;
    download(`x-assistant-data-${S.dayKey()}.json`, JSON.stringify(all, null, 2), 'application/json');
  };
  $('clearUsers').onclick = async () => {
    if (!confirm('清空本地保存的关注列表？不会影响你在 X 上的关注。')) return;
    selected.clear();
    await chrome.storage.local.set({ users: {} });
  };
  $('clearCache').onclick = async () => {
    await chrome.storage.local.set({ cache: {} });
    alert('已清空。');
  };

  // ---------- 启动 ----------
  (async function init() {
    await loadAll();
    renderTagFilters();
    renderHeader();
    renderCollect();
    renderUsers();
    renderJob();
    renderLog();
    fillSettings();
    const tab = location.hash.replace('#', '');
    if (tab && $(`tab-${tab}`)) showTab(tab);
  })();
})();
