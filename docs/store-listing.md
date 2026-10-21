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

- 中文：X 取关助手：分批慢速取关
- English: Unfollow Helper for X

**简短说明**（最多 132 个字符，来自 `_locales` 的 extDescription，不用手填）

**类别**：社交（Social Networking）

**语言**：中文（简体）为默认语言，另有英文名称和简介。

### 详细说明（中文）

```
整理你在 X（原 Twitter）上的关注列表：找出不回关、默认头像、零推文、疑似机器人的账号，选好后在后台按慢速、分批的节奏自动取关。

主要功能
• 读取关注列表：在后台读取，不弹窗口，可以导出 CSV 备份
• 标签筛选：不回关、默认头像、零推文、受保护、已认证、疑似机器人、粉丝少，加上关键词和粉丝数筛选
• 白名单：加入白名单的人永远不会被取关
• 后台分批取关：随机间隔、分批休息、每天上限，加入队列后自动开始
• 自动保护：X 提示操作频繁、登录失效、账号被锁或出现人机验证时立刻停下
• 账号核对：登录的账号不是列表的主人时不会动手
• 可撤销：在日志里一键重新关注
• 重新读取会同步：已经不再关注的人自动移出列表，取关没生效的人会标出来

隐私
所有数据只保存在你的浏览器里。插件只连接 X 自己的服务器，没有自己的服务器，不收集任何统计数据。代码开源。

说明
本插件不是 X 官方产品，与 X Corp. 没有关系。批量取关属于 X 规则限制的自动化行为，即使按默认节奏也可能被限制，请自行判断。
```

### Detailed description (English)

```
Clean up who you follow on X (formerly Twitter). Find accounts that don't follow you back, have a default avatar, never post, or look like bots, then unfollow the ones you pick slowly, in batches, in the background.

Features
• Read your Following list in the background, no pop-up windows; export to CSV
• Filter by tags (doesn't follow back, default avatar, no posts, protected, verified, likely bot, few followers), keywords and follower count
• Whitelist accounts you never want to unfollow
• Background batch unfollowing with random delays, rests between batches and a daily cap; starts automatically
• Automatic safety stop when X reports rate limits, login problems, a locked account or a captcha
• Account check: does nothing if the logged-in account doesn't own the list
• Undo: re-follow anyone from the log
• Re-reading syncs the list: accounts you no longer follow are removed, and unfollows that didn't take effect are flagged

Privacy
Everything stays in your browser. The extension only talks to X's own servers, has no server of its own and collects no analytics. Open source.

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
| 小宣传图 | `docs/store/promo-small-440x280.png` | 440×280 |

截图用的是模拟的 x.com 和虚构账号，重新生成：`node tests/e2e/store-shots.js`。

## 隐私（Privacy practices）

**单一用途说明（Single purpose）**

```
帮助用户管理自己在 x.com 上的关注列表：读取、筛选，并按用户选择分批取消关注（以及撤销时重新关注）。
Helps users manage the accounts they follow on x.com: read and filter their Following list, and unfollow (or re-follow) the accounts they choose, in slow batches.
```

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
| 网站权限 `https://abs.twimg.com/*` | 下载 X 网页版公开的 JavaScript 文件（只读取文本，不执行），找到读取关注列表需要的接口参数。Downloads X's public web app JavaScript as text (never executed) to find the request parameters needed to read the Following list. |

**是否使用远程代码（Remote code）**：否（No）。所有代码都打包在插件里。

**数据使用（Data usage）**

建议勾选：

- **网站内容（Website content）**：从 x.com 读取的关注列表（对方的公开资料），只保存在本地。
- **个人身份信息（Personally identifiable information）**：用户自己的 x.com 用户名，用来核对账号，只保存在本地。

然后勾选三项承诺：不出售或转让给第三方；不用于与单一用途无关的目的；不用于判断信用或放贷。

**隐私政策网址**：仓库建好后填 `https://github.com/<用户名>/<仓库名>/blob/main/PRIVACY.md`。

## 分发

- 公开范围：公开（Public），或者先选「不公开（Unlisted）」只给有链接的人用。
- 地区：所有地区。

## 审核风险

- **X 的规则**：X 的自动化规则不允许批量取关。应用商店允许这类管理工具（商店里已有不少同类插件），但如果 X 投诉，插件可能被下架。说明里已经写明非官方、风险自担。
- **商标**：名称用「for X / X 取关助手」这种描述性写法，图标没有用 X 的标志，符合商店对第三方品牌的要求。
- **权限最少化**：已经去掉推文体检和它需要的其他网站权限；如果审核要求解释某个权限，用上面的说明。
- **界面语言**：目前只有中文界面，英文用户可能看不懂。后续可以把界面文字也放进 `_locales` 做成双语。
