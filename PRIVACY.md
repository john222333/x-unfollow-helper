# 隐私政策 · Privacy Policy

最后更新 / Last updated: 2026-10-21

[English below](#english)

## 中文

X 取关助手（以下称「本插件」）是一个开源的 Chrome 插件，帮你整理自己在 x.com 上的关注列表。本插件没有自己的服务器，开发者收不到你的任何数据。

### 本插件处理哪些数据

| 数据 | 用途 | 保存在哪里 |
| --- | --- | --- |
| 你关注的账号的公开资料：用户名、显示名、简介、头像地址、粉丝数、关注数、推文数、是否回关你、账号 ID | 在管理页里列出、筛选，执行取关 | 只在你的浏览器里（`chrome.storage.local`） |
| 你的 x.com 用户名 | 核对执行取关时登录的是不是关注列表的主人 | 只在你的浏览器里 |
| 取关队列、白名单、操作日志、设置 | 按节奏执行任务、撤销、显示进度 | 只在你的浏览器里 |
| X 网页版的接口参数（GraphQL 的 queryId 和 features，以及网页版公开的应用令牌） | X 更新网页版后仍能读取关注列表 | 只在你的浏览器里 |
| x.com 的登录 cookie（`ct0`、`twid`） | 在 x.com 页面里发请求时，像网页版一样带上防伪令牌、识别当前账号 | **不保存**，只在发请求的那一刻在页面里读取 |

### 本插件连接哪些服务器

只连接 X 自己的服务器：

- `x.com`：读取关注列表、取关、重新关注、确认当前账号。这些请求从你已打开（或插件临时打开）的 x.com 页面里发出，和你在页面上手动操作时网页版发出的请求一样。
- `abs.twimg.com`：下载 X 网页版公开的 JavaScript 文件，只用来查找读取关注列表需要的接口参数，不会执行其中的代码。
- `pbs.twimg.com`：管理页显示头像时由浏览器加载。

本插件不连接其他任何服务器，不使用任何统计、分析或广告服务，不加载远程代码。

### 我们不做的事

- 不收集、不上传、不出售、不分享你的任何数据。
- 不读取你的私信、推文内容、浏览记录或其他网站的数据。
- 不保存你的密码或登录 cookie。

### 删除数据

- 管理页 → 设置 → 数据 → **清空关注列表缓存**，删除读取到的关注列表。
- 卸载本插件会删除它保存的全部数据。

### 联系

有问题请在本项目的 GitHub 仓库提交 Issue。

---

## English

Unfollow Helper for X ("the extension") is an open-source Chrome extension that helps you manage the accounts you follow on x.com. The extension has no server of its own; the developers never receive any of your data.

### What data the extension handles

| Data | Purpose | Where it is stored |
| --- | --- | --- |
| Public profile data of accounts you follow: handle, display name, bio, avatar URL, follower/following/post counts, whether they follow you, account ID | Listing, filtering and unfollowing in the dashboard | Only in your browser (`chrome.storage.local`) |
| Your x.com handle | Checking that the logged-in account owns the list before acting | Only in your browser |
| Unfollow queue, whitelist, action log, settings | Pacing the job, undo, progress | Only in your browser |
| X web app request parameters (GraphQL queryId and features, and the web app's public app token) | Keep reading the Following list working after X updates its web app | Only in your browser |
| x.com login cookies (`ct0`, `twid`) | Sent with requests made from inside an x.com page, exactly like the X web app does, and used to identify the current account | **Never stored**; read in the page only at the moment of a request |

### Which servers the extension contacts

Only X's own servers:

- `x.com`: reading your Following list, unfollowing, re-following, and checking the current account. These requests are sent from an x.com page you have open (or one the extension opens temporarily), the same way the X web app sends them.
- `abs.twimg.com`: downloading X's public web app JavaScript, only to find the request parameters needed to read the Following list. The code is never executed.
- `pbs.twimg.com`: avatar images loaded by the browser in the dashboard.

The extension contacts no other server, uses no analytics, tracking or advertising services, and loads no remote code.

### What we never do

- Collect, upload, sell or share any of your data.
- Read your direct messages, post content, browsing history, or data from other websites.
- Store your password or login cookies.

### Deleting your data

- Dashboard → Settings → Data → **Clear cached following list**.
- Uninstalling the extension deletes everything it stored.

### Contact

Please open an issue in this project's GitHub repository.
