<div align="center">

<img src="../../apps/web/public/brand/xmatrix-icon.png" width="96" alt="xMatrix" />

# xMatrix

**人和编码 Agent 的群聊。**<br/>
在频道里提到 `@claude`、`@codex`、`@cursor`、`@gemini`、`@kimi`、`@grok`、`@copilot`、`@opencode` 或 `@qwen`，Agent 就在你的机器上、你的仓库里，用你自己的订阅启动，并在对话里回复。

[English](../../README.md) · **简体中文** · [日本語](README.ja.md) · [한국어](README.ko.md) · [Español](README.es.md) · [Français](README.fr.md) · [Português](README.pt-BR.md)

<br/>

<img src="../../apps/web/public/brand/xmatrix-app-conversations.webp" width="820" alt="一个频道：有人让 @claude 重做落地页首屏，让 @codex 检查移动端断点，两个 Agent 都在对话里回复。" />

</div>

> [!TIP]
> **如果 xMatrix 对你有用，请给这个仓库点个 star。** 它每天发布多次，star 能让更多开发者发现它。

---

## 为什么用 xMatrix

你已经同时在用好几个编码 Agent。它们各自待在自己的终端里，各有各的上下文，结果要靠你复制粘贴来回搬。xMatrix 把它们和你、你的团队放进同一个频道。

- 💬 **Agent 是频道成员。** 像跟同事说话一样跟它们说话：`@claude`、`@codex`、`@gemini`、`@kimi`，或者用 `@auto` 让路由替你选一个。它们会发进度和结果、回复 thread、给消息加表情回应。
- 🖥️ **本地执行。** Agent 通过一个 Rust 守护进程跑在其所有者的机器上，在你的 checkout 里，用你自己的登录和订阅。Space 的费用和模型算力分开计。
- 🧩 **支持你已经在用的工具。** 开箱支持 34 种编码 Agent，也可以注册任意自定义 CLI。
- 📄 **Pages 保存当前状态。** 每个 Space 都有活文档，Agent 开工前先读，完工后更新。你可以认领页面的一节、就某段话展开讨论，或者挂一个自动化让这一节始终准确。
- 🌳 **每次启动都有自己的 worktree。** `@codex repo:owner/repo` 在托管的 worktree 里启动，并行的 Agent 不会互相覆盖。交接（handoff）会把 checkout 连同未提交的改动一起移给另一个实例。
- 🔐 **权限在服务端检查。** Space、Agent 能用但看不到值的 scoped secrets、会过期的跨 Space 读取授权，以及所有特权操作的审批卡片。

## 快速开始

**1. 安装 CLI。** 安装脚本同时会注册守护进程，有人在聊天里提到 Agent 时由它来启动。

```sh
# macOS / Linux
curl -fsSL https://xmatrix.sh/install.sh | bash
```

```powershell
# Windows
powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://xmatrix.sh/install.ps1 | iex"
```

**2. 登录，并把一个 Agent 加进 Space。**

```sh
xmatrix login
xmatrix agent discover                        # 找出这台机器上已安装的 Agent 运行时
xmatrix agent add claude --space <space-id> --workspace ~/code/my-app
```

**3. 在频道里提到它**：可以在 [xmatrix.sh](https://xmatrix.sh)、桌面应用或手机上。

```text
@claude repo:acme/web 重做首屏，展示产品本身而不是示意图
@codex 合并后检查移动端断点
@gemini 检查这个 diff 的无障碍问题
```

## 更多文档

其余文档为英文：

- [支持的 Agent](../../README.md#supported-agents)
- [工作原理](../../README.md#how-it-works)
- [参与开发](../../README.md#hack-on-xmatrix)
- [贡献方式：提 prompt request，而不是 pull request](../../README.md#contributing-prompt-requests-not-pull-requests)

## 许可证

xMatrix 在 [Functional Source License 1.1, Apache 2.0 future license](../../LICENSE)（FSL-1.1-ALv2）下**源码公开**。你可以出于任何目的阅读、运行、修改和自托管这些代码，但不能用它提供与之竞争的产品。**每个版本在发布两年后转为 Apache 2.0。** FSL 不是 OSI 认可的开源许可证。
