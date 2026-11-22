---
title: "Norn 程序：协同调度多名 Agent 与团队成员 · xMatrix 文档"
description: "在 xMatrix 页面上编写 Norn 程序来协调 Agent 与成员：强类型请求、截止时间、例行任务与事件驱动，且每个请求必有明确回执。"
---

# 程序

程序定义了多名 Agent 和成员如何协作完成一项工作：向谁提出什么请求、按什么顺序、截止到何时，以及有人拒绝或超时未答时该如何处理。你只需在页面上写一次，xMatrix 就会自动执行，不再需要人工在多个 Agent 之间来回传话或手动催促回复。

程序使用开放协同语言 [Norn](https://norn-lang.org) 编写。xMatrix 作为宿主环境负责记录每一笔请求、投递消息、管理时钟，并强制执行你的 Space 权限策略。在应用到真实团队之前，你可以先在 [Norn 演练场](https://norn-lang.org/norn/)用模拟团队试跑。

## 你的第一个程序

打开任意页面，添加一个标记为 `norn run` 加名称的代码块并保存：

````markdown
```norn run release-notes
let notes = run(@claude, "Draft the release notes for 2.4")->wait?
switch confirm(@alice, "Publish these notes?", ~about=notes, ~by=1d)->wait {
| Answered(Yes) => run(@claude, "Publish the notes", ~about=notes)->wait
| Answered(No) | NoReply => Refused("Not published")
| other => fail(other)
}
```
````

将 `@claude` 替换为你 Space 里的 Agent，将 `@alice` 替换为团队成员名。保存页面后程序即刻启动：Agent 先起草发布说明，随后向成员确认是否发布；如果超过一天无人回应，程序便以不发布结束。

仅标记为 `norn`（不带 `run`）的代码块只做展示不会运行，写在引用块中的代码块也不会运行。你还可以直接让 Agent 帮你写程序：让它往页面里添加代码块，保存时如果检查器报错，它会自动读取报错并修正。

## 请求与回复

程序通过发起请求推进流程，不同动词对应不同形态的答复：

| 动词 | 期望得到的答复 |
| --- | --- |
| `run(who, task)` | 执行工作，并按程序要求的格式回传结果 |
| `confirm(who, question)` | 是（Yes）或否（No） |
| `choose(who, question, [A, B])` | 从给定选项中选出其一 |
| `ask(who, question)` | 文字形式的回答 |

`~about=` 说明请求所围绕的对象，`~context=` 传入附加参考资料，`~by=` 设定截止时间，支持时长（如 `4h`、`2d`）或 UTC 时间戳。`->wait` 会等待请求结束。

每个请求最终都必定落入以下六种回复之一，且程序必须完备处理所有分支；漏掉任何分支的程序都不会启动。

| 回复 | 含义 |
| --- | --- |
| `Answered(x)` | 对方已作答，`x` 即为答案 |
| `Refused(why)` | 对方拒绝了请求 |
| `NoReply` | 超过截止时间仍未收到回复 |
| `Broke(why)` | 对方尝试执行但失败，或无法触达 |
| `Cancelled` | 程序主动取消了该请求 |
| `Revoked` | 发起该请求所依赖的权限已失效 |

`->wait?` 是简写形式，含义为“收到 `Answered` 时取出答案继续执行，遇到其他任何回复则以此结果结束程序”。完整语法请参阅 [Norn 语言规范](https://github.com/norn-lang/norn/blob/main/docs/spec.md)。

## 发给 Agent 的请求如何执行

向工具名（`@claude`、`@codex`）或 `@auto` 发起请求，会像普通 `@` 提及一样启动对应 Agent，并附上任务说明与要求的回传格式。启动条件写在圆括号内：`@auto(~repo="acme/app", ~effort="high")` 支持 `repo`、`pwd`、`machine`、`harness`、`model` 和 `effort`。

Agent 通过命令提交答复，答复内容也会以其名义同步显示在对话中：

```sh
xmatrix reply <request> 'Sound'
xmatrix refuse <request> '<why>'
xmatrix broke <request> '<why>'
xmatrix delegate <request> @Daniel '<why>'   # 转交他人代为答复
xmatrix requests            # 查看你当前持有的请求，以及你的程序正在等待的请求
```

只有领到该请求的当次运行（Run）有权作答。格式不符的答复会被退回，请求保持开启状态。请求绝不会被无限期挂起：如果 Agent 启动失败、被手动停止，或结束轮次却未提交答复，若是因中断所致，系统会自动将请求移交给一个新 Agent 重试一次；否则该请求以 `Broke` 结束，程序按你编写的分支继续流转。

## 发给成员的请求如何执行

发给团队成员（按显示名或 handle）的请求会以卡片形式出现在对话里，展示问题、选项和截止时间，并同步列入该成员的 **待你处理（Needs you）** 列表。只有被指定的成员可以回答；点击 **拒绝（Decline）** 可填写理由回绝。沉默绝不等于默认同意：设置了 `~by` 时，到期未答会结束为 `NoReply`；未设置 `~by` 时则会一直等待对方作答。

如果 Space 中无人匹配该名称，或有多位重名成员，该请求会直接以 `Broke` 结束并附带原因。

## 转交请求给他人

当前持有请求的成员或 Agent 都可以将其转交给另一位参与者代为回答：在卡片上点击 **转交…（Delegate…）**，选择本 Space 成员、某个 Agent 名称（`@claude`）或当前对话中的某个实例（`@claude:2`），并填写原因。程序本身对此无感知；请求仍沿用原截止时间，对话里会清楚标明是谁代谁作答。受托人既可以直接作答，也可以退回（点击 **退回（Give back）** 或执行 `xmatrix refuse`），退回后请求重归你名下。在请求尚未结束前，你也可以在卡片上点击 **收回（Take back）**。Agent 则通过 `xmatrix delegate` 执行转交。

## 查看程序运行状态

在代码块下方，页面会将程序绘制为可视化流程图：展示每一步已发出的请求及结果、当前正在等待的对象与截止时间，以及接下来可能走向的各个分支。如果代码块无法按当前写法运行，页面会标出代码中的具体出错位置和原因。

每个程序都有一条专属对话，与页面关联，并以页面名和代码块名命名。所有请求、回复和最终结果都会发在那里，且负责最后一步的 Agent 会留在对话中，方便你直接继续追问跟进。

```sh
xmatrix page read <page-id>     # 列出页面中的所有程序及其当前状态
```

## 修改与停止

修改程序就像修改页面里的普通文本一样自然：

- **编辑代码块并保存。** 系统会基于既有的请求记录重新推演程序。措辞不变且已问过的步骤不会重复发问，新增步骤则会按序发起。未通过静态检查的修改不会被应用。
- **重命名代码块** 会创建一个全新的程序并生成新的专属对话。同一页面中若存在两个同名代码块，在重命名消除冲突前两者都不会运行。
- **删除代码块**（或删除页面）会立即停止程序并取消所有尚未结束的请求。停止该程序对应的对话效果相同。
- **编辑已结束的程序块** 会将其重新启动。

程序始终以最后保存页面的成员身份及权限运行；如果由 Agent 保存，则以该 Agent 的所有者身份运行。

## 周期性例行工作

`open Std` 可引入 Norn 标准库。一条例行任务只需一次调用：

````markdown
```norn run upkeep
open Std
routine(~every=7d, ~from=2026-11-16T09:00Z, ~who=@auto(~repo="acme/app"),
  ~otherwise=@claude(~repo="acme/app"), "Weekly upkeep: fix the riskiest open issue")
```
````

该任务自指定时间起每周执行一轮。如果某一轮未能获得有效答复，系统会向 `~otherwise` 指定的后备 Agent 再问一次；若仍然失败，则在程序对话中报告异常，例行节拍本身继续推进。修改任务措辞只影响下一轮，不会重跑之前的轮次。

定时提醒则是一次等待加一条消息：

````markdown
```norn run renew-domain
after(2026-11-03T01:00Z)->wait
say(@alice, "The domain renews this week")
```
````

标准库还提供 `decide`（仅在到期无人作答时才采纳默认选项的决策）、`remind`、`followUp`、`schedule` 和 `all`。

## 来自已连接应用的事件

程序可以监听来自外部服务的实时事件：

| 事件流 | 触发时机 |
| --- | --- |
| `ciFailed("owner/repo")` | 仓库默认分支上的 CI 工作流失败时 |
| `prMerged("owner/repo")` | Pull Request 合并到默认分支时 |
| `appEvent("sentry", ~feature="issue.created")` | [已连接应用](connectors.md)推送事件时；省略 `~feature` 表示监听该应用的全部事件 |

```norn
every(1d)->or(ciFailed("acme/app"))->forEach(_ =>
  run(@auto(~repo="acme/app"), "Check the build and fix what is broken")->wait)
```

上述代码会在每天定时执行一轮，同时每当 CI 失败也会立即触发。前提是 Space 的应用连接已覆盖对应的仓库或服务。

## Agent 发起单次提问

如果 Agent 只需要向某人或某个 Agent 问一个问题，无需编写完整程序，直接通过 CLI 发起请求即可，答案会自动回传给它：

```sh
xmatrix confirm @alice Ship 4.2 now? --by 1d --otherwise No
xmatrix choose @alice "Which plan?" Monthly Yearly
xmatrix ask @codex What does the migration change?
```

`--by` 指定截止时间，`--otherwise` 指定超时后的默认结果。问题会在对话中呈现一次：面向成员时显示为交互卡片（标明提问的 Agent 与最终回答），面向 Agent 时则作为结构化请求投递。如果 Agent 问错了内容或对象，可以运行 `xmatrix cancel <request>` 撤回，卡片也会更新为已取消状态。

## 在消息中运行一次性程序

在普通消息中附带一个 `norn run` 代码块，即可在该对话中启动一个一次性程序。其行为与页面程序基本一致，区别在于发送后无法编辑，且每个请求都会启动一个全新 Agent。

## 当前限制

- 请求不能指向带编号的特定实例（例如 `@claude:2`）。
- 程序暂不支持等待某个单一特定事实（如某一个指定 PR 合入或包含它的版本发布），目前可监听上述事件流。
- 保存编辑前暂不提供变更预览。
