# X 取关助手 · Unfollow Helper for X

一个 Chrome 插件（Manifest V3），帮你在已经登录的 x.com 上整理关注列表：读取你关注的人，按「不回关」「默认头像」「零推文」「疑似机器人」等标签筛选，然后在后台按慢速、分批的节奏取关。不弹窗口，批次之间不用再确认，遇到 X 的限制提示自动停下。

另外附带一个**热点侧边栏**：汇总正在升温的 AI 和 Web3 话题，用你自己的模型 API key 一键生成推文草稿，填进 X 的发推框后由你自己决定发不发。

[English](#english) · [隐私政策](PRIVACY.md) · [更新记录](CHANGELOG.md) · [参与开发](CONTRIBUTING.md)

> 本插件不是 X 官方产品，与 X Corp. 没有任何关系。批量取关属于 X 规则限制的自动化行为，即使按默认节奏也可能被限制或锁号，请自行判断并承担风险。

## 功能

- **读取关注列表**：在后台读取，几千人的列表一般几分钟读完；被 X 限制读取频率时自动等待后接着读。可以导出 CSV 备份。
- **筛选**：标签（不回关、默认头像、零推文、受保护、已认证、疑似机器人、粉丝少、取关未生效）、关键词、粉丝数，多种排序。
- **白名单**：点 ☆ 加入白名单的人永远不会被取关。
- **后台分批取关**：加入队列后自动开始，随机间隔、分批休息、每天上限；电脑休眠醒来后接着跑。
- **自动保护**：X 提示操作频繁、登录失效、账号被锁、出现人机验证时立刻停下，24 小时内不再继续。
- **可撤销**：日志里勾选取关过的人，一键重新关注。
- **重新读取会同步**：已经不再关注的人会从列表里移除；日志显示取关成功、X 上却还在关注的人会标成「取关未生效」，可以一键重新取关。
- **AI / Web3 热点（侧边栏）**：来源包括你登记的 X 列表（按点赞、转发、浏览的增速算热度）、你在 x.com 首页刷到的相关推文、Hacker News、Hugging Face 每日论文、GitHub 新项目、CoinGecko 热搜和 RSS 新闻源。讲同一件事的推文和新闻会合并成一个话题，按热度排序。
- **推文草稿**：每个话题一键生成观点、科普、轻松三种风格的草稿，也可以针对某条热门推文写引用。支持 Claude、OpenAI、DeepSeek 和兼容 OpenAI 接口的其他模型，key 只存在本地。插件不会替你发推。

## 安装

### 从 Chrome 应用商店安装

上架审核中，通过后会在这里放链接。

### 从源码安装（开发者模式）

1. 下载本仓库（或 Releases 里的 zip）并解压。
2. Chrome 地址栏打开 `chrome://extensions`，打开右上角的 **开发者模式**。
3. 点 **加载已解压的扩展程序**，选择能看到 `manifest.json` 的那一层文件夹。
4. 点浏览器右上角的拼图图标，把「X 取关助手」固定到工具栏。安装后会自动打开管理页。

更新时覆盖文件，再在 `chrome://extensions` 里点插件卡片上的刷新按钮即可，已经打开的 x.com 页面会自动换上新脚本。

## 使用

1. 确认 Chrome 里已经登录 x.com，管理页 → **关注管理** → **读取关注列表**。
2. （建议）点 **导出 CSV** 留一份关注列表备份。
3. （可选）**设置** → 勾选 **演练模式** → 保存。演练只检查登录状态和执行通道是否正常，不真的取关，只跑一批，队列保持不变。
4. 用标签和关键词筛选，勾选要取关的人 → **加入队列并开始取关**。任务在后台自动执行，不用再点「开始」。
5. **取关任务** 页显示进度、预计完成时间和当前的执行方式。建议第一次先用一小批（比如 5 个）试，再按默认节奏慢慢来。
6. 过一段时间再点一次 **读取关注列表**，列表会和 X 上同步。

### 热点与推文建议

1. **设置** → **推文草稿用的模型**：选服务商，填 API key，点 **保存并测试连接**。浏览器会问一次是否允许访问这个服务商的网站。
2. （建议）在 X 上建两个列表，分别放你认可的 AI 博主和 Web3 博主，把列表链接贴到 **热点与推文建议** 里，点 **保存设置**（浏览器会问一次是否允许访问勾选的新闻源）。
3. 点工具栏的插件图标 → **热点与推文**，或者设置页的 **打开热点侧边栏**。侧边栏打开时数据超过 30 分钟会自动刷新；读取 X 列表需要你开着一个已登录的 x.com 页面。
4. 在话题卡片上点 **写推文**，或在某条推文旁点 **引用**。改好后点 **去发推**，插件在新标签页打开 X 的发推框并填好内容，发不发由你决定。

## 后台运行是怎么做到的

取关、重新关注、读取关注列表都不会弹出窗口：

1. 你开着任意一个 x.com 页面时，插件借用那个页面，在里面调用 X 网页版自己的接口（和你在页面上点「取消关注」时浏览器发出的请求一样），页面本身不会有变化。
2. 你没开 x.com 时，插件会在标签栏最左边放一个固定的小标签页来做这件事，批次休息、暂停或完成时自动关掉。手动关掉它任务会暂停，点「继续取关」即可恢复。
3. X 改了接口导致后台接口用不了时，自动改为在这个后台标签页里打开对方主页点按钮，24 小时后再试一次接口。也可以在 **设置 → 执行方式** 里固定用这种方式。
4. 只有后台读取关注列表也失败时，才会打开一个读取窗口滚动列表（这种方式需要窗口可见）。

每次取关前都会核对 x.com 上登录的账号是不是关注列表的主人，不一致就暂停，不会在别的账号上操作。

## 默认节奏与保护

| 参数 | 默认 | 可调范围 |
| --- | --- | --- |
| 每次取关间隔 | 8–20 秒随机 | 最低 5 秒 |
| 每批人数 | 15 | 5–30 |
| 批次间休息 | 15–30 分钟随机 | 最低 10 分钟 |
| 每天上限 | 100 | 最高 200；「新号模式」下 30 |
| 加入队列后自动开始 | 开启 | 可关闭 |
| 每批开始前手动确认 | 关闭 | 可开启 |

出现以下情况会立即 **熔断**（停止并通知你，建议 24 小时后再继续）：X 返回操作频繁或限额已满、登录失效、账号被临时锁定、出现人机验证、连续两次点了按钮但状态没变。

插件自己这边的问题不会熔断：x.com 页面没有响应、加载超时时，那个人会放回队尾稍后再试；连续 3 次就等 15 分钟再继续，连续 9 次才暂停等你看一眼。操作途中电脑休眠被打断的不算失败，醒来后重做。

任务进行中插件会阻止电脑自动休眠（屏幕照常会关；合上笔记本盖子仍会休眠，醒来后接着跑）。不需要的话可以在 **设置** 里关掉。

## 隐私

所有数据只保存在你自己的浏览器里。取关功能只连接 X 自己的服务器（x.com、存放网页代码的 abs.twimg.com、显示头像用的 pbs.twimg.com）。热点功能会读取你勾选的公开新闻源，生成草稿时把话题资料直接发给你自己选的模型服务商；这些网站都要你在设置里授权后才会访问。插件不收集任何统计数据，没有自己的服务器。详见 [隐私政策](PRIVACY.md)。

## 已知限制

- 界面目前只有中文。
- X 改了网页版接口时，后台接口可能失效，插件会自动换成点按钮的方式；接口相关代码集中在 `src/lib/xapi.js`。
- X 改版后按钮的 `data-testid` 可能变化，点按钮的方式会失败（会熔断而不是乱点）；选择器集中在 `src/content/x-dom.js`。
- 还不能按「多久没发推」筛选：关注列表的数据里没有最后发推时间。
- X 的关注列表偶尔有延迟，刚取关的人可能还会出现一阵子，这时会标成「取关未生效」，重新取关一次即可确认。
- 热度是估算：X 上的部分来自你登记的列表和你刷到的首页，覆盖不到整个 X；外部来源的接口变了时对应来源会在侧边栏里提示读取失败，其他来源照常。
- 草稿质量取决于你选的模型。模型可能写错细节，发之前请自己核对。

## 开发

不需要构建，改完直接在 `chrome://extensions` 刷新。

```
manifest.json
_locales/                插件名称和简介（中文、英文）
src/background.js        后台：执行环境、取关调度、限速熔断、关注列表读取与合并
src/lib/xapi.js          X 网页版接口：请求构造和结果判断
src/lib/store.js         默认设置、节奏上下限、标签
src/lib/trends.js        热点：各来源解析、热度打分、话题归并
src/lib/llm.js           推文草稿：模型请求、返回值解析、提示词
src/trends-bg.js         后台：刷新热点、旁听到的推文、生成草稿
src/panel/               热点侧边栏
src/lib/msg.js           页面与后台之间的消息
src/content/page-hook.js 页面环境：记下网页版的接口参数，旁听关注列表数据（兜底读取用）
src/content/x-dom.js     x.com 的选择器、读取和点击（备用方式，X 改版时改这里）
src/content/content.js   内容脚本：在页面里替后台调用接口
src/options/             管理页
src/popup/               工具栏弹窗
tests/                   单元测试与端到端测试（模拟的 x.com）
docs/store-listing.md    Chrome 应用商店上架材料
```

```bash
npm test             # 单元测试（Node 18+）
npm install          # 安装 Playwright，端到端测试需要
npm run test:e2e     # 加载插件，在模拟的 x.com 上跑完整流程
npm run zip          # 打包上架用的 zip（只包含插件运行需要的文件）
```

## 致谢

- [XActions](https://github.com/nirholas/XActions)（Apache-2.0）：取关节奏与熔断思路参考，未复制代码。

## 许可证

[MIT](LICENSE)

---

## English

**Unfollow Helper for X** is a Chrome extension (Manifest V3) that helps you clean up who you follow on x.com. It reads your Following list, lets you filter it (doesn't follow back, default avatar, no posts, likely bot, few followers, and more), and unfollows the accounts you pick slowly, in batches, in the background.

> Not affiliated with X Corp. Bulk unfollowing is automation that X's rules restrict. Even at the default pace your account may be limited or locked. Use at your own risk.

- **No pop-up windows.** Requests are sent from inside an x.com tab you already have open, the same way the X web app does it. If none is open, a small pinned background tab is used and closed when idle.
- **Safe pacing.** Random 8–20 s delays, batches of 15 with 15–30 min rests, 100 per day by default. Rate-limit, login, lock or captcha signals stop everything for 24 hours.
- **Account check.** Nothing happens if the logged-in account isn't the owner of the list.
- **Undo.** Re-follow anyone from the log.
- **Re-reading syncs the list.** Accounts you no longer follow are removed. Accounts the log says were unfollowed but X still lists are tagged so you can retry them.
- **AI / Web3 trends side panel.** Collects rising topics from X lists you register, AI/Web3 posts you scroll past on your home timeline, Hacker News, Hugging Face daily papers, new GitHub projects, CoinGecko trending and RSS feeds, merges posts and articles about the same story, and drafts posts with your own model API key (Claude, OpenAI, DeepSeek or any OpenAI-compatible endpoint). Drafts open in X's compose box; the extension never posts for you.
- **Private.** Everything stays in your browser. Unfollowing only talks to X's own servers (x.com, abs.twimg.com, and pbs.twimg.com for avatars). The trends panel reads the public sources you enable and sends topic material to the model provider you choose, only after you grant access. No server of its own, no analytics. See [PRIVACY.md](PRIVACY.md).

The UI is currently Chinese only. Install from source: open `chrome://extensions`, turn on Developer mode, click **Load unpacked**, and select the folder containing `manifest.json`.

License: MIT.
