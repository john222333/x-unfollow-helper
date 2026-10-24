# Chrome 应用商店上架材料

上架时在 [Chrome Web Store 开发者后台](https://chrome.google.com/webstore/devconsole) 照着填。中文和英文各准备了一份，商店里可以分语言填写。

## 上架步骤

1. 注册开发者账号：用 Google 账号登录开发者后台，付一次性的 5 美元注册费，按提示开启两步验证。
2. 打包：在仓库根目录运行 `npm run zip`，得到 `x-unfollow-helper.zip`（只包含插件运行需要的文件）。
3. 后台点 **新建项目** → 上传 zip。
4. 按下面的内容填写「商店详情」「隐私」「分发」三页。
5. 截图和宣传图在 `docs/store/`，直接上传。
6. 提交审核。申请了 `scripting` 和网站访问权限的插件一般会进入人工审核，通常几天到两三周。
7. 以后发新版本：改 `manifest.json` 和 `package.json` 的版本号 → `npm run zip` → 后台上传新包 → 提交。

微软 Edge 加载项商店（免费注册）可以用同一个 zip 上架，内容照抄即可。

## 商店详情

**名称**（来自 `_locales`，不用手填）

- 中文：X 取关助手：分批取关 + 热点推文
- English: Unfollow Helper for X

**简短说明**（最多 132 个字符，来自 `_locales` 的 extDescription，不用手填）

**类别**：社交（Social Networking）

**语言**：中文（简体）为默认语言，另有英文名称和简介。

### 详细说明（中文）

```
整理你在 X（原 Twitter）上的关注列表：找出不回关、默认头像、零推文、疑似机器人、几个月没发推的账号，选好后在后台按慢速、分批的节奏自动取关。

主要功能
• 读取关注列表：在后台读取，不弹窗口，可以导出 CSV 备份
• 标签筛选：不回关、默认头像、零推文、受保护、已认证、疑似机器人、粉丝少，加上关键词和粉丝数筛选
• 多久没发推：后台检查每个人最近一次发帖的时间，按超过 1 个月、3 个月、半年、1 年筛选
• 白名单：加入白名单的人永远不会被取关
• 后台分批取关：随机间隔、分批休息、每天上限，加入队列后自动开始
• 自动保护：X 提示操作频繁、登录失效、账号被锁或出现人机验证时立刻停下
• 账号核对：登录的账号不是列表的主人时不会动手
• 可撤销：在日志里一键重新关注
• 重新读取会同步：已经不再关注的人自动移出列表，取关没生效的人会标出来

AI / Web3 热点侧边栏
• 汇总 X 趋势榜、你登记的 X 列表、Hacker News、Reddit、Hugging Face 论文和热门模型、GitHub 新项目、CoinGecko 热搜和 RSS 新闻，按热度排序，并显示每个话题的上榜依据
• 讲同一件事的推文和新闻合并成一个话题
• 用你自己的模型 API key（Claude、OpenAI、DeepSeek 等）一键生成推文草稿，填进 X 的发推框，由你决定发不发；插件从不自动发推

隐私
所有数据只保存在你的浏览器里。取关只连接 X 自己的服务器；热点功能只在你授权后读取公开新闻源，并把话题资料直接发给你自己选的模型服务商。没有自己的服务器，不收集任何统计数据。代码开源。

说明
本插件不是 X 官方产品，与 X Corp. 没有关系。批量取关属于 X 规则限制的自动化行为，即使按默认节奏也可能被限制，请自行判断。
```

### Detailed description (English)

```
Clean up who you follow on X (formerly Twitter). Find accounts that don't follow you back, have a default avatar, never post, or look like bots, then unfollow the ones you pick slowly, in batches, in the background.

Features
• Read your Following list in the background, no pop-up windows; export to CSV
• Filter by tags (doesn't follow back, default avatar, no posts, protected, verified, likely bot, few followers), keywords and follower count
• Inactive accounts: checks when each account you follow last posted, then filter by 1, 3, 6 or 12+ months
• Whitelist accounts you never want to unfollow
• Background batch unfollowing with random delays, rests between batches and a daily cap; starts automatically
• Automatic safety stop when X reports rate limits, login problems, a locked account or a captcha
• Account check: does nothing if the logged-in account doesn't own the list
• Undo: re-follow anyone from the log
• Re-reading syncs the list: accounts you no longer follow are removed, and unfollows that didn't take effect are flagged

AI / Web3 trends side panel
• Rising topics from X trends, X lists you register, Reddit, Hacker News, Hugging Face papers, new GitHub projects, CoinGecko trending and RSS news, ranked by heat
• Posts and articles about the same story are merged into one topic
• Draft posts with your own model API key (Claude, OpenAI, DeepSeek and more). Drafts open in X's compose box; the extension never posts for you

Privacy
Everything stays in your browser. Unfollowing only talks to X's own servers; the trends panel reads public news sources and sends topic material to the model provider you choose, only after you grant access. No server of its own, no analytics. Open source.

Note
Not affiliated with X Corp. Bulk unfollowing is automation that X's rules restrict; even at the default pace your account may be limited. Use at your own risk. The interface is currently in Chinese.
```

### 图片

| 用途 | 文件 | 尺寸 |
| --- | --- | --- |
| 商店图标 | `icons/icon128.png` | 128×128 |
| 截图 1：关注管理与筛选 | `docs/store/screenshot-1-users.png` | 1280×800 |
| 截图 2：后台取关进行中 | `docs/store/screenshot-2-job.png` | 1280×800 |
| 截图 3：日志与撤销 | `docs/store/screenshot-3-log.png` | 1280×800 |
| 截图 4：节奏与保护设置 | `docs/store/screenshot-4-settings.png` | 1280×800 |
| 截图 5：热点侧边栏与推文草稿 | `docs/store/screenshot-5-trends.png` | 1280×800 |
| 小宣传图 | `docs/store/promo-small-440x280.png` | 440×280 |

截图用的是模拟的 x.com 和虚构账号，重新生成：`node tests/e2e/store-shots.js`。

## 隐私（Privacy practices）

**单一用途说明（Single purpose）**

```
帮助用户经营自己的 X（x.com）账号：整理关注列表（读取、筛选、按用户选择分批取关或重新关注），以及在侧边栏查看 AI / Web3 领域的热点话题并生成供用户自己发布的推文草稿。
Helps users manage their own X (x.com) account: clean up their Following list (read, filter, and unfollow or re-follow the accounts they choose, in slow batches), and see AI / Web3 trending topics in a side panel with post drafts the user can publish themselves.
```

> 两个功能放在一起，审核员可能按「单一用途」政策提出疑问。上面的说明把它们归到「经营自己的 X 账号」这一个用途下；如果被拒，可以把热点功能拆成独立插件再提交。

**权限说明（Permission justification）**

| 权限 | 说明（可直接粘贴） |
| --- | --- |
| `storage` | 在本地保存用户的关注列表、取关队列、白名单、日志和设置。Stores the user's Following list, queue, whitelist, log and settings locally. |
| `unlimitedStorage` | 关注列表可能有上万人，加上操作日志会超过默认的 10 MB 本地存储上限。A Following list can have tens of thousands of accounts, which together with the action log can exceed the default 10 MB local quota. |
| `alarms` | 按用户设定的间隔和批次休息时间调度下一次取关，在浏览器后台休眠后也能按时继续。Schedules the next action according to the user's pacing settings, surviving service worker shutdowns. |
| `notifications` | 任务完成、达到每日上限或因 X 的限制自动暂停时通知用户。Notifies the user when the queue finishes, the daily cap is reached, or the job pauses because of an X limit. |
| `scripting` | 插件安装或更新后，把内容脚本注入到已经打开的 x.com 页面，不用用户手动刷新。Injects the extension's own content scripts into already-open x.com tabs after install or update. |
| `power` | 任务进行中阻止电脑自动休眠（屏幕仍会关闭），避免任务被打断；用户可以在设置里关闭。Keeps the system awake while a job is running so it isn't interrupted; the user can turn this off. |
| 网站权限 `https://x.com/*` | 在 x.com 页面里读取关注列表、执行用户选择的取关，并核对登录的账号。Reads the Following list, performs the unfollows the user chose, and checks the logged-in account on x.com. |
| `sidePanel` | 在浏览器侧边栏显示 AI / Web3 热点和推文草稿，用户可以一边看 x.com 一边写。Shows the trends and post drafts in the browser side panel next to x.com. |
| 可选网站权限 `https://*/*`（只在用户点「保存」时按需申请具体网站） | 热点功能读取用户勾选的公开新闻源（Hacker News、Reddit、Hugging Face、GitHub、CoinGecko、用户填写的 RSS），以及调用用户自己选择、自己提供 key 的模型服务商生成草稿。每个网站都要用户在浏览器对话框里同意，不开热点功能就不会申请。Optional, requested per site only when the user saves settings: reads the public news sources the user enables and calls the model provider the user chose with their own API key. Each site requires the user's approval in the browser prompt. |
| 网站权限 `https://abs.twimg.com/*` | 下载 X 网页版公开的 JavaScript 文件（只读取文本，不执行），找到读取关注列表需要的接口参数。Downloads X's public web app JavaScript as text (never executed) to find the request parameters needed to read the Following list. |

**是否使用远程代码（Remote code）**：否（No）。所有代码都打包在插件里。

**数据使用（Data usage）**

建议勾选：

- **网站内容（Website content）**：从 x.com 读取的关注列表（对方的公开资料），以及用户点「检查多久没发推」时每个关注对象最近一次发帖的时间，只保存在本地。
- **个人身份信息（Personally identifiable information）**：用户自己的 x.com 用户名，用来核对账号，只保存在本地。
- **身份验证信息（Authentication information）**：用户填写的模型 API key，只保存在本地，只发送给用户自己选的模型服务商。
- 生成草稿时会把公开的话题资料发给用户自己选的模型服务商（用户主动点击才发送），在说明里如实写明。

然后勾选三项承诺：不出售或转让给第三方；不用于与单一用途无关的目的；不用于判断信用或放贷。

**隐私政策网址**：`https://github.com/john222333/x-unfollow-helper/blob/main/PRIVACY.md`。

## 分发

- 公开范围：公开（Public），或者先选「不公开（Unlisted）」只给有链接的人用。
- 地区：所有地区。

## 审核风险

- **X 的规则**：X 的自动化规则不允许批量取关。应用商店允许这类管理工具（商店里已有不少同类插件），但如果 X 投诉，插件可能被下架。说明里已经写明非官方、风险自担。
- **商标**：名称用「for X / X 取关助手」这种描述性写法，图标没有用 X 的标志，符合商店对第三方品牌的要求。
- **单一用途**：取关和热点推文是两个功能，可能被认为不符合单一用途。已经在单一用途说明里统一描述成「经营自己的 X 账号」，如果被拒，把热点功能拆成独立插件即可。
- **权限最少化**：其他网站都是可选权限，按需申请；如果审核要求解释某个权限，用上面的说明。
- **界面语言**：目前只有中文界面，英文用户可能看不懂。后续可以把界面文字也放进 `_locales` 做成双语。
