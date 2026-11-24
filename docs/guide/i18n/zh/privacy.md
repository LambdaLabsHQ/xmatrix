---
title: "遥测、诊断与本地隐私 — xMatrix 文档"
description: "哪些数据留在你本机、可选的本地额度探测和客户端诊断如何工作，以及如何随时关闭。"
---

# 遥测与本地隐私

xMatrix 由托管协作 Hub 与运行在你自己电脑上的 Rust 本地 daemon 组成。本页公开列出客户端与 daemon 的所有诊断上报与本地文件读取行为，以及关闭方式。

## 哪些数据留在你本机

你的源代码、Git 历史、工作目录、模型工具历史与本地模型凭据均留在你自己控制的电脑上。xMatrix 绝不将本机模型 API Key 或 OAuth token 上传至 Hub，也不会读取第三方凭证文件来做跨机器身份归因或指纹关联。

## 本地服务商额度探测

当你在本机注册了受支持的智能体工具（如 Claude Code、Codex、Cursor、Grok、OpenCode、DeepSeek、Z.ai、Antigravity）时，xMatrix 可在 `xmatrix agent list` 与 Agents 页面展示订阅剩余额度，并供 `@auto` 自动避开已用尽的账号。

为了在不消耗模型对话的前提下查询剩余额度，本地 daemon 会在内存中读取对应已注册工具的本地凭据并直连原厂接口：

| 工具 | 仅在本地内存读取的存储位置 | 由你本机直连的原厂接口 |
| --- | --- | --- |
| Claude Code | macOS 钥匙串（`Claude Code-credentials`）或 `~/.claude/.credentials.json` | `https://api.anthropic.com/api/oauth/usage` |
| Codex | `$CODEX_HOME/auth.json` 或 `~/.codex/auth.json` | `https://chatgpt.com/backend-api/wham/usage` |
| Cursor | `CURSOR_API_KEY` / `CURSOR_AUTH_TOKEN`、macOS 钥匙串（`cursor-access-token`）或 Cursor `auth.json` | `https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage` |
| Grok Build | `GROK_CLI_OAUTH_TOKEN` 或 `~/.grok/auth.json` | `https://cli-chat-proxy.grok.com/v1/billing?format=credits` |
| OpenCode | `OPENCODE_API_KEY` 或 OpenCode `auth.json` | `https://opencode.ai/zen/go/v1/usage` 或 ChatGPT `wham/usage` |
| DeepSeek | `DEEPSEEK_API_KEY` 或 `$DSH_HOME` 凭据文件 | `https://api.deepseek.com/user/balance` |
| Z.ai / 智谱 | `ZAI_API_KEY` / `ZHIPU_API_KEY` | `https://api.z.ai/api/monitor/usage/quota/limit`（或 `open.bigmodel.cn`） |
| Antigravity | 直接调用未改动的 `agy -p "/usage" --output-format json` | 由 `agy` 自行处理 |

**严格边界：**

- 凭据仅停留在本地进程内存中，**只发送给对应服务商自己的官方额度接口**。
- 本地计算的 SHA-256 指纹仅作为进程内缓存键用来感知账号切换，**永不写入日志，也永不上传至 xMatrix**。
- 上传给 xMatrix Hub 的只有归一化后的剩余额度信息（窗口百分比、重置时间、账号是否可用及预付余额）。

### 如何关闭本地额度探测

可通过配置命令或环境变量在整台机器上关闭所有本地服务商额度探测：

```sh
# 持久化本机配置
xmatrix config quotaProbes off

# 或通过环境变量（优先级更高）
export XMATRIX_DISABLE_QUOTA_PROBES=1
```

如仅关闭 Antigravity 额度探测，可设 `XMATRIX_DISABLE_ANTIGRAVITY_QUOTA_PROBE=1`。关闭后，xMatrix 不再读取任何本地服务商凭据或查询原厂额度接口。

## 客户端诊断与崩溃报告

xMatrix 不使用广告 Cookie、跨站追踪、会话录屏，也不集成 PostHog、Google Analytics 或 Cloudflare Web Analytics 等第三方行为分析 SDK。

默认情况下，登录客户端会发送受限的运维诊断数据以定位故障与性能回退：

- **错误与崩溃报告（Sentry）**：严格关闭用户信息、Cookie、HTTP 头/请求体、URL 查询参数与控制台面包屑，并对错误文本中的引用内容脱敏；未配置 DSN 的本地或自托管构建不发送任何报告。
- **第一方诊断指标（xMatrix Hub → Cloudflare Analytics Engine）**：启动耗时（`/api/observable/startup-timing`）、新手引导步骤计数（`/api/observable/onboarding-step`）、桌面端 daemon 启动失败原因（`/api/observable/desktop-daemon-failure`）与 CLI 网络重连样本（`/api/observable/client-metrics`）。标识符在服务端通过密钥 HMAC-SHA-256 假名化，不包含消息或命令正文。

### 如何关闭诊断与崩溃报告

- **Web、桌面端、iOS 与 Android**：前往 **Settings → Legal and privacy**，关闭 **Send diagnostics and crash reports**。
- **浏览器隐私信号**：除非你在设置中显式重新开启，xMatrix 会自动遵循 **Do Not Track（DNT）** 与 **Global Privacy Control（GPC）**。
- **CLI 与 daemon**：执行 `xmatrix config telemetry off`，或设置环境变量 `XMATRIX_TELEMETRY=0` / `DO_NOT_TRACK=1`。

## 法律文件

- [隐私政策（EN）](/privacy)
- [Cookie 与本地存储声明（EN）](/cookies)
- [子处理商清单（EN）](/subprocessors)
- [服务条款（EN）](/terms)
