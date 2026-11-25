import { FREE_PLAN_FEATURES, PRO_PLAN_FEATURES } from "@/lib/space-plans";
import { SITE_LOCALES, type SiteLocale } from "@/lib/site-locales";

/**
 * The homepage's words in each language it is published in: English at `/`,
 * and localized trees at `/zh`, `/zh-tw`, `/ja`, `/ko`, and `/es`.
 */
export type Locale = SiteLocale;

type Pair = readonly [string, string];
type Row = readonly [string, string, string];

/**
 * Section headings in Chinese and Japanese break only at punctuation, at a
 * space, or where a zero-width space (`\u200b`) marks the end of a phrase
 * (section-intro.tsx): a heading with no punctuation carries one where it
 * should wrap on a narrow screen.
 */
export interface LandingCopy {
  home: string;
  lang: string;
  meta: { title: string; description: string; shareDescription: string };
  nav: { links: readonly Pair[]; docs: string; openApp: string; download: string; menu: string };
  /** `alsoFor`, `everyDevice` and `appsOnly` are one sentence under the Hero's action: `{list}` is the App's other
      platforms, each a link, and `{browser}` is `inBrowser`, the link to the web app. */
  hero: { slogan: string; startFree: string; art: string;
    alsoFor: string; everyDevice: string; appsOnly: string; inBrowser: string };
  /** What xMatrix is, over a live document; `stores` names the phone app's two badges. */
  livePage: { title: string; body: string; art: string; stores: string };
  conversations: { title: string; body: string };
  /** `body` says how many agents the registry holds. */
  agents: {
    title: string;
    body: (count: number) => string;
    matrixArt: string;
    listLabel: string;
    refusedNote: string;
    refusedLink: { href: string; label: string };
  };
  why: { title: string; others: string; rows: readonly Row[] };
  connectors: { title: string; body: string; label: string };
  pricing: {
    title: string; body: string;
    free: { description: string; features: readonly string[]; button: string };
    pro: { description: string; features: readonly string[]; period: string; annual: string;
      monthly: string; yearly: string };
    terms: string;
    xCreditsLink: { href: string; label: string };
  };
  faq: { title: string; questions: readonly Pair[] };
  footer: {
    tagline: string; product: string; getApp: string; legal: string; compare: string; agents: string; language: string;
    links: Record<"app" | "download" | "pricing" | "docs" | "support" | "console" | "signIn", string>;
    legalLinks: Record<"privacy" | "terms" | "cookies" | "subprocessors", string>;
    askAi: string; rights: string;
  };
}

const en: LandingCopy = {
  home: "/",
  lang: SITE_LOCALES.en.htmlLang,
  meta: {
    title: "xMatrix — Multi-agent collaboration around live documents",
    description: "Collaborate with your team and coding agents like Claude Code, Codex, and Cursor through live documents. Run threads in parallel while your agents update the pages as their work lands.",
    shareDescription: "Attention is all you need. Collaborate with your team and AI coding agents through live documents your agents keep current as work moves.",
  },
  nav: {
    links: [["/#agents", "Agents"], ["/#pricing", "Pricing"]],
    docs: "Docs", openApp: "Open App", download: "Download", menu: "Open navigation menu",
  },
  hero: { slogan: "Attention is all you need.", startFree: "Start Free",
    art: "A modular array of warm wood and liquid-glass blocks engraved with AI marks",
    alsoFor: "Also on {list}, or {browser}.", everyDevice: "On {list}, or {browser}.", appsOnly: "Apps for {list}.", inBrowser: "open in browser" },
  livePage: {
    title: "Get all your agents on the same page.",
    body: "People and AI, working on the same pages in real time. Every change shows up the moment it lands, and a decision written on a page is there for everyone who can open it. Open it on desktop or mobile to see the whole picture.",
    art: "A project page where Claude, Codex and Cursor each move their workstream forward while a person records a decision",
    stores: "Get the phone app",
  },
  conversations: {
    title: "Conversations do the work. The page holds the truth.",
    body: "Mention an agent and it starts work on your machine. Run dozens of threads in parallel—the process stays in the thread, results land on the page.",
  },
  agents: {
    title: "Any machine. Any agent. All managed in one place.",
    body: (count: number) => `${count} coding agents running on your own Mac, Linux, and Windows machines—using the subscriptions and API keys you already pay for. Model credentials are never uploaded to xMatrix, and your code reaches it only when someone posts it. When an agent hits its usage limit mid-task, xMatrix hands the work to another agent that has quota left.`,
    matrixArt: "The agents on each machine of a Space, and what each one is doing",
    listLabel: "Any machine. Any agent. All managed in one place.",
    refusedNote: "xMatrix explicitly refuses ZCode to protect your local code and credential boundaries.",
    refusedLink: { href: "/docs/agents#unsupported-harnesses", label: "Why ZCode is refused" },
  },
  why: {
    title: "Why xMatrix", others: "Juggling tabs & terminals",
    rows: [
      ["Where things stand", "Live Pages record where things stand; agents update them as their work lands.", "Scattered across terminals, chat threads, and PRs."],
      ["Your attention", "Check the page on your schedule—no constant interruptions.", "Every agent pings you for input, one window at a time."],
      ["Parallel work", "Dozens of threads running in parallel, each writing results back to the Pages.", "One agent per tab, with you copy-pasting between them."],
      ["Across machines", "Agents on every machine you own work in one shared Space.", "Each agent is trapped on the single machine it runs on."],
      ["Shared decisions", "Write a decision once on a page; agents started in a linked conversation read it before they begin.", "Re-explain to every agent, then repeat in the next session."],
      ["Human in the loop", "Edit any line directly—an agent writing there stops and is told why.", "Interrupt the agent, explain again, and start over."],
    ],
  },
  connectors: {
    title: "Connect your stack. Keep the final say.",
    body: "Connect GitHub, Linear, Sentry, Cloudflare, and more. Agents read context and react to live events through the Space's connections. A Space admin sets each app to read only, ask first, or read and write; on ask first, every write waits for an admin's approval.",
    label: "Connectors",
  },
  pricing: {
    title: "Start free. Pro is $10 per person.",
    body: "Every plan includes unlimited agents, running on your own model subscriptions or API keys. Seats count people only. On Pro, people write for free, and each Agent or app message or page revision uses one credit; every seat includes 5,000 credits a month.",
    free: { description: "Start free and prove the workflow on a real project.", features: FREE_PLAN_FEATURES, button: "Start Free" },
    pro: { description: "Built for heavy solo builders and fast-moving teams.", features: PRO_PLAN_FEATURES, period: "/human seat/mo",
      annual: "$96 per seat/year ($8/mo, save 20%)",
      monthly: "Choose monthly", yearly: "Annual, save 20%" },
    terms: "Free includes 500 lifetime writes per Space, counting channel messages and page edits by anyone, with up to 2 Free Spaces per account besides its personal Space. On Pro, people write for free; each Agent or app message or page revision uses one credit. A grace of half the allowance applies before Agents pause. Service rate limits apply.",
    xCreditsLink: { href: "/docs/connectors#x-credits", label: "Credit rates for paid X actions" },
  },
  faq: {
    title: "Questions",
    questions: [
      ["Do my agents cost extra?", "There is no charge per agent: every plan supports unlimited agents, and Pro is billed per person. Their writes are metered, though. On Free they count toward the Space's 500 writes; on Pro each Agent message or page revision uses one credit from the 5,000 each seat includes a month. Models run on the subscriptions or API keys you already have, and xMatrix does not bill for model usage."],
      ["Where do my agents run?", "On your own machines, directly inside the folders and repositories you register. xMatrix coordinates your Space across machines. Your model credentials are never uploaded to xMatrix, and your code reaches it only when a person or agent posts or attaches it. To show remaining quota, the local daemon asks each provider from your machine and sends xMatrix only the usage figures; you can turn that off anytime."],
      ["Which agents work with xMatrix?", "Claude Code, Codex, Cursor, Gemini, Grok, Kimi, Copilot, OpenCode, and dozens more—34 built-in coding agents through one CLI. Run xmatrix agent add to connect the ones already on your machine. ZCode is explicitly refused to protect local code and credential boundaries."],
      ["What happens when a person and an agent edit the same paragraph?", "Your typing is kept. An agent writing alongside you stays out of the paragraph your cursor is in, and if you edit what it is writing, it stops there and is told why. An agent's saved edit is merged around whatever you are typing, so your words in progress stay."],
      ["Do I have to watch every conversation?", "No. Execution happens in parallel threads while agents write outcomes to the pages. Read the pages to see where things stand, and open a thread only when you want the details."],
      ["Is it only for code?", "Not at all. Agents can also keep release checklists, research, metrics, hiring, and operations pages up to date."],
    ],
  },
  footer: {
    tagline: "The multi-agent workspace built around live documents, where agents record decisions, progress, and next steps as their work lands.",
    product: "Product", getApp: "Get the app", legal: "Legal", compare: "Compare xMatrix with", agents: "Agents", language: "Languages",
    links: { app: "Online App", download: "Download", pricing: "Pricing", docs: "Docs", support: "Support", console: "Console", signIn: "Sign In" },
    legalLinks: { privacy: "Privacy Policy", terms: "Terms of Service", cookies: "Cookies and Storage", subprocessors: "Subprocessors" },
    askAi: "See what ChatGPT, Claude, Perplexity, Gemini or Grok say about xMatrix.",
    rights: "xMatrix and its related marks are reserved.",
  },
};

const zh: LandingCopy = {
  home: "/zh",
  lang: SITE_LOCALES.zh.htmlLang,
  meta: {
    title: "xMatrix — 实时文档驱动的多智能体协作平台",
    description: "在实时文档中与团队及 Claude Code、Codex、Cursor、Gemini 等编程智能体协同工作。过程留在并行对话，智能体把进展、决策与待办写回实时页面。",
    shareDescription: "注意力就是一切：在实时文档中与多智能体协同推进，由智能体把进展、决策与待办写回文档。",
  },
  nav: {
    links: [["/zh#agents", "智能体"], ["/zh#pricing", "价格"]],
    docs: "文档", openApp: "打开应用", download: "下载", menu: "打开导航菜单",
  },
  hero: { slogan: "注意力就是一切", startFree: "免费开始",
    art: "一组刻着 AI 标志的木块和液态玻璃方块",
    alsoFor: "也支持 {list}，或直接{browser}。", everyDevice: "支持 {list}，或直接{browser}。", appsOnly: "也支持 {list} 版 App。", inBrowser: "在浏览器打开" },
  livePage: {
    title: "在文档中\u200b看清全貌",
    body: "人与 AI 在同一组页面上实时协作。每一处改动即时可见，写进页面的决策，有权打开它的人都能看到。电脑或手机上打开，就能看清全貌。",
    art: "一个项目页面：Claude、Codex 和 Cursor 各自推进自己的工作线，同时有人记下一项决定",
    stores: "下载手机 App",
  },
  conversations: {
    title: "过程留在对话里，结果落回文档",
    body: "@ 一个智能体，它就在你的机器上开工。几十条对话同时并行，过程留在对话里，结果写回文档。",
  },
  agents: {
    title: "任意机器，任意智能体，统一管理",
    body: (count: number) => `原生支持 ${count} 种主流编程智能体，直接运行在你的 Mac、Linux 与 Windows 机器上。沿用你已有的订阅或 API key。模型凭据绝不上传至 xMatrix，代码只有在有人发出时才会到达 xMatrix；智能体在任务中途用完额度时，xMatrix 会把工作交给另一个仍有额度的智能体。`,
    matrixArt: "一个 Space 里每台机器上的智能体，以及它们各自在做什么",
    listLabel: "任意机器，任意智能体，统一管理",
    refusedNote: "为守住本地代码与凭据边界，xMatrix 明确拒绝支持 ZCode。",
    refusedLink: { href: "/zh/docs/agents#明确拒绝支持的工具", label: "查看原因" },
  },
  why: {
    title: "为什么选择 xMatrix", others: "多开终端与窗口",
    rows: [
      ["项目现状", "实时页面记录项目现状，智能体完成工作时随手更新。", "分散在终端、聊天记录和各个 PR 里，全靠手动拼凑。"],
      ["你的注意力", "想看时打开文档即可，不再被窗口轮番打断。", "每个智能体都在催你回复，一个窗口接一个窗口。"],
      ["多线并行", "几十条对话同时推进，各自把结果写回文档。", "一个标签页盯一个智能体，上下文全靠复制粘贴。"],
      ["跨机协作", "名下所有机器的智能体，接入同一个 Space。", "每个智能体被困在单台机器里，彼此看不见。"],
      ["团队决策", "决策写进页面一次，在关联对话中启动的智能体开工前都会先读。", "每个智能体都要重复交代，开新会话就全忘。"],
      ["随时介入", "文档里任意一行都能直接改，正在那里写的智能体会停下并得知原因。", "只能强行打断智能体，重新解释，从头再来。"],
    ],
  },
  connectors: {
    title: "连上常用服务，操作由你把关",
    body: "接入 GitHub、Linear、Sentry、Cloudflare 等常用服务。智能体通过 Space 的连接读取上下文、响应外部事件。Space 管理员为每个应用设定只读、先询问或读写；设为先询问时，每次写入都要等管理员批准。",
    label: "连接器",
  },
  pricing: {
    title: "免费开始，Pro 每人每月 $10",
    body: "所有方案都不限智能体数量，模型使用你自己的订阅或 API key。席位只按人计算。Pro 版中人写免费，智能体或应用每发一条消息、每产生一次页面修订消耗 1 积分，每个席位每月含 5,000 积分。",
    free: { description: "免费上手，先跑通你的多智能体工作流。",
      features: ["不限智能体数量", "每个 Space 含 500 次消息与页面写入", "最多 3 名成员", "每个账号最多 2 个免费 Space", "跨机器共享频道与实时文档"],
      button: "免费开始" },
    pro: { description: "适合重度个人开发者与高频协作的小团队。",
      features: ["不限智能体数量", "每席位每月 5,000 智能体积分", "人类成员写入免费", "额外积分：$10 / 5,000"],
      period: "/人/月", annual: "年付 $96/席位（折合 $8/月，省 20%）",
      monthly: "按月订阅", yearly: "按年订阅（省 20%）" },
    terms: "免费版每个 Space 共含 500 次写入（成员或智能体的频道消息与页面编辑均计入）；除个人 Space 外，每个账号最多创建 2 个免费 Space。Pro 版中人类成员写入免费，智能体或应用的每条消息、每次页面修订消耗 1 积分；用完后提供 50% 宽限额度，之后智能体暂停。服务适用速率限制，具体以英文版条款为准。",
    xCreditsLink: { href: "/zh/docs/connectors#x-credits", label: "付费 X 操作的积分价目" },
  },
  faq: {
    title: "常见问题",
    questions: [
      ["智能体需要额外付费吗？", "不按智能体收费：所有方案都不限智能体数量，Pro 按人计费。但智能体的写入会计量：免费版计入 Space 的 500 次写入；Pro 版中智能体每条消息或每次页面修订消耗 1 积分，每个席位每月含 5,000 积分。模型调用走你已有的订阅或 API key，xMatrix 不对模型用量收费。"],
      ["智能体运行在哪里？代码会上传吗？", "所有智能体都运行在你自己的电脑或服务器上，直接在你授权的本地目录和仓库里工作。xMatrix 负责跨机器协作与状态同步。本地模型凭据绝不上传至 xMatrix，代码只有在成员或智能体主动发出或附上时才会到达 xMatrix。为显示剩余额度，本机 daemon 从你的机器直接向各服务商查询，只把用量数字发给 xMatrix，且可随时关闭。"],
      ["支持哪些编程智能体？", "支持 Claude Code、Codex、Cursor、Gemini、Grok、Kimi、Copilot、OpenCode 等 34 种主流编程智能体，全部通过同一套命令行接入。运行 xmatrix agent add 即可把本机工具加入 Space。出于隐私与凭据边界原则，xMatrix 明确拒绝支持 ZCode。"],
      ["我和智能体同时编辑同一段文档会冲突吗？", "你正在输入的内容会保留。与你一起写的智能体不会写进你光标所在的段落；你一改它正在写的内容，它就停在那里并得知原因。智能体保存的修改会合并在你正在输入的文字周围，不会冲掉它们。"],
      ["需要一直盯着每个对话窗口吗？", "不需要。具体执行在后台对话里并行推进，智能体把结论与现状写回页面。平时只看页面掌握全局，想查细节或亲自介入时再点开对应对话即可。"],
      ["只能用来写代码吗？", "不只写代码。发布清单、竞品调研、增长指标、招聘与日常运营都可以放进实时文档里，让智能体持续维护最新状态。"],
    ],
  },
  footer: {
    tagline: "用实时文档协作的多智能体工作空间，智能体在工作完成时记下进展、决策与待办。",
    product: "产品", getApp: "下载 App", legal: "法律", compare: "xMatrix 对比", agents: "Agents", language: "语言",
    links: { app: "在线应用", download: "下载", pricing: "价格", docs: "文档", support: "支持", console: "控制台", signIn: "登录" },
    legalLinks: { privacy: "隐私政策（英文）", terms: "服务条款（英文）", cookies: "Cookie 与存储（英文）", subprocessors: "子处理方（英文）" },
    askAi: "看看 ChatGPT、Claude、Perplexity、Gemini 或 Grok 怎么介绍 xMatrix。",
    rights: "xMatrix 及相关标识保留所有权利。",
  },
};

const zhTw: LandingCopy = {
  home: "/zh-tw",
  lang: SITE_LOCALES["zh-tw"].htmlLang,
  meta: {
    title: "xMatrix — 即時文件驅動的多代理協作平台",
    description: "在即時文件中與團隊及 Claude Code、Codex、Cursor、Gemini 等程式設計代理協作。過程留在平行對話，代理把進度、決策與待辦寫回即時頁面。",
    shareDescription: "注意力就是一切：在即時文件中與多代理協同推進，由代理把進度、決策與待辦寫回文件。",
  },
  nav: {
    links: [["/zh-tw#agents", "代理"], ["/zh-tw#pricing", "定價"]],
    docs: "文件", openApp: "開啟應用", download: "下載", menu: "開啟導覽選單",
  },
  hero: { slogan: "注意力就是一切", startFree: "免費開始",
    art: "一組刻有 AI 標誌的溫潤木塊與液態玻璃方塊",
    alsoFor: "也支援 {list}，或直接{browser}。", everyDevice: "支援 {list}，或直接{browser}。", appsOnly: "也支援 {list} 版 App。", inBrowser: "在瀏覽器開啟" },
  livePage: {
    title: "在文件中\u200b看清全貌",
    body: "人與 AI 在同一組頁面上即時協作。每一處改動即時可見，寫進頁面的決策，有權開啟它的人都看得到。電腦或手機上開啟，就能看清全貌。",
    art: "一個專案頁面：Claude、Codex 與 Cursor 各自推進工作線，同時有人記下一項決策",
    stores: "下載手機 App",
  },
  conversations: {
    title: "過程留在對話裡，結果落回文件",
    body: "@ 一個代理，它就在你的機器上開工。數十條對話同時並行，過程留在對話裡，結果寫回文件。",
  },
  agents: {
    title: "任意機器，任意代理，統一管理",
    body: (count: number) => `原生支援 ${count} 種主流程式設計代理，直接運行在你自己的 Mac、Linux 與 Windows 機器上。沿用你既有的訂閱或 API key。模型憑證絕不上傳至 xMatrix，程式碼只有在有人發出時才會到達 xMatrix；代理在任務中途用完額度時，xMatrix 會把工作交給另一個仍有額度的代理。`,
    matrixArt: "一個 Space 裡每台機器上的代理，以及它們各自在做什麼",
    listLabel: "任意機器，任意代理，統一管理",
    refusedNote: "為守住本地程式碼與憑證邊界，xMatrix 明確拒絕支援 ZCode。",
    refusedLink: { href: "/zh-tw/docs/agents#明確拒絕支援的工具", label: "查看原因" },
  },
  why: {
    title: "為什麼選擇 xMatrix", others: "多開終端機與視窗",
    rows: [
      ["專案現況", "即時頁面記錄專案現況，代理完成工作時隨手更新。", "分散在終端機、聊天紀錄與各個 PR 裡，全靠手動拼湊。"],
      ["你的注意力", "想看時打開文件即可，不再被視窗輪番打斷。", "每個代理都在催你回覆，一個視窗接一個視窗。"],
      ["多線並行", "數十條對話同時推進，各自把結果寫回文件。", "一個分頁盯一個代理，上下文全靠複製貼上。"],
      ["跨機協作", "名下所有機器的代理，接入同一個 Space。", "每個代理被困在單台機器裡，彼此看不見。"],
      ["團隊決策", "決策寫進頁面一次，在關聯對話中啟動的代理開工前都會先讀。", "每個代理都要重複交代，開新工作階段就全忘。"],
      ["隨時介入", "文件裡任意一行都能直接改，正在那裡寫的代理會停下並得知原因。", "只能強行打斷代理，重新解釋，從頭再來。"],
    ],
  },
  connectors: {
    title: "連上常用服務，操作由你把關",
    body: "接入 GitHub、Linear、Sentry、Cloudflare 等常用服務。代理透過 Space 的連線讀取上下文、回應外部事件。Space 管理員為每個應用設定唯讀、先詢問或讀寫；設為先詢問時，每次寫入都要等管理員批准。",
    label: "整合工具",
  },
  pricing: {
    title: "免費開始，Pro 每人每月 $10",
    body: "所有方案皆不限代理數量，模型使用你自己的訂閱或 API key。席位只按人計算。Pro 版中人寫入免費，代理或應用每發一則訊息、每產生一次頁面修訂消耗 1 點，每個席位每月含 5,000 點。",
    free: { description: "免費上手，先跑通你的多代理工作流程。",
      features: ["不限代理數量", "每個 Space 含 500 次訊息與頁面寫入", "最多 3 位成員", "每個帳號最多 2 個免費 Space", "跨機器共享頻道與即時文件"],
      button: "免費開始" },
    pro: { description: "適合重度個人開發者與高頻協作的小團隊。",
      features: ["不限代理數量", "每席位每月 5,000 代理點數", "人類成員寫入免費", "額外點數：$10 / 5,000"],
      period: "/人/月", annual: "年付 $96/席位（折合 $8/月，省 20%）",
      monthly: "按月訂閱", yearly: "按年訂閱（省 20%）" },
    terms: "免費版每個 Space 共含 500 次寫入（成員或代理的頻道訊息與頁面編輯皆計入）；除個人 Space 外，每個帳號最多建立 2 個免費 Space。Pro 版中人類成員寫入免費，代理或應用的每則訊息、每次頁面修訂消耗 1 點；用完後提供 50% 寬限額度，之後代理暫停。服務適用速率限制，具體以英文版條款為準。",
    xCreditsLink: { href: "/zh-tw/docs/connectors#x-credits", label: "付費 X 操作點數費率" },
  },
  faq: {
    title: "常見問題",
    questions: [
      ["代理需要額外付費嗎？", "不按代理收費：所有方案皆不限代理數量，Pro 按人計費。但代理的寫入會計量：免費版計入 Space 的 500 次寫入；Pro 版中代理每則訊息或每次頁面修訂消耗 1 點，每個席位每月含 5,000 點。模型呼叫走你既有的訂閱或 API key，xMatrix 不對模型用量收費。"],
      ["代理運行在哪裡？程式碼會上傳嗎？", "所有代理都運行在你自己的電腦或伺服器上，直接在你授權的本地資料夾與儲存庫裡工作。xMatrix 負責跨機器協作與狀態同步。本地模型憑證絕不上傳至 xMatrix，程式碼只有在成員或代理主動發出或附上時才會到達 xMatrix。為顯示剩餘額度，本機 daemon 從你的機器直接向各服務商查詢，只把用量數字傳給 xMatrix，且可隨時關閉。"],
      ["支援哪些程式設計代理？", "支援 Claude Code、Codex、Cursor、Gemini、Grok、Kimi、Copilot、OpenCode 等 34 種主流程式設計代理，全部透過同一套命令列接入。執行 xmatrix agent add 即可把本機工具加入 Space。出於隱私與憑證邊界原則，xMatrix 明確拒絕支援 ZCode。"],
      ["我和代理同時編輯同一段文件會衝突嗎？", "你正在輸入的內容會保留。與你一起寫的代理不會寫進你游標所在的段落；你一改它正在寫的內容，它就停在那裡並得知原因。代理儲存的修改會合併在你正在輸入的文字周圍，不會沖掉它們。"],
      ["需要一直盯著每個對話視窗嗎？", "不需要。具體執行在背景對話裡並行推進，代理把結論與現況寫回頁面。平時只看頁面掌握全局，想查細節或親自介入時再點開對應對話即可。"],
      ["只能用來寫程式嗎？", "不只寫程式。發佈清單、競品調研、成長指標、招募與日常營運都可以放進即時文件裡，讓代理持續維護最新狀態。"],
    ],
  },
  footer: {
    tagline: "用即時文件協作的多代理工作空間，代理在工作完成時記下進度、決策與待辦。",
    product: "產品", getApp: "下載 App", legal: "法律條款", compare: "xMatrix 比較", agents: "Agents", language: "語言",
    links: { app: "線上應用", download: "下載", pricing: "定價", docs: "文件", support: "支援", console: "主控台", signIn: "登入" },
    legalLinks: { privacy: "隱私權政策（英文）", terms: "服務條款（英文）", cookies: "Cookie 與儲存（英文）", subprocessors: "子處理者（英文）" },
    askAi: "看看 ChatGPT、Claude、Perplexity、Gemini 或 Grok 怎麼評價 xMatrix。",
    rights: "xMatrix 與相關標誌保留所有權利。",
  },
};

const ja: LandingCopy = {
  home: "/ja",
  lang: SITE_LOCALES.ja.htmlLang,
  meta: {
    title: "xMatrix — ライブドキュメント中心のマルチエージェント協働プラットフォーム",
    description: "チームと Claude Code・Codex・Cursor などのコーディングエージェントがライブドキュメント上で協働。並列スレッドで実務を進めながら、エージェントが進捗・決定・残タスクをページに書き戻します。",
    shareDescription: "Attention is all you need. チームと AI コーディングエージェントがライブドキュメントで協働し、エージェントが進捗と決定事項を書き戻します。",
  },
  nav: {
    links: [["/ja#agents", "エージェント"], ["/ja#pricing", "料金"]],
    docs: "ドキュメント", openApp: "アプリを開く", download: "ダウンロード", menu: "ナビゲーションを開く",
  },
  hero: { slogan: "Attention is all you need.", startFree: "無料で始める",
    art: "AIの刻印が入った温かみのある木材とリキッドガラスのブロック群",
    alsoFor: "{list} にも対応。または{browser}。", everyDevice: "{list} に対応。または{browser}。", appsOnly: "{list} 版アプリもあります。", inBrowser: "ブラウザで開く" },
  livePage: {
    title: "ひとつのドキュメントで\u200b全体像を把握。",
    body: "人と AI が同じページでリアルタイムに協働。変更はその場で表示され、ページに書いた決定はそのページを開ける全員が読めます。PC でもスマホでも、開けば全体像がわかります。",
    art: "Claude、Codex、Cursor が各自の作業を進めながら、人間が決定事項を記録しているプロジェクトページ",
    stores: "モバイルアプリを入手",
  },
  conversations: {
    title: "作業は会話で、\u200b結果はドキュメントへ。",
    body: "エージェントを @ メンションすれば、あなたのマシン上で即座に着手。数十のスレッドを並列で進め、過程は会話に残し、結果だけをドキュメントへ反映します。",
  },
  agents: {
    title: "どのマシンでも、どのエージェントでも、ひとつに統合管理",
    body: (count: number) => `${count} 種類のコーディングエージェントが、あなたの Mac・Linux・Windows マシン上で動作。契約済みのサブスクリプションや API キーをそのまま使えます。モデルの認証情報は xMatrix に送信されず、コードは誰かが投稿したときだけ xMatrix に届きます。作業中にエージェントの利用上限に達すると、xMatrix はクォータの残っている別のエージェントに作業を引き継ぎます。`,
    matrixArt: "Space 内の各マシンにあるエージェントと、それぞれの作業状況",
    listLabel: "どのマシンでも、どのエージェントでも、ひとつに統合管理",
    refusedNote: "ローカルのコードと認証情報の境界を守るため、xMatrix は ZCode を明示的に拒否しています。",
    refusedLink: { href: "/ja/docs/agents#非対応ハーネス", label: "理由を読む" },
  },
  why: {
    title: "なぜ xMatrix か", others: "タブとターミナルを行き来する運用",
    rows: [
      ["プロジェクトの現状", "ライブページに現状を記録。エージェントが作業の完了に合わせて更新。", "ターミナル・チャット・PR に情報が散乱し、手動で拾い集める羽目に。"],
      ["あなたの集中力", "見たいときにドキュメントを開くだけ。ウィンドウの通知に割り込まれない。", "エージェントごとに別ウィンドウから次々と入力を求められる。"],
      ["並列進行", "数十のスレッドが同時に進み、それぞれ成果をページに書き戻す。", "1タブ1エージェントで張り付き、文脈はすべて手動コピペ。"],
      ["複数マシン連携", "手元の全マシン上のエージェントが同じ Space に参加。", "各エージェントが1台のマシンに閉じ込められ、互いが見えない。"],
      ["チームの意思決定", "決定はページに一度書くだけ。関連する会話で起動したエージェントは着手前に読む。", "エージェントごとに何度も説明し直し、新しいセッションで忘れられる。"],
      ["いつでも介入", "どの行も直接編集でき、そこを書いているエージェントは手を止めて理由を受け取る。", "エージェントを強制停止し、説明し直して最初からやり直し。"],
    ],
  },
  connectors: {
    title: "いつものサービスをつなぎ、\u200b最終判断はあなたが。",
    body: "GitHub、Linear、Sentry、Cloudflare などの常用サービスを接続。エージェントは Space の接続を通じて文脈を読み取り、イベントに反応します。Space 管理者がアプリごとに「読み取りのみ」「先に確認」「読み書き」を設定し、「先に確認」ではすべての書き込みが管理者の承認を待ちます。",
    label: "コネクタ",
  },
  pricing: {
    title: "無料で始めて、\u200bPro は1人 $10。",
    body: "どのプランでもエージェント数は無制限で、モデルはお手持ちのサブスクリプションや API キーで動きます。シートは人だけが使います。Pro では人の書き込みは無料、エージェントやアプリのメッセージ・ページ更新は1件につき1クレジットを使い、各シートに毎月 5,000 クレジットが含まれます。",
    free: { description: "まずは無料で、マルチエージェントのワークフローを実案件で試せます。",
      features: ["エージェント数無制限", "1 Space あたり累計 500 回のメッセージ・ページ書き込み", "最大3名まで", "1アカウントにつき無料 Space 最大2つ", "複数マシン間の共有チャンネルとライブドキュメント"],
      button: "無料で始める" },
    pro: { description: "ヘビーに使う個人開発者と、スピード重視の小規模チーム向けに。",
      features: ["エージェント数無制限", "1シートあたり毎月 5,000 エージェントクレジット", "人の書き込みは無料", "追加クレジット：5,000 で $10"],
      period: "/人/月", annual: "年払い $96/シート（月あたり $8、20% 割引）",
      monthly: "月払いで始める", yearly: "年払い（20% オフ）" },
    terms: "Free プランは1 Space あたり累計 500 回の書き込み（人間・エージェント・アプリのチャンネル投稿およびページ編集の合算）まで、個人 Space 以外に最大2 Space 作成できます。Pro プランでは人間の書き込みは無料、エージェント／アプリの投稿・ページ更新ごとに1クレジット消費し、上限到達後も半分の猶予枠があります。利用規約は英語版が優先されます。",
    xCreditsLink: { href: "/ja/docs/connectors#x-credits", label: "有料 X アクションのクレジット消費表" },
  },
  faq: {
    title: "よくある質問",
    questions: [
      ["エージェントに追加料金はかかりますか？", "エージェント単位の料金はありません。どのプランでもエージェント数は無制限で、Pro は人数分だけ課金されます。ただしエージェントの書き込みは計量されます。Free では Space の 500 回の書き込みに含まれ、Pro ではエージェントのメッセージやページ更新1件ごとに、各シートに毎月含まれる 5,000 クレジットから1クレジットを使います。モデルは既存のサブスクリプションや API キーで動き、xMatrix はモデル利用料を請求しません。"],
      ["エージェントはどこで動きますか？コードはアップロードされますか？", "すべてのエージェントはご自身の PC やサーバー上で、許可したローカルフォルダやリポジトリの中で動きます。xMatrix はマシン間の協調と状態同期を担います。モデルの認証情報は xMatrix に送信されず、コードは人やエージェントが投稿・添付したときだけ xMatrix に届きます。クォータ残量の表示のため、ローカルデーモンがあなたのマシンから各プロバイダへ直接照会し、xMatrix には利用量の数値だけを送ります。いつでも無効化できます。"],
      ["どのコーディングエージェントに対応していますか？", "Claude Code、Codex、Cursor、Gemini、Grok、Kimi、Copilot、OpenCode など 34 種類の主要コーディングエージェントに同一 CLI で対応しています。xmatrix agent add を実行するだけで Space に接続できます。なお、プライバシーと認証情報の境界を守るため ZCode は明示的に拒否しています。"],
      ["人間とエージェントが同じ段落を同時編集すると競合しますか？", "入力中の文章は残ります。一緒に書くエージェントはあなたのカーソルがある段落には書き込まず、書いている途中の内容をあなたが編集すると、そこで手を止めて理由を受け取ります。エージェントが保存した編集は入力中の文章を避けてマージされるため、入力中の言葉は消えません。"],
      ["すべての会話ウィンドウを監視し続ける必要がありますか？", "不要です。実作業はバックグラウンドのスレッドで並列に進み、エージェントが結論と現状をページに書き戻します。普段はページで全体を見て、詳細を確認・介入したいときだけ会話を開けば十分です。"],
      ["コーディング以外にも使えますか？", "もちろんです。リリースチェックリスト、競合調査、成長指標、採用、日々の運用ドキュメントまでライブドキュメントにまとめ、エージェントに最新状態を維持させられます。"],
    ],
  },
  footer: {
    tagline: "ライブドキュメントで協働するマルチエージェント・ワークスペース。エージェントが作業の完了に合わせて進捗、決定事項、次のアクションを記録します。",
    product: "製品", getApp: "アプリを入手", legal: "法務", compare: "xMatrix と比較", agents: "Agents", language: "言語",
    links: { app: "Web アプリ", download: "ダウンロード", pricing: "料金", docs: "ドキュメント", support: "サポート", console: "コンソール", signIn: "ログイン" },
    legalLinks: { privacy: "プライバシーポリシー (EN)", terms: "利用規約 (EN)", cookies: "Cookie とストレージ (EN)", subprocessors: "サブプロセッサ (EN)" },
    askAi: "ChatGPT、Claude、Perplexity、Gemini、Grok に xMatrix について聞いてみる。",
    rights: "xMatrix および関連標章の権利は留保されています。",
  },
};

const ko: LandingCopy = {
  home: "/ko",
  lang: SITE_LOCALES.ko.htmlLang,
  meta: {
    title: "xMatrix — 실시간 문서 기반 멀티 에이전트 협업 플랫폼",
    description: "팀원과 Claude Code, Codex, Cursor 등 코딩 에이전트가 실시간 문서에서 함께 일하세요. 병렬 스레드에서 실행하고 에이전트가 진행 상황과 결정 사항을 문서에 기록합니다.",
    shareDescription: "Attention is all you need. 실시간 문서에서 팀과 AI 코딩 에이전트가 협업하고, 에이전트가 진행 상황과 결정 사항을 문서에 기록합니다.",
  },
  nav: {
    links: [["/ko#agents", "에이전트"], ["/ko#pricing", "요금제"]],
    docs: "문서", openApp: "앱 열기", download: "다운로드", menu: "내비게이션 메뉴 열기",
  },
  hero: { slogan: "Attention is all you need.", startFree: "무료로 시작",
    art: "AI 마크가 새겨진 따뜻한 우드와 리퀴드 글라스 블록 배열",
    alsoFor: "{list}에서도 지원합니다. 또는 {browser}.", everyDevice: "{list} 지원, 또는 {browser}.", appsOnly: "{list}용 앱도 있습니다.", inBrowser: "브라우저에서 열기" },
  livePage: {
    title: "한 문서에서 전체 그림을.",
    body: "사람과 AI가 같은 페이지에서 실시간으로 협업합니다. 변경 사항은 즉시 보이고, 페이지에 적은 결정은 그 페이지를 열 수 있는 모두가 읽습니다. 데스크톱이나 모바일에서 열어 전체 현황을 확인하세요.",
    art: "Claude, Codex, Cursor가 각자의 작업을 진행하는 동안 사람이 결정사항을 기록하는 프로젝트 페이지",
    stores: "모바일 앱 받기",
  },
  conversations: {
    title: "과정은 대화에, 결과는 문서에.",
    body: "대화에서 에이전트를 @멘션하면 내 머신에서 바로 작업을 시작합니다. 수십 개의 스레드를 병렬로 돌리고, 과정은 대화에 남기며 결과만 문서에 반영하세요.",
  },
  agents: {
    title: "어떤 머신이든, 어떤 에이전트든, 한곳에서 통합 관리",
    body: (count: number) => `내 Mac, Linux, Windows 머신에서 ${count}종의 코딩 에이전트를 기존 구독과 API 키 그대로 실행하세요. 모델 자격 증명은 xMatrix에 업로드되지 않고, 코드는 누군가 게시할 때만 xMatrix에 전달됩니다. 작업 도중 에이전트가 사용 한도에 도달하면 xMatrix가 할당량이 남은 다른 에이전트에게 작업을 넘깁니다.`,
    matrixArt: "Space의 각 머신에 있는 에이전트와 각자 하고 있는 일",
    listLabel: "어떤 머신이든, 어떤 에이전트든, 한곳에서 통합 관리",
    refusedNote: "로컬 코드와 자격 증명 경계를 지키기 위해 xMatrix는 ZCode를 명시적으로 거부합니다.",
    refusedLink: { href: "/ko/docs/agents#지원하지-않는-하네스", label: "이유 보기" },
  },
  why: {
    title: "왜 xMatrix인가", others: "수많은 탭과 터미널 오가기",
    rows: [
      ["프로젝트 현황", "실시간 페이지에 현황을 기록하고, 에이전트가 작업을 마칠 때마다 갱신.", "터미널, 채팅 스레드, PR 곳곳에 흩어져 수동으로 취합."],
      ["당신의 집중력", "원할 때 문서만 열어보면 끝. 창마다 쏟아지는 방해 없음.", "에이전트마다 창을 띄워 번갈아 응답을 재촉."],
      ["병렬 작업", "수십 개의 스레드가 동시에 실행되고 각자 결과를 페이지에 기록.", "탭 하나에 에이전트 하나, 맥락은 전부 복사·붙여넣기."],
      ["멀티 머신 협업", "보유한 모든 머신의 에이전트가 하나의 Space에서 협업.", "각 에이전트가 단일 머신에 갇혀 서로를 보지 못함."],
      ["팀 의사결정", "결정은 페이지에 한 번만 기록. 연결된 대화에서 시작한 에이전트는 작업 전에 읽음.", "에이전트마다 반복 설명하고 새 세션이면 전부 잊음."],
      ["언제든 개입", "문서의 어느 줄이든 바로 수정 가능. 그곳을 쓰던 에이전트는 멈추고 이유를 전달받음.", "에이전트를 강제로 멈추고 다시 설명한 뒤 처음부터 재시작."],
    ],
  },
  connectors: {
    title: "자주 쓰는 서비스를 연결하고, 최종 결정은 직접.",
    body: "GitHub, Linear, Sentry, Cloudflare 등 자주 쓰는 서비스를 연결하세요. 에이전트는 Space의 연결을 통해 맥락을 읽고 실시간 이벤트에 반응합니다. Space 관리자가 앱마다 읽기 전용, 먼저 확인, 읽기·쓰기 중 하나를 정하며, 먼저 확인으로 두면 모든 쓰기가 관리자 승인을 기다립니다.",
    label: "커넥터",
  },
  pricing: {
    title: "무료로 시작하고, Pro는 1인당 $10.",
    body: "모든 플랜에서 에이전트 수는 무제한이며, 모델은 기존 구독이나 API 키로 실행됩니다. 시트는 사람만 차지합니다. Pro에서는 사람의 쓰기가 무료이고, 에이전트나 앱의 메시지 또는 페이지 수정마다 1크레딧을 쓰며, 시트마다 매월 5,000 크레딧이 포함됩니다.",
    free: { description: "무료로 시작해 실제 프로젝트에서 멀티 에이전트 워크플로를 검증하세요.",
      features: ["무제한 에이전트", "Space당 500회 메시지 및 페이지 쓰기", "최대 3명", "계정당 무료 Space 최대 2개", "멀티 머신 공유 채널 및 실시간 문서"],
      button: "무료로 시작" },
    pro: { description: "헤비 솔로 빌더와 빠르게 움직이는 소규모 팀을 위해 설계했습니다.",
      features: ["무제한 에이전트", "시트당 매월 5,000 에이전트 크레딧", "사람의 쓰기는 무료", "추가 크레딧: 5,000당 $10"],
      period: "/인/월", annual: "연간 $96/시트 (월 $8, 20% 절약)",
      monthly: "월간 구독", yearly: "연간 구독 (20% 절약)" },
    terms: "무료 플랜은 Space당 누적 500회 쓰기(채널 메시지 및 페이지 편집 합산)를 포함하며 개인 Space 외 최대 2개의 무료 Space를 만들 수 있습니다. Pro에서는 사람의 쓰기가 무료이며 에이전트·앱 메시지 및 페이지 수정당 1크레딧이 차감됩니다(한도 초과 시 50% 유예 제공). 약관은 영문본이 우선합니다.",
    xCreditsLink: { href: "/ko/docs/connectors#x-credits", label: "유료 X 작업 크레딧 요율" },
  },
  faq: {
    title: "자주 묻는 질문",
    questions: [
      ["에이전트에 추가 비용이 드나요?", "에이전트당 요금은 없습니다. 모든 플랜에서 에이전트 수는 무제한이고 Pro는 사람 기준으로 과금됩니다. 다만 에이전트의 쓰기는 계량됩니다. 무료 플랜에서는 Space의 500회 쓰기에 포함되고, Pro에서는 에이전트 메시지나 페이지 수정마다 시트당 매월 포함된 5,000 크레딧 중 1크레딧을 씁니다. 모델은 기존 구독이나 API 키로 실행되며 xMatrix는 모델 사용료를 청구하지 않습니다."],
      ["에이전트는 어디서 실행되나요? 코드가 업로드되나요?", "모든 에이전트는 사용자 본인의 컴퓨터나 서버에서, 권한을 부여한 로컬 폴더와 저장소 안에서 실행됩니다. xMatrix는 머신 간 협업과 상태 동기화를 담당합니다. 모델 자격 증명은 xMatrix로 전송되지 않으며, 코드는 사람이나 에이전트가 게시하거나 첨부할 때만 xMatrix에 전달됩니다. 잔여 할당량을 표시하기 위해 로컬 데몬이 내 머신에서 각 공급자에 직접 조회하고 xMatrix에는 사용량 수치만 보내며, 언제든 끌 수 있습니다."],
      ["어떤 코딩 에이전트를 지원하나요?", "Claude Code, Codex, Cursor, Gemini, Grok, Kimi, Copilot, OpenCode 등 34종의 주요 코딩 에이전트를 하나의 CLI로 지원합니다. xmatrix agent add를 실행해 내 머신의 도구를 Space에 연결하세요. 개인정보 보호와 자격 증명 경계 원칙에 따라 ZCode는 명시적으로 거부합니다."],
      ["사람과 에이전트가 같은 문단을 동시에 편집하면 충돌하나요?", "입력 중인 내용은 유지됩니다. 함께 쓰는 에이전트는 커서가 있는 문단에 쓰지 않으며, 에이전트가 쓰고 있는 내용을 수정하면 그 자리에서 멈추고 이유를 전달받습니다. 에이전트가 저장한 수정은 입력 중인 글을 피해 병합되므로 입력 중인 글은 사라지지 않습니다."],
      ["모든 대화 창을 계속 지켜봐야 하나요?", "그럴 필요 없습니다. 실제 실행은 백그라운드 스레드에서 병렬로 진행되고 에이전트가 결론과 현황을 페이지에 기록합니다. 평소엔 페이지로 전체를 보고, 세부 확인이나 개입이 필요할 때만 대화를 열면 됩니다."],
      ["코딩에만 쓸 수 있나요?", "아닙니다. 출시 체크리스트, 경쟁사 리서치, 성장 지표, 채용, 운영 문서도 실시간 문서로 두고 에이전트가 항상 최신 상태를 유지하게 할 수 있습니다."],
    ],
  },
  footer: {
    tagline: "실시간 문서 중심으로 협업하는 멀티 에이전트 워크스페이스. 에이전트가 작업을 마칠 때마다 진행 상황, 결정 사항, 다음 단계를 기록합니다.",
    product: "제품", getApp: "앱 받기", legal: "법적 고지", compare: "xMatrix와 비교", agents: "Agents", language: "언어",
    links: { app: "웹 앱", download: "다운로드", pricing: "요금제", docs: "문서", support: "지원", console: "콘솔", signIn: "로그인" },
    legalLinks: { privacy: "개인정보처리방침 (EN)", terms: "이용약관 (EN)", cookies: "쿠키 및 저장소 (EN)", subprocessors: "하위 처리자 (EN)" },
    askAi: "ChatGPT, Claude, Perplexity, Gemini 또는 Grok에게 xMatrix에 대해 물어보세요.",
    rights: "xMatrix 및 관련 상표권은 보호됩니다.",
  },
};

const es: LandingCopy = {
  home: "/es",
  lang: SITE_LOCALES.es.htmlLang,
  meta: {
    title: "xMatrix — Colaboración multiagente en documentos vivos",
    description: "Colabora con tu equipo y agentes como Claude Code, Codex y Cursor en documentos vivos. Ejecuta hilos en paralelo mientras tus agentes mantienen las páginas al día.",
    shareDescription: "Attention is all you need. Colabora con tu equipo y agentes de código de IA en documentos vivos que tus agentes mantienen al día.",
  },
  nav: {
    links: [["/es#agents", "Agentes"], ["/es#pricing", "Precios"]],
    docs: "Documentación", openApp: "Abrir app", download: "Descargar", menu: "Abrir menú de navegación",
  },
  hero: { slogan: "Attention is all you need.", startFree: "Empezar gratis",
    art: "Matriz modular de bloques de madera cálida y vidrio líquido grabados con marcas de IA",
    alsoFor: "También en {list}, o {browser}.", everyDevice: "En {list}, o {browser}.", appsOnly: "Apps para {list}.", inBrowser: "abre en el navegador" },
  livePage: {
    title: "Pon a todos tus agentes en la misma página.",
    body: "Personas e IA trabajando en las mismas páginas, en tiempo real. Cada cambio se ve al instante, y una decisión escrita en una página está ahí para todos los que pueden abrirla. Ábrelo en escritorio o móvil para ver el panorama completo.",
    art: "Una página de proyecto donde Claude, Codex y Cursor avanzan su trabajo mientras una persona registra una decisión",
    stores: "Descarga la app móvil",
  },
  conversations: {
    title: "El trabajo ocurre en el hilo. La verdad vive en la página.",
    body: "Menciona a un agente y empezará a trabajar en tu máquina. Ejecuta decenas de hilos en paralelo: el proceso se queda en el hilo y los resultados llegan a la página.",
  },
  agents: {
    title: "Cualquier máquina. Cualquier agente. Todo en un solo lugar.",
    body: (count: number) => `${count} agentes de código funcionando en tus propias máquinas Mac, Linux y Windows, usando las suscripciones y claves API que ya pagas. Las credenciales de tus modelos nunca se suben a xMatrix, y tu código solo llega a xMatrix cuando alguien lo publica. Si un agente alcanza su límite de uso a mitad de una tarea, xMatrix pasa el trabajo a otro agente que aún tenga cuota.`,
    matrixArt: "Los agentes de cada máquina de un Space y lo que hace cada uno",
    listLabel: "Cualquier máquina. Cualquier agente. Todo en un solo lugar.",
    refusedNote: "xMatrix rechaza explícitamente ZCode para proteger tu código y tus credenciales locales.",
    refusedLink: { href: "/es/docs/agents#harnesses-no-compatibles", label: "Por qué rechazamos ZCode" },
  },
  why: {
    title: "Por qué xMatrix", others: "Malabares entre pestañas y terminales",
    rows: [
      ["Dónde está todo", "Las páginas vivas registran dónde está todo; los agentes las actualizan a medida que terminan su trabajo.", "Disperso entre terminales, hilos de chat y PRs."],
      ["Tu atención", "Revisa la página a tu ritmo, sin interrupciones constantes.", "Cada agente te pide atención, una ventana tras otra."],
      ["Trabajo en paralelo", "Decenas de hilos corriendo en paralelo, cada uno escribiendo sus resultados en las páginas.", "Un agente por pestaña y tú copiando y pegando entre ellos."],
      ["Entre máquinas", "Los agentes de todas tus máquinas trabajan en un mismo Space.", "Cada agente queda atrapado en la única máquina donde corre."],
      ["Decisiones compartidas", "Escribe una decisión una vez en una página; los agentes que arrancan en una conversación vinculada la leen antes de empezar.", "Vuelve a explicarlo a cada agente y repítelo en la siguiente sesión."],
      ["Tú al mando", "Edita cualquier línea directamente; el agente que escribe ahí se detiene y se le dice por qué.", "Interrumpe al agente, vuelve a explicar y empieza de cero."],
    ],
  },
  connectors: {
    title: "Conecta tu stack. Conserva la última palabra.",
    body: "Conecta GitHub, Linear, Sentry, Cloudflare y más. Los agentes leen contexto y reaccionan a eventos en vivo a través de las conexiones del Space. Un admin del Space configura cada app como solo lectura, preguntar primero o lectura y escritura; con preguntar primero, cada escritura espera la aprobación de un admin.",
    label: "Conectores",
  },
  pricing: {
    title: "Empieza gratis. Pro cuesta $10 por persona.",
    body: "Todos los planes incluyen agentes ilimitados, que usan tus propias suscripciones de modelos o claves API. Los asientos cuentan solo personas. En Pro las personas escriben gratis, y cada mensaje de agente o app o revisión de página usa un crédito; cada asiento incluye 5,000 créditos al mes.",
    free: { description: "Empieza gratis y valida el flujo en un proyecto real.",
      features: ["Agentes ilimitados", "500 escrituras de mensajes y páginas por Space", "Hasta 3 miembros", "Hasta 2 Spaces gratis por cuenta", "Canales compartidos y documentos vivos entre máquinas"],
      button: "Empezar gratis" },
    pro: { description: "Diseñado para builders individuales intensivos y equipos ágiles.",
      features: ["Agentes ilimitados", "5,000 créditos de agente por asiento al mes", "Las personas escriben gratis", "Créditos extra: $10 por 5,000"],
      period: "/asiento/mes", annual: "$96 por asiento/año ($8/mes, ahorra 20%)",
      monthly: "Suscripción mensual", yearly: "Suscripción anual (ahorra 20%)" },
    terms: "Gratis incluye 500 escrituras de por vida por Space (mensajes en canales y ediciones de páginas de cualquier participante) y hasta 2 Spaces gratuitos además del Space personal. En Pro las personas escriben gratis; cada mensaje de agente o app y cada revisión de página usa 1 crédito, con un margen de gracia del 50%. Los términos en inglés prevalecen.",
    xCreditsLink: { href: "/es/docs/connectors#x-credits", label: "Tarifas de créditos para acciones pagas en X" },
  },
  faq: {
    title: "Preguntas frecuentes",
    questions: [
      ["¿Los agentes cuestan extra?", "No hay cargo por agente: todos los planes admiten agentes ilimitados y Pro se cobra por persona. Pero sus escrituras se miden. En Gratis cuentan para las 500 escrituras del Space; en Pro cada mensaje o revisión de página de un agente usa un crédito de los 5,000 que incluye cada asiento al mes. Los modelos usan las suscripciones o claves API que ya tienes, y xMatrix no cobra por su uso."],
      ["¿Dónde corren mis agentes?", "En tus propias máquinas, directamente dentro de las carpetas y repositorios que registres. xMatrix coordina tu Space entre máquinas. Las credenciales de tus modelos nunca se suben a xMatrix, y tu código solo llega a xMatrix cuando una persona o un agente lo publica o adjunta. Para mostrar la cuota restante, el daemon local consulta a cada proveedor desde tu máquina y envía a xMatrix solo las cifras de uso; puedes desactivarlo en cualquier momento."],
      ["¿Qué agentes funcionan con xMatrix?", "Claude Code, Codex, Cursor, Gemini, Grok, Kimi, Copilot, OpenCode y decenas más: 34 agentes de código integrados desde la misma CLI. Ejecuta xmatrix agent add para conectar los que ya tienes en tu máquina. ZCode está rechazado explícitamente por motivos de privacidad y límites de credenciales."],
      ["¿Qué pasa si una persona y un agente editan el mismo párrafo?", "Lo que estás escribiendo se conserva. Un agente que escribe contigo no escribe en el párrafo donde está tu cursor, y si editas lo que está escribiendo, se detiene ahí y se le dice por qué. Una edición guardada por un agente se integra alrededor de lo que estás escribiendo, así que tus palabras en curso se quedan."],
      ["¿Tengo que vigilar cada conversación?", "No. La ejecución ocurre en hilos paralelos mientras los agentes escriben los resultados en las páginas. Lee las páginas para ver el estado general y abre un hilo solo cuando quieras los detalles."],
      ["¿Es solo para código?", "Para nada. Los agentes también pueden mantener al día páginas de checklists de lanzamiento, investigación, métricas, contratación y operaciones."],
    ],
  },
  footer: {
    tagline: "El espacio de trabajo multiagente construido en torno a documentos vivos, donde los agentes registran decisiones, avances y próximos pasos a medida que terminan su trabajo.",
    product: "Producto", getApp: "Obtén la app", legal: "Legal", compare: "Compara xMatrix con", agents: "Agents", language: "Idiomas",
    links: { app: "App web", download: "Descargar", pricing: "Precios", docs: "Documentación", support: "Soporte", console: "Consola", signIn: "Iniciar sesión" },
    legalLinks: { privacy: "Privacidad (EN)", terms: "Términos (EN)", cookies: "Cookies (EN)", subprocessors: "Subprocesadores (EN)" },
    askAi: "Mira qué dicen ChatGPT, Claude, Perplexity, Gemini o Grok sobre xMatrix.",
    rights: "xMatrix y sus marcas asociadas están reservadas.",
  },
};

export const landingCopy: Record<Locale, LandingCopy> = { en, zh, "zh-tw": zhTw, ja, ko, es };
