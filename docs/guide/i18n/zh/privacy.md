---
title: "遥测、诊断与本地隐私 — xMatrix 文档"
description: "哪些数据留在你本机、可选的本地额度探测和客户端诊断如何工作，以及如何随时关闭。"
---

# 遥测与本地隐私

xMatrix 由托管协作 Hub 与运行在你自己电脑上的 Rust 本地 daemon 组成。本页公开列出客户端与 daemon 的所有诊断上报与本地文件读取行为，以及关闭方式。

## 哪些数据留在你本机

你的源代码、Git 历史、工作目录、模型工具历史与本地模型凭据均留在你自己控制的电脑上。xMatrix 绝不将本机模型 API Key 或 OAuth token 上传至 Hub，也不会读取第三方凭证文件来做跨机器身份归因或指纹关联。

为保证同一台电脑在重装后仍稳定对应到你的账号下，本地 daemon 仅在本地将你的 xMatrix 用户 ID 与系统机器标识混合做 SHA-256 派生出按账号隔离的 `machineId`；原始硬件标识与未按账号隔离的机器指纹绝不上传至 Hub。

## 本地服务商额度探测

**一句话说明：** 为了显示你已注册的 AI 工具还剩多少额度，xMatrix daemon 会读取这些工具在你电脑上的登录文件（例如 `~/.grok/auth.json`），并直接向对应服务商查询。Codex、Claude Code 和 OpenCode 例外：xMatrix 直接询问工具本身，不打开它们的任何登录文件。Codex 通过正在运行的会话或短暂启动的 `codex app-server` 询问；Claude Code 通过正在运行的会话或短暂启动的 `claude` 询问（其 `get_usage` 请求，不发送任何提示词）；OpenCode 通过短暂启动的 `opencode serve` 询问。从这些文件读到的任何内容（令牌、账号 ID、文件内容或文件指纹）都不会发送给 xMatrix；Hub 只收到归一化后的额度结果。同一个开关可同时停止读取文件、向 Codex、Claude Code 和 OpenCode 发请求以及向服务商发请求（见下方「如何关闭本地额度探测」）。没有官方额度接口的工具（如 Cursor），在你于那台电脑上允许之前完全不会被读取（见下方「仅在你允许后才读取的工具」）。OpenCode 2.2.0 以前的版本没有官方额度接口，同样在你于该电脑上授权前完全不读取。

当你在本机注册了受支持的智能体工具（如 Claude Code、Codex、Cursor、Grok、OpenCode、DeepSeek、Z.ai、Antigravity）时，xMatrix 可在 `xmatrix agent list` 与 Agents 页面展示订阅剩余额度，并供 `@auto` 自动避开已用尽的账号。

为了在不消耗模型对话的前提下查询剩余额度，本地 daemon 会在内存中读取对应已注册工具的本地凭据并直连原厂接口：

| 工具 | 仅在本地内存读取的存储位置 | 由你本机直连的原厂接口 |
| --- | --- | --- |
| Claude Code | 不读取：调用 Claude Code 自己的 `get_usage` 控制请求（正在运行的会话或短暂启动的 `claude`），不发送提示词 | 由 Claude Code 使用其自身登录处理 |
| Codex | 不读取：调用 Codex 自己的 app-server 方法 `account/rateLimits/read`（正在运行的会话或短暂启动的 `codex app-server`） | 由 Codex 使用其自身登录处理 |
| Cursor（仅在你于那台电脑上允许后） | `CURSOR_API_KEY` / `CURSOR_AUTH_TOKEN`、macOS 钥匙串（`cursor-access-token`）或 Cursor `auth.json` | `https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage` |
| Grok Build | `GROK_CLI_OAUTH_TOKEN` 或 `~/.grok/auth.json` | `https://cli-chat-proxy.grok.com/v1/billing?format=credits` |
| OpenCode 2.2.0 及以上 | 不读取：向短暂启动的 `opencode serve` 请求 `GET /api/experimental/usage/limits`（仅监听本机回环地址，使用一次性密码）。OpenCode 路由到其他服务商的模型不读取任何额度 | 由 OpenCode 使用其自身登录处理 |
| OpenCode 2.2.0 以前（仅在你于该电脑上授权后） | `OPENCODE_API_KEY` 或 OpenCode `auth.json` 中的 `opencode-go` 条目 | `https://opencode.ai/zen/go/v1/usage` |
| DeepSeek | `DEEPSEEK_API_KEY` 或 `$DSH_HOME` 凭据文件 | `https://api.deepseek.com/user/balance` |
| Z.ai / 智谱 | `ZAI_API_KEY` / `ZHIPU_API_KEY` | `https://api.z.ai/api/monitor/usage/quota/limit`（或 `open.bigmodel.cn`） |
| Antigravity | 直接调用未改动的 `agy -p "/usage" --output-format json` | 由 `agy` 自行处理 |

**严格边界：**

- 凭据仅停留在本地进程内存中，**只发送给对应服务商自己的官方额度接口**。
- 本地计算的 SHA-256 指纹仅作为进程内缓存键用来感知账号切换，**永不写入日志，也永不上传至 xMatrix**。
- 上传给 xMatrix Hub 的只有归一化后的剩余额度信息（窗口百分比、重置时间、账号是否可用及预付余额）。

### 仅在你允许后才读取的工具

Cursor 没有官方的额度查询接口：唯一的办法是读取 Cursor 为自己保存的登录凭据。这份凭据是给 Cursor 用的，xMatrix 不把它当作授权。在电脑所有者允许之前，xMatrix 不会读取那台电脑上 Cursor 的任何登录来源（macOS 钥匙串项 `cursor-access-token`、Cursor 的 `auth.json`，以及环境中已设置的 `CURSOR_API_KEY` / `CURSOR_AUTH_TOKEN`），Cursor 的额度显示为**未知**；额度用尽仍会根据 Cursor 自己的报错识别。

电脑所有者可以在 Agents 或 Machines 视图显示 Cursor 额度的地方选择 **Allow reading Cursor sign-in to show quota**，或在那台电脑上运行：

```sh
xmatrix config quotaAccess cursor on    # 允许
xmatrix config quotaAccess cursor off   # 停止
xmatrix config quotaAccess              # 查看本机已允许的工具
```

- 授权按电脑、按工具分别设置，默认关闭，并且独立于额度探测开关：`quotaProbes` 开着不算授权。
- 凭据只在那台电脑上读取，只用于向 Cursor 查询它自己的用量。凭据中的任何内容都不会离开那台电脑；Hub 只收到 Cursor 返回的用量以及是否已授权。
- 授权绑定首次使用时登录的 Cursor 账号，依据一个只保存在那台电脑 xMatrix 配置中、从不发送的指纹。账号或凭据一旦变化，授权即失效，最近的额度数字也会被删除。
- 随时可以在同一位置、在 **Settings → Legal and privacy → Reading sign-ins for quota**，或用 `xmatrix config quotaAccess cursor off` 停止，下一次读取即被拒绝。
- 关闭本地额度探测（见下）优先于授权：即使已授权也什么都不读。

OpenCode 2.2.0 以前的版本同样没有官方额度接口，处理方式相同。未授权时，xMatrix 既不打开 OpenCode 的 `auth.json`，也不读取为它设置的 `OPENCODE_API_KEY`，不请求任何 OpenCode 端点，额度显示为 **Unknown**。授权后（**Allow reading OpenCode sign-in to show quota**，或 `xmatrix config quotaAccess opencode on`），xMatrix 只读取 OpenCode 为 OpenCode Go 保存的密钥，并只用于一次对 `https://opencode.ai/zen/go/v1/usage` 的请求。xMatrix 绝不代替 OpenCode 刷新已过期的登录：额度显示为未知并标注已过期，直到 OpenCode 重新登录。上面的账号绑定、撤回与总开关同样适用。从 OpenCode 2.2.0 起，xMatrix 询问 `opencode serve`，无论是否授权都不读取任何 OpenCode 凭据。

### 如何关闭本地额度探测

可在 **桌面 App → Settings → Legal and privacy → Local provider quota probes** 中关闭，或通过配置命令 / 环境变量在整台机器上关闭所有本地服务商额度探测：

```sh
# 持久化本机配置
xmatrix config quotaProbes off

# 或通过环境变量（优先级更高）
export XMATRIX_DISABLE_QUOTA_PROBES=1
```

如仅关闭 Antigravity 额度探测，可设 `XMATRIX_DISABLE_ANTIGRAVITY_QUOTA_PROBE=1`。关闭后，xMatrix 在预检、启动/重连与限额恢复等所有路径下均不再读取任何本地服务商凭据、启动 `codex app-server`、`claude` 或 `opencode serve`，询问 Codex 或 Claude Code 会话，也不查询原厂额度接口。

## 客户端诊断与崩溃报告

xMatrix 不使用广告 Cookie、跨站追踪、会话录屏，也不集成 PostHog、Google Analytics 或 Cloudflare Web Analytics 等第三方行为分析 SDK。

可选的客户端诊断与浏览器崩溃报告**在稳定版应用与 CLI 中默认关闭**；Beta 版的默认规则见下表。未登录的官网营销页、文档页与法律条款页绝不加载 Sentry。诊断开启时发送的内容：

- **错误与崩溃报告（Sentry）**：仅在已登录应用内生效，只发送错误的类型、错误自带的代码（如有）以及调用栈中的代码位置；错误消息、面包屑、URL、Cookie、HTTP 头、请求体与用户信息一律不发送。未配置 DSN 的本地或自托管构建不发送任何报告。（Hub 服务端自身故障仍在服务端上报以保障托管服务运行，见下文。）
- **第一方诊断指标（xMatrix Hub → Cloudflare Analytics Engine）**：发送启动耗时（`/api/observable/startup-timing`）、新手引导步骤计数（`/api/observable/onboarding-step`）、桌面端 daemon 启动失败原因（`/api/observable/desktop-daemon-failure`）与 CLI 网络重连样本（`/api/observable/client-metrics`）。标识符在服务端通过密钥 HMAC-SHA-256 假名化。

### 诊断事件可以包含什么

每个诊断事件都有一组声明好的字段，客户端生成时校验一次，Hub 接收时再校验一次。字段只能是列表中的固定值、数字、true/false、版本号、不透明标识符，或形如 `websocket_connect_failed` 的短代码（小写字母、数字、`_` 与 `-`）。只要出现未声明的字段或超出字段范围的值，整个事件就会被拒绝，而不是被截断成合规形状，因此你写下的文字没有任何字段可以夹带。错误只按类型和代码上报，绝不包含错误消息。

只有以下两条路径会携带文字：

- **桌面端启动失败卡片上的「发送失败报告」**：CLI 的最后几行输出，桌面应用会先在你的机器上脱敏（主目录、邮箱地址、URL 查询参数以及任何形似令牌或密钥的内容都会被替换）。卡片会先向你展示这些行，只有你点击按钮才会发送；诊断开启时自动发送的报告只包含失败阶段、退出码、平台与应用版本。
- **Hub 服务端错误报告**：服务端自身的错误消息，其中引用的值、邮箱地址、URL 查询参数、主目录路径与形似令牌的字符串都会被移除。日志附带的字段只有在是数字、true/false 或不透明标识符时才会上报。

### Beta 版与稳定版的默认行为

| | 稳定版应用与 CLI | Beta 版应用与 CLI |
| --- | --- | --- |
| 你已主动开启 | 发送 | 发送 |
| 你已主动关闭，或开启了 Do Not Track、Global Privacy Control，或设置 `XMATRIX_TELEMETRY=0` | 不发送 | 不发送 |
| 未作选择；注册地**与**当前所在国家都不在欧盟、欧洲经济区、英国和瑞士 | 不发送 | 发送，并显示一行附带关闭入口的提示 |
| 未作选择；任一国家在欧盟、欧洲经济区、英国或瑞士，或无法判断 | 不发送 | 不发送；显示一个未勾选的「Send diagnostics to help improve the beta」复选框 |

各行按顺序生效：主动开启即使在 Do Not Track 或 Global Privacy Control 打开时也会被尊重。只有勾选该复选框或在设置中切换开关（或 `xmatrix config telemetry on|off`）才算你的选择；关闭提示不算选择，xMatrix 也不会替你更改设置。

**如何判断地区。** 客户端自身没有可靠的位置信息（时区和语言都是用户设置），因此由 Hub 告诉它们：

- **注册地区。** 创建账号时，Hub 根据 Cloudflare 报告的该请求所在国家，记录它是否属于需要事先同意的国家。只保存这一类别，不保存国家或 IP 地址，之后的请求也不会改写它。较早创建的账号在第一次使用 Beta 版时记录。删除账号时一并删除。
- **当前地区。** 每次发送前，客户端使用 Hub 对当前连接给出的答复，且不超过 10 分钟；超过时会向 Hub 发一个不含任何诊断数据的小请求重新询问。若查询失败、超时或国家未知，则不发送。因此进入需要同意的国家后，默认发送最多 10 分钟内停止。

### 如何开启或关闭诊断与崩溃报告

- **Web、桌面端、iOS 与 Android**：前往 **Settings → Legal and privacy**，切换 **Send diagnostics and crash reports**。你的选择保存在账号上，所有客户端都会遵循。在桌面端中，该开关会同步更新内置本地 daemon 的 `telemetry` 配置。
- **桌面端启动失败卡片**：即便诊断开关处于关闭状态，若后台服务启动失败，你仍可在失败卡片上按需点击一次 **发送失败报告**，仅上报该次脱敏后的失败信息。
- **CLI 与 daemon**：执行 `xmatrix config telemetry on` 或设 `XMATRIX_TELEMETRY=1` 开启；通过 `xmatrix config telemetry off`、`XMATRIX_TELEMETRY=0` 或 `DO_NOT_TRACK=1` 关闭。`xmatrix config telemetry on|off` 也会把选择保存到账号。

## 把对话交给 xMatrix 支持

只有在你把对话交给支持时，xMatrix 的工作人员和 Agent 才会读你的对话。产品分析只用元数据，从不使用你写的内容。

需要帮助时，在对话菜单里、在 xMatrix 发出的故障通知上（启动失败、反复失败、几分钟没有进展），或在对话打开时从 **Help → Report an issue** 选择 **Hand to xMatrix support**。然后：

- 用一句话写下出了什么问题。
- 勾选要包含的内容。默认什么都不勾：
  - **This conversation's messages**，包括其中的子话题。
  - **Diagnostics for this conversation**：Agent 在这里何时启动、停止或失败，以及失败代码。这些是只含状态、代码、计数和时间的诊断事件：没有消息正文、提示词、错误信息或 ID。
  - **Daemon logs**：xMatrix 守护进程在你某台在线机器上最近写下的日志末尾。家目录路径、邮箱地址、网址的查询部分以及任何形似令牌或密钥的内容，都会在离开你的机器之前就在本机删除；发送之前，对话框会原样显示将要发送的内容。预览只有你本人可读，保留约一周；你一撤回交接，已发送的日志就会被删除。
- 勾选 **I agree to let xMatrix support read what I selected**。不勾选就什么都不会发送。

这次交接允许的范围：

- **谁来读：** xMatrix 支持，即 xMatrix 团队及其支持 Agent，在为这次交接开设的支持对话里处理。
- **只读：** 支持按你能看到的样子读取你勾选的内容，不能在你的对话里写入、回应或启动任何东西。支持的答复以"xMatrix support"的消息出现在你的对话里，或通过邮件发给你。
- **多长时间：** 14 天。你，或你所在空间的所有者或管理员，随时可以在它留在对话里的说明上点 **Withdraw now**。撤回或到期后立刻停止读取。
- **每次读取你都看得到：** 支持在一小时内第一次读取时，你的对话会显示"xMatrix support read this conversation"和时间。这一小时内之后的每次读取都会更新同一条提示，写明读了几次和最近一次的时间，例如"xMatrix support read this conversation 3 times (latest 14:05 UTC)"。下一个小时会另起一条。
- 只有对话的发起人，或其空间的所有者或管理员，才能交出这个对话。

## 法律文件

- [隐私政策（EN）](/privacy)
- [Cookie 与本地存储声明（EN）](/cookies)
- [子处理商清单（EN）](/subprocessors)
- [服务条款（EN）](/terms)
