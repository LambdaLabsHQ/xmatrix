---
title: "AI 编码 Agent 的 @提及语法参考 · xMatrix 文档"
description: "xMatrix 消息语法完整参考：通过 @ 提及启动 Claude Code 或 Codex，指定仓库、模型与推理强度，以及停止、重启或交接 Agent。"
---

# 消息语法

你向 xMatrix 下达的一切指令，本质上都是一条普通消息。没有隐藏表单：你输入的内容就是存储的内容，服务端解析的也正是你看到的文本。在输入框键入 `@`、`#` 或 `[[` 时会自动弹出补全菜单，平时几乎不用死记硬背。本页是完整语法参考。

## 速查表

| 输入内容 | 效果 |
| --- | --- |
| `@claude fix the failing test` | 启动一个新的 Claude 实例并把消息交给它 |
| `@auto repo:acme/api fix the failing test` | 让 xMatrix 自动挑选 Agent，并在 `acme/api` 的独立 worktree 中启动 |
| `@codex pwd:"/Users/me/my app" …` | 在已注册目录中原地启动 |
| `@codex model:<id> effort:high …` | 使用指定的模型和推理强度启动 |
| `@claude:2 also update the changelog` | 让当前对话中的 2 号 Claude 实例继续处理 |
| `@claude:2 /model <id>` | 切换运行中实例的模型 |
| `@claude:2:stop` | 停止该实例 |
| `@claude:2:reborn` | 保留原有记忆重启该实例 |
| `@claude:2:handoff:@codex finish the migration` | 将当前代码检出与上下文交接给一个新的 Codex 实例 |
| `/stop all` | 停止当前对话中的所有实例 |
| `@Maya` · `@everyone` | 通知某位成员，或通知对话中的所有人 |
| `@github:subscribe:acme/web pulls checks` | 执行已连接应用的指令 |
| `page:<id>` · `channel:<id>` | 引用某个页面或某个对话 |

## 提及（Mentions）

提及由 `@` 加名称组成。当 `@` 位于消息开头，或紧跟在空格、左括号之后时才会生效。全角 `＠` 与半角 `@` 效果相同。

名称匹配不区分大小写，且遵循最长匹配优先原则，因此 `@codex-mba` 绝不会被误判为 `@codex`。

用于启动或控制 Agent 的提及必须自成一词：后面需要跟空格、换行或右标点。仅用于通知成员的提及则可以直接紧贴中文或日文文本，例如 `@Maya的方案`。

### 哪些情况不会触发提及

出现在以下 Markdown 结构中的提及仅作为纯文本处理，不会通知任何人，也不会启动任何 Agent：

- 行内代码与代码块
- 引用块（block quotes）
- 链接与图片
- 删除线文本

因此，当你需要在消息里讨论某条语法又不想触发它时，把它放进反引号即可。

### 提及成员

输入 `@` 并选择成员，消息中会填入其显示名（如 `@Maya Chen`）或用户名（handle）。被提及的成员会收到通知，阅读后自动清除。

`@everyone`、`@channel`、`@all` 和 `@here` 会通知对话中的全部成员。

如果两位成员同名，或成员名与 Agent 名冲突，系统会拒绝发送该消息，直到你改用其 handle 明确指定。

## 启动 Agent

提及编码工具名会在当前对话中启动该 Agent 的一个**新实例**：

```text
@claude rework the hero so it shows the product
@codex check the mobile breakpoints
@auto find out why billing webhooks retry twice
```

- `@<harness>` 指定对应工具：`@claude`、`@codex`、`@cursor`、`@gemini` 等。详见[支持的编码工具](agents.md#支持的编码工具)。
- `@auto` 交由 xMatrix 自动决策。它会结合任务语义，选择最契合且所在机器余量最充足的编码工具。

消息中其余部分即为任务说明。Agent 同时也能看到上下文对话，所以当上方讨论已经明确“这个”指什么时，发一句简短的 `@claude take this one` 也完全足够。

### 启动条件

启动条件用于限定 Agent 在何处、以何种配置启动。它们是紧跟在提及之后的 `key:value` 词组，以空格分隔：

```text
@auto repo:acme/api model:<id> effort:high find out why webhooks retry twice
```

这里 `@auto` 是提及，紧随其后的三个词是启动条件，从 `find` 开始的全部内容则是任务正文。

| 条件 | 含义 |
| --- | --- |
| `repo:<owner/repo>` | 在该代码仓库的全新托管 worktree 中工作 |
| `pwd:"<absolute path>"` | 在该已注册本地目录中原地工作 |
| `machine:<name>` | 在指定名称的机器上运行；名称可通过 `xmatrix agent list` 查看 |
| `harness:<name>` | 与 `@auto` 配合，将候选范围限定为某一种编码工具 |
| `model:<id>` | 指定使用的模型 |
| `effort:<level>` | 指定推理强度 |
| `fast:on` | 在工具支持时开启快速模式 |
| `param.<id>:<value>` | 设置该编码工具声明的其他自定义参数 |

解析规则：

- **遇到第一个非条件词即结束解析。** 此后全部内容都属于任务文本，因此未知的 `key:value` 只会被当作普通文本，不会报错。
- **顺序无关**，但每种条件最多出现一次。
- **仅限提及所在行生效。** 换行会终止启动条件解析。
- **含空格的值用双引号包裹。** 值内部如需字面双引号，连写两个即可：`pwd:"/Users/me/my ""old"" app"`。
- **条件无法满足时会中止启动。** xMatrix 不会静默替换成别的模型或机器，提及状态会直接展示未启动的原因。

### 智能体的工作位置

`repo:` 与 `pwd:` 互为替代项，单次提及只能使用其中之一。

**`repo:`** 指定代码仓库。Agent 会获得专属的 Git worktree，多名 Agent 可同时在同一仓库中并行工作而互不覆盖。GitHub 仓库写作 `owner/repo`，也支持完整的 HTTPS 或 SSH 远程地址（GitHub 远程地址会自动简化为 `owner/repo`）。仓库引用不接受凭证、查询参数或片段（fragment）。

```text
@codex repo:acme/web …
@codex repo:https://gitlab.example.com/team/service …
```

**`pwd:`** 指定已在某台机器上通过 `xmatrix workspace register` 注册过的目录。Agent 会在该目录中就地工作，直接使用当前检出状态。路径必须是绝对路径，同时也会锁定到该目录所在的机器。

```text
@claude pwd:/srv/app …
@claude pwd:"C:\Users\me\my app" …
```

如果两者都未指定，xMatrix 会根据任务内容去匹配 Space 中各仓库和目录的名称及描述。当对话上下文不足以判断目标仓库时，建议显式写出 `repo:`。

### 模型、推理强度与其他选项

`model:` 和 `effort:` 接受编码工具自身上报的 ID。选择工具后输入框会自动列出可选项，[Agents 视图](agents.md)中同样可查。

除模型和推理强度外，各编码工具提供的额外参数各不相同，因此不设固定关键字。工具会自行声明支持的参数，你可以用 `param.<id>:<value>` 指定：

```text
@kimi param.<id>:<value> summarize the incident
@codex fast:on apply the rename
```

输入框会自动展示各工具当前声明的参数 ID 与取值。`fast:on` 是 `param.fast:on` 的简写。开关型参数接受 `on`、`off`、`true` 或 `false`。

### 谁能启动 Agent

在 xMatrix 输入框中发送消息会启动你 `@` 召唤的 Agent。而 Agent 发出的消息只有在附带 `xmatrix send --launch` 时才会启动其他 Agent；不带该标志时，报告里的 `@codex` 只是普通提及，避免 Agent 之间意外互相触发。停止、重启与交接在两种方式下行为一致。

未触发启动的提及会明确标示状态，发信人可以在提及上手动点击启动。消息正文里的任何文本都不能强制拉起 Agent：已废弃的 `launch:force` 条件会被直接忽略，因此 Agent 无法通过在汇报里写这段文本来拉起其他 Agent。

### 新对话的第一条消息

如果新对话的第一条消息没有提及任何人，系统会给你几秒钟时间决定交给哪个 Agent 处理（或都不选）。若未手动选择，xMatrix 会分析消息语义，仅在判断其确实在委派任务时才启动 Agent。

此后的消息若未提及任何人，则不会启动新 Agent。已在对话中的实例会将其作为上下文读取，并自行判断是否需要回应。

## 与已有实例对话

每个实例在所属对话中都有固定编号，显示在名称旁，如 `claude:1`、`codex:2`。通过 `@<name>:<number>` 直接与它对话：

```text
@claude:1 the tests still fail on Windows, take another look
```

该消息会精准路由给对应实例；若实例正处于休眠状态，则会自动唤醒它。编号仅在当前对话内有效：不同对话中的 `claude:1` 彼此独立。

直接回复某条来自实例的消息也会自动投递给该实例，无需再次 `@` 提及。

对话中的其他实例能看到这条消息作为背景上下文，但不会越俎代庖去执行指派给其他实例的工作。

## 向运行中的实例发送指令

针对单个实例发送且以 `/` 开头的内容会被识别为实例控制指令，而非工作任务：

| 指令 | 效果 |
| --- | --- |
| `@claude:1 /model` | 列出该实例可用的模型 |
| `@claude:1 /model <id>` | 切换模型 |
| `@claude:1 /effort` | 列出该实例支持的推理强度 |
| `@claude:1 /effort <level>` | 切换推理强度（`/reasoning` 效果相同） |
| `@claude:1 /config <id>` | 查看某项已声明参数的选项及当前值 |
| `@claude:1 /config <id> <value>` | 设置该参数 |
| `@claude:1 /fast on` · `off` · `status` | 控制快速模式；仅写 `/fast` 表示切换开关 |
| `@claude:1 /goal <condition>` | 为实例设定跨轮次持续推进的完成条件 |
| `@claude:1 /goal status` · `pause` · `resume` · `clear` | 查看、暂停、恢复或清除目标 |

上述切换直接作用于运行中的会话。实例会保留原有记忆与工作目录，无需重启。

`/model` 和 `/effort` 必须占据整条消息。你可以在同一条消息中每行写一条指令：

```text
@claude:1 /model <id>
@codex:2 /effort high
```

如果混杂了其他普通文本，整条消息会被当作常规工作任务投递，避免配置只生效一半。

各编码工具还自带各自的斜杠命令。输入 `@<name>:<number> /` 后，输入框会列出当前实例支持的命令并直接透传。

## 停止、重启与交接

对话中有操作权限的成员和 Agent 都可以控制对话中的实例。

| 输入内容 | 效果 |
| --- | --- |
| `@claude:1:stop` | 停止该实例。`:kill` 效果相同。 |
| `@claude:1:stop wrong branch` | 停止该实例，并附带显示停止原因 |
| `/stop all` | 停止当前对话中的全部实例。`/kill all` 效果相同。 |
| `/stop claude:1` | 停止单个实例的另一种写法 |
| `@claude:1:reborn` | 重启同一个实例，保留其会话记忆与代码检出 |
| `@claude:1:handoff:@codex` | 将其工作与对话上下文交接给一个新的 Codex 实例 |
| `@claude:1:handoff:@auto` | 同上，由 xMatrix 自动挑选接手者 |

**停止（Stop）**必须作为整条消息发送；指令之后的文本会记录为原因。已停止的实例不会因新消息自动唤醒，只有 `:reborn` 能重新拉起它。

**重启（Reborn）**会原样拉起同一实例：编号不变、记忆不变、目录不变。适用于实例卡住、唤醒失败或手动停止后需要恢复的场景。提及之后附带的文字会直接投递给重启后的实例。

**交接（Handoff）**会先确认前任实例已经退出，再启动一个新的接手实例（通常是另一种编码工具）。路由同样遵循常规的召唤权限和校验规则。若源实例启动时显式指定了机器条件，则交接（包括自动额度接力）也会保持在该机器上；未显式锁定的位置仍可自由迁移。如果目标机器上没有符合条件的接手者，交接会被明确拒绝并展示原因。若源实例正处于停止等待中，则不会启动接手者，请待其守护进程确认退出后再重试。

紧跟在接手目标后的启动条件同样沿用常规召唤语法。你也可以直接以条件开头（如 `@claude:1:handoff:@machine:Laptop`、`@claude:1:handoff:@model:<id> effort:high`），把编码工具的选择交给路由，就像召唤里的 `@machine:Laptop` 一样。显式指定的机器条件会覆盖继承的机器限制，并重新校验访问权限和在线状态。模型、推理强度和工具参数按常规校验；当显式提供模型、推理强度或工具参数时，若没有更优候选，也可在源实例自身的注册环境下启动新实例。仓库或目录条件必须与源工作位置一致；如需更换工作位置，请直接新派任务。从第一个非条件词开始就是交接任务说明：

```text
@claude:1:handoff:@codex you have the branch; finish the migration and open the PR
@claude:1:handoff:@codex machine:Laptop effort:high continue in the original browser
@claude:1:handoff:@machine:Laptop model:<id> effort:high finish the migration
```

接手者永远是新实例，因此名称不带编号。`@auto` 同样将工具选择交给路由。

仓库检出（包含未提交的本地修改）会通过一条交接分支移交给接手者；已注册本地目录则保留在原机器上。前任实例导出的对话记录仅作为前置上下文提供，不会变成接手者的身份或会话。浏览器登录态和其他本地进程状态不会随检出迁移。

精确指派给某个实例的消息只作为该实例的任务，对同频道其他实例仅作上下文参考。常规频道消息仍为共享任务，广播提及仍面向所有人。在整个恢复流程中，Agent 的受信任运行时实例与 Run 始终标识其身份。临时协助的 Agent 在完成任务并发送最终回执后应自行停止；正在等待成员回复或 CI 结果的实例仍有未完成工作，应保持可用。

当服务商额度耗尽时，xMatrix 会尝试自动交接。如果没有符合条件的接手者，你可以选择 **额度恢复后重试（Retry when quota recovers）** 或 **暂不处理（Not now）**。即使关闭页面等待也会持续生效，并可随时取消；等待最长保留 35 天，xMatrix 会在重试前检查服务商实际剩余额度。

## 已连接应用

Space 中已连接的应用与 Agent 类似，通过动作语法调用：

```text
@<app>:<action>:<target> <text>
```

```text
@github:subscribe:acme/web pulls checks
@github:comment:acme/web:#42 Reproduced on main.
@sentry:resolve:<issue>
```

该指令必须位于消息开头，且每条消息只承载一条指令。第一行之后的所有内容都属于 `<text>` 正文。完整列表与动作请参阅[已连接应用](connectors.md)。

## 引用

| 在输入框中键入 | 消息中的存储格式 | 界面显示效果 |
| --- | --- | --- |
| `[[` 后选择页面 | `page:<page-id>` | 带页面当前标题的胶囊标签 |
| `[[page#` 后选择章节 | `page:<page-id>#<heading-slug>` | 直达该章节的胶囊标签 |
| `#` 后选择对话 | `channel:<channel-id>` | 带对话当前名称的胶囊标签 |

由于底层存储的是 ID，重命名页面或对话永远不会导致历史消息中的引用失效。引用本身不附带任何额外授权：无权查看目标的读者不会看到标题或链接。在对话中提及某个页面会自动将该页面关联到本对话。

在页面正文中直接写下的 `page:<page-id>` 和 `channel:<channel-id>` 也会渲染为同样的胶囊标签；当光标移入其中时，会还原显示原始 ID 便于编辑。

`#` 后面紧跟数字时会保留为普通文本，因此 `#3484` 仍会正常显示为 Pull Request 编号。使用中文输入法时，输入 `【【` 同样可以唤出页面选择器。

## 限制

- 单条消息正文最长 131,072 个字符。
- 单条消息最多包含 8 条指令。
- 实例名、机器名、模型 ID 与推理强度最长 160 个字符；路径或仓库引用最长 4,000 个字符。

## 当没有 Agent 启动时

提及标签本身会直接显示当前状态：等待中、工作中、已回复、失败或已停止，并附带具体原因。常见情况如下：

| 提及提示 | 处理方式 |
| --- | --- |
| 已提及，未启动 | 发送方未请求启动 Agent：点击提及上的“启动”，或改用 `xmatrix send --launch` 重新发送 |
| 没有已注册环境提供所请求的模型、推理强度或工具 | 核对工具实际支持的 ID，或去掉该条件；可通过 `xmatrix agent list` 查看各机器的工具 |
| 所请求的机器未运行该 Agent | 运行 `xmatrix agent list`（或查看 Agents 页面）检查每台机器的工具、在线状态与剩余额度 |
| 所请求的目录未获授权 | 在该机器上执行 `xmatrix workspace register` 注册目录 |
| 仓库引用格式无效 | 改写为 `owner/repo`，不要携带认证凭证 |
| 所有匹配环境的模型服务商额度均已用尽 | 等待额度重置，或改用其他编码工具 |
| 仅有已关闭自动分配的机器能运行此任务 | 使用 `machine:<name>` 显式指定机器 |
| `:new` 与 `:once` 后缀已停用 | 改用 `@auto repo:owner/repo` 代替 `@agent:new:owner/repo` |

你也可以在终端运行 `xmatrix diagnose <conversation>` 查看相同的诊断记录。
