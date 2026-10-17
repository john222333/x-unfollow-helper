// 管理页：关注列表筛选、取关队列、日志、推文体检、设置。
(function () {
  'use strict';

  const S = window.XAStore;
  const send = window.XAPanel.send;
  const $ = (id) => document.getElementById(id);
  const PAGE = 100;

  const data = { users: {}, whitelist: {}, queue: [], job: null, collect: null, me: null, owner: null, log: [], settings: S.mergeSettings() };
  let cap = 100;
  let st = null; // 后台返回的整体状态（执行方式、预计完成时间等）
  let account = null; // 当前 x.com 登录的账号（只看已经打开的页面）
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
    const got = await chrome.storage.local.get(['users', 'whitelist', 'queue', 'job', 'collect', 'me', 'owner', 'log', 'settings']);
    data.users = got.users || {};
    data.whitelist = got.whitelist || {};
    data.queue = got.queue || [];
    data.job = got.job || null;
    data.collect = got.collect || null;
    data.me = got.me || null;
    data.owner = got.owner || null;
    data.log = got.log || [];
    data.settings = S.mergeSettings(got.settings);
    await refreshState();
  }

  async function refreshState() {
    try {
      st = await send({ type: 'xa:state' });
      data.job = st.job;
      cap = st.cap;
    } catch (e) {
      console.warn(e);
    }
  }

  const sameHandle = (c) => ((c.oldValue && c.oldValue.handle) || '') === ((c.newValue && c.newValue.handle) || '');

  async function refreshAccount() {
    try {
      account = await send({ type: 'xa:account' });
    } catch (e) {
      account = null;
    }
    renderHeader();
    renderAccountWarn();
  }

  // 存储变化很密集（读取列表时每页都会改几项），合并到一起再渲染。
  // 要累积所有变过的项：只看最后一次变化会漏掉前面的（比如列表更新后紧跟着一次进度更新）。
  let renderTimer = null;
  const pending = new Set();
  chrome.storage.onChanged.addListener(async (changes, area) => {
    if (area !== 'local') return;
    for (const [k, v] of Object.entries(changes)) {
      if (k in data) data[k] = k === 'settings' ? S.mergeSettings(v.newValue) : (v.newValue || (Array.isArray(data[k]) ? [] : k === 'users' || k === 'whitelist' ? {} : null));
      pending.add(k);
    }
    if (changes.job || changes.settings || changes.queue || changes.exec || changes.owner) await refreshState();
    if ((changes.me && !sameHandle(changes.me)) || changes.owner) refreshAccount();
    // 节流而不是防抖：变化一直不停时（比如读取列表中）也要定期刷新界面。
    if (renderTimer) return;
    renderTimer = setTimeout(() => {
      renderTimer = null;
      const has = (...keys) => keys.some((k) => pending.has(k));
      renderHeader();
      if (has('users', 'whitelist', 'settings')) renderUsers();
      if (has('collect')) renderCollect();
      if (has('job', 'queue', 'settings', 'exec')) renderJob();
      if (has('log')) renderLog();
      pending.clear();
    }, 150);
  });

  // ---------- 顶部 ----------
  function renderHeader() {
    $('ver').textContent = `v${chrome.runtime.getManifest().version}`;
    const live = account && account.live;
    const handle = (live && live.handle) || (data.me && data.me.handle);
    $('me').textContent = live && live.loggedOut
      ? 'x.com 没有登录'
      : handle ? `@${handle}` : '未检测到账号（打开 x.com 后会自动识别）';
    const status = (data.job && data.job.status) || 'idle';
    const pill = $('statusPill');
    pill.textContent = `取关：${STATUS[status] || status}`;
    pill.className = `pill ${status}`;
    const ex = $('execPill');
    const e = st && st.exec;
    if (e && e.mode === 'ui') {
      ex.textContent = '后台标签页模式';
      ex.className = 'pill exec-ui';
      ex.title = '在固定的小标签页里打开主页点按钮，可在「设置」里改回后台接口';
    } else if (e && e.apiBroken) {
      ex.textContent = '后台标签页模式（接口暂不可用）';
      ex.className = 'pill exec-warn';
      ex.title = `后台接口暂时用不了${e.apiError ? `（${e.apiError}）` : ''}，已自动改为在固定的小标签页里点按钮，${fmtTime(e.apiBrokenUntil)} 后自动再试接口`;
    } else {
      ex.textContent = '后台运行';
      ex.className = 'pill';
      ex.title = '取关在后台调用 X 网页版接口完成，不会弹出窗口';
    }
  }

  // x.com 上登录的账号和关注列表的主人不一致时提前提醒，取关前也会再核对一次。
  function renderAccountWarn() {
    const live = account && account.live;
    const owner = data.owner && data.owner.handle;
    let text = '';
    if (live && live.loggedOut) text = 'x.com 现在没有登录。取关和读取列表都需要先在 Chrome 里登录 x.com。';
    else if (live && live.handle && owner && live.handle.toLowerCase() !== owner.toLowerCase()) {
      text = `x.com 现在登录的是 @${live.handle}，但这里的关注列表是 @${owner} 的。取关前会自动核对，账号不对时会暂停；要整理 @${live.handle} 请重新读取关注列表。`;
    }
    for (const id of ['acctWarn', 'acctWarnJob']) {
      $(id).hidden = !text;
      $(id).textContent = text;
    }
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
      order: (a, b) => (a.seq || 1e9) - (b.seq || 1e9) || (a.firstSeen || 0) - (b.firstSeen || 0),
      orderRev: (a, b) => (b.seq || 0) - (a.seq || 0) || (b.firstSeen || 0) - (a.firstSeen || 0),
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
    $('onboard').hidden = total > 0;
    $('enqueueBtn').textContent = `${data.settings.autoStart ? '加入队列并开始取关' : '加入取关队列'}（${selected.size}）`;
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
  // 导出当前筛选结果（没有筛选就是全部），取关前留一份备份。
  $('exportUsers').onclick = () => {
    const list = filteredUsers();
    if (!list.length) { alert('没有可导出的人。'); return; }
    const head = ['用户名', '名字', 'ID', '粉丝', '关注', '推文', '回关', '标签', '白名单', '简介', '主页'];
    const rows = list.map((u) => [
      u.handle, u.name || '', u.id || '', u.followers ?? '', u.following ?? '', u.tweets ?? '',
      u.followsYou === true ? '是' : u.followsYou === false ? '否' : '',
      u.tags.map((t) => S.TAG_LABELS[t] || t).join(' '), data.whitelist[u.key] ? '是' : '',
      (u.bio || '').replace(/\s+/g, ' '), `https://x.com/${u.handle}`,
    ]);
    download(`x-following-${(data.owner && data.owner.handle) || 'me'}-${S.dayKey()}.csv`, `\ufeff${toCsv([head, ...rows])}`, 'text/csv');
  };

  $('enqueueBtn').onclick = () => act($('enqueueBtn'), async () => {
    if (!selected.size) throw new Error('先勾选要取关的人。');
    const keys = [...selected].map((k) => data.users[k] || k).map((u) => (typeof u === 'string' ? u : u.handle));
    const r = await send({ type: 'xa:enqueue', keys, action: 'unfollow' });
    selected.clear();
    renderUsers();
    flash($('userSummary'), `已加入 ${r.added} 人${r.skipped ? `，跳过白名单 ${r.skipped} 人` : ''}，队列共 ${r.total} 人。${enqueueNote(r)}`);
  });

  // 加入队列后告诉用户任务现在是什么状态、要不要再点什么。
  function enqueueNote(r) {
    if (r.started) return data.settings.dryRun ? '已自动开始演练（不会真的点击）。' : '已自动开始，会按设定的节奏执行。';
    if (r.startError) return `没能自动开始：${r.startError}`;
    const st = r.status;
    if (st === 'running' || st === 'awaiting_confirm') return '任务正在进行，会接着往下执行。';
    if (st === 'daily_cap') return '今天的额度已用完，明天会自动继续。';
    if (st === 'paused') return '任务目前是暂停状态，到「取关任务」点「继续取关」。';
    if (st === 'tripped') return '任务因为 X 的限制被暂停了，到「取关任务」查看。';
    return '到「取关任务」点「开始取关」。';
  }

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
    if (left >= 120) return `${Math.floor(left / 60)} 分 ${left % 60} 秒后`;
    return left > 0 ? `${left} 秒后` : '马上';
  }

  function etaText(job) {
    const n = data.queue.length;
    if (!n || !job || ['tripped', 'paused'].includes(job.status)) return '';
    const est = S.estimateFinish(job, n, data.settings, Date.now());
    if (!est) return '';
    if (data.settings.dryRun) return '';
    const at = new Date(est.at);
    const hm = at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const idle = job.status === 'idle' ? '开始后' : '';
    if (est.days === 0) return `${idle}预计今天 ${hm} 左右处理完队列里的 ${n} 人。`;
    return `${idle}按每天最多 ${cap} 个的节奏，队列里的 ${n} 人预计 ${at.toLocaleDateString()} ${hm} 左右处理完（还要 ${est.days} 天）。`;
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
    // 进行中的提示（比如页面没响应、稍后自动重试）不是错误，用普通提示的颜色。
    err.className = job.status === 'running' ? 'banner' : 'banner err';
    err.textContent = job.lastError ? `${job.lastError}${job.status === 'tripped' && job.pausedUntil ? `。建议 ${fmtTime(job.pausedUntil)} 之后再继续。` : ''}` : '';

    const btns = [];
    if (['idle', 'paused'].includes(job.status)) {
      btns.push(`<button class="btn primary" data-do="start" ${data.queue.length ? '' : 'disabled'}>${job.status === 'paused' ? '继续取关' : '开始取关'}</button>`);
    }
    if (job.status === 'awaiting_confirm') btns.push(`<button class="btn primary" data-do="confirm">确认执行这一批（${job.batch.length} 个）</button>`);
    if (['running', 'awaiting_confirm', 'daily_cap'].includes(job.status)) btns.push('<button class="btn" data-do="pause">暂停</button>');
    if (job.status === 'tripped') {
      if (Date.now() >= (job.pausedUntil || 0)) btns.push('<button class="btn primary" data-do="resume">继续取关</button>');
      else btns.push('<button class="btn danger" data-do="force">仍然继续（不建议）</button>');
    }

    $('etaLine').textContent = etaText(job);
    const e = st && st.exec;
    let execText = '';
    if (e && e.mode === 'ui') execText = '执行方式：在固定的小标签页里打开主页点按钮（可在「设置」里改回后台接口）。';
    else if (e && e.apiBroken) execText = `执行方式：后台接口暂时用不了${e.apiError ? `（${e.apiError}）` : ''}，已自动改为在固定的小标签页里点按钮，${fmtTime(e.apiBrokenUntil)} 后自动再试接口。`;
    else execText = '执行方式：后台调用 X 网页版接口，不弹窗口。你开着 x.com 时借用那个页面；没开时会在标签栏最左边放一个固定的小标签页，批次休息时自动关掉。';
    $('execLine').textContent = execText;
    if (e && e.apiBroken && e.mode !== 'ui') btns.push('<button class="btn" data-do="resetExec">重新尝试后台接口</button>');
    $('jobButtons').innerHTML = btns.join('');

    const p = s.pace;
    $('paceSummary').textContent = `当前节奏：每次间隔 ${p.minDelaySec}–${p.maxDelaySec} 秒，每批 ${p.batchSize} 个，批间休息 ${p.restMinMin}–${p.restMaxMin} 分钟，每天最多 ${cap} 个。${s.confirmEachBatch ? '每批开始前需要你确认。' : '批次之间自动接着执行，不需要确认。'}${s.dryRun ? '演练模式只跑一批，队列保持不变。' : ''}`;

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
      if (what === 'resume') await send({ type: 'xa:resume' });
      if (what === 'resetExec') { await send({ type: 'xa:resetExec' }); await refreshState(); renderJob(); renderHeader(); }
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

  let trippedWaiting = false;
  setInterval(() => {
    if (data.job && ['running', 'daily_cap'].includes(data.job.status)) $('jobNext').textContent = nextText(data.job);
    // 熔断冷却时间到了，把「仍然继续」换成普通的「继续取关」。
    const waiting = !!(data.job && data.job.status === 'tripped' && Date.now() < (data.job.pausedUntil || 0));
    if (trippedWaiting && !waiting) renderJob();
    trippedWaiting = waiting;
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
  const SKIP = new Set(['already', 'gone', 'mismatch', 'interrupted']);
  // 日志会滚动删掉最旧的记录，所以选择要用不会变的键，不能用数组下标。
  const logId = (l) => `${l.t}|${l.key}|${l.action}`;
  function filteredLog() {
    const f = $('logFilter').value;
    let list = data.log.map((l) => ({ ...l, id: logId(l) })).reverse();
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
      return `<tr data-id="${esc(l.id)}"><td>${canRefollow ? `<input type="checkbox" class="lsel" ${logSelected.has(l.id) ? 'checked' : ''}>` : ''}</td>
        <td class="small">${esc(fmtTime(l.t))}</td>
        <td><a href="https://x.com/${esc(l.handle)}" target="_blank" rel="noopener">@${esc(l.handle)}</a></td>
        <td>${l.action === 'follow' ? '重新关注' : '取关'}${l.dryRun ? '（演练）' : ''}</td>
        <td class="${cls}" title="${esc(l.detail || '')}">${esc(l.label || l.result)}</td><td class="n">${l.batchNo || ''}</td></tr>`;
    }).join('');
  }
  $('logFilter').onchange = renderLog;
  $('logRows').addEventListener('change', (e) => {
    if (!e.target.classList.contains('lsel')) return;
    const id = e.target.closest('tr').dataset.id;
    if (e.target.checked) logSelected.add(id); else logSelected.delete(id);
  });
  $('logAll').addEventListener('change', (e) => {
    filteredLog().slice(0, 500).filter((l) => l.result === 'ok' && l.action === 'unfollow')
      .forEach((l) => (e.target.checked ? logSelected.add(l.id) : logSelected.delete(l.id)));
    renderLog();
  });
  $('refollowBtn').onclick = () => act($('refollowBtn'), async () => {
    const keys = data.log.filter((l) => logSelected.has(logId(l))).map((l) => ({ handle: l.handle, id: l.id || null, name: l.name || '' }));
    if (!keys.length) throw new Error('先勾选成功取关的记录。');
    const r = await send({ type: 'xa:enqueue', keys, action: 'follow', front: true });
    logSelected.clear();
    renderLog();
    alert(`已把 ${r.added} 个重新关注加到队列最前面，会按同样的节奏执行。${enqueueNote(r)}`);
  });
  $('exportCsv').onclick = () => {
    const head = ['时间', '用户名', '名字', '动作', '结果', '说明', '批次', '演练'];
    const rows = data.log.map((l) => [fmtTime(l.t), l.handle, l.name || '', l.action, l.label || l.result, l.detail || '', l.batchNo || '', l.dryRun ? '是' : '']);
    download(`x-assistant-log-${S.dayKey()}.csv`, `\ufeff${toCsv([head, ...rows])}`, 'text/csv');
  };
  $('clearLog').onclick = async () => {
    if (!confirm('清空所有日志？清空后就不能从日志里重新关注了。')) return;
    logSelected.clear();
    await chrome.storage.local.set({ log: [] });
  };

  // 以 = + - @ 开头的单元格在表格软件里会被当成公式，前面加个单引号。
  function toCsv(rows) {
    const cell = (c) => {
      let v = String(c == null ? '' : c);
      if (/^[=+\-@]/.test(v)) v = `'${v}`;
      return `"${v.replace(/"/g, '""')}"`;
    };
    return rows.map((r) => r.map(cell).join(',')).join('\r\n');
  }

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
    $('autoStart').checked = !!s.autoStart;
    $('dryRun').checked = !!s.dryRun;
    $('execMode').value = s.execMode;
    $('keepAwake').checked = !!s.keepAwake;
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
      autoStart: $('autoStart').checked,
      dryRun: $('dryRun').checked,
      execMode: $('execMode').value,
      keepAwake: $('keepAwake').checked,
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
    refreshAccount();
    window.addEventListener('focus', () => refreshAccount());
    const tab = location.hash.replace('#', '');
    if (tab && $(`tab-${tab}`)) showTab(tab);
  })();
})();
