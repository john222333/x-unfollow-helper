# 隐私政策 · Privacy Policy

最后更新 / Last updated: 2026-10-22

[English below](#english)

## 中文

X 取关助手（以下称「本插件」）是一个开源的 Chrome 插件，帮你整理自己在 x.com 上的关注列表，并在侧边栏汇总 AI / Web3 热点、帮你写推文草稿。本插件没有自己的服务器，开发者收不到你的任何数据。

### 本插件处理哪些数据

| 数据 | 用途 | 保存在哪里 |
| --- | --- | --- |
| 你关注的账号的公开资料：用户名、显示名、简介、头像地址、粉丝数、关注数、推文数、是否回关你、账号 ID | 在管理页里列出、筛选，执行取关 | 只在你的浏览器里（`chrome.storage.local`） |
| 每个关注对象最近一次发帖的时间（你点「检查多久没发推」时在插件的小标签页里打开对方主页读取；你在 x.com 首页、列表或别人主页上看到的帖子也会顺带记下作者的发帖时间。只记时间，不保存推文内容） | 按「多久没发推」筛选 | 只在你的浏览器里 |
| 你的 x.com 用户名 | 核对执行取关时登录的是不是关注列表的主人 | 只在你的浏览器里 |
| 取关队列、白名单、操作日志、设置 | 按节奏执行任务、撤销、显示进度 | 只在你的浏览器里 |
| X 网页版的接口参数（GraphQL 的 queryId 和 features，以及网页版公开的应用令牌） | X 更新网页版后仍能读取关注列表 | 只在你的浏览器里 |
| x.com 的登录 cookie（`ct0`、`twid`） | 在 x.com 页面里发请求时，像网页版一样带上防伪令牌、识别当前账号 | **不保存**，只在发请求的那一刻在页面里读取 |
| 热点功能：你登记的 X 列表里的公开推文，以及你在 x.com 首页刷到的、和 AI / Web3 有关的公开推文（作者用户名、正文、互动数、发布时间） | 计算热度、生成话题 | 只在你的浏览器里，最多保留 3 天、1500 条；和 AI / Web3 无关的推文不保存 |
| 热点功能：X 趋势榜上的趋势词和帖子数（你打开 x.com 首页或探索页时，从页面已经加载的数据里记下） | 计算热度 | 只在你的浏览器里，只留最近 6 小时 |
| 热点功能：从公开新闻源读到的标题、链接和摘要 | 计算热度、生成话题 | 只在你的浏览器里 |
| 你填写的模型 API key | 生成推文草稿时调用你选的模型服务商 | 只在你的浏览器里，不放进设置，导出数据时也不包含 |

### 本插件连接哪些服务器

取关功能只连接 X 自己的服务器：

- `x.com`：读取关注列表、取关、重新关注、确认当前账号。这些请求从你已打开（或插件临时打开）的 x.com 页面里发出，和你在页面上手动操作时网页版发出的请求一样。
- `abs.twimg.com`：下载 X 网页版公开的 JavaScript 文件，只用来查找读取关注列表需要的接口参数，不会执行其中的代码。
- `pbs.twimg.com`：管理页显示头像时由浏览器加载。

热点功能（可以在设置里关闭）会额外连接下面这些网站。它们都是可选权限：只有你在设置里点「保存」并在浏览器弹出的对话框里同意后，插件才能访问。

- 公开数据源，只读取公开内容，不发送你的任何数据：`hn.algolia.com`（Hacker News）、`huggingface.co`（每日论文、热门模型榜）、`www.reddit.com`（几个 AI / 加密社区的热门帖子）、`api.github.com`（新项目）、`api.coingecko.com`（热搜币），以及你在设置里填写的 RSS 地址（默认 `cointelegraph.com`、`decrypt.co`）。
- 你自己选的模型服务商（例如 `api.anthropic.com`、`api.openai.com`、`api.deepseek.com` 或你填写的地址）：只在你点「写推文」「引用」或「测试连接」时，把话题标题、相关的公开推文和新闻摘要、你填写的账号定位，连同你的 API key 直接发给这个服务商。服务商如何处理这些内容，以它自己的隐私政策为准。

除此之外本插件不连接其他任何服务器，不使用任何统计、分析或广告服务，不加载远程代码。

### 我们不做的事

- 不收集、不上传、不出售、不分享你的任何数据。
- 不读取你的私信、浏览记录或其他网站的数据。热点功能只看你在 x.com 首页和列表里本来就能看到的公开推文。
- 不替你发推、点赞或转发。草稿只会填进 X 的发推框，由你自己决定是否发布。
- 不保存你的密码或登录 cookie。

### 删除数据

- 管理页 → 设置 → 数据 → **清空关注列表缓存**，删除读取到的关注列表。
- 管理页 → 设置 → **删除保存的 key**，删除模型 API key。
- 关闭热点功能后插件不再收集热点数据；旧数据会在 3 天内自然过期，卸载时全部删除。
- 卸载本插件会删除它保存的全部数据。

### 联系

有问题请在本项目的 GitHub 仓库提交 Issue。

---

## English

Unfollow Helper for X ("the extension") is an open-source Chrome extension that helps you manage the accounts you follow on x.com, and shows AI / Web3 trending topics with post drafts in a side panel. The extension has no server of its own; the developers never receive any of your data.

### What data the extension handles

| Data | Purpose | Where it is stored |
| --- | --- | --- |
| Public profile data of accounts you follow: handle, display name, bio, avatar URL, follower/following/post counts, whether they follow you, account ID | Listing, filtering and unfollowing in the dashboard | Only in your browser (`chrome.storage.local`) |
| The time of each followed account's most recent post (read by opening their profile in the extension's small pinned tab when you click "Check last post time", and noted from posts you see on your x.com Home, lists or profiles; time only, no post content) | Filtering by how long since they last posted | Only in your browser |
| Your x.com handle | Checking that the logged-in account owns the list before acting | Only in your browser |
| Unfollow queue, whitelist, action log, settings | Pacing the job, undo, progress | Only in your browser |
| X web app request parameters (GraphQL queryId and features, and the web app's public app token) | Keep reading the Following list working after X updates its web app | Only in your browser |
| x.com login cookies (`ct0`, `twid`) | Sent with requests made from inside an x.com page, exactly like the X web app does, and used to identify the current account | **Never stored**; read in the page only at the moment of a request |
| Trends: public posts from X lists you register, and AI/Web3-related public posts you see on your x.com home timeline (author handle, text, engagement counts, time) | Scoring and grouping trending topics | Only in your browser, at most 3 days / 1,500 posts; unrelated posts are not kept |
| Trends: X trending topics and post counts (recorded from data the x.com home or Explore page already loaded) | Scoring trending topics | Only in your browser, last 6 hours only |
| Trends: titles, links and summaries from public news sources | Scoring and grouping trending topics | Only in your browser |
| The model API key you enter | Calling the model provider you chose to draft posts | Only in your browser; kept out of settings and data exports |

### Which servers the extension contacts

Unfollowing only contacts X's own servers:

- `x.com`: reading your Following list, unfollowing, re-following, and checking the current account. These requests are sent from an x.com page you have open (or one the extension opens temporarily), the same way the X web app sends them.
- `abs.twimg.com`: downloading X's public web app JavaScript, only to find the request parameters needed to read the Following list. The code is never executed.
- `pbs.twimg.com`: avatar images loaded by the browser in the dashboard.

The trends feature (can be turned off in Settings) also contacts the sites below. They are optional permissions: the extension can reach them only after you click Save in Settings and approve the browser's permission prompt.

- Public data sources, read-only, no data of yours is sent: `hn.algolia.com` (Hacker News), `huggingface.co` (daily papers, trending models), `www.reddit.com` (hot posts in a few AI / crypto communities), `api.github.com` (new projects), `api.coingecko.com` (trending coins), and the RSS feeds you configure (by default `cointelegraph.com` and `decrypt.co`).
- The model provider you choose (for example `api.anthropic.com`, `api.openai.com`, `api.deepseek.com`, or an address you enter): only when you click Draft, Quote or Test connection, the topic title, related public posts and article summaries, and the account description you wrote are sent directly to that provider together with your API key. The provider's own privacy policy applies to that content.

Otherwise the extension contacts no other server, uses no analytics, tracking or advertising services, and loads no remote code.

### What we never do

- Collect, upload, sell or share any of your data.
- Read your direct messages, browsing history, or data from other websites. The trends feature only looks at public posts you can already see on your x.com home timeline and lists.
- Post, like or repost on your behalf. Drafts are only placed in X's compose box; you decide whether to publish.
- Store your password or login cookies.

### Deleting your data

- Dashboard → Settings → Data → **Clear cached following list**.
- Dashboard → Settings → **Delete saved key** removes the model API key.
- With the trends feature off, no new trend data is collected; old data expires within 3 days and is deleted on uninstall.
- Uninstalling the extension deletes everything it stored.

### Contact

Please open an issue in this project's GitHub repository.
