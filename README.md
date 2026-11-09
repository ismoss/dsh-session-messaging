<div align="center">

<img src="icon.svg" width="88" alt="">

# dsh-session-messaging

**让会话之间互相发消息** —— 一个会话可以找到另一个会话、给它发消息，或者新开一个会话交代任务；对方用同样的方式回复。

<img src="https://img.shields.io/badge/DeepSeek_Harness-社区插件-4d6bfe?style=flat-square" alt="DeepSeek Harness 社区插件">
<img src="https://img.shields.io/badge/DSH-0.2.0%2B-4d6bfe?style=flat-square" alt="支持 DSH 0.2.0+">
<img src="https://img.shields.io/badge/新增工具-4_个-4d6bfe?style=flat-square" alt="新增 4 个工具">
<img src="https://img.shields.io/badge/license-MIT-555?style=flat-square" alt="MIT 许可证">

**中文** · [English](README.en.md)

[功能](#功能) · [安装](#安装) · [用法](#用法) · [设置](#设置) · [工作原理](#工作原理) · [已知限制](#已知限制)

</div>

<br>

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 社区插件。DSH 自带的消息通道都要求双方有关系：`send_message` 只在直接父子 agent 之间传递，Agent Teams 只在同一个 Team 的成员之间传递，侧栏里两个普通会话之间没有路。装上本插件后，每个顶层会话多了四个工具：找会话、发消息、开新会话，以及查任务看板。收到的消息会标明来自哪个会话，对方可以用同一个工具回复。

> 本仓库是 [tonyzdev/dsh-session-messaging](https://github.com/tonyzdev/dsh-session-messaging) 的 fork：在上游基础上加了「任务合同」——单写者锁、唤醒自动带已完成、每轮回执。不想用合同就照旧只传 `session_id` + `message`，行为和上游一致。

<p align="center">
  <img src="docs/demo.gif" width="932" alt="会话「整理发布说明」让 agent 去问会话「修复登录超时」；对方收到一条标着「来自会话「整理发布说明」」的消息，用同一个工具回复，回复回到原会话">
</p>

<p align="center"><sub>「整理发布说明」里的 agent 用 <code>session_list</code> 找到「修复登录超时」，用 <code>session_send_message</code> 发出问题。对方被唤醒并回复，回复又唤醒了原会话。</sub></p>

## 功能

- 🔎 **找会话** — `session_list` 按最近活跃列出可以发消息的会话：id、运行中 / 空闲、标题。默认只看当前工作区，也可以列出全部工作区或按标题搜索。
- ✉️ **发消息** — `session_send_message` 把消息送到另一个会话：正在运行的会话在下一步读到，空闲的会话立即开始新一轮，已存储（未加载）的会话先恢复再处理。
- 🆕 **开新会话** — `session_create` 在侧栏新开一个带标题的会话，用你的消息开始第一轮。新会话独立干活，看不到发起方的对话；消息里让它回报，它就会回报。
- 🏷️ **标明来源** — 收到的消息显示为用户侧气泡，上方写着「来自会话「标题」」。模型看到的是一行来源说明：哪个会话、由对方的 agent 而不是用户撰写、怎么回复。
- 🔁 **不会互相客套** — 来源说明提醒对方不要只为确认收到而回复，两个会话不会来回说「收到」「好的」停不下来。
- 🛡️ **有边界** — 不能发给自己、子 agent 会话或已归档的会话；单条消息上限 64 KB；每个会话每次运行最多开 10 个新会话；子 agent 看不到这四个工具。
- 📒 **任务合同**（本 fork 新增）— 带 `task_id` 发消息时记一笔只追加的账：同一个任务同时只有一个写者、每次唤醒自动带上「已完成」、每一轮用 `status` 回报收尾。看板写到 `board.md`，`session_tasks` 随时查。

## 安装

**需要**：DeepSeek Harness `0.2.0+`（已在 macOS 版 `0.2.1-rc.5` 上实测）。插件本身不调用模型，不需要额外的 API key。

### 方式一：发一句话让 DSH 自己安装（推荐）

把下面这句话直接复制发给任意 DSH 会话，agent 会自动识别桌面端或网页端完成安装并热加载：

```text
请帮我在当前 DSH profile 安装插件 https://github.com/tonyzdev/dsh-session-messaging：若有 plugin_manager 工具请直接调用 install_bundle 安装并启用；否则读取当前 profile 名（bash 为 $DSH_PROFILE，PowerShell 为 $env:DSH_PROFILE；为 desktop 时调用 app.asar 同级 runtime/cli/bin 下的 dsh 或 dsh.cmd，其他情况用 PATH 中的 dsh，受沙箱限制时申请全盘权限审批）执行 dsh plugin --profile <profile> add github:tonyzdev/dsh-session-messaging，不要手改配置文件或重启宿主。
```

### 方式二：在「插件」页手动安装

在 Harness 侧栏打开 **插件 → 添加插件**，填入下面的仓库地址，点击 **安装** 后再点 **立即启用** 即可使用（若聊天里的转发气泡样式尚未出现，按 `⌘R` / `Ctrl+R` 刷新页面）：

```text
https://github.com/tonyzdev/dsh-session-messaging
```

> [!IMPORTANT]
> 安装时请填入上面的完整 GitHub 仓库地址，**不要**输入不带前缀的 `dsh-session-messaging`（npm 上同名无前缀包由其他作者维护；本插件安装后的包名为 `@tonyzdev/dsh-session-messaging`）。

<details>
<summary><b>用命令行安装、离线包安装或移除</b></summary>

<br>

**网页端（`dsh web`）**：

```sh
dsh plugin --profile web add github:tonyzdev/dsh-session-messaging
```

**桌面端（DSH Desktop，支持在应用运行时首次热装）**：

macOS：

```sh
DSH="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"
"$DSH" plugin --profile desktop add github:tonyzdev/dsh-session-messaging
```

Windows（PowerShell）：

```powershell
& "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop add github:tonyzdev/dsh-session-messaging
```

> 注意：在装有 DSH Desktop 的电脑上如果运行 `--profile web`，插件只会装进 `profiles/web`，不会出现在桌面端界面里；桌面端请使用上面的内置 CLI 指向 `--profile desktop`，或直接在界面「插件 → 添加插件」中安装。

**预打包 Release `.tgz` 直装（无需拉取完整 Git 仓库）**：

```sh
dsh plugin --profile web add https://github.com/tonyzdev/dsh-session-messaging/releases/download/v0.3.2/tonyzdev-dsh-session-messaging-0.3.2.tgz
```

**本地开发（以链接方式安装，改代码直接作用于该副本）**：

```sh
git clone https://github.com/tonyzdev/dsh-session-messaging ~/.dsh/local-plugins/dsh-session-messaging
"$DSH" plugin --profile desktop add link:$HOME/.dsh/local-plugins/dsh-session-messaging
```

**移除**：在「插件」页卸载，或运行：

```sh
"$DSH" plugin --profile desktop remove @tonyzdev/dsh-session-messaging
```

</details>

## 用法

不用记工具名，直接告诉 agent 要做什么：

> 问问「修复登录超时」那个会话：bug 修好了吗？改了什么？
>
> 告诉「前端重构」那个会话：接口字段 `user_id` 改名为 `uid` 了。
>
> 开一个新会话，让它把这条修复写进 CHANGELOG.md，写完告诉我。

<p align="center">
  <img src="docs/create.gif" width="932" alt="会话「整理发布说明」用 session_create 新开会话「写 CHANGELOG 登录超时修复」；新会话写好 CHANGELOG.md 后回报「已写入」，原会话收到结果">
  <br>
  <sub>新开的会话出现在侧栏，带着任务开工；写完后用 <code>session_send_message</code> 回报，原会话收到结果。</sub>
</p>

| 工具 | 参数 | 作用 |
| --- | --- | --- |
| `session_list` | `query?` `all_workspaces?` `limit?` | 按最近活跃列出可以发消息的顶层会话；持有任务的会话会多一列 `task` |
| `session_send_message` | `session_id` `message` `delivery?` `task_id?` `this_round?` `already_done?` `status?` `done?` `note?` `task_title?` `force?` | 发消息；带 `task_id` 就是一次派活（带上下文、拿锁），带 `status` 就是一次回执 |
| `session_create` | `title` `message` `workspace?` `task_id?` `this_round?` `already_done?` `note?` `force?` | 新开会话并用消息开始第一轮；带 `task_id` 时新会话直接成为该任务的写者 |
| `session_tasks` | `task_id?` `limit?` | 任务看板：谁在干、第几轮、已完成、本次只做 |

工具只返回送达确认，不返回对方的回答；回答会作为一条新消息回到发送方会话。

## 任务合同（本 fork 新增）

上游插件解决「消息怎么送到」；这个 fork 多解决三件真跑工作流时一定会踩的事：

| 合同 | 没有它会发生什么 | 实现 |
| --- | --- | --- |
| **单写者** | 两个会话同时改一个项目，互相覆盖 | 一条任务同一时间只允许一个会话持有；第二个会话来接会被拒绝，并告诉它现在谁在干。确实要换人（原来那个卡死了）才传 `force: true`，账上记一条 takeover |
| **已做过什么** | 每次唤醒都要重新交代上下文，或者对方把做完的事又做一遍 | 账本只追加，每次派活自动折叠出「已完成」写进消息头部；发送方只需要说「本次只做」什么 |
| **回执契约** | 会话干完就不吭声，你不知道它停在哪 | 消息里直接写明收尾格式：结论写进最后一条回复，同时用 `session_send_message` + `status` 回报；要你拍板就 `status: "blocked"` |

### 一次典型的派活

```text
session_send_message({
  session_id: "会话 B",
  task_id: "login-refactor",
  note: 3,
  this_round: ["把登录页接到 AuthService", "补 AuthService 的单测"],
  message: "按本次只做里的两条做，做完回报。"
})
```

会话 B 收到的消息前面会多一段（`already_done` 没传时，这段历史从账本里来）：

```text
【任务 login-refactor · 第 2 轮 · 进行中】
项目：重构登录
便签：#3

已完成：
- 拆出 AuthService
- 现有调用点全部改完

本次只做：
- 把登录页接到 AuthService
- 补 AuthService 的单测

回执契约（这一轮收尾时必须照做）：
1. 结论写在最后一条回复里，不要只说「收到」。
2. 同时调用 session_send_message：session_id="会话 A", task_id="login-refactor", status="done", done=[这一轮真正做完的事]。
3. 需要我拍板时 status="blocked"，在结论里写清有哪几个选项；不要自己往下做。
4. 只做「本次只做」里的事；范围外的问题写进结论，不要顺手改。
```

干完它回报：

```text
session_send_message({
  session_id: "会话 A",
  task_id: "login-refactor",
  status: "done",
  done: ["登录页已接上", "补了 3 个单测"],
  message: "接好了，单测 12 条全过。"
})
```

这条消息同时是「结果」和「账」：锁释放，下一轮谁来接都能在头部看到这两条已完成。

### 看板

`session_tasks` 列出所有任务；账本目录里还会渲染一份人看的 `board.md`：

| 任务 | 状态 | 持有会话 | 轮次 | 最近活动 |
| --- | --- | --- | --- | --- |
| `login-refactor` | 进行中 | `…`（重构登录） | 2 | 2026-11-09 11:40 |

账本默认在 `$DSH_HOME/session-tasks/`（即 `~/.dsh/session-tasks`）：一个任务一份 JSONL，只追加、不重写；`board.md` 每次派活后重渲染，可以直接用 Typora 打开，也能进同步盘。

### 和便签怎么配合

便签记「这个项目现在到哪一步」，账本记「这个任务谁在干、干过什么」。两边的编号用 `note` 参数对齐：派活时传 `note: 3`，任务头部就写「便签：#3」，从便签翻到任务、从任务翻回便签都不用猜。

> [!NOTE]
> 合同是**软约束**：它靠消息头部的指令要求对方按格式收尾。对方也是模型，绝大多数时候会照做；但它真不回报时插件没法替你追问——`session_tasks` 里会显示「第 N 轮、没有回执」，那就是你该去看一眼的信号。

**重复派活保护：** 同一句「本次只做」在 `dupWindowMinutes`（默认 30 分钟）内又发给同一个会话，会被当作误重发拦下，避免把同一件事跑两遍；确实要再喊一次就传 `force: true`。

## 设置

| 字段 | 默认值 | 说明 |
| --- | :---: | --- |
| `crossWorkspace` | `true` | 是否允许列出其他工作区的会话、给它们发消息、在其他工作区新开会话；`false` 只限当前工作区 |
| `maxMessageBytes` | `65536` | 单条消息的大小上限，包括来源说明和任务上下文 |
| `listLimit` | `20` | `session_list` 默认返回的条数，最多 100 |
| `createLimit` | `10` | 一个会话在一次运行内最多新开的会话数 |
| `taskDir` | `$DSH_HOME/session-tasks` | 任务账本目录；也认 `DSH_SESSION_TASKS_DIR` 环境变量 |
| `dupWindowMinutes` | `30` | 同一句「本次只做」在这么多分钟内重发给同一个会话算重发；`0` 关闭 |

> [!TIP]
> 要改的话，在 profile 的补丁文件（桌面版是 `~/.dsh/profiles/desktop/cordis.patch.yml`）里加一行，只写要改的字段，没写的用默认值：
>
> ```yaml
> - id: session-messaging
>   config:
>     crossWorkspace: false
> ```
>
> 保存后生效；如果没有生效，重启 DeepSeek Harness。

## 工作原理

```mermaid
sequenceDiagram
    participant A as 会话 A
    participant P as 本插件
    participant B as 会话 B
    A->>P: session_send_message(B, 问题)
    P->>B: 转发消息，标明来自会话 A
    Note over B: 运行中：下一步读到<br/>空闲：开始新一轮<br/>已存储：先恢复
    B->>P: session_send_message(A, 回复)
    P->>A: 转发消息，标明来自会话 B
```

<p align="center"><sub>转发的消息写进对方的会话日志；模型看到来源说明，界面显示带来源标注的气泡。</sub></p>

| 文件 | 位置 | 作用 |
| --- | :---: | --- |
| `lib/index.js` | Host | 四个工具、消息转发、任务上下文注入、对子 agent 隐藏工具 |
| `lib/tasks.js` | Host | 任务账本：事件折叠、单写者规则、重复派活保护、`board.md` 渲染 |
| `lib/client.js` | 浏览器 | 把转发的消息画成用户侧气泡，并标注来源会话 |
| `cordis.patch.yml` | 补丁 | 插件行和默认配置 |
| `locale/*.json`、`icon.svg` | 元数据 | 「插件」页显示的名称、描述和图标 |

<details>
<summary><b>实现细节</b></summary>

<br>

- 发消息走 `sessionController.resolveAgent`，与网页端发送 prompt 是同一条路径，必要时从存储冷恢复会话。消息带 DSH 内置的转发来源 `{ kind: 'agent-message', form: 'relay', senderSessionId }`，写进对方的会话日志。
- 开新会话走 `sessionController.create({ workspaceId })`，也就是网页端「新对话」的路径；在第一轮开始前先改好标题，因为转发的消息不会触发 DSH 的自动起标题。
- 两者都在 `withoutInitiator` 里执行：对方是独立的顶层会话，不算发送方这一轮发起的子任务。
- 来源说明以空行结尾，因为相邻的文本块到模型那里会直接拼接在一起。
- 子 agent 在 `agent/created` 时通过 `agent.ctx.tools.restrict({ deny })` 隐藏这四个工具：它们无法通过这条通道收到回复。
- 浏览器端覆盖 Chat 的 `turn-trigger` 渲染器，只接管本插件转发的消息，复用 DSH 自带的 `conversation.chat.user.content` 气泡；目标、定时任务、子 agent 等其他触发消息仍用 DSH 自带的卡片。只改显示，模型收到的内容不变。

</details>

## 已知限制

> [!CAUTION]
> **被唤醒或新开的会话按它自己的设置运行。** 新开的会话使用默认模型和默认审批策略（实测为 `ask`），不继承发起会话的设置。它如果需要审批，审批请求会停在那个会话里，可能没人在看。

- 只在顶层会话之间通信；子 agent 和 Team 成员仍用 DSH 自带的 `send_message`。
- 账本是**本机的**：放进同步盘可以，但两台机器同时写会各写各的；从命令行 headless 起的会话不经过本插件，也就不受单写者约束。
- 合同是软约束：对方不按格式回报时，插件不会替你追问，只在 `session_tasks` 里显示「第 N 轮、没有回执」。
- 「送达」只代表对方的收件箱接受了消息，不代表已经处理；没有重试、去重或已读回执。
- 对方正在运行时收到的消息会并入它这一轮，模型能收到，但不会显示成气泡。只有唤醒会话的消息显示为气泡。
- 气泡里不渲染 Markdown，也不折叠很长的消息。
- 发消息没有频率限制，防止来回客套靠的是来源说明里的提示。`createLimit` 存在内存里，插件重新加载或重启后清零，也不限制「A 开 B、B 再开 C」这样的链条。
- `session_create` 设的标题像手动改名一样被固定，DSH 之后不会再自动改标题。

## 开发

```sh
node --test test/*.test.js
```

测试用模拟的 Harness 上下文覆盖投递、开新会话、各种拒绝路径、列表过滤、对子 agent 隐藏工具，以及浏览器端能否解析 Host 写出的来源说明（两边改动不同步会在这里失败）。

> [!NOTE]
> 修改 `lib/index.js` 后，在「插件」页把本插件关掉再打开即可加载新代码，不用重启；修改 `lib/client.js` 后需要重新安装并刷新页面。
