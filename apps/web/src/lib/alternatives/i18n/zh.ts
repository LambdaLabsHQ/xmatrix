import type { AlternativeLocaleCopy, AlternativeSlug } from "../types";

export const alternativesCopyZh: Readonly<Record<AlternativeSlug, AlternativeLocaleCopy>> = {
  raft: {
    alsoKnownAs: "原名 Slock",
    verifiedDate: "2026 年 11 月 22 日",
    metaTitle: "Raft 替代方案 (2026)：Raft vs xMatrix",
    metaDescription:
      "正在寻找 Raft (Slock) 替代方案或平替？对比 Raft vs xMatrix：用持续更新的活页面替代沉底聊天与已下线的 Wiki Agent，支持 34 种编程智能体与 40+ 个受控应用。",
    eyebrow: "Raft 替代方案 · Raft vs xMatrix",
    headline: "Raft vs xMatrix",
    lead: "Raft 把编程智能体当作群聊成员，并在 2026 年 9 月下线了 Wiki Agent。xMatrix 同样提供人与 34 种编程智能体共享的协作频道，智能体还会把完成的工作记录进全队共读的活页面，并按应用权限接入 40+ 个已连接应用。",
    productCaption:
      "在 xMatrix 中：成员与编程智能体在频道内协同工作，同时维护共享的项目活页面，不再把上下文打散在聊天刷屏和各机器本地的 MEMORY.md 里。",
    painPoints: [
      {
        title: "工作成果被困在聊天记录和单机 MEMORY.md 里",
        problem:
          "Raft 于 2026 年 9 月 24 日下线了 Wiki Agent，每个智能体只能依赖所在单机的本地 MEMORY.md 和 notes/。一旦某个智能体早期写下了错误假设，过时信息就会在交接中反复污染上下文，只能靠人工清理；而且 Free 方案的历史记录仅保留 30 天。",
        xmatrixAnswer:
          "xMatrix 把活页面作为产品的核心产出。任务落地时智能体会就地更新对应章节；如果成员正在修改某段文字，智能体会主动等待并接着成员写下的内容继续推进。",
      },
      {
        title: "Stamp 只管到 GitHub，其余运维连接器缺少统一审批面",
        problem:
          "Raft 的 Stamp 为 GitHub 推送和 PR 提供了人工审批，但真实发布软件还会频繁触及 Vercel、Cloudflare、Linear、Sentry、Gmail、Stripe 和 Google Workspace。除此之外，Raft 的智能体运行时基本处于绕过权限检查的状态。",
        xmatrixAnswer:
          "xMatrix 在 40+ 个已连接应用上统一实施按应用设置的权限（只读、先询问或读写——其中 GitHub 提供只读与读写），并通过 xmatrix secret exec 将 Space 密钥传入命令的运行环境，既不会打印出来，也不会出现在聊天中。",
      },
      {
        title: "Pro 方案仍按智能体收席位费，且绑定单台电脑",
        problem:
          "在 Raft Pro（每人每月 $10，年付 $8.80）中，每个智能体仍计为 0.1 个席位，并且与单台电脑强绑定——那台笔记本一离线，智能体就停摆。",
        xmatrixAnswer:
          "xMatrix 在你注册的所有 macOS、Windows 和 Linux 机器上原生支持 34 种编程智能体（并可通过 --runtime 接入任意自定义 CLI），智能体零席位费，按任务匹配度与机器余量自动路由。",
      },
    ],
    comparisonRows: [
      {
        dimension: "项目状态存放位置",
        xmatrix: "由智能体持续维护、并与人类协同编辑的活页面",
        competitor: "聊天话题、编号任务与单机 MEMORY.md（Wiki Agent 已下线）",
      },
      {
        dimension: "审批与密钥管控层",
        xmatrix: "40+ 个应用按应用设置权限 + Space 密钥；每台机器的所有者为每个编程智能体选择完全访问或询问模式",
        competitor: "仅 Stamp 管控 GitHub 推送/PR；本地代理令牌；运行时绕过权限",
      },
      {
        dimension: "编程智能体与定价",
        xmatrix: "34 种编程智能体（+ --runtime）；Free（终身 500 次写入）/ Pro $10/人/月（年付 $8）",
        competitor: "支持的运行时更少；Free（30 天历史）；Pro $10/席/月（年付 $8.80）+ 每个智能体 0.1 席",
      },
      {
        dimension: "路由与故障转移",
        xmatrix: "@auto 按任务匹配度与机器余量择优分配；额度触顶时跨服务商自动交接",
        competitor: "每个智能体绑定单一运行时；服务商限流或机器离线即中断",
      },
      {
        dimension: "源码开放程度",
        xmatrix: "基于 FSL-1.1-ALv2 源码可见",
        competitor: "提供源码镜像；Enterprise SSO 仍未发布",
      },
    ],
    stayWhen: [
      "你更偏爱传统的即时通讯 + 任务清单布局，且免费版 30 天不限次群聊比持续维护的项目活页面更重要。",
      "你的审批诉求仅限于通过 Stamp 管控 GitHub 推送和 PR。",
    ],
    switchWhen: [
      "团队已经厌倦翻聊天记录或排查陈旧的本地 MEMORY.md 才能弄清当前到底上线了什么。",
      "智能体需要在一个统一的 Space 密钥库下，受控地访问 Vercel、Cloudflare、Linear、Sentry、Gmail 或 Stripe。",
      "你想在多台机器上运行几十个专职或临时智能体，不想为每个智能体额外支付 0.1 席位费。",
    ],
    migrationSteps: [
      {
        title: "保留现有本地仓库与 CLI 订阅",
        detail:
          "在运行 Raft Computer 的同一批 macOS、Windows 或 Linux 主机上安装 xMatrix CLI——你原有的 Claude Code、Codex 或 Cursor 登录态全部留在本地。",
      },
      {
        title: "把置顶频道上下文升级为活页面",
        detail:
          "为每个活跃项目或产品线创建一个活页面，让所有智能体读取同一份最新决策，不再各自维护互相漂移的 MEMORY.md。",
      },
      {
        title: "将 API 令牌迁入 Space 密钥并连接应用",
        detail:
          "以只读或读写策略接入 GitHub，以“先询问”策略接入 Linear、Vercel、Cloudflare 或 Sentry，其余凭证统一存入 Space 密钥。",
      },
    ],
    faqs: [
      {
        question: "既然 Raft 和 xMatrix 都有人机共享频道，核心区别在哪里？",
        answer:
          "在 Raft 里，聊天记录和任务就是最终归档，其 Wiki Agent 已下线。在 xMatrix 里，对话只是推进工作的现场，活页面才是团队决策、当前状态与待办事项的权威记录。",
      },
      {
        question: "xMatrix 会像 Raft Pro 那样按每个智能体收取 0.1 个席位费吗？",
        answer:
          "不会。无论是 Free 还是 Pro 方案，智能体都不占席位。Pro 方案为每人每月 $10（年付 $96/人/年），每月每席包含 5,000 Agent 积分，人类成员的编辑和发消息完全免费。",
      },
      {
        question: "xMatrix 是否像 Raft 一样支持私有频道？",
        answer:
          "支持。Space 同时支持公开频道和私有频道，并配套 Space 级密钥与按应用配置的审批策略。",
      },
    ],
  },
  lody: {
    verifiedDate: "2026 年 11 月 22 日",
    metaTitle: "Lody 替代方案 (2026)：Lody vs xMatrix",
    metaDescription:
      "对比 Lody 替代方案？告别单会话 worktree 孤岛与守护进程断连，迁往 xMatrix 的多人共享频道、活页面、Space 密钥与事件驱动 Norn 程序。",
    eyebrow: "Lody 替代方案 · Lody vs xMatrix",
    headline: "Lody vs xMatrix",
    lead: "Lody 围绕孤立的“单会话单 worktree”线程组织工作，并通过闭源云中继同步。xMatrix 将团队成员与 34 种编程智能体汇聚到同一个共享频道，由智能体随工作落地保持活页面最新，并配备 Space 密钥与事件驱动的 Norn 程序。",
    productCaption:
      "在 xMatrix 中：不必把孤立的编码会话传来传去，多名成员与 34 种编程智能体直接在同一个频道协作，并将交付成果沉淀到活页面。",
    painPoints: [
      {
        title: "以单会话为中心的交互缺少共享团队频道与活页面",
        problem:
          "Lody 的核心是个人编码会话及其子会话树；虽然可以把会话移交给同事，但多人多智能体共享频道、成员 @提及与共享活页面仍停留在路线图，而非核心工作流。",
        xmatrixAnswer:
          "xMatrix 从第一天起就支持多名成员与多个智能体同处一个频道，智能体会把完成的工作写回跟踪项目真相的共享活页面。",
      },
      {
        title: "跨设备守护进程心跳掉线与 worktree 锁冲突",
        problem:
          "社区反馈与 GitHub 追踪记录（LodyAI/Lody 当前有 334 个未关闭 Issue，包括持续跟踪桌面端日常回归的 #507）频繁反映远程 npx lody 守护进程断连、登录链接超时、并发 Git worktree 锁冲突以及 ACP 聊天记录卡死。",
        xmatrixAnswer:
          "xMatrix 将 Hub 状态权威与本地守护进程执行清晰解耦，采用有界结果发件箱与显式运行生命周期转换，断线重连后可干净恢复，不会遗留悬空状态。",
      },
      {
        title: "缺少工作区密钥、应用审批策略与 Webhook 自动化",
        problem:
          "Lody 的权限只按会话隔离，没有工作区密钥库，缺少面向运维服务的按应用审批治理，定时任务也不支持入站 Webhook 事件触发。",
        xmatrixAnswer:
          "xMatrix 提供运行时注入的 Space 密钥、覆盖 40+ 个连接器的按应用审批控制，以及嵌入页面内、支持定时或 GitHub/Sentry 外部事件触发的 Norn 程序。",
      },
    ],
    comparisonRows: [
      {
        dimension: "核心协作单元",
        xmatrix: "由多人多智能体频道驱动的活页面",
        competitor: "独立会话与子会话树（每会话一个 worktree）",
      },
      {
        dimension: "密钥与外部运维工具",
        xmatrix: "Space 级密钥（xmatrix secret exec）+ 40+ 个受控应用连接器",
        competitor: "仅限单会话权限；无工作区密钥库",
      },
      {
        dimension: "自动化触发方式",
        xmatrix: "嵌入页面中的定时与事件驱动 Norn 程序",
        competitor: "定时 cron 任务与额度重置恢复；无 Webhook 触发",
      },
      {
        dimension: "编程智能体与路由广度",
        xmatrix: "34 种编程智能体（+ --runtime），按匹配度、机器余量与额度交接智能路由",
        competitor: "暂停等待同一服务商额度窗口重置后继续",
      },
      {
        dimension: "定价",
        xmatrix: "Free（最多 3 人，终身 500 次写入）/ Pro $10/人/月（年付 $8）",
        competitor: "Free（3 人，2 工作区）/ Plus $8/人/月（年付）/ Enterprise",
      },
    ],
    stayWhen: [
      "你非常喜欢基于会话树模型的 iOS 灵动岛锁屏审批体验。",
      "团队只需要协调纯编码会话，不需要持续更新的活页面或非 Git 运维连接器。",
    ],
    switchWhen: [
      "你需要多位同事和多种编程智能体在同一个实时频道里协同，而不是来回移交单个会话。",
      "你希望项目进展沉淀在清晰可读的活页面里，并具备 Webhook 自动化和 Space 密钥。",
      "守护进程同步抖动或 worktree 锁冲突正在拖慢你的跨机远程协作。",
    ],
    migrationSteps: [
      {
        title: "用 xMatrix 守护进程注册同一批机器",
        detail:
          "保留现有的 Claude Code、Codex、Kimi 或兼容 ACP 的 CLI；xMatrix 会直接检测并注册，无需更换订阅。",
      },
      {
        title: "用项目活页面与频道替代来回切换会话",
        detail:
          "把每个活跃仓库关联到 Space 活页面，让人与智能体在同一话题协同并把确定结论写回页面。",
      },
      {
        title: "接入 GitHub、Sentry 与部署连接器",
        detail:
          "绑定外部事件源，让 Norn 程序自动唤醒智能体，无需人工逐个开启会话。",
      },
    ],
    faqs: [
      {
        question: "xMatrix 是否也像 Lody 一样在我自己的机器上运行编程智能体？",
        answer:
          "是的。编程智能体直接运行在你自己注册的 macOS、Windows、Linux 电脑（或自有服务器）上的代码目录和仓库里。",
      },
      {
        question: "面对模型服务商限流，xMatrix 与 Lody 的处理有什么不同？",
        answer:
          "Lody 只能暂停等待原服务商额度重置，而 xMatrix 可以把当前对话与上下文自动交接给另一套可用工具——例如从 Claude Code 平滑交接给 Codex 或 Gemini。",
      },
      {
        question: "xMatrix 的同步服务端也像 Lody 一样完全闭源吗？",
        answer:
          "xMatrix 在 FSL-1.1-ALv2 协议下公开了 Hub、Web、CLI 与客户端完整源码，但官方以自助托管云服务形式提供，而非自部署发行包。",
      },
    ],
  },
  multica: {
    verifiedDate: "2026 年 11 月 22 日",
    metaTitle: "Multica 替代方案 (2026)：Multica vs xMatrix",
    metaDescription:
      "正在评估 Multica 替代方案或寻找类似 Multica 的平替工具？告别无头工单运行、静默丢弃 bypassPermissions 限制 (#9559) 与明文环境变量，升级到 xMatrix 实时频道、活页面与 Space 密钥。",
    eyebrow: "Multica 替代方案 · Multica vs xMatrix",
    headline: "Multica vs xMatrix",
    lead: "Multica 迫使每项智能体任务都变成默认开启 bypassPermissions 的无头看板工单，且没有活页面文档层。xMatrix 让团队成员与 34 种编程智能体在频道中实时协作（也可以用 xmatrix claude 在你自己的终端里启动 Claude Code，作为频道成员加入），由智能体持续更新活页面，并以 Space 密钥统一管控 40+ 个外部应用。",
    productCaption:
      "在 xMatrix 中：与同事一起在共享频道实时引导 Claude Code、Codex 及其他 32 种编程智能体，配合显式应用审批与活页面，替代盲跑的无头看板任务。",
    painPoints: [
      {
        title: "默认强制 bypassPermissions、静默丢弃权限限制与服务端明文环境变量",
        problem:
          "Multica 默认以 --permission-mode bypassPermissions 启动 Claude Code、以 full-auto 启动 Codex，并将服务端环境变量以明文存储。社区缺陷 #9559 更暴露出 custom_args 会静默丢弃用户自定义的 --permission-mode 限制。",
        xmatrixAnswer:
          "xMatrix 对 40+ 个已连接应用统一实施按应用设置的只读、先询问或读写权限，并通过 xmatrix secret exec 将 Space 密钥传入命令的运行环境，绝不会出现在聊天记录中。每台机器的所有者在添加编程智能体时，为其选择完全访问或先询问模式。",
      },
      {
        title: "万事皆须建无头工单——缺少共享频道与交互式会话挂载",
        problem:
          "Multica 的应用内聊天严格限定为私密 1 对 1，核心工作流要求把一切工作都变成无头看板工单。既不支持中途纠偏智能体，也无法把正在运行的本地终端会话直接拉进团队讨论。",
        xmatrixAnswer:
          "xMatrix 让成员与 34 种编程智能体在共享频道里实时配合——执行 xmatrix claude 还能在你的终端里启动 Claude Code，作为频道的实时成员，同时由智能体把成果写回活页面。",
      },
      {
        title: "没有活页面或内置项目记忆",
        problem:
          "Multica 只管理工单与技能，不沉淀持续演进的项目状态——社区提出的记忆功能需求 (#838) 自 2026 年 4 月起一直悬而未决，关键决策散落在大量已关闭的工单里。",
        xmatrixAnswer:
          "活页面是每个 xMatrix Space 的内置核心。每条决策只写一次，支持人机共编（带建议模式与按段落归属标注），并由真正干活的智能体保持最新。",
      },
    ],
    comparisonRows: [
      {
        dimension: "协作模式",
        xmatrix: "多人多智能体共享实时频道 + 终端内的 xmatrix claude + 活页面",
        competitor: "看板工单 + 仅无头后台运行 + 仅私密 1 对 1 聊天",
      },
      {
        dimension: "外部操作与密钥安全",
        xmatrix: "40+ 个应用按应用设置权限 + 传入命令运行环境的 Space 密钥，绝不显示在聊天中",
        competitor: "默认 bypassPermissions (#9559)；服务端明文环境变量；MCP schema 审批",
      },
      {
        dimension: "活页面文档",
        xmatrix: "原生活页面由智能体维护；支持建议模式、作者归属与无锁协同编辑",
        competitor: "无（记忆功能需求 #838 仍未实现）",
      },
      {
        dimension: "支持的编程智能体",
        xmatrix: "34 种内置编程智能体（+ --runtime 接入任意自定义 CLI）",
        competitor: "28 种 CLI 运行时",
      },
      {
        dimension: "外部运维连接器",
        xmatrix: "40+ 个原生连接器（GitHub、Linear、Vercel、Cloudflare、Sentry、Gmail、Stripe 等）",
        competitor: "IM 桥接（Slack、飞书、钉钉、企业微信、Telegram）+ MCP 插件",
      },
    ],
    stayWhen: [
      "你的组织硬性要求在内网自托管 Go + PostgreSQL 架构的工单看板自动化系统。",
      "你的每一项工作本来就是独立看板工单，且重度依赖钉钉、企业微信或飞书触发。",
    ],
    switchWhen: [
      "你需要与同事及多个编程智能体实时互动、随时纠偏，而不是把任务扔进无头工单盲跑。",
      "生产发布或运维工具绝对无法接受服务端明文环境变量和 bypassPermissions 默认配置。",
      "你希望项目决策与未决事项由智能体维护在活页面里，而非埋在已关闭的工单评论里。",
    ],
    migrationSteps: [
      {
        title: "接入现有开发机",
        detail:
          "在运行 Multica 守护进程的同一批机器上安装 xMatrix CLI；再用 xmatrix agent add 添加本地已配好的 Claude Code、Codex 和 Cursor。",
      },
      {
        title: "把周期性 Autopilot 任务迁入页面 Norn 程序",
        detail:
          "把定时和事件驱动任务直接写进它所维护的项目活页面里，每次执行完自动把状态更新在大家查阅的地方。",
      },
      {
        title: "用 Space 密钥替代明文环境变量",
        detail:
          "将敏感令牌存入 xMatrix Space 密钥，并为 GitHub（只读或读写）以及 Linear、Sentry 或 Vercel 配置明确的审批策略。",
      },
    ],
    faqs: [
      {
        question: "从 Multica 看板迁出后，还能继续搭配 Linear 或 GitHub Issues 使用吗？",
        answer:
          "完全可以。xMatrix 原生连接 GitHub 和 Linear，智能体可以直接读取 Issue、提交 PR 并同步更新项目活页面，不必放弃你现有的任务追踪工具。",
      },
      {
        question: "xMatrix 会强制让 Claude Code 以 bypassPermissions 运行吗？",
        answer:
          "不会。添加编程智能体时，由其所在机器的所有者选择访问方式：完全访问（对 Claude Code，xMatrix 会加上 --dangerously-skip-permissions）或询问模式，此时每个权限请求都会在频道中征询。已连接应用另行支持只读、先询问和读写，Space 密钥的值也绝不会出现在聊天中。",
      },
      {
        question: "在 xMatrix 里可以多名成员一起围观并中途纠偏同一个智能体吗？",
        answer:
          "可以。所有成员与智能体同处一个频道，实时查看执行轨迹与审批卡片，并共同编辑关联活页面。",
      },
    ],
  },
  paradev: {
    alsoKnownAs: "原名 Superset",
    verifiedDate: "2026 年 11 月 22 日",
    metaTitle: "Paradev / Superset 替代方案 (2026)：对比 xMatrix",
    metaDescription:
      "寻找 Paradev (Superset) 平替或替代品？在 macOS、Windows、Linux 和 Android 上以 $10/席运行编程智能体团队，配共享频道、活页面与 40+ 个应用审批。",
    eyebrow: "Paradev (Superset) 替代方案 · Paradev vs xMatrix",
    headline: "Paradev vs xMatrix",
    lead: "Paradev（2026 年 10 月由 Superset 更名）以 macOS 优先、团队版飙升至每人每月 $60，且开启远程中继等同于暴露整台主机。xMatrix 覆盖 macOS、Windows、Linux、Android 与 Web，以每人每月 $10 提供共享频道、活页面与 40+ 个受控应用连接器。",
    productCaption:
      "在 xMatrix 中：通过整洁的频道与活页面统筹数十个并行智能体任务，不再在 20 个终端分屏间疲于奔命。",
    painPoints: [
      {
        title: "终端与 worktree 蔓延把瓶颈转嫁给了你的注意力",
        problem:
          "Product Hunt 和 Reddit 上的开发者虽然认可 Paradev 的并行 worktree 能力，但普遍吐槽同时盯几十个独立终端、diff 面板和重叠分支带来严重的视觉噪点与审查疲劳——外加底层 LLM 账单飙升且云端自动化没有内置消费上限。",
        xmatrixAnswer:
          "xMatrix 将监督视角从“紧盯每个终端”反转为“只看项目活页面”。对话在后台并行推进，你只需扫一眼页面，在需要拍板或处理异常时再点进话题。",
      },
      {
        title: "远程与团队协作高达 $20–$60/席的陡峭门槛",
        problem:
          "尽管 Paradev 本地客户端开源免费（MIT），但远程功能需升级 Pro（$20/人/月，年付 $192），团队协作更是跳涨至 $60/人/月——而这还是在你已有 Anthropic 和 OpenAI 订阅之外的额外支出。",
        xmatrixAnswer:
          "xMatrix Pro 仅需每人每月 $10（年付 $8/月），不限智能体数量，每席含 5,000 Agent 积分，开箱即享多机协作频道，没有额外的团队档加价。",
      },
      {
        title: "开启中继即暴露整台机器，且缺少 Space 密钥与运维连接器",
        problem:
          "Paradev 缺少 Space 级密钥库和跨应用审批治理层；一旦向同事开放远程主机中继权限，实质上几乎开放了整台宿主机的访问面。",
        xmatrixAnswer:
          "xMatrix 在你注册的仓库和目录中启动智能体，由每台机器的所有者为每个编程智能体选择完全访问或先询问模式，将 Space 密钥传入命令而不打印出来，并对 40+ 个连接器统一执行按应用设置的权限。",
      },
    ],
    comparisonRows: [
      {
        dimension: "团队定价",
        xmatrix: "每人每月 $10（年付 $8/月）；3 人以内免费（终身 500 次写入）",
        competitor: "Free（1 人本地）/ Pro $20/人/月 / Team $60/人/月（含 150 云小时）",
      },
      {
        dimension: "核心工作流",
        xmatrix: "共享频道 + 智能体随工作落地更新的活页面",
        competitor: "并行 IDE / worktree 工作台 + 带锚点评论的发布页",
      },
      {
        dimension: "智能体运行位置",
        xmatrix: "你自己的 macOS、Windows、Linux 机器（台式机、笔记本或自有服务器）",
        competitor: "macOS 优先的本地 IDE、远程 SSH/中继主机，或 Vercel 云端沙箱",
      },
      {
        dimension: "密钥与运维应用",
        xmatrix: "Space 级密钥库 + 40+ 个带按应用审批策略的连接器",
        competitor: "行内跨工作区审批；无 Space 密钥；仅开发类触发器",
      },
      {
        dimension: "多人实时群聊",
        xmatrix: "原生多人多智能体公开与私有频道",
        competitor: "工作区与页面评论；缺少多人多智能体团队频道",
      },
    ],
    stayWhen: [
      "你明确需要 Paradev 开箱即用的 Vercel 云端沙箱，希望合上笔记本盖子后无需自备云主机也能继续跑任务。",
      "你偏爱以可视化 worktree diff 和页面元素锚点评论为核心的 IDE 风格桌面应用。",
    ],
    switchWhen: [
      "在 Claude/Codex 订阅之外还要按人头再交 $20–$60/月来协调自有机器，成本过高。",
      "你希望 20 个并行线程中的智能体把结果写进活页面，而不是在 20 个终端标签页之间来回切换。",
      "你的智能体除了操作 Git worktree，还需要受控地联动 Cloudflare、Vercel、Gmail、Stripe、Sentry 或 Google Workspace。",
    ],
    migrationSteps: [
      {
        title: "将你的 macOS、Linux 或 Windows 主机注册进 xMatrix",
        detail:
          "把现有工作站或你自己的常在线 Linux 服务器统一接入同一个 Space，不再受限于 macOS 优先客户端。",
      },
      {
        title: "用项目活页面替代多标签巡检",
        detail:
          "在与活页面关联的频道中召唤智能体，让它们把每个 PR、测试结果和决策写回该页面。",
      },
      {
        title: "集中管理凭证与应用权限",
        detail:
          "为已连接应用设置只读或先询问策略，并将共享令牌统一托管到 Space 密钥。",
      },
    ],
    faqs: [
      {
        question: "xMatrix 提供类似 Paradev Team 的托管云端沙箱吗？",
        answer:
          "目前不提供——xMatrix 在你自主掌控的电脑和云主机（macOS、Windows、Linux）上运行编程智能体。如果你手头已有常在线的 VPS 或构建机，xMatrix 可以把它和你的笔记本无缝编排在一起。",
      },
      {
        question: "xMatrix 如何避免 Paradev 的多终端视觉杂乱？",
        answer:
          "你不必逐个翻看几十个原始终端面板；智能体会把每条对话的结果写回关联的活页面，你在那里就能通览最新进展。",
      },
      {
        question: "Superset 就是现在的 Paradev 吗？",
        answer:
          "是的。Superset 已于 2026 年 10 月正式更名为 Paradev（GitHub 仓库 ParadevAI/Paradev）。本页全部价格与架构对比均核实于 2026 年 11 月 22 日。",
      },
    ],
  },
  conductor: {
    verifiedDate: "2026 年 11 月 22 日",
    statusNote: "已于 2026 年 11 月被 Meta 收购——Conductor Cloud 已于 2026 年 11 月 20 日正式关停。",
    metaTitle: "Conductor 替代方案：Meta 关停云端后迁往 xMatrix (2026)",
    metaDescription:
      "Conductor 已被 Meta 收购并于 2026 年 11 月 20 日关停云端服务。寻找 Conductor 平替？立即迁往 xMatrix，在 macOS、Windows 与 Linux 上以 $10/席继续运行 Claude Code 与 Codex 团队。",
    eyebrow: "Conductor 替代方案 · Meta 收购后迁移指南",
    headline: "Meta 关停后迁出 Conductor",
    lead: "Meta 于 2026 年 11 月收购 Conductor 后停止了新用户注册，并于 2026 年 11 月 20 日永久关停 Conductor Cloud，仅对 macOS 独占的本地应用维持有限维护至 2027 年初。xMatrix 是持续迭代、独立运营的家园，让你在 macOS、Windows 和 Linux 上继续运行 34 种编程智能体，并将团队上下文沉淀在活页面中。",
    productCaption:
      "在 xMatrix 中：把从 Conductor 导出的仓库与现有的 Claude Code / Codex 账号直接带入跨平台工作区，覆盖 macOS、Windows、Linux、Android 与 Web。",
    painPoints: [
      {
        title: "Conductor Cloud 已经关停，产品路线图进入收尾期",
        problem:
          "随着 Meta 在 2026 年 11 月完成收购，Conductor Cloud 于 11 月 13 日转为只读并于 11 月 20 日永久下线。新用户已无法注册，随着原团队并入 Meta Superintelligence Labs，本地应用也仅维持关键修复至 2027 年初。",
        xmatrixAnswer:
          "xMatrix 保持高频独立研发，源码基于 FSL-1.1-ALv2 公开可见，面向长期运作的独立团队提供透明自助定价，不依附于巨头收购。",
      },
      {
        title: "macOS 独占锁定长期把 Windows 与 Linux 同事拒之门外",
        problem:
          "在独立运营的整个周期内，Conductor 从未推出原生 Windows 或 Linux 支持，迫使混合系统研发团队拆分工具链，甚至为共享工作区额外采购 Mac。",
        xmatrixAnswer:
          "xMatrix 覆盖 macOS、Windows、Linux、iPhone 与 iPad、Android 与 Web。你可以把 Linux 构建服务器、Windows 开发机和 MacBook 直接编排进同一个 Space。",
      },
      {
        title: "缺少项目活页面，且关停前高达 $50–$60/月",
        problem:
          "Conductor 关停前 Pro 定价 $50/月、Teams 高达 $60/人/月，超长对话日志还容易导致界面卡顿，且知识沉淀在孤立工作区里而非共享活页面中。",
        xmatrixAnswer:
          "xMatrix Pro 仅每人每月 $10（年付 $8/月），支持 34 种编程智能体且不限数量，由智能体把完成的工作记录进活页面，同时带来 40+ 个受控应用连接器与 Space 密钥。",
      },
    ],
    comparisonRows: [
      {
        dimension: "产品状态（2026 年 11 月）",
        xmatrix: "独立活跃迭代、开放注册、源码可见",
        competitor: "已被 Meta 收购；Cloud 于 2026 年 11 月 20 日关停；已停止新注册",
      },
      {
        dimension: "支持操作系统",
        xmatrix: "macOS、Windows、Linux、iPhone 与 iPad、Android 及 Web",
        competitor: "仅 macOS 与 iOS；无原生 Windows 或 Linux 支持",
      },
      {
        dimension: "定价",
        xmatrix: "Free 方案（终身 500 次写入）+ Pro $10/人/月（年付 $8/月）",
        competitor: "此前为 Pro $50/月、Teams $60/人/月（关停时已退款）",
      },
      {
        dimension: "多智能体产出形态",
        xmatrix: "活页面 + 覆盖 34 种编程智能体的多人共享频道",
        competitor: "并行 worktree 会话与 diff 视图",
      },
      {
        dimension: "权限治理与连接器",
        xmatrix: "40+ 个应用按需配置权限策略 + Space 密钥",
        competitor: "本地智能体以完整系统用户权限运行；无运维审批面",
      },
    ],
    stayWhen: [
      "你已经把 Conductor Cloud 工作区导出到 Mac 本地，只打算把它当作 2027 年初前的短期过渡。",
    ],
    switchWhen: [
      "11 月 20 日 Conductor Cloud 关停后，你现在就需要一个活跃的跨机工作区继续跑 Claude Code 和 Codex。",
      "团队中除了 Mac 之外还有 Windows 或 Linux 开发机与服务器。",
      "你想要 $10/席定价、项目活页面，以及 GitHub、Linear、Vercel、Cloudflare 等受控连接器。",
    ],
    migrationSteps: [
      {
        title: "直接沿用从 Conductor 导出的本地仓库",
        detail:
          "如果你执行过 Conductor 的「Transfer to local」导出，Git 仓库和分支已经在磁盘上了——xMatrix 可以直接面向这些目录工作。",
      },
      {
        title: "连接你的机器与现有订阅",
        detail:
          "在 Mac、Linux VPS 或 Windows 主机上安装 xMatrix CLI，用 xmatrix agent add 接入已有的 Claude Code、Codex 或 Cursor。",
      },
      {
        title: "创建团队 Space 并连接 GitHub",
        detail:
          "邀请同事加入，为每条产品线建立活页面，从此摆脱 macOS 锁定和单家厂商关停风险。",
      },
    ],
    faqs: [
      {
        question: "从 Conductor Cloud 导出的工作区能直接迁进 xMatrix 吗？",
        answer:
          "可以。任何已导出到本地或托管在 GitHub 的 Git 仓库都可以立刻注册到 xMatrix 中，继续使用你原本付费的 Claude Code 和 Codex 订阅。",
      },
      {
        question: "xMatrix 除了 macOS 外也支持 Windows 和 Linux 吗？",
        answer:
          "支持。不同于 Conductor 的 macOS 独占客户端，xMatrix 允许 macOS、Windows 和 Linux 机器接入同一个 Space，并提供 Web、iPhone 与 iPad 以及 Android 客户端。",
      },
      {
        question: "xMatrix 会像曾经的 Conductor Cloud 那样提供托管云虚拟机吗？",
        answer:
          "目前不会——xMatrix 连接的是你自己掌控的笔记本、办公服务器或自有云主机（如 Fly、AWS、Hetzner），因此任何外部云服务关停都不会抹掉你的工作环境。",
      },
    ],
  },
  orca: {
    verifiedDate: "2026 年 11 月 22 日",
    metaTitle: "Orca 替代方案 (2026)：Orca vs xMatrix",
    metaDescription:
      "对比 Orca (stablyai/orca) 替代方案与团队平替？告别单机内存飙升、8,900+ 未关闭 Issue 与脆弱的局域网扫码配对，迁往 xMatrix 多人频道与活页面。",
    eyebrow: "Orca 替代方案 · Orca vs xMatrix",
    headline: "Orca vs xMatrix",
    lead: "Orca 是一款热门的开源单人 ADE，擅长把单条提示词扇出到多个本地并行 worktree，但多人协作 UI 至今缺失，将一条提示词扇出给 N 个智能体会成倍放大 Token 消耗，重度并发还容易打爆本机内存。xMatrix 从 34 种编程智能体中为每项任务路由最合适的一位，并持续为全队更新活页面。",
    productCaption:
      "在 xMatrix 中：把并行编码任务分散到你名下的所有机器上，避免内嵌浏览器吃光内存，并在桌面或手机上清爽掌控全局。",
    painPoints: [
      {
        title: "仍是单人工具——缺少共享频道、团队身份与 Space 密钥",
        problem:
          "Orca 为单名开发者本地指挥多路智能体而生；多人界面至今未上线，实验性的 Slack/Discord 桥接仅把同事消息当作被动上下文，也没有 Space 级密钥库或按应用审批层。",
        xmatrixAnswer:
          "xMatrix 原生面向多人协作。多名同事与多个智能体共享公开或私有频道，按应用策略审批外部操作，并安全共用 Space 密钥。",
      },
      {
        title: "本机资源飙升、崩溃积压与界面状态漂移",
        problem:
          "stablyai/orca 当前积压了 8,988 个未关闭 Issue（其中 100+ 涉及崩溃），用户高频反馈并行 xterm 加内嵌 Chromium 导致内存与 CPU 飙升、开发助手权限报错 (#26498)、界面假死把仍在改文件的任务误标为「已完成」，以及一条提示词扇出 4–5 个智能体飞速烧干额度。",
        xmatrixAnswer:
          "xMatrix 不在每个面板里塞入浏览器进程，也不鼓励浪费额度的盲目扇出。智能体在最合适的已注册机器上干净运行，上报清晰的状态流转，并把结果写进易读的活页面。",
      },
      {
        title: "脆弱的局域网移动端配对，且没有活页面项目记忆",
        problem:
          "Orca 移动端依赖局域网端到端加密扫码配对，在企业 VPN 或隔离 Wi-Fi 环境下经常断联；而且任务结束后不会沉淀出持续维护的项目 Wiki。",
        xmatrixAnswer:
          "xMatrix 通过 Hub 在蜂窝网络、企业 VPN 或桌面端都能稳定中继，智能体还会把完成的工作记录进团队在 Web、桌面和手机上随时可查的活页面。",
      },
    ],
    comparisonRows: [
      {
        dimension: "多人协作与权限",
        xmatrix: "多人多智能体频道、角色权限、Space 密钥、按应用审批",
        competitor: "单人桌面 ADE；多人 UI 未发布；无共享密钥",
      },
      {
        dimension: "项目活页面状态",
        xmatrix: "智能体随工作落地更新活页面；与成员无锁协同编辑",
        competitor: "Worktree diff 与实验性 DAG 编排；无活页面",
      },
      {
        dimension: "移动端与远程访问",
        xmatrix: "经 Hub 稳定中继，覆盖 Web、桌面端、iPhone 与 iPad 以及 Android 应用，无惧 VPN",
        competitor: "局域网扫码配对，易受企业 VPN 与防火墙阻断",
      },
      {
        dimension: "路由与 Token 消耗",
        xmatrix: "@auto 按任务匹配度、CPU/内存与额度余量挑选一个智能体",
        competitor: "单提示词扇出到 N 个并行 worktree，成倍放大 Token 消耗",
      },
      {
        dimension: "运维应用连接器",
        xmatrix: "40+ 个连接器按应用配置权限策略 + Space 密钥",
        competitor: "实验性 Slack/Discord 上下文桥接；无运维审批层",
      },
    ],
    stayWhen: [
      "你是独立开发者，特别需要把同一条提示词同时发给四个模型并借助内嵌浏览器横向对比视觉 diff。",
      "你要求 100% MIT 许可的纯本地桌面 IDE，完全不经过任何托管 Hub。",
    ],
    switchWhen: [
      "你需要与同事在同一个工作区里拥有各自独立身份、通知提醒与操作审批。",
      "本地内嵌浏览器与多路 worktree 正在榨干笔记本内存，或疯狂烧掉 Claude/OpenAI 额度。",
      "你需要跨 VPN/蜂窝网络稳定可用的移动端控制，以及能看清项目进展的活页面。",
    ],
    migrationSteps: [
      {
        title: "把工作站与闲置构建机一起接入",
        detail:
          "在同一个 xMatrix Space 中将任务分摊到 MacBook 和 Linux 服务器，不再把所有负载压在一台笔记本内存上。",
      },
      {
        title: "沿用现有 CLI 编程智能体",
        detail:
          "通过 xmatrix agent add 一次注册 Claude Code、Codex、Kimi 或 Cursor，无需向专有运行时重新认证。",
      },
      {
        title: "将仓库关联到活页面",
        detail:
          "让智能体把 PR、CI 状态和决策沉淀到共享活页面，取代人工比对一堆原始终端标签页。",
      },
    ],
    faqs: [
      {
        question: "为什么 Orca 的 GitHub Star 数量很高，但未关闭 Issue 也这么多？",
        answer:
          "Star 反映的是关注度，而不是是否适合你的团队。Orca 是热门项目，但积压了大量未关闭 Issue；建议结合日常稳定性以及是否需要多人权限治理来综合评估。",
      },
      {
        question: "xMatrix 在企业 VPN 和手机流量下能稳定使用吗？",
        answer:
          "可以。本地守护进程主动维持到 xMatrix Hub 的出站连接，你无论身处何种网络，都能在手机上阅读页面、给智能体发消息和审批连接器操作。",
      },
      {
        question: "在 xMatrix 里依然可以同时并行跑很多智能体吗？",
        answer:
          "当然可以。数十条对话可以在一台或多台已注册机器上并行推进，智能体会把每条对话的进展与最终结果写回项目活页面。",
      },
    ],
  },
  lobehub: {
    alsoKnownAs: "原名 LobeChat",
    verifiedDate: "2026 年 11 月 22 日",
    metaTitle: "LobeHub / LobeChat 替代方案 (2026)：对比 xMatrix",
    metaDescription:
      "寻找 LobeHub 或 LobeChat 替代方案？摆脱积分转售加价、2.0 PostgreSQL/S3 部署门槛与 RAG 切片污染，用 xMatrix 协调你自己的本地编程智能体与活页面。",
    eyebrow: "LobeHub (LobeChat) 替代方案 · LobeHub vs xMatrix",
    headline: "LobeHub vs xMatrix",
    lead: "LobeHub（原 LobeChat）是靠转售模型积分变现的通用 AI 工作台，2.0 自托管技术栈沉重，且缺少多人多智能体实时频道。xMatrix 用你现有的订阅在真实代码仓库中直接运行 34 种编程智能体，配备用于设定完成条件的 Goals 与 40+ 个受控应用连接器。",
    productCaption:
      "在 xMatrix 中：直接在实时团队频道里编排你原有的 Claude Code、Codex 和 Cursor 订阅并维护活页面——零 Token 加价，也不用折腾 Docker 运维栈。",
    painPoints: [
      {
        title: "积分转售模式在长代码上下文里消耗难以预测",
        problem:
          "LobeHub Cloud 免费版（约 50 万积分）限制了大量前沿模型，付费档（$12.9 / $24.9 / $49.9 每月）全部按云端积分计费。许多开发者反馈，一旦进入长代码上下文或深度研究任务，积分池见底的速度远超预期。",
        xmatrixAnswer:
          "xMatrix 从不转售模型 Token，也不加价。编程智能体直接使用你已有的 Claude Code、Codex、Cursor 或 Gemini 订阅与 API 密钥运行，xMatrix Pro 为每人每月 $10，每席含 5,000 积分，供 Agent 与应用写入使用。",
      },
      {
        title: "2.0 架构大幅变重，原有自托管教程大面积失效",
        problem:
          "从 LobeChat 升级到 LobeHub 2.0 后，自托管强制引入 PostgreSQL、S3 兼容对象存储与全新认证流程，并转向 LobeHub Community License——导致大量 1.x Docker Compose 教程失效，引发社区对部署复杂度的普遍抱怨。",
        xmatrixAnswer:
          "使用 xMatrix 无需自建数据库或对象存储。登录账号、在机器上安装一个轻量 CLI，几分钟内就能接入现有代码仓库开始协作。",
      },
      {
        title: "缺少多人多智能体实时编码房间，且 RAG 检索易受脏切片污染",
        problem:
          "LobeHub 虽有 Agent Groups 与知识库，但用户常受困于向量检索把无关文档碎片拉进上下文；同时它没有让多名工程师与多个本地编程智能体实时协同发版的共享房间。",
        xmatrixAnswer:
          "xMatrix 用清晰可读、实时更新的活页面取代黑盒向量切片，配合多人实时频道，让智能体精准读取当下生效的决策，而非陈旧的向量碎片。",
      },
    ],
    comparisonRows: [
      {
        dimension: "模型与 Token 计费",
        xmatrix: "自带已有订阅/密钥；Token 零加价；Pro 仅 $10/人类席位",
        competitor: "云端转售模型积分（$12.9–$49.9/月）；免费档限制前沿模型",
      },
      {
        dimension: "多人多智能体协作房间",
        xmatrix: "原生公开/私有频道，支持多名同事与多种本地编程智能体同框协作",
        competitor: "由主智能体编排的 Agent Groups；通过 Discord/Slack/飞书接入外部机器人",
      },
      {
        dimension: "知识沉淀机制",
        xmatrix: "人与智能体原地共编的 Markdown 活页面",
        competitor: "向量知识库（易受切片污染）+ 带编辑锁的页面",
      },
      {
        dimension: "部署与维护负担",
        xmatrix: "托管 Hub + 本机单个原生 CLI 守护进程",
        competitor: "云端 SaaS 或自建 PostgreSQL + S3 + 认证服务栈（2.0 迁移）",
      },
      {
        dimension: "交付验收与权限治理",
        xmatrix: "在支持的编程智能体上使用 Goals + 40+ 个受控连接器",
        competitor: "内置交付检查；经 lh connect 接入的外部编程智能体不受权限治理",
      },
    ],
    stayWhen: [
      "你想要一个打包 40+ 托管对话模型的通用 AI 门户，用一张积分账单解决日常问答，不想分别持有 Anthropic/OpenAI 订阅。",
      "你重度依赖 LobeHub 内置的 Discord、Telegram、微信和飞书消费级机器人绑定，或按成员/智能体细分的预算看板。",
    ],
    switchWhen: [
      "你已经在为 Claude Code、Codex 或 Cursor 付费，不想再为长代码上下文支付二次积分加价。",
      "你希望工程师和 34 种编程智能体在实时频道协同，并维护权威活页面，而不是天天排查 RAG 召回偏差。",
      "你不想仅仅为了协调本地编程智能体，去长期运维一整套 PostgreSQL + S3 自托管服务。",
    ],
    migrationSteps: [
      {
        title: "保留原生编程 CLI 与已有订阅",
        detail:
          "把 34 种编程智能体（Claude Code、Codex、Gemini、Cursor 等）直接注册进 xMatrix，停止为托管积分池重复付费。",
      },
      {
        title: "将静态知识库升级为活页面与 Goals",
        detail:
          "把核心架构说明与待办事项迁入 xMatrix 活页面由智能体持续同步，并用 xmatrix goal 设定完成条件，让运行持续推进直至达成。",
      },
      {
        title: "按应用治理接入运维服务",
        detail:
          "以只读或读写规则连接 GitHub，并以只读 / 先询问 / 读写规则接入 Linear、Vercel、Cloudflare、Sentry 或 Gmail。",
      },
    ],
    faqs: [
      {
        question: "xMatrix 会像 LobeHub Cloud 那样转售模型积分吗？",
        answer:
          "不会。你的智能体完全使用你自己的订阅或 API 密钥运行。xMatrix Pro（每人每月 $10）每席含 5,000 积分，用于 Agent 与应用消息、Agent 页面修订及付费 X API 操作——绝不转售 LLM Token。",
      },
      {
        question: "xMatrix 如何避免 LobeHub 知识库的检索污染问题？",
        answer:
          "xMatrix 不把文档切成不透明的向量块，而是组织成结构简洁的活页面，支持按大纲和章节精准读写，智能体每次都能准确读取最新章节。",
      },
      {
        question: "xMatrix 也支持按工具审批和密钥管理吗？",
        answer:
          "支持。已连接应用支持只读、先询问和读写权限（GitHub：只读或读写），Space 密钥在命令运行时传入其运行环境，不会被打印，也不会出现在聊天中。",
      },
    ],
  },
  cumora: {
    verifiedDate: "2026 年 11 月 22 日",
    metaTitle: "Cumora 替代方案 (2026)：Cumora vs xMatrix",
    metaDescription:
      "对比 Cumora (yetone/cumora) 替代方案？让编程智能体直接在你的真实本地仓库工作，告别离线沙箱拦截 (#350)、bwrap 报错与邀请制预览。",
    eyebrow: "Cumora 替代方案 · Cumora vs xMatrix",
    headline: "Cumora vs xMatrix",
    lead: "Cumora 把人格化智能体引入了团队群聊，但将本地 BYOA 运行锁在脱离真实工作目录的离线沙箱里，频繁遭遇 Bubblewrap 和 CDN 拉取报错 (#350)，且仍处于邀请制预览阶段。xMatrix 直接在你的代码仓库中运行 34 种编程智能体，并通过 40+ 个受控连接器与活页面持续交付。",
    productCaption:
      "在 xMatrix 中：无需邀请码、没有离线沙箱墙——你本地真实的 Claude Code 和 Codex 直接在你的仓库里与团队协同。",
    painPoints: [
      {
        title: "离线沙箱墙打断真实开发流与 CDN 资源拉取",
        problem:
          "Cumora 的 BYOA 模式将本地 CLI 关在默认禁止出网的隔离沙箱里——导致拉取依赖包、查外部文档甚至读取自身聊天附件都失败（Issue #350），同时把智能体挡在你真实的工作目录之外。",
        xmatrixAnswer:
          "xMatrix 让智能体直接在你显式注册的本机仓库和目录中运行，完整兼容本地工具链、Git 远端与测试套件。",
      },
      {
        title: "Bubblewrap 启动报错、云端与本地行为漂移及移动端缺失",
        problem:
          "用户频繁遇到本地 bwrap 启动失败、Cumora Cloud Kubernetes FUSE 容器与本地 BYOA 行为不一致，以及移动端多处仍显示「coming soon」占位符——而且仓库自 2026 年 11 月 1 日后再无新提交。",
        xmatrixAnswer:
          "xMatrix 在 macOS、Windows、Linux、iPhone 与 iPad、Android 与 Web持续发布，采用统一可靠的本地机器执行模型与经过生产验证的发版节奏。",
      },
      {
        title: "缺少面向发布与运维的受控应用连接器",
        problem:
          "Cumora 内置了聊天、文档、看板和日历原语，但缺少覆盖 GitHub、Vercel、Cloudflare、Linear、Sentry、Gmail 和 Stripe 的跨应用审批面与 Space 密钥库。",
        xmatrixAnswer:
          "xMatrix 原生连接 40+ 个研发与业务应用，统一提供按应用细分的权限策略以及 Space 级密钥管理。",
      },
    ],
    comparisonRows: [
      {
        dimension: "本地智能体工作位置",
        xmatrix: "直接在你注册的真实本地仓库与工具链中运行 34 种编程智能体",
        competitor: "运行在 Cumora 自带离线沙箱中（阻断出网拉取，#350）",
      },
      {
        dimension: "开放度与迭代节奏",
        xmatrix: "开放自助注册 Free（终身 500 次写入）与 Pro 方案；日常高频迭代",
        competitor: "邀请制预览；自 2026 年 11 月 1 日后无代码推送",
      },
      {
        dimension: "外部应用治理",
        xmatrix: "40+ 个连接器按应用配置权限策略 + Space 密钥",
        competitor: "仅生产部署审批；缺少对等的运维连接器审批层",
      },
      {
        dimension: "活页面文档",
        xmatrix: "人机共编的活页面，由智能体随工作落地更新",
        competitor: "围绕人格化聊天配套文档、看板与日历",
      },
      {
        dimension: "移动端与跨系统客户端",
        xmatrix: "macOS、Windows、Linux、iPhone 与 iPad、Android 及 Web",
        competitor: "以桌面/网页为主；移动端会话存在「coming soon」缺口",
      },
    ],
    stayWhen: [
      "你特别希望在 Cumora 邀请制预览期间，由 Cumora Cloud 托管 Kubernetes 容器并代付推理费用。",
      "你偏爱把人格化聊天智能体彻底隔离在与本地仓库无关的零网络沙箱中。",
    ],
    switchWhen: [
      "你希望智能体直接在真实代码仓库、依赖环境和测试套件中干活，不被离线沙箱处处拦截。",
      "你现在就需要一个开放、稳定且持续发版的生产级工作区，而不是排队等邀请码。",
      "你需要在同一个 Space 里受控联动 GitHub、Linear、Vercel、Cloudflare、Sentry 与 Gmail。",
    ],
    migrationSteps: [
      {
        title: "免排队立即开用",
        detail: "创建免费的 xMatrix Space，最多 3 人，智能体数量不限。",
      },
      {
        title: "注册现有本地仓库与编程智能体",
        detail:
          "在 Mac、Linux 或 Windows 主机上执行 xmatrix agent add，让 Claude Code、Codex 与 Cursor 直接在代码所在目录开工。",
      },
      {
        title: "将活跃项目上下文收拢进活页面",
        detail:
          "把决策、发布节奏与待办统一维护在活页面中，不再把上下文分散在人格化聊天和看板里。",
      },
    ],
    faqs: [
      {
        question: "xMatrix 会像 Cumora 那样封锁本地编程智能体的出网能力吗？",
        answer:
          "不会。智能体在你注册的本地环境中沿用常规开发网络，依赖安装、文档查询和测试套件都能正常运转；而通过已连接应用的写入操作则遵循各应用的权限设置。",
      },
      {
        question: "试用 xMatrix 需要邀请码吗？",
        answer: "不需要。xMatrix 全面开放自助注册，免费版即可支持 3 名成员和不限数量的智能体。",
      },
      {
        question: "xMatrix 只能写代码，还是也能维护文档与运营事务？",
        answer:
          "两者兼顾。智能体既能在仓库中提交代码，也能围绕发版、调研、招聘、故障响应和日常运营持续维护活页面。",
      },
    ],
  },
  "t3-code": {
    verifiedDate: "2026 年 11 月 22 日",
    metaTitle: "T3 Code 替代方案 (2026)：T3 Code vs xMatrix",
    metaDescription:
      "正在找 T3 Code 替代品或类似 T3 Code 的团队平替工具？一次性补齐真实成员身份、共享频道 (#27974)、项目活页面 (#15858)、Space 密钥与跨服务商接力 (#15846)。",
    eyebrow: "T3 Code 替代方案 · T3 Code vs xMatrix",
    headline: "T3 Code vs xMatrix",
    lead: "T3 Code 是一款出色的免费单人编码工作台，但每个环境只绑定单一账号、缺少共享项目活页面，且模型额度耗尽时会卡死在 Limited。xMatrix 为团队提供共享频道、活页面、Space 密钥，并在你的所有机器上原生运行 34 种编程智能体。",
    productCaption:
      "在 xMatrix 中：真正的多人协作频道，34 种编程智能体跨你所有的机器协同作战，持续为全队维护最新的活页面。",
    painPoints: [
      {
        title: "缺少真正的多人身份与共享团队频道",
        problem:
          "T3 Code 把每个环境绑定到单一 T3 Connect 账号——日志里所有人都是「user」，访客链接 24 小时过期且每条消息都需房主逐条审批。GitHub Discussions 中反复呼吁的团队协作需求（#27974、#12283、#27708）至今未落地，迫使不少团队转向第三方魔改分支。",
        xmatrixAnswer:
          "xMatrix 从底层即为多人多智能体 Space 设计：真实成员身份、公开与私有频道、可追溯作者的页面编辑，以及精准触达提问者的消息提醒。",
      },
      {
        title: "触达 Limited 即原地卡死，没有跨服务商自动额度接力",
        problem:
          "在 T3 Code 里，一旦 Claude 或 Codex 撞上限额，整个线程就停在 Limited，只能干等重置或手动切换。GitHub Discussions 中请求的自动跨服务商故障转移（#15846、#24453、#18949）仍未实现，用户还反映封装子任务开销加速消耗额度甚至误报 Limited。",
        xmatrixAnswer:
          "xMatrix 实时追踪各已注册工具的服务商额度窗口，当一家触顶（如 Claude Code）时自动把工作交接给另一家有余量的工具（如 Codex 或 Gemini），任务绝不中断。",
      },
      {
        title: "没有项目活页面、Space 密钥与运维连接器",
        problem:
          "T3 Code 擅长本地 diff 与模拟器，但没有共享项目记忆或活页面文档（GitHub Discussion #15858），新建线程默认 Full access，免费版 T3 Connect 通道限 3 台机器，且仅聚焦写代码而不覆盖受控运维应用。",
        xmatrixAnswer:
          "在 xMatrix 中，智能体把完成的工作记录进活页面；你可以跨 34 种编程智能体接入任意数量机器，存储 Space 级密钥，并统一管控 Vercel、Cloudflare、Sentry、Gmail 和 Stripe 等 40+ 个已连接应用。",
      },
    ],
    comparisonRows: [
      {
        dimension: "多人协作与归属记录",
        xmatrix: "完整团队 Space、成员独立身份、公开/私有频道、可追溯页面修订",
        competitor: "单用户环境；24 小时访客链接 Beta；无团队身份",
      },
      {
        dimension: "服务商撞上额度墙时",
        xmatrix: "自动跨服务商交接，完整保留未提交的本地更改",
        competitor: "停在 Limited；只能手动切换或等待重置",
      },
      {
        dimension: "项目状态与活页面",
        xmatrix: "由智能体持续维护、人机共编的活页面",
        competitor: "按线程分散的历史记录；无项目记忆或活页面文档（Discussion #15858）",
      },
      {
        dimension: "默认安全与运维治理",
        xmatrix: "由机器所有者为每个编程智能体选择完全访问或询问模式；40+ 个应用按需配置权限策略 + Space 密钥",
        competitor: "新线程默认 Full access；密钥留在单机本地；仅开发工单",
      },
      {
        dimension: "编程智能体与远程机器",
        xmatrix: "34 种编程智能体（+ --runtime），覆盖你所有的 macOS、Windows 与 Linux 机器",
        competitor: "10 种编程智能体 + ACP；T3 Connect 免费版上限 3 台机器",
      },
    ],
    stayWhen: [
      "你完全独立开发，想要一个免费的本地 IDE 工作台，看重内置 diff 审查、检查点回滚、浏览器预览和 iOS/Android 模拟器。",
      "你只需要在 1–3 台机器上免账号本地运行，不需要同事协作、活页面或非代码类应用连接器。",
    ],
    switchWhen: [
      "两名及以上成员需要在同一工作区与编程智能体协作，且需要清晰的身份归属与共享上下文。",
      "你受够了 Claude 撞上 5 小时或每周限额时整个线程卡在 Limited，而旁边的 Codex 或 Gemini 额度却闲置着。",
      "你希望把几十条线程的产出沉淀为活页面，同时安全联动 Vercel、Cloudflare、Linear、Sentry 与 Gmail。",
    ],
    migrationSteps: [
      {
        title: "保留现有本地 CLI——甚至可以通过 MCP 配合使用",
        detail:
          "xMatrix 直接复用你为 T3 Code 安装好的本地 Claude Code、Codex、Cursor、OpenCode、Grok 与 Antigravity CLI。",
      },
      {
        title: "无需捆绑 T3 Chat 即可连接超过 3 台机器",
        detail:
          "把你的笔记本、构建机和自有服务器全部注册到同一个 Space，让 @auto 自动路由到最有余量的机器与服务商。",
      },
      {
        title: "为每个项目配一份活页面",
        detail:
          "不再在每个新线程里重复交代架构决策——写进项目活页面一次，所有编程智能体都会自动读取。",
      },
    ],
    faqs: [
      {
        question: "既然 T3 Code 免费，为什么还要为 xMatrix Pro 付费？",
        answer:
          "如果你只需要在 1–3 台机器上自己用免费编码工作台，T3 Code 很合适。但当团队需要真正的多人 Space、项目活页面、自动跨服务商额度接力、Space 密钥以及 40+ 个受控运维连接器时，xMatrix 才是为此打造的平台。",
      },
      {
        question: "Claude 触顶时 xMatrix 真的会自动切换服务商吗？",
        answer:
          "是的。当一家服务商的额度窗口耗尽时，xMatrix 会自动把任务路由或交接给你已注册的另一家可用工具——而非违反条款去轮换同一厂商的多账号。",
      },
      {
        question: "我可以把 xMatrix 和 T3 Code 搭配在一起用吗？",
        answer:
          "可以。xMatrix 提供标准 MCP 服务器用于读写页面和发送频道消息，同时也直接运行在你的本地仓库上，互不锁死。",
      },
    ],
  },
  herdr: {
    verifiedDate: "2026 年 11 月 22 日",
    metaTitle: "herdr 替代方案 (2026)：herdr vs xMatrix",
    metaDescription:
      "正在评估 herdr (herdr-core) 替代方案？在 xMatrix 中即刻获得内置认证、团队权限、无需候补名单的跨设备中继、按应用审批与活页面。",
    eyebrow: "herdr 替代方案 · herdr vs xMatrix",
    headline: "herdr vs xMatrix",
    lead: "herdr 从广受喜爱的 Rust TUI 终端复用器演变为 herdr-core 与原生客户端，带来破坏性协议变更与社区对 GUI 锁定的反弹，同时仍缺少多用户认证、审批、密钥与已上线的云中继。xMatrix 今天就能给你完整的受控协作层。",
    productCaption:
      "在 xMatrix 中：桌面、网页与移动端跨设备协作今日即可使用——配备完整认证的 Space、Space 密钥与活页面，而非裸露的无认证本地套接字。",
    painPoints: [
      {
        title: "缺少身份认证、权限边界、审批与密钥管理",
        problem:
          "herdr-core 明确是一个单用户本地运行时：任何能连上其 socket 的人实际上就拥有了完整的 Shell 权限。它没有用户角色、没有操作审批、没有密钥库，也没有定时或 Webhook 自动化。",
        xmatrixAnswer:
          "xMatrix 在本地执行之上建立了完整的信任边界：可验证的人类与智能体身份、传入命令时不会被打印、也不会进入聊天的 Space 密钥、按应用审批策略以及 Norn 自动化程序。",
      },
      {
        title: "协议频繁变动、破坏性更新与从 TUI 转向 GUI 的争议",
        problem:
          "重写为 herdr-core 破坏了旧版第三方客户端，v0.9.2 移除了面板图形 API，Reddit 社区也对放弃通用 SSH TUI 转推专属图形客户端表达了强烈不满。活跃 Issue 还持续追踪 SSH stderr 串屏、macOS 主线程卡顿（os error 35）以及 systemd 单元间的 CLAUDE_CODE_* 环境变量泄漏。",
        xmatrixAnswer:
          "xMatrix 提供一体化的 Web、桌面、CLI 与移动端体验，背后有带版本契约的 Hub/CLI 兼容性保障以及清晰的逐次运行隔离。",
      },
      {
        title: "Herdr Cloud 仍在排队候补，且终端窗格不会自动维护文档",
        problem:
          "跨设备加密中继（Herdr Cloud）与官方移动端仍处于候补或开发中；即便未来上线，PTY 终端复用器依然会把所有决策埋没在滚屏日志里。",
        xmatrixAnswer:
          "xMatrix 今天就已支持覆盖 macOS、Windows、Linux、iPhone 与 iPad、Android 与 Web的跨机中继，智能体还会把完成的工作写回活页面。",
      },
    ],
    comparisonRows: [
      {
        dimension: "身份与安全边界",
        xmatrix: "完整认证的 Space、成员角色、Space 密钥、按应用审批",
        competitor: "无——能访问本地 socket 即等同拥有完整 Shell 权限",
      },
      {
        dimension: "跨设备中继与移动端",
        xmatrix: "今日即用，覆盖 macOS、Windows、Linux、iPhone 与 iPad、Android 及 Web",
        competitor: "目前需手配 SSH；Herdr Cloud 中继仍在候补名单",
      },
      {
        dimension: "成果沉淀位置",
        xmatrix: "由智能体持续维护的活页面 + 可检索频道",
        competitor: "持久化 PTY 终端回滚缓冲",
      },
      {
        dimension: "自动化与连接器",
        xmatrix: "定时/事件驱动的 Norn 程序 + 40+ 个已连接应用",
        competitor: "无内置定时任务、Webhook 自动化或应用连接器",
      },
      {
        dimension: "适用人群",
        xmatrix: "独立 Vibe Coder 以及需要协同多智能体与多应用的团队",
        competitor: "基于 PTY 运行时折腾自定义终端的单人极客",
      },
    ],
    stayWhen: [
      "你明确需要一个 Apache-2.0 协议的本地 PTY 守护进程，用来通过原始 JSON-RPC/OpenRPC 套接字在 SSH 上自写终端 UI。",
      "你完全单兵在终端工作，永远不需要团队成员接入、活页面或外部应用审批。",
    ],
    switchWhen: [
      "你现在就要稳定可用的跨设备桌面与移动端控制，不想苦等 Herdr Cloud 候补名单或排查 SSH ProxyCommand 泄漏。",
      "在智能体通过 Vercel、Cloudflare、Linear 或其他已连接应用执行操作之前，你需要真正的身份认证、Space 密钥与人工审批。",
      "你希望在活页面里一眼掌握项目状态，而不是在持久化 PTY 窗格里翻找结论。",
    ],
    migrationSteps: [
      {
        title: "与现有工具并行安装 xMatrix CLI",
        detail: "一条命令注册你的 macOS、Linux 或 Windows 主机，无需手工搭建 SSH 隧道。",
      },
      {
        title: "一次性接入编程智能体",
        detail: "使用 xmatrix agent add 添加 Claude Code、Codex、Cursor、Gemini 或 OpenCode，订阅留在本地。",
      },
      {
        title: "将例行状态跟踪迁往活页面",
        detail: "为活跃项目创建活页面，由定时或事件驱动的 Norn 程序持续刷新状态。",
      },
    ],
    faqs: [
      {
        question: "关掉浏览器或合上笔记本后，xMatrix 的智能体还会继续跑吗？",
        answer:
          "对于保持开机的机器（如台式机、Mac Studio 或 Linux VPS），任务会在守护进程上持续运行，你随时用 Web、桌面或手机重连都能实时看到最新进展。",
      },
      {
        question: "为什么 xMatrix 比暴露本地 PTY socket 更安全？",
        answer:
          "xMatrix 在服务端强制执行 Space 认证与成员校验，将机器注册与 Space 权限解耦，通过 xmatrix secret exec 将 Space 密钥传入命令而不打印出来，并用只读/先询问权限把关外部 SaaS 写操作。",
      },
      {
        question: "我还能在终端里用 xMatrix 吗？",
        answer:
          "完全可以。原生 Rust 编写的 xmatrix CLI 允许成员与智能体直接在终端里读写页面、发消息、排查运行并调用受控连接器。",
      },
    ],
  },
  seedmux: {
    verifiedDate: "2026 年 11 月 22 日",
    metaTitle: "Seedmux 替代方案 (2026)：跨系统团队与移动端管控",
    metaDescription:
      "正在寻找 Seedmux 替代方案？告别 macOS + iPhone 生态锁定、闭源二进制与手机端默认 YOLO 模式，在 macOS、Windows、Linux、Android 与 iOS 上全面运行 xMatrix。",
    eyebrow: "Seedmux 替代方案 · Seedmux vs xMatrix",
    headline: "Seedmux vs xMatrix",
    lead: "Seedmux 将精致的 Ghostty + tmux macOS 终端与 iPhone 伴侣应用结合在一起，但它闭源、仅限 Mac、面向单人，且手机端发起的会话默认开启 YOLO 模式。xMatrix 将跨系统多机协作、真实团队 Space 与活页面带到 macOS、Windows、Linux、Android 和 iOS。",
    productCaption:
      "在 xMatrix 中：一个工作区覆盖 macOS、Windows、Linux、iPhone 与 iPad、Android 与 Web——配备受控的应用审批，以及由每台机器所有者选择的编程智能体访问权限。",
    painPoints: [
      {
        title: "macOS + iPhone 强绑定，把 Windows、Linux 与 Android 拒之门外",
        problem:
          "Seedmux 是一款纯粹的原生 macOS 应用，通知强依赖刘海屏交互，并仅配套 iPhone 伴侣应用（需订阅 Seedmux Pro）。它没有原生 Windows 或 Linux 桌面端，没有网页版工作区，也没有 Android 应用。",
        xmatrixAnswer:
          "xMatrix 覆盖 macOS、Windows、Linux、iPhone 与 iPad、Android 与 Web——无论你或同事使用哪套电脑和手机，都能直接加入同一个 Space。",
      },
      {
        title: "单人终端窗格，且移动端默认放开 YOLO 权限",
        problem:
          "Seedmux 没有团队频道、共享角色或 Space 密钥；通过 iPhone 伴侣发起的会话默认运行在 YOLO 权限下，且在移动网络或企业防火墙下中继审批容易出现延迟。",
        xmatrixAnswer:
          "无论从哪台设备发起工作，xMatrix 都执行同一套规则：每个编程智能体按其所在机器所有者确认的完全访问或先询问模式运行，已连接应用遵循只读 / 先询问 / 读写权限，Space 密钥不会进入聊天，Space 管理员在共享频道中审批“先询问”操作。",
      },
      {
        title: "脆弱的 CLI 状态抓取，且缺少项目活页面",
        problem:
          "由于 Seedmux 通过 tmux 包装本地 CLI 窗格，一旦 CLI 升级或认证令牌过期就可能导致窗格状态检测卡住；重度多窗格也会压垮本机 MacBook 内存，而产出仍停留在终端回滚日志里。",
        xmatrixAnswer:
          "xMatrix 采用结构化工具适配器与显式生命周期状态机，把任务分散到你名下的所有机器上，并将交付成果沉淀为活页面。",
      },
    ],
    comparisonRows: [
      {
        dimension: "支持平台",
        xmatrix: "macOS、Windows、Linux、iPhone 与 iPad、Android 及 Web",
        competitor: "仅 macOS + iPhone 伴侣（Linux 主机需经 SSH/中继连接）",
      },
      {
        dimension: "团队协作",
        xmatrix: "多人多智能体频道与人机共编活页面",
        competitor: "仅限单人终端；无共享团队频道或文档",
      },
      {
        dimension: "移动端安全默认值",
        xmatrix: "按机器所有者确认的访问权限（完全或询问）运行编程智能体 + 任何设备上相同的按应用策略",
        competitor: "手机发起的会话默认开启 YOLO 模式",
      },
      {
        dimension: "源码透明度",
        xmatrix: "基于 FSL-1.1-ALv2 源码可见",
        competitor: "闭源二进制发行",
      },
      {
        dimension: "外部运维应用",
        xmatrix: "40+ 个已连接应用（GitHub、Linear、Vercel、Cloudflare、Sentry、Gmail、Stripe 等）",
        competitor: "仅终端 CLI 命令；无 SaaS 连接器审批层",
      },
    ],
    stayWhen: [
      "你是只用 macOS + iPhone 的单人终端爱好者，特别看重 Ghostty 渲染、tmux 分屏与 MacBook 刘海屏弹窗。",
    ],
    switchWhen: [
      "你或你的同事使用 Windows、Linux 或 Android 设备。",
      "你希望在手机上远程管控智能体，并且每台机器的所有者都已为每个编程智能体明确选择完全访问或先询问模式。",
      "你希望决策与项目进度沉淀在活页面里，而不是消失在临时终端分屏中。",
    ],
    migrationSteps: [
      {
        title: "保留现有 CLI 工具与订阅",
        detail:
          "在你的 Mac 和 Linux 主机上安装 xMatrix，并用 xmatrix agent add 接入 34 种编程智能体中的任意工具（Claude Code、Codex、Grok、OpenCode、Kimi 等）。",
      },
      {
        title: "无需自建中继即可覆盖 Web、桌面与移动端",
        detail:
          "通过任意浏览器、桌面应用或 iPhone、iPad 与 Android 应用实时跟进进度并处理审批。",
      },
      {
        title: "将各路执行结果汇聚到活页面",
        detail:
          "不必挨个翻看 worker 窗格回执，让每个智能体直接把结果更新到项目活页面对应章节。",
      },
    ],
    faqs: [
      {
        question: "xMatrix 也有类似 Seedmux worker 的结构化任务回执吗？",
        answer:
          "有。发送给智能体的每条程序请求都会以带类型的结构化回复结束，同时在频道和关联活页面中上报清晰的生命周期状态与更新。",
      },
      {
        question: "我可以把 Linux 服务器和 MacBook 一起接入吗？",
        answer:
          "可以。在 Linux、macOS 和 Windows 机器上安装原生 xMatrix 守护进程后，它们都会统一出现在你的 Space 智能体视图中。",
      },
      {
        question: "xMatrix 是开源还是闭源？",
        answer:
          "xMatrix 在 GitHub（LambdaLabsHQ/xmatrix）以 FSL-1.1-ALv2 协议公开源码，而 Seedmux 是闭源产品。",
      },
    ],
  },
  linear: {
    alsoKnownAs: "Linear Coding Sessions 与 Loops",
    verifiedDate: "2026 年 11 月 22 日",
    metaTitle: "Linear Agents 替代方案 (2026)：本地机器与实时频道",
    metaDescription:
      "正在对比 Linear Agents 替代方案或平替？摆脱 12 个月过期的预付沙箱余额、纯云端工单执行与企业版专属审计日志，用 xMatrix 在本地机器运行实时频道与活页面。",
    eyebrow: "Linear Agents 替代方案 · Linear vs xMatrix",
    headline: "Linear Agents vs xMatrix",
    lead: "Linear 是一流的 Issue 追踪工具，Linear Agents 能把边界清晰的工单交给云端沙箱提 PR——但每次需按 $0.25/20 分钟加 Token 从独立预付钱包扣费，且余额 12 个月过期不退。你可以继续用 Linear 追踪 Issue，同时将其接入 xMatrix，在自有机器的实时频道与活页面中运行 34 种编程智能体。",
    productCaption:
      "在 xMatrix 中：保持连接 Linear，同时在你自己的机器上用实时频道运行本地 Claude Code 与 Codex，零云沙箱计时费、无过期预付余额。",
    painPoints: [
      {
        title: "独立预付余额 12 个月过期且不可退款",
        problem:
          "在 Basic（$10/席）或 Business（$16/席，使用 Loops 必需）席位费之外，Linear Coding Sessions 还要求额外充值独立美元预付余额（最低 $10、12 个月过期、不可退），按 Token 叠加上每 20 分钟 $0.25 的沙箱时长费。需求稍有模糊、重试几轮就会迅速烧钱。",
        xmatrixAnswer:
          "xMatrix 直接在你自己的机器上调用你已付费的 Claude Code、Codex 或 Cursor 订阅——没有沙箱计时表，也没有会过期的预付现金池。",
      },
      {
        title: "一切皆工单——缺少多人多智能体实时频道与本地机器编排",
        problem:
          "Linear Agents 擅长在云端沙箱里处理定义极清晰的单个小工单，但无法编排你自己的 MacBook、Linux 构建机或 Windows 工作站，也没有让团队与多种编程智能体实时协同纠偏的共享频道。",
        xmatrixAnswer:
          "xMatrix 提供实时频道，让人与多种本地编程智能体同场协作，并将最终状态直接写回活页面。",
      },
      {
        title: "缺少逐动作编码审批，智能体审计能力薄弱",
        problem:
          "Linear 的审计日志仅对 Enterprise 开放，且不细化记录单个智能体动作；同时也没有覆盖 Cloudflare、Vercel、Gmail、Sentry 或 Stripe 的统一按应用审批闸门。",
        xmatrixAnswer:
          "xMatrix 在所有方案中都提供对话与运行轨迹、Space 级密钥，以及覆盖 40+ 个已连接应用（包括 Linear 本身）的按应用权限策略。",
      },
    ],
    comparisonRows: [
      {
        dimension: "编程智能体运行位置",
        xmatrix: "你自己的 macOS、Windows、Linux 机器（笔记本、台式机或自有服务器）",
        competitor: "Linear 云端沙箱（$0.25/20 分钟）或外部厂商云",
      },
      {
        dimension: "智能体计费模式",
        xmatrix: "跨 34 种编程智能体自带模型订阅；Pro $10/人类席位/月（年付 $8）",
        competitor: "席位费（$10–$16/月）+ 独立预付余额（12 个月过期、不可退款）",
      },
      {
        dimension: "最适合的工作形态",
        xmatrix: "从实时频道、活页面与日常运维出发的工作流——直接联动 Linear",
        competitor: "范围非常清晰、可直接出云端 PR 的标准工单",
      },
      {
        dimension: "权限治理与可审计性",
        xmatrix: "全方案支持 40+ 个应用按需配置权限策略 + Space 密钥",
        competitor: "仅团队级开关；审计日志限 Enterprise 且不精确到单次智能体动作",
      },
      {
        dimension: "能否协同共存？",
        xmatrix: "原生 Linear 连接器让 xMatrix 智能体直接读写 Linear Issue",
        competitor: "工单优先；第三方智能体需对接 Agent Interaction API",
      },
    ],
    stayWhen: [
      "你的工作流完全是边界清晰、自包含的工单转 PR，且希望零本地机器配置。",
      "团队已经全面采用 Linear Business，只需要偶尔跑一跑面向 Linear 工单的云端 Loops。",
    ],
    switchWhen: [
      "你想在自有硬件上复用已买的 Claude Code / Codex 订阅，不想按每 20 分钟付云沙箱费或操心预付余额过期。",
      "团队需要面向架构演进、发版与运维的实时多智能体频道和活页面，而不止是工单。",
      "你需要横跨 Linear、GitHub、Vercel、Cloudflare、Sentry 和 Gmail 的按应用审批与 Space 密钥。",
    ],
    migrationSteps: [
      {
        title: "保留 Linear 作为 Issue 追踪器，并将其接入 xMatrix",
        detail:
          "无需抛弃 Linear。在 xMatrix 中连接 Linear 应用，让本地智能体自动读单、提 PR 并回写状态。",
      },
      {
        title: "注册本地机器与编程智能体",
        detail:
          "在你自己的工作站运行 Claude Code、Codex、Cursor 或 Gemini，彻底告别云沙箱计时费。",
      },
      {
        title: "用活页面维护项目全局真相",
        detail:
          "将活页面与各工作流关联，让架构决策、发布进展与阻塞项清晰可读，不必在工单评论里大海捞针。",
      },
    ],
    faqs: [
      {
        question: "使用 xMatrix 必须放弃 Linear 吗？",
        answer:
          "不需要。xMatrix 内置原生 Linear 连接器——团队可以继续在 Linear 管工单，同时把多智能体协同执行、活页面与受控运维交给 xMatrix。",
      },
      {
        question: "为什么不直接用 Linear Coding Sessions 的 BYOK 选项？",
        answer:
          "即便自带 API Key，Linear Coding Sessions 依然只能在云端沙箱运行，照样按 $0.25/20 分钟从会过期的预付余额扣费，而且无法调度你的本地机器或非 Linear 运维连接器。",
      },
      {
        question: "xMatrix 的定时自动化像 Linear Loops 一样要升级更高档位吗？",
        answer:
          "不需要。定时与事件驱动的 Norn 程序直接内置在 xMatrix 页面中，使用你现有方案额度即可，无需额外升级 Business 档。",
      },
    ],
  },
  notion: {
    alsoKnownAs: "Notion AI 与 External Agents",
    verifiedDate: "2026 年 11 月 22 日",
    metaTitle: "Notion Custom Agents 替代方案 (2026) — xMatrix",
    metaDescription:
      "寻找 Notion Custom Agents 平替或替代品？告别 $20–$24 Business 门槛、三套积分钱包、消耗创建者个人额度导致中断以及移动端限制，换用 xMatrix 活页面。",
    eyebrow: "Notion Custom Agents 替代方案 · Notion vs xMatrix",
    headline: "Notion vs xMatrix",
    lead: "Notion Custom Agents 被锁在 $20–$24/席的 Business 付费墙与复杂的三套积分钱包后面：同事调用共享智能体默认烧掉创建者的个人 Select 积分，归零瞬间任务即刻暂停。在 xMatrix 中，34 种编程智能体在你的真实仓库交付代码时更新活页面，全 Space 共用一个积分额度池。",
    productCaption:
      "在 xMatrix 中：智能体直接在你的真实仓库运行、在频道里与团队协同并维护活页面——全 Space 共用一个额度池，移动端全功能可用。",
    painPoints: [
      {
        title: "三套割裂的积分钱包，以及消耗创建者额度导致的半途暂停",
        problem:
          "Notion 将 AI 用量拆分为个人 Standard 积分（1,500/月）、个人 Select 积分（500/月，Custom Agents 必需）以及管理员另购的 Workspace Notion Credits（$10/1,000）。个人余额既不能合并也不能结转；同事触发共享智能体时默认扣除创建者的个人 Select 池，一归零智能体就在任务中途停摆。",
        xmatrixAnswer:
          "xMatrix Pro 为每人每月 $10（年付 $8/月）。每个席位每月为整个 Space 共享的额度池增加 5,000 积分；Agent 与应用写入消耗积分，成员书写免费；用完后可由所有者购买加量包（每 5,000 积分 $10），之后还有每席 2,500 积分的宽限额度。xMatrix 从不转售 LLM Token。",
      },
      {
        title: "不支持本地机器执行、跨机中继或多人实时智能体频道",
        problem:
          "Notion 仍把文档当作人工主操作面，写代码只能转包给外部云端 API（Alpha）。它无法在你的笔记本或构建机上直接运行 Claude Code 或 Codex，没有 Space 级密钥，也没有多人多智能体实时频道。",
        xmatrixAnswer:
          "在 xMatrix 中，你在频道里直接沟通，编程智能体在你的 macOS、Windows 和 Linux 本地仓库中真实干活，活页面随真实工程交付自然保持最新。",
      },
      {
        title: "移动端无法新建、甚至无法运行团队共享的 Custom Agents",
        problem:
          "Notion 手机端禁止创建 Custom Agents，并且只允许用户与自己名下创建的 Custom Agents 互动——离开电脑后同事基本寸步难行。",
        xmatrixAnswer:
          "xMatrix 成员可以在 Web、桌面应用或 iPhone、iPad 与 Android 应用上阅读页面、召唤 Space 的智能体——Space 管理员还能在这些端上审批“先询问”的连接器操作。",
      },
    ],
    comparisonRows: [
      {
        dimension: "定价与积分体系",
        xmatrix: "Free（终身 500 次写入）+ Pro $10/席/月（年付 $8）；全 Space 共用单一额度池",
        competitor: "Business $20–$24/席/月 + 三套独立钱包（Standard、Select、Workspace $10/1k）",
      },
      {
        dimension: "智能体执行环境",
        xmatrix: "直接在你自己的 macOS、Windows、Linux 机器上运行 34 种编程智能体",
        competitor: "Notion 云端浏览器/VM；编码转交外部厂商云",
      },
      {
        dimension: "文档如何保持最新",
        xmatrix: "正在干活的编程智能体随交付就地改写活页面；内置建议模式与段落归属",
        competitor: "需人工触发智能体或规则编辑块；同样支持建议模式与修订归属",
      },
      {
        dimension: "移动端团队能力",
        xmatrix: "移动端可用频道、页面与智能体召唤；Space 管理员也能在移动端审批操作",
        competitor: "无法在移动端创建 Custom Agents，也无法调用团队共享智能体",
      },
      {
        dimension: "密钥与工程连接器",
        xmatrix: "Space 级密钥库 + 40+ 个连接器（包括 Notion 自身）",
        competitor: "缺少面向 CLI 执行的 Space 级密钥库",
      },
    ],
    stayWhen: [
      "公司整体运转在 Notion 关系型数据库、CRM 表格以及面向非研发团队的富文本排版上。",
    ],
    switchWhen: [
      "你受够了折腾 Standard、Select 与 Workspace 三套积分，或共享智能体因为某位创建者个人积分耗尽而全员停摆。",
      "你希望编程智能体直接在本地仓库执行任务并在工作过程中维护项目活页面，而不是让 Wiki 迅速落后于代码现实。",
      "工程师需要在手机上也能调用团队共享智能体、使用 Space 密钥并管控部署/运维连接器。",
    ],
    migrationSteps: [
      {
        title: "先连接 Notion，不必一夜之间全量搬家",
        detail:
          "xMatrix 内置原生 Notion 连接器，智能体可以直接读取现有 Notion 规格文档，同时在 xMatrix 活页面中维护实时工程状态。",
      },
      {
        title: "把变化最快的项目状态迁入 xMatrix 活页面",
        detail:
          "先从发布追踪、架构决策与故障手册开始——这些正是在 Notion 里最容易迅速过时的文档。",
      },
      {
        title: "为页面挂载定时与事件驱动的 Norn 程序",
        detail:
          "把 Norn 程序直接嵌入页面，按 GitHub、Sentry 事件或每日计划自动刷新，不再消耗 Notion Select 积分。",
      },
    ],
    faqs: [
      {
        question: "xMatrix 能连接我们现有的 Notion 工作区吗？",
        answer:
          "可以。xMatrix 内置原生 Notion 连接器，支持按需配置只读、先询问或读写权限。",
      },
      {
        question: "同事触发我配置的智能体时，会扣我个人的额度吗？",
        answer:
          "不会。在 xMatrix Pro 上，Agent 积分（每人类席位每月 5,000）在整个 Space 池化共享，不存在创建者个人钱包被刷爆的瓶颈。",
      },
      {
        question: "如果成员和智能体同时编辑同一份 xMatrix 页面会怎样？",
        answer:
          "不会加锁。实时协同写作的智能体会避开你正在输入的段落，并在你编辑它正在写的内容时立即停下；通过 CLI 编辑的智能体若与你的修改重叠，其修改会被拒绝，并拿到当前文本重新合并。",
      },
    ],
  },
  "slack-code": {
    alsoKnownAs: "Slack Code API",
    verifiedDate: "2026 年 11 月 22 日",
    metaTitle: "Slack Code 替代方案 (2026)：告别 15 条 API 限流",
    metaDescription:
      "寻找 Slack Code 替代方案？告别 Slack 对自定义应用每分钟 1 次、每次 15 条历史消息的严苛限流、免费版 90 天限制与运行时缺失，改用 xMatrix。",
    eyebrow: "Slack Code 替代方案 · Slack Code vs xMatrix",
    headline: "Slack Code vs xMatrix",
    lead: "Slack Code API 在 Slack 里增加了任务频道与 diff 预览，但 Slack 本质仍是聊天外壳——没有智能体运行时、没有活页面，还对非 Marketplace 应用祭出极严苛的 API 限流（历史接口每分钟 1 次、每次最多 15 条消息）。你可以通过 xMatrix 的原生 Slack 连接器继续联动 Slack，同时在自有机器上运行 34 种编程智能体并把决策沉淀在活页面。",
    productCaption:
      "在 xMatrix 中：原生多人多智能体频道由你的自有机器和活页面支撑——完整读取上下文，没有 15 条历史消息的人为 API 墙。",
    painPoints: [
      {
        title: "激进的 Slack API 限流把自定义编程智能体活活饿死",
        problem:
          "Slack 将非 Marketplace 应用调用 conversations.history 和 conversations.replies 的限额砍到每分钟仅 1 次、每次最多 15 条消息——严重截断自研智能体的上下文视野并引发开发者对 AI 守门行为的强烈抗议；此外免费工作区 90 天后即丢失历史记录。",
        xmatrixAnswer:
          "xMatrix 原生为智能体设计：完整读取频道历史、按大纲与章节精准读取活页面，对你自己的 Space 绝不设置 15 条消息的人为卡口。",
      },
      {
        title: "Slack 只是聊天外壳——没有运行时、没有跨机路由、也没有 Space 密钥",
        problem:
          "Slack Code 负责展示 diff 和合作厂商智能体的状态，但你仍要另行购买合作智能体，或者自己从零搭建并运维机器执行器、守护进程、额度故障转移和密钥注入。",
        xmatrixAnswer:
          "xMatrix 提供开箱即用的完整运行时协作栈：一次注册你的 macOS、Windows 和 Linux 机器，在 Claude Code、Codex、Cursor 与 Gemini 间智能路由，并安全注入 Space 密钥。",
      },
      {
        title: "项目知识在刷屏的 Slack 频道中不断沉底",
        problem:
          "哪怕拆出专门的任务频道，Slack 依然没有活页面文档层——关键决策很快淹没在几百条聊天里，逼得每个新人和新智能体靠猜来判断什么仍然有效。",
        xmatrixAnswer:
          "xMatrix 频道关联活页面，智能体就地改写当前状态——打开页面就知道项目的真实进展。",
      },
    ],
    comparisonRows: [
      {
        dimension: "智能体上下文与 API 限制",
        xmatrix: "原生完整读取频道历史 + 结构化页面大纲/章节读取",
        competitor: "非 Marketplace 历史/回复接口限 1 次/分钟且最多 15 条；免费版限 90 天",
      },
      {
        dimension: "执行运行时",
        xmatrix: "内置跨机守护进程，原生支持 34 种编程智能体（+ --runtime）",
        competitor: "仅聊天界面；需另购合作智能体订阅或自建托管执行器",
      },
      {
        dimension: "项目活页面状态",
        xmatrix: "智能体随工作落地维护的活页面",
        competitor: "滚动聊天记录与已归档任务频道",
      },
      {
        dimension: "受控连接器与密钥",
        xmatrix: "Space 密钥 + 40+ 个已连接应用（按应用配置权限策略）",
        competitor: "无内置智能体密钥库或跨应用运行时权限治理",
      },
      {
        dimension: "能否与 Slack 共存？",
        xmatrix: "原生 Slack 连接器把 Slack 消息带入频道；智能体按其权限回帖到 Slack",
        competitor: "完全局限于 Slack 内部",
      },
    ],
    stayWhen: [
      "全公司硬性规定绝不离开 Slack，且你只需要一个付费的 Marketplace 合作智能体往现有 Slack 话题里贴 diff。",
    ],
    switchWhen: [
      "Slack 每分钟 1 次、每次 15 条消息的历史限流正在拖垮你的自定义智能体工作流。",
      "你想要开箱即用的多机执行与路由层来运行 Claude Code、Codex 和 Cursor，不想自己写胶水基础设施。",
      "你希望团队决策沉淀在活页面里，而不是消失在 Slack 聊天刷屏中。",
    ],
    migrationSteps: [
      {
        title: "保留 Slack 用于公司日常沟通，并将其连接到 xMatrix",
        detail:
          "以“先询问”或“只读”策略接入 xMatrix 的原生 Slack 连接器，既让工程协作井然有序，又不割裂非技术同事。",
      },
      {
        title: "把多智能体工程协作频道迁入 xMatrix",
        detail:
          "注册你的机器，在拥有完整上下文的 xMatrix 频道里直接运行 Claude Code、Codex 与 Cursor。",
      },
      {
        title: "把 Slack 置顶消息升级为活页面",
        detail:
          "用智能体随工作落地更新的活页面，替代常年失修的置顶消息和频道书签。",
      },
    ],
    faqs: [
      {
        question: "xMatrix 还能继续对接我们现有的 Slack 工作区吗？",
        answer:
          "可以。xMatrix 内置原生 Slack 连接器，支持按应用设置只读、先询问或读写权限。",
      },
      {
        question: "xMatrix 会限制我自己的智能体读取多少频道历史吗？",
        answer:
          "不会。智能体可以直接读取完整对话历史和关联的活页面，不存在非 Marketplace 应用 15 条消息的 API 卡口。",
      },
      {
        question: "相比 Slack 叠加合作编程智能体，xMatrix 的价格如何？",
        answer:
          "xMatrix Pro 为每人每月 $10（年付 $8/月），不限智能体数量且复用你原有的 CLI 订阅，不必在 Slack 席位之外再叠一层合作智能体的高额订阅费。",
      },
    ],
  },
  "nowledge-mem": {
    verifiedDate: "2026 年 11 月 22 日",
    metaTitle: "Nowledge Mem 替代方案 (2026)：对比 xMatrix",
    metaDescription:
      "对比 Nowledge Mem 替代方案？别再只从旧聊天里被动猜测记忆碎片——在 xMatrix 中跨机运行编程智能体并实时维护权威活页面。",
    eyebrow: "Nowledge Mem 替代方案 · Nowledge Mem vs xMatrix",
    headline: "Nowledge Mem vs xMatrix",
    lead: "Nowledge Mem 打造了一套精巧的跨工具本地图谱/向量记忆层，但它本质上是被动记忆库——只能从旧聊天里猜测事实，无法运行编程智能体或管控外部工具，且团队工作区仍处于私密内测阶段。在 xMatrix 中，亲手交付工作的运行会直接写就全队今日即可共享的权威活页面。",
    productCaption:
      "在 xMatrix 中：不必从旧聊天里事后猜测记忆，而是让亲手交付代码与结果的编程智能体直接保持团队活页面准确。",
    painPoints: [
      {
        title: "事后猜测记忆碎片 vs. 就地更新权威项目活页面",
        problem:
          "Nowledge Mem 在后台旁听对话并推断 Trace → Unit → Crystal 记忆图谱，伴随 30 天衰减与矛盾待消解队列。一旦某个 PR 合入或线上发布改变了事实，概率式记忆提取天然滞后于权威记录。",
        xmatrixAnswer:
          "在 xMatrix 中，亲手合入 PR 或跑完检查的那次智能体运行会直接就地改写项目活页面——对人和智能体同样清晰可读，内置建议模式、按段落归属标注与完整修订历史。",
      },
      {
        title: "缺少智能体编排、团队频道与跨机执行能力",
        problem:
          "Nowledge Mem 不会帮你拉起编程智能体，不能让多位同事在共享频道里协同，也无法跨机器路由任务——你还是得自己东拼西凑执行器、内网穿透和 MCP 配置。",
        xmatrixAnswer:
          "xMatrix 是一站式协作层：共享频道、跨 34 种编程智能体的多机路由、渐进式大纲/章节页面阅读与活页面全部集成在同一产品里。",
      },
      {
        title: "团队同步仍在内测，且缺少运维权限治理",
        problem:
          "Nowledge Mem Team 仍停留在私密内测阶段，本地部署要求 macOS 15+ 并手动接线 MCP/代理，且没有面向生产服务的 Space 密钥库或按应用审批闸门。",
        xmatrixAnswer:
          "xMatrix Space 今日即可自助开通，覆盖 macOS、Windows、Linux、iPhone 与 iPad、Android 与 Web，内置 Space 级密钥与 40+ 个已连接应用的按应用权限策略。",
      },
    ],
    comparisonRows: [
      {
        dimension: "核心职责",
        xmatrix: "在共享频道中驱动多智能体干活，并维护活页面",
        competitor: "跨工具抽取、索引并检索对话记忆",
      },
      {
        dimension: "事实权威来源",
        xmatrix: "由执行任务的 Run 直接就地改写的权威 Markdown 活页面",
        competitor: "带 30 天衰减的推断图谱/向量 Crystal；LLM Wiki 仅是派生视图",
      },
      {
        dimension: "团队可用状态",
        xmatrix: "Free（终身 500 次写入）与 Pro 团队 Space 今日即可自助开通",
        competitor: "个人本地版 GA；云端公测；团队工作区仍为私密内测",
      },
      {
        dimension: "智能体执行",
        xmatrix: "跨你所有的机器拉起并路由 34 种编程智能体（+ --runtime）",
        competitor: "不执行也不路由编程智能体",
      },
      {
        dimension: "密钥与外部应用",
        xmatrix: "Space 级密钥 + 40+ 个按应用配置策略的连接器",
        competitor: "团队版提供托管 Slack 连接；无运维连接器审批层",
      },
    ],
    stayWhen: [
      "你想要一个离线个人记忆图谱，在不改变现有编码方式的前提下收集网页版 ChatGPT、Claude 网页版与 Cursor 的聊天记忆。",
    ],
    switchWhen: [
      "你希望干活的智能体亲自维护权威的项目活页面，而不是靠后台提取器从旧聊天记录里猜测事实。",
      "你今天就需要正式可用的团队 Space（而非私密内测），涵盖多机智能体执行与 40+ 个受控运维连接器。",
      "你不想在 macOS、Windows、Linux、Android 和 Web 之间手工折腾本地代理与穿透隧道。",
    ],
    migrationSteps: [
      {
        title: "把长期有效的知识沉淀进 xMatrix 活页面",
        detail:
          "将核心决策与架构笔记（支持 OKF/Markdown 导出）按项目结构整理进 xMatrix 活页面。",
      },
      {
        title: "一次性接入编程智能体",
        detail:
          "在 xMatrix 中注册 Claude Code、Codex、Cursor 或 Gemini，让每次 Run 按大纲精准读取所需章节并写回更新。",
      },
      {
        title: "用 Norn 程序自动化维护活页面",
        detail:
          "让智能体按计划刷新指标、发布说明与阻塞清单，不必为空闲聊天日志持续支付后台 LLM 记忆抽取费用。",
      },
    ],
    faqs: [
      {
        question: "不用向量数据库，xMatrix 如何避免智能体读入过多上下文？",
        answer:
          "xMatrix 支持渐进式阅读——智能体先浏览 Space 页面树与摘要，再查看页面大纲和各章节篇幅，仅读取需要的章节并在原地改写。",
      },
      {
        question: "我可以把 Nowledge Mem 和 xMatrix 一起使用吗？",
        answer:
          "可以。如果你仍想为日常网页闲聊保留个人跨浏览器记忆，可以继续用它；而把共享项目真相、智能体编排与团队审批放在 xMatrix 里。",
      },
      {
        question: "如果智能体往 xMatrix 页面写错了内容怎么办？",
        answer:
          "每份活页面都具备完整修订历史和无锁协同编辑——你直接改掉那一行，读取该章节的智能体会在下一轮被告知这一变更。",
      },
    ],
  },
  everos: {
    alsoKnownAs: "EverMind / EverMemOS",
    verifiedDate: "2026 年 11 月 22 日",
    metaTitle: "EverOS (EverMemOS) 替代方案 (2026)：对比 xMatrix",
    metaDescription:
      "寻找 EverOS 或 EverMemOS 替代方案？摆脱单机 SQLite 目录锁、持续后台记忆抽取 Token 账单与团队同步缺失，迁往 xMatrix 频道与活页面。",
    eyebrow: "EverOS (EverMemOS) 替代方案 · EverOS vs xMatrix",
    headline: "EverOS vs xMatrix",
    lead: "EverOS (EverMemOS) 将 Markdown 文件与本地 SQLite、LanceDB 索引结合，但其开源 v1 明确拒绝同一目录启动第二个服务、排除多租户与分布式同步，且后台抽取会持续消耗 LLM Token。xMatrix 为团队提供覆盖 34 种编程智能体的实时多机执行与权威活页面。",
    productCaption:
      "在 xMatrix 中：由干活的编程智能体跨多机实时维护 Markdown 活页面——没有单目录锁冲突，也没有后台记忆抽取的额外 Token 消耗。",
    painPoints: [
      {
        title: "纯单机架构，v1 明确排除多租户与跨机同步",
        problem:
          "EverOS v1 面向单一本地进程设计：同一目录启动第二个服务会被直接拒绝，多租户与分布式同步明确不在范围内；多个本地编程工具共享同一 Markdown/SQLite 目录还会引发锁竞争。",
        xmatrixAnswer:
          "xMatrix 在所有团队成员以及所有已注册的 macOS、Windows 和 Linux 机器之间实时同步活页面与频道，彻底消除本地 SQLite 抢锁问题。",
      },
      {
        title: "持续的后台 LLM 抽取开销与单机本地索引负担",
        problem:
          "在单机上同时运行 LanceDB 向量索引以及持续不断的 LLM 事件抽取、冲突消解与画像归并调用，不仅吃掉大量本地内存，还会产生难以预测的持续 API 账单——且多用户场景下 EverMemBench 准确率降至 66.67%。",
        xmatrixAnswer:
          "xMatrix 不跑后台抽取循环去反推历史聊天发生了什么。完成任务的那次智能体运行会直接就地更新对应活页面章节。",
      },
      {
        title: "单纯的记忆存储无法执行、调度或治理编程智能体",
        problem:
          "EverOS 只是一个记忆后端（且 v1.7.1 已移除 Foresight 预测功能）；它不能跨机器召唤编程智能体，也无法在操作 Vercel、Cloudflare、Gmail 或 Stripe 前强制人工审批。",
        xmatrixAnswer:
          "xMatrix 将覆盖 34 种编程智能体的多智能体执行、Space 密钥、40+ 个连接器的按应用审批与活页面整合为一个完整工作区。",
      },
    ],
    comparisonRows: [
      {
        dimension: "多机与团队同步",
        xmatrix: "覆盖 macOS、Windows、Linux、Android 与 Web 的实时多人多机 Space",
        competitor: "开源 v1 严格单机；多租户与同步均不在支持范围内",
      },
      {
        dimension: "知识如何保持更新",
        xmatrix: "干活的智能体 Run 就地改写权威 Markdown 活页面",
        competitor: "后台 LLM 持续抽取写入 SQLite + LanceDB 索引（额外消耗 Token）",
      },
      {
        dimension: "智能体执行与路由",
        xmatrix: "跨你的机器拉起并路由 34 种编程智能体（+ --runtime）",
        competitor: "仅记忆层；不执行也不协调智能体集群",
      },
      {
        dimension: "并发协同编辑",
        xmatrix: "实时协同活页面，支持建议模式、作者归属与无锁合并",
        competitor: "本地目录锁；多工具并发写入易触发锁竞争",
      },
      {
        dimension: "权限治理与连接器",
        xmatrix: "Space 级密钥 + 40+ 个按应用配置权限策略的已连接应用",
        competitor: "无",
      },
    ],
    stayWhen: [
      "你在做对话记忆学术基准研究（如 LoCoMo / LongMemEval），或需要一个 Apache-2.0 许可的本地记忆引擎嵌入到单机 Python/CLI 技术栈中。",
    ],
    switchWhen: [
      "你在多台机器上工作或需要与同事协同，无法接受单机单目录 v1 的锁边界。",
      "你希望由真正完成任务的 Run 直接维护权威 Markdown 活页面，而不是为后台持续抽取循环烧 API 费用。",
      "除了持久化项目知识外，你还需要覆盖 34 种编程智能体的真正执行能力与 40+ 个受控连接器。",
    ],
    migrationSteps: [
      {
        title: "将现有 Markdown 文件直接迁入 xMatrix 活页面",
        detail:
          "既然 EverOS 也以 Markdown 作为权威层，你整理好的项目笔记可以直接无缝迁移进 xMatrix 活页面。",
      },
      {
        title: "把所有机器接入同一个 Space",
        detail:
          "在你的笔记本和服务器上安装 xMatrix CLI，让所有编程智能体实时共享同一套活页面，告别本地 SQLite 锁报错。",
      },
      {
        title: "让执行任务的 Run 维护各自章节",
        detail:
          "每当智能体合入代码或完成调研时直接更新对应章节，取代笨重的后台抽取管线。",
      },
    ],
    faqs: [
      {
        question: "xMatrix 活页面也像 EverOS 一样是纯 Markdown 吗？",
        answer:
          "是的。xMatrix 活页面本质上是结构化 Markdown 文档，支持章节级读写、完整修订历史和人机实时共编。",
      },
      {
        question: "xMatrix 会为后台记忆归并收取额外的 LLM Token 费吗？",
        answer:
          "不会。因为由干活的智能体在收尾时直接更新页面，你无需针对全部聊天日志常年运行一套额外的后台抽取模型管线。",
      },
      {
        question: "相比 EverOS，xMatrix 在多人协作方面表现如何？",
        answer:
          "xMatrix 从立项起就面向多人多智能体 Space 构建，提供精确到人的修订归属、实时频道，彻底没有单机目录锁限制。",
      },
    ],
  },
  youmind: {
    verifiedDate: "2026 年 11 月 22 日",
    metaTitle: "YouMind 替代方案 (2026)：YouMind vs xMatrix",
    metaDescription:
      "对比 YouMind 替代方案？告别 $20–$200/月单人积分档以及 Android 与团队协作缺口，用 $10/席的 xMatrix 实现多人编码频道、本地仓库运行与活页面。",
    eyebrow: "YouMind 替代方案 · YouMind vs xMatrix",
    headline: "YouMind vs xMatrix",
    lead: "YouMind 是一款精致的单人创作工作室，擅长把视频、播客和网页资料提炼成幻灯片与文章（$20–$200/月积分档），但它缺少原生团队协作、没有 Android 应用，对 GitHub/Linear 也仅限于桥接上下文而非运行本地编程智能体。xMatrix 在一个多人 Space 里打通代码、研究与运营。",
    productCaption:
      "在 xMatrix 中：把调研笔记、需求规格与多智能体真实编码交付收拢到同一个多人 Space，全面支持桌面、Web、Android 与 iOS。",
    painPoints: [
      {
        title: "个人创作定位——缺少实时团队频道与权限治理",
        problem:
          "YouMind 围绕个人研究白板设计，而非多人工作空间。团队在协同交付时缺少实时共享频道、基于角色的审批策略与 Space 级密钥。",
        xmatrixAnswer:
          "xMatrix 让成员与智能体在公开/私有频道中实时配合，背后由活页面以及按应用细分的只读 / 先询问 / 读写治理体系兜底。",
      },
      {
        title: "不是本地编程智能体运行器，且 $40–$200/月积分档门槛陡峭",
        problem:
          "YouMind 虽可桥接 GitHub 和 Linear 辅助起草文档，但无法在你的本地仓库和构建机上调度 Claude Code、Codex 或 Cursor。重度多模态任务会迅速耗尽 Starter（$20 / 2 万积分）和 Pro（$40 / 4 万积分），把桌面智能体工作流推向 $100–$200 的 Max 档。",
        xmatrixAnswer:
          "xMatrix Pro 仅每人每月 $10，复用你已有的订阅在自有机器上驱动真实编程智能体，一并覆盖调研、文档与运营工作。",
      },
      {
        title: "缺少 Android 客户端，跨设备工程流割裂",
        problem:
          "YouMind 仅提供 iOS 应用与 Chrome 插件，没有官方 Android 应用，导致 Android 开发者离开工位后无法查看进展或远程指挥。",
        xmatrixAnswer:
          "xMatrix 覆盖 macOS、Windows、Linux、iPhone 与 iPad、Android 与 Web，让调研、规格、代码 PR 与上线动作汇聚到共享的活页面中。",
      },
    ],
    comparisonRows: [
      {
        dimension: "核心聚焦",
        xmatrix: "围绕活页面协同推进的多人编码、研究与运营",
        competitor: "面向个人的多媒体研究与内容创作画板",
      },
      {
        dimension: "本地代码执行",
        xmatrix: "直接在你的本地仓库运行 34 种编程智能体（+ --runtime）",
        competitor: "仅桥接 GitHub/Linear 上下文；桌面智能体锁在 $100–$200 Max 档",
      },
      {
        dimension: "定价",
        xmatrix: "Free（终身 500 次写入）+ Pro $10/人类席位/月（年付 $8），自带订阅",
        competitor: "Starter $20 / Pro $40 / Max $100–$200 每月（按积分计量）",
      },
      {
        dimension: "团队协作",
        xmatrix: "多人多智能体频道、共编活页面、Space 密钥",
        competitor: "偏个人画板；对外协作主要依赖导出成品",
      },
      {
        dimension: "平台覆盖",
        xmatrix: "macOS、Windows、Linux、iPhone 与 iPad、Android 及 Web",
        competitor: "Web、iOS、Chrome 插件；无官方 Android 应用",
      },
    ],
    stayWhen: [
      "你的核心目标是个人多模态内容生产——把 YouTube 视频和播客转化为图文长文、幻灯片与短视频脚本。",
    ],
    switchWhen: [
      "你希望研究结论和产品规格直接留在同一个 Space 里，让编程智能体据此实现 PR、跑测试并推进发布。",
      "你需要与同事协同、使用 Android 手机，或不想在编码订阅之外再花 $40–$200/月买创作积分。",
    ],
    migrationSteps: [
      {
        title: "将进行中的调研简报迁入 xMatrix 活页面",
        detail:
          "把竞品分析、发布计划和架构笔记放进活页面，让智能体既能持续更新它们，又能直接照着落地执行。",
      },
      {
        title: "连接编程智能体与发布工具",
        detail:
          "在自有机器上运行 Claude Code、Codex 或 Gemini，以只读或读写策略接入 GitHub，并以“先询问”审批策略接入 Google Docs、Notion、X 或 Search Console。",
      },
      {
        title: "自动化周期性研究与汇报",
        detail:
          "在页面内嵌入定时 Norn 程序，让智能体按计划刷新周报摘要与关键指标。",
      },
    ],
    faqs: [
      {
        question: "xMatrix 除了写代码，也能处理调研、写作和产品发布吗？",
        answer:
          "可以。很多团队把 xMatrix 活页面用于市场调研、SEO、产品发版、招聘与日常运营，与软件工程并肩运转，并全部由智能体持续更新。",
      },
      {
        question: "xMatrix 有 Android 应用吗？",
        answer:
          "有。xMatrix 提供 Android 应用（Google Play 或 APK），另有 iPhone 与 iPad 应用、macOS 与 Windows 桌面应用、Web，以及用于 Linux 机器的 CLI。",
      },
      {
        question: "外部智能体工具也能接入 xMatrix 吗？",
        answer:
          "可以。xMatrix 原生内置 34 种编程智能体（并可通过 --runtime 接入任意自定义 CLI），同时对外提供标准 MCP 服务器。",
      },
    ],
  },
  jules: {
    verifiedDate: "2026 年 11 月 22 日",
    statusNote: "Google Jules 已于 2026 年 11 月 11 日进入只读模式，并将于 2026 年 12 月 31 日彻底关停。",
    metaTitle: "Google Jules 替代方案 (2026 年底关停迁移) — xMatrix",
    metaDescription:
      "Google Jules 已于 11 月 11 日只读并将于 2026 年 12 月 31 日关停，正在寻找 Google Jules 替代品或平替？将导出的记忆、定时任务与 GitHub 仓库迁入 xMatrix，联合运行 Antigravity、Claude Code 与 Codex。",
    eyebrow: "Google Jules 替代方案 · 12 月 31 日关停迁移指南",
    headline: "迁出 Google Jules",
    lead: "Google Jules 已于 2026 年 11 月 11 日停止创建新会话，并将于 2026 年 12 月 31 日彻底关闭，且不提供记忆、定时任务或会话的自动迁移。xMatrix 让你把导出的上下文装入活页面，在自有常在线电脑或个人 VPS 上运行 Google Antigravity 及其他 33 种编程智能体，继续随时通过手机或 Web 异步派发 GitHub PR。",
    productCaption:
      "在 xMatrix 中：通过自有常在线机器或 VPS 运行 Google Antigravity、Claude Code、Codex 及其他 31 种编程智能体，继续从网页或手机异步清空 GitHub Issues。",
    painPoints: [
      {
        title: "2026 年 12 月 31 日永久关停，且仅提供手工导出",
        problem:
          "Jules 自 11 月 11 日起转为只读并将于 2026 年 12 月 31 日彻底终止服务。尽管官方 @google/jules 工具允许导出环境变量、记忆、定时任务和会话日志，但 Google 并未提供向 Antigravity 的自动迁移通道——团队只能手工重建全部工作流。",
        xmatrixAnswer:
          "xMatrix 今天就能承接你的导出资产：把导出的 Jules 记忆放入活页面，将 .env 密钥存入 Space 密钥，并把周期任务重建为嵌入页面的 Norn 程序。",
      },
      {
        title: "全部押注 Google Antigravity 带来的单厂商额度焦虑",
        problem:
          "Hacker News、Reddit 与 Google AI 论坛上的开发者普遍表达了不满：不仅失去了 Jules 稳定可预期的每日异步任务模式，更担心把所有工作并入单一厂商的统一额度池后频繁撞上意外限流或超额。",
        xmatrixAnswer:
          "xMatrix 原生将 Google Antigravity 与其他 33 种编程智能体（Claude Code、Codex、Cursor、Gemini CLI 等）编排在同一空间，一旦某家服务商额度窗口打满，还能将任务交接给另一家继续执行。",
      },
      {
        title: "重建轻量级手机端与异步 GitHub 积压清理习惯",
        problem:
          "早期迁移用户反馈，离开 Jules 后最怀念的就是不必整天坐在本地 IDE 前、随时在手机上触发异步清理 GitHub Issue 并自动提 PR 的轻快体验。",
        xmatrixAnswer:
          "接入一台常在线电脑或你自己的 Linux VPS，即可随时通过 iPhone、iPad、Android 应用或 Web 发送 @auto repo:owner/repo——或配置由 GitHub 事件自动触发的 Norn 程序——看着 PR、CI 状态与活页面更新异步落地。",
      },
    ],
    comparisonRows: [
      {
        dimension: "服务状态（2026 年 11 月）",
        xmatrix: "持续活跃、自助注册、源码可见（FSL-1.1-ALv2）",
        competitor: "2026 年 11 月 11 日起只读；2026 年 12 月 31 日永久关停",
      },
      {
        dimension: "编程智能体与模型选择",
        xmatrix: "Google Antigravity + 33 种其他编程智能体（+ --runtime），支持额度交接",
        competitor: "仅限 Google 云端智能体（正退役合并至 Google Antigravity）",
      },
      {
        dimension: "记忆与项目文档",
        xmatrix: "人与所有编程智能体共享的 Markdown 活页面",
        competitor: "需在 12 月 31 日前用 @google/jules CLI 导出；无自动迁移",
      },
      {
        dimension: "定时与事件驱动任务",
        xmatrix: "嵌入页面中的 Norn 程序（定时 + GitHub/连接器事件）",
        competitor: "定时任务已于 11 月 11 日停摆；仅支持导出本地快照",
      },
      {
        dimension: "代码执行位置",
        xmatrix: "你自己的常在线电脑或自管 Linux VPS（xMatrix 不提供托管云虚拟机）",
        competitor: "Google 托管云端虚拟机（将于 12 月 31 日关停）",
      },
    ],
    stayWhen: [
      "2026 年 12 月 31 日之后已无法继续留在 Jules——请务必在停服前通过 npm install -g @google/jules 导出你的全部数据。请注意，xMatrix 需要你自己的常在线电脑或 VPS，而非平台托管的云虚拟机。",
    ],
    switchWhen: [
      "你希望继续使用 Google Antigravity，并与其余 33 种编程智能体协同工作，不再把全部工作押注于单一厂商。",
      "你需要一个长期稳固的家，用来安放导出的 Jules 记忆、环境密钥与定时 GitHub 巡检任务。",
      "你手头已有 Mac Studio、台式机或低成本 Linux VPS，想要不会因某项云端测试版关停而被夺走的手机异步提 PR 工作流。",
    ],
    migrationSteps: [
      {
        title: "在 2026 年 12 月 31 日前导出全部 Jules 数据",
        detail:
          "运行 Google 官方 @google/jules 导出工具，将记忆、定时任务、初始化脚本和环境变量保存到本地。",
      },
      {
        title: "将记忆导入活页面、将密钥存入 Space 密钥",
        detail:
          "把导出的项目记忆整理进 xMatrix 活页面，把导出的 .env 凭证迁入 Space 密钥（切勿以明文发进聊天）。",
      },
      {
        title: "接入你的常在线机器或 VPS 与 GitHub",
        detail:
          "将一台常在线台式机或你自己的 Linux VPS 注册进 xMatrix，连接 GitHub，并把周期性积压清理任务重建为页面 Norn 程序。",
      },
    ],
    faqs: [
      {
        question: "从 Jules 迁出后，还能在 xMatrix 里继续运行 Google Antigravity 吗？",
        answer:
          "可以。xMatrix 在你自己的机器上原生支持 Google Antigravity (agy)，并可与其他 33 种编程智能体（Claude Code、Codex、Cursor、Gemini 等）并肩运行。",
      },
      {
        question: "xMatrix 会像曾经的 Jules 一样提供托管云虚拟机吗？",
        answer:
          "不会——xMatrix 需要一台由你自主掌控的常在线电脑（台式机、Mac Studio 或你自己租用的低成本 Linux VPS）。换来的是彻底告别厂商锁定：你的代码仓库和工作流绝不会因为某项托管云测试版关停而凭空消失。",
      },
      {
        question: "如何在 xMatrix 中替代 Jules 的定时任务？",
        answer:
          "直接在对应的 xMatrix 项目活页面里插入一段 Norn 程序代码块即可——它既能按计划定时触发，也能响应 GitHub 事件，并把执行结果直接更新回该页面。",
      },
    ],
  },
};
