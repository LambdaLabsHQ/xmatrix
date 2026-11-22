---
title: "动态页面与保持文档准确的 Norn 程序 · xMatrix 文档"
description: "用 xMatrix 页面保持项目文档实时准确：人与 Agent 协同编辑的共享 Markdown，以及按定时或事件自动运行 Agent 的 Norn 程序。"
---

# 页面

对话推进得很快，事后往往难以翻查。页面（Page）用于存放 Space 中当下仍然成立的事实：当前进展、生效决策与待办工作。团队在对话里讨论，Agent 负责让页面始终保持最新。

## 页面树

每个 Space 拥有一棵页面树。请按项目或工作主题组织结构，而不是按发言人归类。每个页面都是一份 Markdown 文档，标题即章节。无论位于哪里，第一个一级标题（`# 名称`）就是页面标题；重命名页面会同步改写该标题。

在应用中打开 **页面（Pages）**，列表顶部展示近期更新，下方是完整的页面树。也可以通过终端操作：

```sh
xmatrix page tree
xmatrix page tree --summaries
xmatrix page search <words>
xmatrix page read <page-id>
xmatrix page create "Billing" --under <parent-page-id>
xmatrix page rename <page-id> "Billing and invoices"
xmatrix page move <page-id> --under <other-page-id>
xmatrix page delete <page-id>
```

`page tree --summaries` 会在每个页面下方附上一行现状摘要。`page search` 会查找同时包含全部查询词的页面，以 `page:<id>#<section>` 标出命中章节并展示上下文片段，完整词组精确匹配的页面排在最前。在大型 Space 中，先搜索定位比逐页通读高效得多。

## 阅读与编辑

团队成员可以在应用中协同编辑同一页面，并看到实时光标。Agent 则通过 CLI 编辑，修改会在落地时实时呈现在打开的文档中。页面不加粗粒度锁：每个章节会显示当前正在浏览或编辑的成员，以及在关联对话中工作的 Agent，`xmatrix page read` 也会把相同信息告知 Agent。

通过 CLI 编辑时，提交的新 Markdown 基于你此前读取的版本号（revision）进行合并：

```sh
xmatrix page read <page-id>                       # 输出页面内容及其版本号
xmatrix page edit <page-id> --base <revision> -f page.md
```

`--base` 必须填写你实际读取时的版本号，而不是强行填最新版本。xMatrix 会自动把你的改动与期间他人的改动合并；若改动存在重叠冲突，编辑会被拒绝，并返回最新正文供你重新合并。

修改长页面的局部内容时，无需通读全文：

```sh
xmatrix page read <page-id> --outline             # 列出各章节标题、slug 与篇幅大小
xmatrix page read <page-id> --section <slug>      # 仅读取指定章节（含下级子标题）
xmatrix page edit <page-id> --base <revision> --section <slug> -f section.md
```

章节级编辑只替换该章节，完整保留页面其余部分（包括读取后他人在其他章节所做的更改）。提交的文本需包含该章节自身的标题行。你可以直接将 `page read --section` 的输出修改后通过 `-f` 写回：其头部信息带有章节标识，绝不会被误当作整页覆盖。若需新增、删除或重排章节，则应整页读取并编辑。

`xmatrix page read <page-id> --since <revision>` 仅打印某个版本之后的变更内容，`xmatrix page history <page-id>` 列出完整修订历史。

在应用中想查看某段文字是谁写的，将指针悬停在该段落上，页边会显示作者与时间。选中一段文字后，上方浮层还会一并显示它出自哪条对话；点击即可在页面旁侧打开该对话，并定位到当时写下这段文字时的消息位置。正在输入但尚未保存的文字会标注为“正在输入”。

### 页面里该写什么

页面记录的是“此刻仍然成立的事实”。请在原地改写内容，移除已完成或已被推翻的条目，不要把它写成只增不减的流水账。提交哈希、运行 ID、时间戳等过程证据留在 Pull Request 和对话里，页面只需链接过去即可。同一条事实只在一处维护，其他地方引用链接。

## 页面与对话的关联

只要页面与对话相互引用，二者就会建立关联。已关联的页面会以实时卡片的形式置顶显示在对话上方，该对话中启动的 Agent 会在开工前先阅读这些页面。

- 在消息中输入 `[[` 选择页面，或输入 `[[page#` 选择具体章节。消息中存储为 `page:<page-id>` 或 `page:<page-id>#<heading-slug>`。
- Agent 在运行过程中读取某个页面时，也会自动将该页面关联到当前对话。
- 运行 `xmatrix page link <page-id> --block <heading-slug>` 可手动关联指定章节，`xmatrix page linked` 可列出当前对话已关联的所有页面。
- 如果不希望某页面的更新再同步到当前对话，将鼠标悬停在对话顶部的页面卡片上选择 **取消关联（Unlink from this conversation）**，或运行 `xmatrix page unlink <page-id>`。取消后，即使该对话里的 Agent 继续读写该页面，也不会重新关联，直到有人手动再次关联。

章节 slug 的生成规则与 GitHub 一致：标题转小写、空格换连字符、去掉标点，例如 `## Open work` 对应 `open-work`。

### 锚点讨论

在页面中选中任意段落即可发起讨论，创建一条锚定在该段落上的对话。讨论得出结论后，将结论写回页面并标记该讨论为已解决。

## 程序

需要周期性重复、等待特定日期或响应外部事件的工作，可以直接作为程序写在页面里：在它负责维护的章节中插入一个标记为 `norn run` 并带有名称的代码块。程序使用 [Norn](https://norn-lang.org) 编写，保存页面即自动启动。你可以像编辑页面上的普通文字一样阅读和修改程序。

每 12 小时让 Agent 自动刷新一次章节内容：

````markdown
## Open work

```norn run triage
open Std
routine(~every=12h, ~from=2026-11-16T09:00Z, ~who=@auto(~repo="acme/web"),
  ~otherwise=@claude(~repo="acme/web"),
  "Read the issues opened since the last run and update this section")
```
````

在指定日期发出提醒：

````markdown
```norn run renew-domain
after(2026-11-03T01:00Z)->wait
say(@alice, "Renew the domain this week")
```
````

每天定时巡检，并在 CI 失败时立刻触发一轮：

````markdown
```norn run build-watch
open Std
routine(~every=1d, ~from=2026-11-16T09:00Z, ~on=ciFailed("acme/web"),
  ~who=@auto(~repo="acme/web"), ~otherwise=@claude(~repo="acme/web"),
  "Check the build and fix what is broken")
```
````

所有时间均为 UTC。`~from` 指定首轮触发时刻及后续节拍，`~who` 指定执行者，`~otherwise` 指定当某轮未能得到有效回复时再追问一次的后备执行者。`~on` 可在外部事件发生时立即触发一轮，例如 `ciFailed("owner/repo")` 或 `prMerged("owner/repo")`。程序还可以向团队成员提问、设定超时截止时间，并在多个 Agent 之间接力推进。语言细节、请求类型、事件流与限制请参阅[程序](programs.md)。

### 程序的运行方式

- 每个程序块都拥有一条专属对话并与页面关联，其发出的请求、收到的回答和最终结果都会记录在该对话中。
- 在代码块下方，页面会实时展示程序的当前状态：已经问过什么、结果如何、正在等待谁以及下一步会做什么。如果代码块语法或类型检查不通过，页面会直接标明原因，`xmatrix page edit` 也会将其打印出来。
- 程序以最后保存该页面的成员身份运行并沿用其权限；如果由 Agent 保存，则以该 Agent 的所有者身份运行。
- 修改代码块并保存即可更新程序，之前以相同措辞问过的请求不会重复询问；删除代码块即可停止程序。

```sh
xmatrix page read <page-id>     # 查看页面中的所有程序及其当前状态
```

## 公开页面

Space 所有者或管理员可以将单个页面设为公开发布。公开后，任何人都无需登录即可通过公开链接访问，且当 Agent 更新页面时，读者面前的页面也会实时同步变化。

只有 Space 内全体成员均有权阅读的页面才能公开发布。发布父页面不会自动公开其子页面。Agent 可以持续维护公开页面的内容，但发布与取消发布只能由人类成员操作。
