(function () {
  'use strict';
  const send = window.XAPanel.send;
  const $ = (id) => document.getElementById(id);
  const STATUS = { idle: '空闲', running: '进行中', awaiting_confirm: '待确认', paused: '已暂停', tripped: '已熔断', daily_cap: '今日已满' };

  function open(hash) {
    chrome.tabs.create({ url: chrome.runtime.getURL(`src/options/options.html#${hash}`) });
    window.close();
  }

  async function render() {
    const st = await send({ type: 'xa:state' });
    const { users } = await chrome.storage.local.get('users');
    $('me').textContent = st.me && st.me.handle ? `@${st.me.handle}` : '还没识别到账号，打开 x.com 即可';
    $('status').textContent = STATUS[st.job.status] || st.job.status;
    $('today').textContent = `${st.job.doneToday} / ${st.cap}`;
    $('queue').textContent = st.queueLength;
    $('users').textContent = Object.keys(users || {}).length;
    $('err').hidden = !st.job.lastError;
    $('err').textContent = st.job.lastError || '';
    const btns = ['<button class="primary" data-go="users">打开管理页</button>'];
    if (st.job.status === 'running' || st.job.status === 'awaiting_confirm') btns.push('<button data-do="pause">暂停取关</button>');
    if (st.job.status === 'awaiting_confirm') btns.push('<button data-go="job">去确认下一批</button>');
    if (st.job.status === 'paused' && st.queueLength) btns.push('<button data-do="start">继续取关</button>');
    btns.push('<button data-go="check">粘贴体检</button>');
    $('actions').innerHTML = btns.join('');
  }

  $('actions').addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.go) return open(b.dataset.go);
    try {
      await send({ type: `xa:${b.dataset.do}` });
    } catch (err) {
      $('err').hidden = false;
      $('err').textContent = err.message;
    }
    render();
  });

  render().catch((e) => { $('err').hidden = false; $('err').textContent = e.message; });
})();
