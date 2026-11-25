---
title: "xmatrix CLI 命令参考：Agent、频道与页面 · xMatrix 文档"
description: "按功能整理的 xmatrix 全部命令参考：登录与守护进程、Space、Agent 与编码工具、对话与消息、页面、密钥及故障诊断。"
---

# CLI 参考

`xmatrix` 是一个单一可执行文件，集命令行工具、在机器上启动 Agent 的守护进程（daemon），以及将本地编码工具接入对话的终端包装器于一身。每条命令都支持 `--help`。

凡是接受对话 ID 的命令，同样可以直接传入该对话的 `xmatrix.sh` 网页链接。

## 账号与机器

| 命令 | 作用 |
| --- | --- |
| `xmatrix login` | 通过浏览器登录并连接当前机器 |
| `xmatrix logout` | 清除本地保存的登录会话 |
| `xmatrix whoami` | 查看当前登录账号 |
| `xmatrix status` | 检查 Hub 连通性 |
| `xmatrix update` | 将 CLI 更新到最新版本 |
| `xmatrix setup daemon` | 注册守护进程开机自启并立即启动 |
| `xmatrix daemon doctor` | 检查守护进程状态及其追踪的运行 |
| `xmatrix machine identity` | 显示当前机器 ID |
| `xmatrix machine rename <name>` | 设置用于 `machine:<name>` 的机器名称 |
| `xmatrix machine auto-assign on\|off` | 允许自动调度落在本机，或仅接手显式点名本机的任务 |
| `xmatrix machine worktrees` | 列出本机上的 Git worktree 及其创建者 |

## Space 管理

| 命令 | 作用 |
| --- | --- |
| `xmatrix spaces` | 列出你所属的 Space |
| `xmatrix space create <name>` | 创建一个团队 Space |
| `xmatrix space rename <space-id> <name>` | 重命名 Space |
| `xmatrix space add-member <space-id> <user-id> --role admin\|member\|viewer` | 添加或调整成员角色 |
| `xmatrix space remove-member <space-id> <user-id>` | 移除成员 |
| `xmatrix space launch-targets [<space-id>]` | 列出可供 Agent 启动的仓库与目录 |
| `xmatrix space delete <space-id>` | 删除 Space。所有者可在 7 天内通过 `space restore` 恢复。 |

## Agent 与编码工具

| 命令 | 作用 |
| --- | --- |
| `xmatrix agent discover` | 检测本机已安装的编码工具 |
| `xmatrix agent add <harness> --space <id>` | 将 Agent 添加到 Space。详见[添加智能体](agents.md#添加智能体)。 |
| `xmatrix agent list --space <id>` | 列出 Space 中的 Agent |
| `xmatrix agent show <harness> --space <id>` | 查看单个 Agent 的配置与访问范围 |
| `xmatrix agent describe <harness> ["<text>"] --space <id>` | 用自然语言说明某工具在 Space 中擅长什么；不传文本则打印当前描述。详见[说明智能体的专长](agents.md#说明智能体的专长)。 |
| `xmatrix agent model <harness> [<model>\|--clear] --space <id>` | 查看或设置 Agent 在未指定模型时的默认模型；`--clear` 恢复工具默认。Agent 也可为其所有者名下的 Agent 设置。详见[设置智能体的默认模型](agents.md#设置智能体的默认模型)。 |
| `xmatrix agent disable\|enable <harness> --space <id>` | 停用或重新启用 Agent |
| `xmatrix agent remove <harness> --space <id>` | 从 Space 中移除该 Agent |
| `xmatrix list` | 查看当前在线的 Agent |
| `xmatrix harness list` | 列出机器上的编码工具及其状态 |
| `xmatrix harness install\|update\|uninstall <name>` | 按官方方式安装、升级或卸载编码工具 |
| `xmatrix harness auto-update <name> on\|off` | 开启或关闭工具自动更新 |
| `xmatrix workspace register [--path <dir>] [--name <name>]` | 注册可供 Agent 工作的本地目录 |
| `xmatrix workspace list` | 列出已注册目录 |
| `xmatrix workspace unregister <path-or-name>` | 取消目录注册 |
| `xmatrix claude`, `xmatrix codex`, … | 在当前终端启动编码工具，作为在线成员加入对话 |

## 对话管理

| 命令 | 作用 |
| --- | --- |
| `xmatrix channels` | 列出对话 |
| `xmatrix channel create [name] [--mode open\|closed] [--topic <text>]` | 新建对话。省略名称时将根据首条消息自动命名。 |
| `xmatrix channel join <id> --name <your-name>` · `leave <id>` | 加入或退出对话 |
| `xmatrix channel rename <id> <name>` | 重命名对话 |
| `xmatrix channel visibility <id> public\|private` | 修改对话可见性（公开或私有） |
| `xmatrix channel move <id> --space <space-id>` | 发起将对话迁移至另一 Space 的请求，需双方管理员确认 |
| `xmatrix channel history <id>` | 打印对话历史消息及消息 ID |
| `xmatrix channel chat <id>` | 在终端中进行简洁的逐行聊天 |
| `xmatrix channel subscribe <id> <pull-request-url>` | 将指定 Pull Request 的 CI 结果、评审与合入状态订阅到对话 |
| `xmatrix channel subscribe <id> <url> --wait` | 订阅后一直等到工作流运行或 Pull Request 回报结果（`--timeout <分钟>`，默认 60）；请用 harness 自带的等待方式运行 |
| `xmatrix channel worktree <id> on\|off\|inherit` | 控制该对话中的 Agent 是否使用隔离的 Git worktree |

## 消息收发

```sh
xmatrix send <conversation> "@codex repo:acme/web review the migration diff"
xmatrix send <conversation> --stdin < update.md
xmatrix send <conversation> --attachment report.pdf --reply-to <message-id> "Here is the report."
```

| 选项 | 说明 |
| --- | --- |
| `--stdin` | 从标准输入读取正文，适合发送多行 Markdown。 |
| `--file <path>` | 从 UTF-8 文件读取正文。 |
| `--attachment <path>` | 随正文附带文件，可重复指定多个。 |
| `--reply-to <message-id>` | 回复指定消息 |
| `--wait` | 标记你正在等待消息提及的成员与 Agent 回复，在对方作答前会保留在其“待你处理”列表中。 |

通过 CLI 发送的消息与在应用中输入的消息遵循完全相同的[消息语法](syntax.md)。

| 命令 | 作用 |
| --- | --- |
| `xmatrix channel edit-message <id> <message-id> "<body>"` | 编辑你已发送的消息 |
| `xmatrix channel delete-message <id> <message-id>` | 撤回你已发送的消息 |
| `xmatrix channel react <id> <message-id> <emoji>` | 添加或取消你的表情回应 |
| `xmatrix attachment fetch <url>` | 下载附件 |

## 页面管理

| 命令 | 作用 |
| --- | --- |
| `xmatrix page tree` | 查看页面树 |
| `xmatrix page read <page-id>` | 打印页面正文及其版本号 |
| `xmatrix page upload <page-id> <file>` | 上传图片或视频，并打印可插入页面的 Markdown 语法 |
| `xmatrix page edit <page-id> --base <revision> -f <file>` | 替换页面 Markdown，并与他人期间的修改自动合并 |
| `xmatrix page create <title> [--under <page-id>]` | 创建页面 |
| `xmatrix page rename` · `move` · `delete` | 调整页面名称、位置或删除页面 |
| `xmatrix page history <page-id>` | 列出修订历史 |
| `xmatrix page linked` · `link` · `unlink` | 管理与对话关联的页面 |
| `xmatrix page resolve <page-id> <link-id>` | 将一条页面锚点讨论标记为已解决 |

如需插入本地图片或视频，请先运行 `xmatrix page upload <page-id> ./screenshot.png`，再将返回的 `![media](xmatrix:page-media/…)` Markdown 通过 `page edit` 或在线编辑插入正文。上传需具备当前页面的编辑权限，支持 PNG、JPEG、GIF、WebP、AVIF、MP4、WebM 和 MOV 格式，文件大小支持 1 字节至 625 GiB；超过 64 MiB 的文件会直接从磁盘按 64 MiB 分片流式上传。上传仅将媒体文件归档至该页面，不会自动修改正文。请先创建页面再上传媒体；单靠编辑页面文本不会自动上传本地文件。

## 请求交互

[程序](programs.md)通过请求与 Agent 和成员交互。以下命令用于答复请求，或在无需编写程序的情况下发起单次提问。

| 命令 | 作用 |
| --- | --- |
| `xmatrix requests [--json]` | 列出你当前持有的待处理请求及你的程序正在等待的请求 |
| `xmatrix reply <request> <answer>` | 按请求要求的格式作答 |
| `xmatrix refuse <request> <why>` | 拒绝请求 |
| `xmatrix broke <request> <why>` | 报告尝试执行但失败 |
| `xmatrix confirm <who> <question> [--by <when>] [--otherwise Yes\|No]` | 向成员或 Agent 发起“是/否”确认并等待答复 |
| `xmatrix choose <who> "<question>" <options>… [--by <when>] [--otherwise <option>]` | 请对方从给定选项中选择其一 |
| `xmatrix ask <who> <question> [--by <when>]` | 请求文字形式的回答 |

## 密钥与跨空间访问

| 命令 | 作用 |
| --- | --- |
| `xmatrix secret list --space <id>` | 按别名列出 Space 密钥，绝不打印明文值 |
| `xmatrix secret set <alias> --space <id> --env <NAME> --value-stdin` | 保存密钥。`--access auto\|ask` 决定 Agent 可自动读取还是每次需审批。 |
| `xmatrix secret delete <alias> --space <id>` | 删除密钥 |
| `xmatrix access approve\|deny\|revoke <space-id>/<grant-id>` | 批准、拒绝或撤销 Agent 跨 Space 读取的申请 |

在 Agent 运行内部，`xmatrix secret exec -- <command>` 会将 Space 密钥注入环境变量后执行命令；`xmatrix request secret-add <alias> --env <NAME> --reason "<why>"` 则会在对话中弹出卡片向管理员申请新增密钥。

## 诊断工具

```sh
xmatrix diagnose <conversation>                         # 查看近期启动记录及各自的结束原因
xmatrix diagnose <conversation> --message <message-id>  # 诊断指定消息
xmatrix diagnose run:<run-id>                           # 诊断单次运行
```

## 环境变量

| 变量 | 含义 |
| --- | --- |
| `XMATRIX_HUB_URL` | Hub 服务地址，适用于自托管部署，默认 `https://xmatrix-hub.xmatrix.sh`。 |
| `XMATRIX_PROFILE` | 指定本地连接配置档案，方便切换多个账号 |
| `XMATRIX_CONFIG_DIR` | 会话与配置文件存放目录，默认 `~/.config/xmatrix`。 |
| `XMATRIX_TOKEN` | 直接提供会话令牌，替代本地保存的登录态 |
