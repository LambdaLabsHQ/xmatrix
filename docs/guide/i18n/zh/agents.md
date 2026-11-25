---
title: "运行 Claude Code、Codex、Cursor 等 30+ 编码 Agent · xMatrix 文档"
description: "将编码 Agent 添加到 Space 并在你自己的机器上运行：支持的编码工具、独立 Git worktree、智能路由、休眠与唤醒以及密钥管理。"
---

# 使用 Agent

xMatrix 在你自己的机器上，用你已有的订阅来运行你熟悉的编码 Agent，如 Claude Code、Codex、Cursor 和 Gemini CLI。本页介绍如何将它们添加到 Space、它们在哪里工作、xMatrix 如何调度路由，以及它们如何休眠、重启与交接任务。

## 添加智能体

一个 Agent 就是注册在某台机器上并加入某个 Space 的编码工具（Harness）。在将要执行任务的机器上运行：

```sh
xmatrix agent discover                                  # 检测本机已安装的编码工具
xmatrix agent add codex --space <space-id>
xmatrix agent add claude --space <space-id> --workspace ~/code/my-app
```

| 选项 | 说明 |
| --- | --- |
| `--space <id>` | Agent 要加入的 Space。可用 `xmatrix spaces` 查看你的 Space。 |
| `--workspace <dir>` | 默认工作目录。如果该目录尚未在本机注册，会自动完成注册。 |
| `--name <name>` | 显示名称，默认使用工具 ID。 |
| `--arg <arg>` | 每次启动该工具时附带的命令行参数，可重复指定多个。 |
| `--runtime <command>` | 自定义启动命令，适用于安装在非常规路径的工具或自研 CLI。 |
| `--access full\|ask` | Agent 在这台机器上可以做什么：`full` 让工具无需询问即可工作，`ask` 在工具每次请求权限时到对话中询问。省略时在终端中询问。 |

`xmatrix agent list --space <id>` 可列出 Space 中的所有 Agent，`xmatrix agent show <harness> --space <id>` 查看单个 Agent 的详细配置，`xmatrix agent disable` / `enable` / `remove` 用于停用、启用或移除。停用 Agent 会同时停止它在该 Space 中正在运行的任务。

Agent 在你的本机用户账号下运行，沿用你为该工具登录的账号与订阅。Space 中的其他成员可以向它派发工作，但它能接触的范围仅限于你授权注册的目录与仓库。

## 支持的编码工具

| 提及方式 | Agent | 提及方式 | Agent |
| --- | --- | --- | --- |
| `@claude` | Claude Code | `@codex` | OpenAI Codex CLI |
| `@cursor` | Cursor Agent | `@gemini` | Gemini CLI |
| `@copilot` | GitHub Copilot CLI | `@opencode` | OpenCode |
| `@kimi` | Kimi Code | `@grok` | Grok Build |
| `@qwen` | Qwen Code | `@goose` | goose |
| `@junie` | Junie | `@kiro` | Kiro CLI |
| `@vibe` | Mistral Vibe | `@hermes` | Hermes Agent |
| `@openclaw` | OpenClaw | `@pi` | Pi |
| `@qoder` | Qoder CLI | `@deepseek` | DeepSeek Harness |
| `@codebuddy` | CodeBuddy Code | `@omp` | Oh My Pi |
| `@auggie` | Auggie | `@cline` | Cline |
| `@kilo` | Kilo | `@droid` | Factory Droid |
| `@devin` | Devin | `@commandcode` | Command Code |
| `@jcode` | jcode | `@prime` | Prime Agent |
| `@trae` | TraeCode CLI | `@antigravity` | Google Antigravity |
| `@autohand` | Autohand Code | `@amp` | Amp |
| `@reasonix` | Reasonix | `@dimcode` | DimCode |

除下方明确拒绝的工具外，任何其他 CLI 均可通过 `--runtime` 注册接入。

`xmatrix harness list` 可查看本机已安装的工具及其状态。`xmatrix harness install <name>` 和 `xmatrix harness update <name>` 会按各工具官方方式安装或升级，开启 `xmatrix harness auto-update <name> on` 则可自动保持最新。

## 明确拒绝支持的工具

当某些工具的架构或数据处理行为与 xMatrix 的本地隐私和凭据边界冲突时，xMatrix 会明确拒绝注册、管理或运行它们（包括通过 `--runtime` 指定）：

- **ZCode（`zcode`）** — 明确拒绝。ZCode 的 app-server 协议要求宿主程序直接处理模型提供商凭据，且其未经明确告知即上传工作区和 git 历史记录的历史事件违背了 xMatrix 的隐私底线。请改用上方 34 种受支持的编码工具。

## Agent 在哪里工作

Agent 会在两类位置之一启动。你可以用[启动条件](syntax.md#智能体的工作位置)显式指定，也可以交由 xMatrix 自动判断。

**代码仓库。** 将 GitHub 连接到 Space 后，其仓库即可直接作为启动目标。`@codex repo:acme/web` 会在选中的机器上按需克隆仓库，并为该 Agent 分配专属的 Git worktree。并行运行的 Agent 绝不会共用同一份工作区，Git 推送也直接使用 Space 的 GitHub 连接。

**已注册目录。** 在机器上注册任意目录后，Agent 可以在其中原地工作：

```sh
xmatrix workspace register --path ~/code/my-app --name my-app
xmatrix workspace list
xmatrix workspace unregister my-app
```

适用于不在 Git 仓库中、或需要依赖精确本机状态的任务。已注册目录绑定到其所在机器：`pwd:` 会同时锁定目录与机器。xMatrix 自身保留的目录（如 `~/.xmatrix` 下的 worktree 或 `~/.config/xmatrix` 下的任意路径）不允许注册。

运行 `xmatrix space launch-targets` 可以列出当前 Space 中可供 Agent 启动的全部代码仓库与目录。

## xMatrix 如何调度选择

当你的提及留有未指定的条件时，xMatrix 分两步完成决策。

第一步分析任务语义：判断这条消息是否在指派工作、涉及哪个仓库或目录，以及每种可用工具的适配程度。这一步只看消息本身的意思。

第二步安排落点：在所有能胜任的环境中，综合权衡工具适配度与资源余量——包括机器的空闲 CPU/内存，以及模型服务商剩余额度。额度已耗尽的环境会被自动跳过，直至额度重置。

你写下的每一项启动条件都是硬约束。打开提及详情页，可以看到最终选中了哪个环境以及落选的备选方案。

### 说明智能体的专长

每个 Space 可以用自然语言为每种编码工具维护一段专长描述。xMatrix 在判断某项任务适合哪种工具时会参考这段文字。你可以用任意语言、任意格式自由描述它擅长什么、应该避开什么，没有固定字段，仅限 1000 字符以内。

在 **Agents** 视图中打开对应 Agent 并编辑 **擅长领域（What it's good at）**，或使用 CLI：

```sh
xmatrix agent describe codex "擅长严谨的代码审查与安全审计，不适合精细 UI 调整。" --space <space-id>
xmatrix agent describe codex --space <space-id>    # 查看当前描述
```

该描述对 Space 内同属该工具的所有 Agent 生效。Space 所有者、管理员以及在该 Space 注册了该工具的成员都可以编写。当你输入 `@` 时，工具名称旁会展示其首句简介，`auto` 选项也会提示系统会依据这些描述择优调度。若某种工具尚未填写描述，有权限编辑的成员会在该位置看到本地化的 **说明它擅长什么** 入口，点击即可打开编辑器。在提及详情中，你也能看到本次调度究竟参考了专长描述，还是仅根据名称做出判断。

### 设置智能体的默认模型

除非 Space 另行指定，否则 Agent 会运行其编码工具自身的默认模型。要设置默认模型，可在 Agents 页面的设置项修改 **默认模型（Default model）**，或运行 CLI：

```sh
xmatrix agent model antigravity gemini-4-hydrogen-medium --space <space-id>
xmatrix agent model antigravity --space <space-id>            # 查看当前模型
xmatrix agent model antigravity --clear --space <space-id>    # 恢复工具默认模型
```

`xmatrix agent show` 会在 `modelCatalog` 字段下列出该工具支持的所有模型。设定默认模型后，每次未显式指定模型的启动都会使用它。如果机器所有者在注册时未声明模型白名单（大多数 Agent 的默认情况），则只要该模型在工具目录中即可运行，且召唤时显式指定其他目录模型（`model:<name>`）依然生效。如果所有者显式声明了允许的模型列表，则默认模型必须位于其中，且召唤列表之外的模型会被拒绝。若设定的模型尚未包含在所有者的授权列表中，系统会先将其加入授权——此操作仅限该 Agent 的所有者完成；更改 Space 配置则需 Space 所有者或管理员权限。

Agent 也可以代表其所有者运行该命令，读取和设置其所有者在当前 Space 内各 Agent 的模型，因此你可以直接在对话中让它调整。不过，Agent 无法修改其他 Agent 的名称、指令、工作模式或工作区，也不能从授权列表中移除模型。

### 保留专属机器不参与自动分配

```sh
xmatrix machine auto-assign off
```

关闭自动分配后，这台机器只会在有人通过 `machine:<name>` 或该机器上的 `pwd:` 明确点名时才承接任务。可用 `xmatrix machine rename <name>` 设置便于识别的机器名。

## 休眠与唤醒

实例不是一个常驻进程。它的记忆由编码工具的会话状态和工作目录共同构成，两者都会持久保留。

当实例完成一轮回复且没有待处理事项时，它会自动休眠：本地进程退出，头像变灰。下一条指派给它的消息到来时，它会自动唤醒，带着原有的会话记忆和代码检出继续工作。

| 状态 | 显示样式 | 能否被消息唤醒 |
| --- | --- | --- |
| 工作中 | 彩色在线头像 | — |
| 休眠中 | 灰色头像 | 可以 |
| 已中断（崩溃、重启） | 灰色头像带警告图标 | 可以 |
| 唤醒失败 | 灰色头像带红色警告及原因 | 不可以，需使用 `:reborn` |
| 已停止 | 从对话实例列表中移除 | 不可以，需使用 `:reborn` |

## 停止、重启与交接

具体指令见[消息语法](syntax.md)；在应用中点击实例头像也可以执行同样操作。

- **停止（Stop）** 会立即终止进程并将实例置为停止状态。成员发出的停止指令随消息即时生效：从那一刻起实例不能再发出任何消息。
- **重启（Reborn）** 会带着原有记忆重新拉起同一实例，用于从已停止、唤醒失败或卡住的轮次中恢复。
- **交接（Handoff）** 会将当前工作区检出（包含未提交更改）移交给一个新实例，通常是另一种编码工具。当某个工具在任务中途触发服务商额度上限时，xMatrix 会自动执行此类交接。

## 目标（Goals）

目标是实例跨多个轮次持续推进的完成条件。每轮结束后，系统会单独检查该条件是否已经满足，未满足则继续推进，直至达成。

```text
@claude:1 /goal every test in packages/api passes on CI
@claude:1 /goal status
@claude:1 /goal clear
```

## 密钥（Secrets）

密钥归属于 Space。Agent 使用密钥时，其值不会出现在聊天或密钥列表中：通过 `xmatrix secret exec` 运行的命令会在环境变量中拿到密钥。该命令运行在 Agent 所在的机器上，因此打印环境变量的命令也会打印出密钥值。

Space 管理员可以为每个密钥选择策略：允许 Agent 按需自动读取，或每次使用前先请求批准。当 Agent 需要一个未获自动放行的密钥时，它会在对话中发出一张请求卡片；管理员可直接在卡片上批准，或填入一个新值。密钥明文绝不会出现在聊天记录里。

```sh
xmatrix secret list --space <space-id>                           # 仅列出别名，绝不打印明文
printf %s "$VALUE" | xmatrix secret set <alias> --space <space-id> --env <ENV_NAME> --value-stdin
xmatrix secret delete <alias> --space <space-id>
```

## 跨 Space 读取

Agent 默认只能读取自己所属的 Space。当它需要查阅你所在的另一个 Space 中的某条对话时，会向你发起授权请求：批准卡片弹出后，所授权限为只读、仅限当次运行有效，且在 24 小时内自动过期。

```sh
xmatrix access status <space-id>/<grant-id>
xmatrix access approve <space-id>/<grant-id>
xmatrix access revoke <space-id>/<grant-id>
```

## 故障排查

每个提及都会显示其状态，例如启动中、排队中、工作中、已回复、失败、已停止或未确认。点开即可看到启动所经过的每一步以及停在何处。

也可以在终端执行：

```sh
xmatrix diagnose <conversation-url-or-id>             # 查看对话中最近的启动记录
xmatrix diagnose <conversation> --message <message-id>
xmatrix daemon doctor                                 # 检查本机守护进程及其追踪的运行
xmatrix harness list                                  # 检查编码工具是否已安装并登录
```
