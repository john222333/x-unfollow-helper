# X 助手：分批取关 + 推文体检

一个 Chrome 插件（Manifest V3），在你已经登录的 x.com 上做两件事：

- **分批取关**：读取你的关注列表，按「不回关」「默认头像」「零推文」「疑似机器人」等标签筛选，加入队列后按慢速、分批、每批确认的节奏自动取关，遇到 X 的限制提示自动停下。
- **推文体检**：在发推框和每条推文下面加一个「体检」按钮，给出 **AI 味**（0–100，越低越像人写的）和 **算法友好度**（按 X 开源排序代码里的互动权重推算），列出逐句修改建议，并能生成 3 个改写版本一键替换。

> 本插件不是 X 官方产品。自动取关不符合 X 的自动化规则，即使按默认节奏也可能被限制或锁号，请自行判断并承担风险。

## 安装（本地测试）

1. 把整个 `x-assistant` 文件夹放到电脑上（不要只放里面的某个子文件夹）。
2. Chrome 地址栏打开 `chrome://extensions`，打开右上角的 **开发者模式**。
3. 点 **加载已解压的扩展程序**，选择 `x-assistant` 文件夹（里面能看到 `manifest.json` 的那一层）。
4. 点浏览器右上角的拼图图标，把「X 助手」固定到工具栏。安装后会自动打开管理页。

改了代码以后，在 `chrome://extensions` 里点插件卡片上的刷新按钮，再刷新 x.com 页面即可。

## 第一次使用建议

1. 管理页 → **设置** → 勾选 **演练模式** → 保存。演练模式会打开每个人的主页、找到关注按钮，但不点击。
2. 确认 Chrome 里已经登录 x.com，回到 **关注管理** → **读取关注列表**。会弹出一个小窗口自动慢速滚动，几千人的列表需要几分钟到十几分钟，期间不要关闭或最小化它。
3. 用标签和关键词筛选，勾选要取关的人 → **加入取关队列**。不想动的人点 ☆ 加入白名单，白名单里的人永远不会被取关。
4. **取关任务** → **开始取关**，在 **日志** 里看结果。
5. 演练没问题后关闭演练模式，先用一小批（比如 5 个）试真实取关，再按默认节奏慢慢来。

## 默认节奏与保护

| 参数 | 默认 | 可调范围 |
| --- | --- | --- |
| 每次取关间隔 | 8–20 秒随机 | 最低 5 秒 |
| 每批人数 | 15 | 5–30 |
| 批次间休息 | 15–30 分钟随机 | 最低 10 分钟 |
| 每天上限 | 100 | 最高 200；「新号模式」下 30 |
| 每批确认 | 开启 | 可关闭 |

出现以下情况会立即 **熔断**（停止并通知你，建议 24 小时后再继续）：X 提示操作频繁或无法取关、跳到登录页、账号被临时锁定、出现人机验证、连续两次点击后状态没变化。

取关成功的记录可以在 **日志** 里勾选后 **重新关注**，同样按节奏执行。

## 配置 LLM（推文体检）

不配置也能用：本地规则会离线算出 AI 味并给出建议。配置后可以得到逐句评审、算法推算和改写。

管理页 → 设置 → LLM，可以用「常用预设」快速填写：

| 服务 | 接口地址 | 模型示例 |
| --- | --- | --- |
| Claude（默认） | `https://api.anthropic.com` | `claude-opus-5-5` |
| DeepSeek | `https://api.deepseek.com` | `deepseek-chat` |
| 通义千问 | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen-plus` |
| 本机 Ollama | `http://localhost:11434/v1` | `qwen2.5:7b` |

填好 API Key 后点 **测试连接**，再点 **保存设置**。第一次保存自定义地址时 Chrome 会询问是否允许访问该网站。同一条推文的体检结果会缓存，重复体检不会重复计费。

## 算法友好度是怎么算的

X 开源的排序代码（[xai-org/x-algorithm](https://github.com/xai-org/x-algorithm)，`home-mixer/params/param.rs`）里，一条帖子的排序分是「模型预测的各种互动概率 × 权重」之和，例如复制链接分享 +20、回复 +5、引用 +5、喜欢 +0.6、不感兴趣 −47.52、举报 −234。

插件拿不到 X 的模型，所以让 LLM 估计你这条推文引发各种互动的概率，再乘以同一套权重，和一条「普通推文」的基线比较：持平是 50 分，越高越好。它适合比较同一条推文改写前后哪个版本更好，**不代表真实曝光**。权重在 `src/lib/algo.js` 里，X 更新时可以同步修改。

## 隐私

- 所有数据（关注列表、日志、设置、API Key）只保存在本机浏览器里。
- 插件不读取你的密码或 cookie，也不调用 x.com 的接口；读取关注列表时只「旁听」页面自己加载的数据，取关是在页面上点按钮。
- 只有你主动体检的推文文本会发送给你配置的 LLM 服务。

## 已知限制

- X 改版后按钮的 `data-testid` 可能变化，取关或读取会失败（会熔断而不是乱点）。选择器集中在 `src/content/x-dom.js`。
- 还不能按「多久没发推」筛选：关注列表的数据里没有最后发推时间，要逐个打开主页才能拿到，留到下一版。
- 统计型 AI 检测器（Fast-DetectGPT、Binoculars）需要 GPU 后端，没有集成。

## 开发

不需要构建，改完直接在 `chrome://extensions` 刷新。

```
manifest.json
src/background.js        后台：取关调度、限速熔断、关注列表合并、LLM 调用
src/content/page-hook.js 页面环境：旁听关注列表接口的返回数据
src/content/x-dom.js     x.com 的选择器、读取和点击（X 改版时改这里）
src/content/content.js   内容脚本：响应后台指令，注入「体检」按钮
src/lib/rules.js         本地 AI 味规则
src/lib/algo.js          x-algorithm 权重与算法友好度推算
src/lib/llm.js           Claude / OpenAI 兼容接口
src/lib/panel.js         体检报告面板
src/lib/store.js         默认设置、节奏上下限、标签
src/options/             管理页
src/popup/               工具栏弹窗
tests/                   单元测试与端到端测试
```

```bash
npm test          # 单元测试（只需要 Node 18+）
npm run test:e2e  # 端到端测试：加载插件，用模拟的 x.com 页面和模拟的 LLM 跑完整流程（需要 Playwright）
```

## 参考与致谢

- [xai-org/x-algorithm](https://github.com/xai-org/x-algorithm)（Apache-2.0）：互动权重数值。
- 维基百科 [Signs of AI writing](https://en.wikipedia.org/wiki/Wikipedia:Signs_of_AI_writing) 与 [humanizer](https://github.com/blader/humanizer)（MIT）：AI 写作特征的归纳思路，本项目的规则和中文部分为自行编写。
- [XActions](https://github.com/nirholas/XActions)（Apache-2.0）：取关节奏与熔断思路参考，未复制代码。

## 许可证

MIT
