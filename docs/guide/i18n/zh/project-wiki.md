---
title: "用 Claude Code 或 Codex 搭建项目 Wiki · xMatrix 文档"
description: "让你自己的 Claude Code 或 Codex 将项目笔记转化为持续更新的动态 Wiki：创建状态页、审阅核对，并在对话中随时更新。"
---

# 用 Claude Code 或 Codex 搭建项目 Wiki

在 xMatrix 中，你可以用自己的 Claude Code 或 Codex Agent 将零散的项目笔记整理为持续更新的动态 Wiki：先生成项目状态页，核对已达成决策与未决事项，之后每当情况变化时，在同一个对话里让 Agent 就地更新。

如果是开源项目，不妨从下一个版本开始：记录已达成一致的方案、当前阻塞项以及下一步的负责人。无需先连接 GitHub 或邀请团队成员，只要准备几条笔记和一个本地文件夹就能马上上手。

## 开始之前

你需要一台已安装并登录 Claude Code 或 Codex 的电脑，以及一个 xMatrix 账号。Agent 使用你现有的工具账号并在你自己的电脑上运行，因此工作期间请保持电脑在线。你可以通过网页端进行对话和阅读页面。

如果尚未连接这台电脑，请先按[安装与登录](index.md#安装)完成配置，然后在[网页端](https://xmatrix.sh/app)打开你的 Space。

## 为 Agent 指定一个文件夹

创建第一个页面时，一个空文件夹就足够了。在 macOS 或 Linux 上运行以下命令创建文件夹并将 Codex 添加到你的 Space：

```sh
mkdir -p ~/xmatrix/project-wiki
xmatrix spaces
xmatrix agent add codex --space <space-id> --workspace ~/xmatrix/project-wiki
```

将 `<space-id>` 替换为你刚打开的 Space ID。如果使用 Claude Code，将 `codex` 替换为 `claude`。在 Windows 上，可以新建类似 `C:\xmatrix\project-wiki` 的文件夹，并将其路径传给 `--workspace`。

在 macOS 或 Linux 上执行 `echo "$HOME/xmatrix/project-wiki"`，或在 PowerShell 中执行 `Resolve-Path C:\xmatrix\project-wiki` 以获取该文件夹的完整路径。在下面的消息中填入该完整路径（保留双引号）。关于注册流程与支持的工具列表，请参阅[使用 Agent](agents.md)。

## 让 Agent 创建第一个页面

在你的 Space 中新建一个对话，粘贴以下消息，并将其中的路径和示例笔记替换为你项目的真实信息。如果你添加的是 Claude Code，请将 `@codex` 改为 `@claude`。

```text
@codex pwd:"/full/path/to/project-wiki"
根据下面这些笔记创建一个名为 Release status 的页面。
按 Goal、Decisions、Open work 和 Next steps 四个章节组织内容。
尚未确定的负责人或日期保持标记为未知。
基于这些笔记完成页面，准备好后在这里附上页面链接。

Goal: Ship the next release with a usable installation guide.
Decided: Support macOS and Windows first. Linux is still open.
Open work: Check the Windows instructions.
The owner and release date are not decided.
Next: Ask a maintainer to try a clean Windows install.
```

这里的文件夹仅用于指定 Agent 的运行位置。内容完全来自你的笔记，此任务不需要访问代码仓库。Windows 用户同样使用 `pwd:` 语法并填入完整的 Windows 路径。

等待 Agent 回复后，点击它给出的页面链接，或在 **页面（Pages）** 中找到 **Release status**。检查页面是否清晰区分了已决定事项和未决问题，且没有擅自补全未知的负责人或日期。如果有误，直接在对话里指正即可。

如果没有 Agent 回复，请在该电脑上运行 `xmatrix status` 和 `xmatrix agent list --space <space-id>`，确认 Agent 已启用且对应的编码工具已登录。对话中的调用详情会显示启动失败原因；进一步排查请参阅[使用 Agent](agents.md)。

## 变更决策并观察页面更新

直接回复刚才作答的那个实例。例如，如果它在对话中的名字是 `codex:1`，发送：

```text
@codex:1 Windows 安装步骤已经验证通过。
请更新 Release status：移除那条待办项。
把下一步改为确定发布日期。
在我们达成一致之前，发布日期继续保持未知。
```

请使用你对话中实际显示的实例名和编号。重新打开同一个页面，确认旧的待办项已被移除、下一步已更新。这正是活页面的核心价值：你随时只需回到这一页查看最新状态，而不必翻查整条聊天记录去拼凑计划。

## 用于真实项目协作

之后每当出现新决策、Issue 摘要或发布说明，都可以在对话中同步，并让 Agent 更新既有页面。当 Agent 需要查看代码时，再将真实项目目录注册给它。如果希望它读取 GitHub Issues 或 Pull Requests，请先将 [GitHub](connectors.md#github) 连接到 Space，并在任务中指明代码仓库。

每条事实尽量只在一处维护。随着项目推进，可以按需创建子页面，并从 Release status 链接过去。页面树、协同编辑与定时更新详见[页面](pages.md)。

页面默认保持私有，除非 Space 所有者或管理员主动发布。对外分享前请先检查内容与访问权限；创建这个 Wiki 不会将其公开。
