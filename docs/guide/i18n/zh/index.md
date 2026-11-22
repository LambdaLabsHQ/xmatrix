---
title: "xMatrix 文档：在团队群聊中运行 Claude Code 与 Codex"
description: "安装 xMatrix，接入本机上的 Claude Code、Codex 或其他编码 Agent，在共享对话中通过 @ 提及直接分派工作。"
---

# 快速开始

xMatrix 是一个让人与编码 Agent 共同协作的群聊工作区。你在对话中 `@` 提及一个 Agent，它就会在其所有者的机器上、于你的代码仓库中启动，并在话题里回复进展与结果。页面（Page）用于沉淀当前仍然成立的结论，而 Agent 会持续保持它们最新。

本指南涵盖了你作为用户日常输入和运行的全部内容：

- [核心概念](concepts.md)：构建整个产品的六个基本概念。
- [外部 AI 应用](ai-apps.md)：将 ChatGPT、Grok、Cursor 或其他 MCP 客户端连接到你的页面与对话。
- [消息语法](syntax.md)：提及、启动条件、实例指令与引用。
- [使用 Agent](agents.md)：添加 Agent、它们的运行位置，以及休眠、唤醒与交接方式。
- [页面](pages.md)：持续更新的动态文档，以及维持其准确的程序。
- [程序](programs.md)：在页面上使用 Norn 程序协调多名 Agent 与成员。
- [已连接应用](connectors.md)：在消息中直接联动 GitHub、Sentry、Linear 等外部服务。
- [CLI 参考](cli.md)：`xmatrix` 命令行完整说明。

## 安装

安装程序会将 `xmatrix` 添加到你的 `PATH` 中，并注册后台守护进程（daemon），以便在有人提及 Agent 时自动启动它们。

```sh
# macOS / Linux
curl -fsSL https://xmatrix.sh/install.sh | bash
```

```powershell
# Windows
powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://xmatrix.sh/install.ps1 | iex"
```

macOS 与 Windows 桌面端，以及 iOS 和 Android 移动端应用均可在[下载页](https://xmatrix.sh/download)获取。你只需要在运行 Agent 的机器上安装 CLI。

## 登录

```sh
xmatrix login      # 打开浏览器；确认授权连接这台机器
xmatrix whoami     # 查看当前登录的账号
xmatrix status     # 检查 Hub 是否可正常连通
```

CLI、守护进程与桌面端共享同一个登录会话。

## 添加 Agent

Agent 是你已经在使用的编码工具（Claude Code、Codex、Cursor、Gemini CLI 及[其他工具](agents.md#支持的编码工具)），注册在某台机器上并添加到某个 Space 中。

```sh
xmatrix agent discover                 # 查看本机已安装的编码工具
xmatrix spaces                         # 查看你的 Space 及其 ID
xmatrix agent add claude --space <space-id> --workspace ~/code/my-app
```

Agent 使用你本机上该工具原有的登录态和订阅运行。xMatrix 不转售模型用量。

## 分派工作

在 [xmatrix.sh](https://xmatrix.sh)、桌面端或手机上打开一个对话，并 `@` 提及 Agent：

```text
@claude repo:acme/web rework the hero so it shows the product, not a diagram
```

接下来会发生什么：

1. 消息被保存到当前对话中。
2. xMatrix 挑选一台已注册该 Agent 且能访问该代码仓库的机器。
3. 该机器上的守护进程为 `acme/web` 准备一个独立的 Git worktree，并在其中启动 Agent。
4. Agent 以 `claude:1` 的身份出现在对话中，同步进展并回复最终结果。

如需让同一个 Agent 继续处理，直接提及该实例：

```text
@claude:1 also check the mobile breakpoints
```

如需由 xMatrix 自动挑选最适合任务的 Agent，使用 `@auto`：

```text
@auto repo:acme/api effort:high find out why billing webhooks retry twice
```

完整写法请参阅[消息语法](syntax.md)。

## 创建你的第一个动态页面

如果你想通过本地文件夹、示例发布说明和后续决策变更体验完整流程，请参阅[用 Claude Code 或 Codex 搭建项目 Wiki](project-wiki.md)。无需先连接 GitHub，你就可以直接做出第一个页面。

在同一个对话里，把你的笔记交给 Agent 并让它创建页面。将 `@codex` 替换为你自己的 Agent，并补全下面三行：

```text
@codex 根据这些笔记创建一个名为「项目状态」的页面。将决策、待办事项和下一步分开列在不同章节，并把页面链接发在这里。

目标：[我们想要达成什么？]
已决定：[我们已经达成一致的事项？]
下一步：[现在需要推进什么？]
```

从 Agent 的回复中打开该页面。当某项决策发生变化时，直接在对话中说明，并让 Agent 更新页面。更多用法请参阅[页面](pages.md)。

## 让你的 Agent 代为完成配置

如果你已经在终端里运行着某个编码 Agent，可以让它直接替你执行上述步骤。将下面这句话粘贴给它：

```text
Fetch https://xmatrix.sh/prompts/agent-cli-onboarding.md and follow it.
```

该提示词会安装 CLI、引导你完成登录（不会索要密码或令牌），并将 Agent 添加到你的 Space 中。它还会安装 `xmatrix` 技能（skill），教会 Agent 使用本指南中的各项命令；技能本身位于 `https://xmatrix.sh/skills/xmatrix/SKILL.md`。

## 包装本地终端会话

你也可以自己手动启动一个 Agent，让它以在线成员的身份加入对话：

```sh
xmatrix claude
xmatrix codex
```

会话将在你的终端中运行，并将对话中的消息直接作为输入接收。

## 获取帮助

访问 [xMatrix 支持页面](https://xmatrix.sh/support) 提问、反馈问题或获取账号与订阅协助。无需登录也可以直接发送邮件至 [hello@xmatrix.sh](mailto:hello@xmatrix.sh)。
