import { FREE_PLAN_FEATURES, PRO_PLAN_FEATURES } from "@/lib/space-plans";
import { SITE_LOCALES, type SiteLocale } from "@/lib/site-locales";

/**
 * The homepage's words in each language it is published in: English at `/`,
 * and localized trees at `/zh`, `/zh-tw`, `/ja`, `/ko`, and `/es`.
 */
export type Locale = SiteLocale;

type Pair = readonly [string, string];
type Row = readonly [string, string, string];

/** The words inside Why xMatrix's animated examples, one example per row. */
export interface WhyScenes {
  terminal: string; thread: string; terminalLine: string; threadLine: string; prLine: string;
  page: string; web: string; mobile: string; docs: string; progress: readonly [string, string, string]; done: readonly [string, string, string];
  pings: readonly [string, string, string]; quiet: string;
  copied: string; paste: string; waiting: string;
  machines: readonly [string, string, string]; thisMachineOnly: string;
  decided: string; decision: string; read: string; forgot: string;
  stop: string; again: string; draft: readonly [string, string, string]; edited: string; agentWaits: string;
}

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
  agents: { title: string; body: (count: number) => string; matrixArt: string; listLabel: string };
  why: { title: string; others: string; rows: readonly Row[]; scenes: WhyScenes };
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
    description: "Collaborate with your team and coding agents like Claude Code, Codex, and Cursor through live documents. Run threads in parallel while pages stay current.",
    shareDescription: "Attention is all you need. Collaborate with your team and AI coding agents through live documents that stay current as work moves.",
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
    body: "People and AI, working as one—in real time. Every change is visible the moment it lands, every decision shared with everyone. Open it on desktop or mobile to see the whole picture.",
    art: "A project page where Claude, Codex and Cursor each move their workstream forward while a person records a decision",
    stores: "Get the phone app",
  },
  conversations: {
    title: "Conversations do the work. The page holds the truth.",
    body: "Mention an agent and it starts work on your machine. Run dozens of threads in parallel—the process stays in the thread, results land on the page.",
  },
  agents: {
    title: "Any machine. Any agent. All managed in one place.",
    body: (count: number) => `${count} coding agents running on your own Mac, Linux, and Windows machines—using the subscriptions and API keys you already pay for. Code and credentials stay local, and when one agent hits its quota, another picks up the work.`,
    matrixArt: "The agents on each machine of a Space, and what each one is doing",
    listLabel: "Any machine. Any agent. All managed in one place.",
  },
  why: {
    title: "Why xMatrix", others: "Juggling tabs & terminals",
    rows: [
      ["Where things stand", "One live document per project, always up to date.", "Scattered across terminals, chat threads, and PRs."],
      ["Your attention", "Check the page on your schedule—no constant interruptions.", "Every agent pings you for input, one window at a time."],
      ["Parallel work", "Dozens of threads running in parallel, reporting to one page.", "One agent per tab, with you copy-pasting between them."],
      ["Across machines", "Agents on every machine you own work in one shared Space.", "Each agent is trapped on the single machine it runs on."],
      ["Shared decisions", "Write a decision once; every human and agent reads it.", "Re-explain to every agent, then repeat in the next session."],
      ["Human in the loop", "Edit any line directly—an agent on that paragraph waits for you.", "Interrupt the agent, explain again, and start over."],
    ],
    scenes: {
      terminal: "Terminal", thread: "Thread", terminalLine: "claude › fixing auth…", threadLine: "codex: which branch?", prLine: "Changes requested",
      page: "Launch", web: "Web editor", mobile: "Mobile app", docs: "Launch video", progress: ["login fix, checks 3/5", "build 2.4 at 60%", "cut 2 of 4 scenes"], done: ["merged, live in `v1.0.464`", "build 2.4 in `TestFlight`", "on the launch page"],
      pings: ["Claude needs your input", "Codex: which branch?", "Cursor is waiting for you"], quiet: "No pings",
      copied: "Copied the API from Claude", paste: "Paste it into Codex", waiting: "Cursor waits for both",
      machines: ["Mac Studio", "Linux server", "Windows"], thisMachineOnly: "this machine only",
      decided: "Decided", decision: "Ship Friday, behind one switch.", read: "read", forgot: "New session: what did we decide?",
      stop: "Stop", again: "Let me explain again…", draft: ["The editor saves ", "every change", " to the page."], edited: "every keystroke", agentWaits: "waits for you",
    },
  },
  connectors: {
    title: "Connect your stack. Keep the final say.",
    body: "Connect GitHub, Linear, Sentry, Cloudflare, and more. Agents read context and react to live events—while sensitive external actions wait for your approval and agents never see your raw credentials.",
    label: "Connectors",
  },
  pricing: {
    title: "People pay. Agents don't.",
    body: "Bring unlimited agents on every plan—agents never take a seat. Each Pro seat includes 5,000 monthly agent credits, using your existing model subscriptions or API keys.",
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
      ["Do my agents cost extra?", "No. Every plan supports unlimited agents, and Pro charges only per human seat. Your agents keep using the subscriptions or API keys you already have—with no markup."],
      ["Where do my agents run?", "On your own machines, directly inside the folders and repositories you register. xMatrix coordinates your Space across machines while your code and model credentials stay local and are never uploaded to xMatrix. When quota display is enabled, the local daemon uses them only on your machine to query your provider's usage endpoint, and you can disable that anytime."],
      ["Which agents work with xMatrix?", "Claude Code, Codex, Cursor, Gemini, Grok, Kimi, Copilot, OpenCode, and dozens more—all through one CLI. Run xmatrix agent add to connect the ones already on your machine."],
      ["What happens when a person and an agent edit the same paragraph?", "The person always wins. If an agent reaches a paragraph you are editing, it pauses, waits until you finish, and continues from your latest text—never overwriting your words."],
      ["Do I have to watch every conversation?", "No. Execution happens in parallel threads while outcomes roll up into the live document. Read the page to see where everything stands, and open a thread only when you want the details."],
      ["Is it only for code?", "Not at all. Teams also use agents to keep release checklists, research, metrics, hiring, and operations docs continuously up to date."],
    ],
  },
  footer: {
    tagline: "The multi-agent workspace built around live documents. Decisions, progress, and next steps stay current as work moves.",
    product: "Product", getApp: "Get the app", legal: "Legal", compare: "Compare", agents: "Agents", language: "Languages",
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
    description: "在实时文档中与团队及 Claude Code、Codex、Cursor、Gemini 等编程智能体协同工作。过程留在并行对话，进展、决策与待办自动更新到活页面。",
    shareDescription: "拯救你的注意力：在实时文档中与多智能体协同推进，进展、决策与待办始终保持最新。",
  },
  nav: {
    links: [["/zh#agents", "智能体"], ["/zh#pricing", "价格"]],
    docs: "文档", openApp: "打开应用", download: "下载", menu: "打开导航菜单",
  },
  hero: { slogan: "拯救你的注意力", startFree: "免费开始",
    art: "一组刻着 AI 标志的木块和液态玻璃方块",
    alsoFor: "也支持 {list}，或直接{browser}。", everyDevice: "支持 {list}，或直接{browser}。", appsOnly: "也支持 {list} 版 App。", inBrowser: "在浏览器打开" },
  livePage: {
    title: "在文档中\u200b看清全貌",
    body: "人与 AI，通力协作，实时同步。每一处改动即时可见，每一个决策全员共享。电脑或手机上打开，就是最新全貌。",
    art: "一个项目页面：Claude、Codex 和 Cursor 各自推进自己的工作线，同时有人记下一项决定",
    stores: "下载手机 App",
  },
  conversations: {
    title: "过程留在对话里，结果落回文档",
    body: "@ 一个智能体，它就在你的机器上开工。几十条对话同时并行，过程留在对话里，结果写回文档。",
  },
  agents: {
    title: "任意机器，任意智能体，统一管理",
    body: (count: number) => `原生支持 ${count} 种主流编程智能体，直接运行在你的 Mac、Linux 与 Windows 机器上。沿用你已有的订阅或 API key，代码与凭据留在本地；一个额度用完，另一个立刻接手。`,
    matrixArt: "一个 Space 里每台机器上的智能体，以及它们各自在做什么",
    listLabel: "任意机器，任意智能体，统一管理",
  },
  why: {
    title: "为什么选择 xMatrix", others: "多开终端与窗口",
    rows: [
      ["项目现状", "每个项目一份实时文档，随工作推进自动更新。", "分散在终端、聊天记录和各个 PR 里，全靠手动拼凑。"],
      ["你的注意力", "想看时打开文档即可，不再被窗口轮番打断。", "每个智能体都在催你回复，一个窗口接一个窗口。"],
      ["多线并行", "几十条对话同时推进，各自把结果写回文档。", "一个标签页盯一个智能体，上下文全靠复制粘贴。"],
      ["跨机协作", "名下所有机器的智能体，接入同一个 Space。", "每个智能体被困在单台机器里，彼此看不见。"],
      ["团队决策", "写进文档一次，所有成员与智能体实时共享。", "每个智能体都要重复交代，开新会话就全忘。"],
      ["随时介入", "文档里任意一行都能直接改，同段智能体会自动等你。", "只能强行打断智能体，重新解释，从头再来。"],
    ],
    scenes: {
      terminal: "终端", thread: "聊天", terminalLine: "claude › 正在修登录…", threadLine: "codex：用哪个分支？", prLine: "需要修改",
      page: "发布", web: "网页编辑器", mobile: "手机 App", docs: "发布视频", progress: ["修登录，检查 3/5", "2.4 版构建 60%", "剪了 2/4 个镜头"], done: ["已合并，`v1.0.464` 上线", "2.4 版已进 TestFlight", "已放上发布页"],
      pings: ["Claude 需要你回复", "Codex：用哪个分支？", "Cursor 在等你"], quiet: "没有打扰",
      copied: "从 Claude 复制了接口", paste: "再粘贴给 Codex", waiting: "Cursor 等着两边",
      machines: ["Mac Studio", "Linux 服务器", "Windows"], thisMachineOnly: "只看得到本机",
      decided: "已决定", decision: "周五发布，用一个开关控制。", read: "已读", forgot: "新会话：我们定了什么？",
      stop: "停止", again: "我再解释一遍……", draft: ["编辑器会把", "每一次修改", "存进页面。"], edited: "每一次按键", agentWaits: "在等你",
    },
  },
  connectors: {
    title: "连上常用服务，操作由你把关",
    body: "接入 GitHub、Linear、Sentry、Cloudflare 等常用服务。智能体可以读取上下文、响应外部事件，涉及对外写入或敏感操作前先等你批准，且始终接触不到你的原始密钥。",
    label: "连接器",
  },
  pricing: {
    title: "按人付费，智能体不占席位",
    body: "所有方案均不限制智能体数量。每个 Pro 席位每月含 5,000 智能体积分，模型继续使用你已有的订阅或 API key。",
    free: { description: "免费上手，先跑通你的多智能体工作流。",
      features: ["不限智能体数量", "每个 Space 含 500 次消息与页面写入", "最多 3 名成员", "每个账号最多 2 个免费 Space", "跨机器共享频道与实时文档"],
      button: "免费开始" },
    pro: { description: "适合重度个人开发者与高频协作的小团队。",
      features: ["智能体永不占席位", "每席位每月 5,000 智能体积分", "跨智能体上下文接力与完整轨迹", "操作审批流与外部连接器"],
      period: "/人/月", annual: "年付 $96/席位（折合 $8/月，省 20%）",
      monthly: "按月订阅", yearly: "按年订阅（省 20%）" },
    terms: "免费版每个 Space 共含 500 次写入（成员或智能体的频道消息与页面编辑均计入）；除个人 Space 外，每个账号最多创建 2 个免费 Space。Pro 版中人类成员写入免费，智能体或应用的每条消息、每次页面修订消耗 1 积分；用完后提供 50% 宽限额度，之后智能体暂停。服务适用速率限制，具体以英文版条款为准。",
    xCreditsLink: { href: "/zh/docs/connectors#x-credits", label: "付费 X 操作的积分价目" },
  },
  faq: {
    title: "常见问题",
    questions: [
      ["智能体需要额外付费吗？", "不需要。无论免费版还是 Pro 版，接入的智能体数量都不受限制，Pro 仅按人类成员席位计费。模型调用直接走你已有的订阅或 API key，不加价转售。"],
      ["智能体运行在哪里？代码会上传吗？", "所有智能体都运行在你自己的电脑或服务器上，直接在你授权的本地目录和仓库里工作。xMatrix 只负责跨机器协作与状态同步，代码和本地模型凭据留在原处、绝不上传至 xMatrix；开启配额显示时，本机 daemon 仅在本地用它们直连原厂查询剩余额度，且可随时关闭。"],
      ["支持哪些编程智能体？", "支持 Claude Code、Codex、Cursor、Gemini、Grok、Kimi、Copilot、OpenCode 等 35 种主流编程智能体，全部通过同一套命令行接入。运行 xmatrix agent add 即可把本机工具加入 Space。"],
      ["我和智能体同时编辑同一段文档会冲突吗？", "不会，人永远优先。只要检测到你正在编辑某一段，智能体会主动暂停等待，等你写完再顺着你的最新内容继续，绝不覆盖你的文字。"],
      ["需要一直盯着每个对话窗口吗？", "不需要。具体执行在后台对话里并行推进，重要结论与现状自动汇总到实时文档。平时只看文档掌握全局，想查细节或亲自介入时再点开对应对话即可。"],
      ["只能用来写代码吗？", "不只写代码。发布清单、竞品调研、增长指标、招聘与日常运营都可以放进实时文档里，让智能体持续维护最新状态。"],
    ],
  },
  footer: {
    tagline: "用实时文档协作的多智能体工作空间。进展、决策与待办随工作推进自动更新。",
    product: "产品", getApp: "下载 App", legal: "法律", compare: "竞品对比", agents: "Agents", language: "语言",
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
    description: "在即時文件中與團隊及 Claude Code、Codex、Cursor、Gemini 等程式設計代理協作。過程留在平行對話，進度、決策與待辦自動更新到即時頁面。",
    shareDescription: "拯救你的注意力：在即時文件中與多代理協同推進，進度、決策與待辦始終保持最新。",
  },
  nav: {
    links: [["/zh-tw#agents", "代理"], ["/zh-tw#pricing", "定價"]],
    docs: "文件", openApp: "開啟應用", download: "下載", menu: "開啟導覽選單",
  },
  hero: { slogan: "拯救你的注意力", startFree: "免費開始",
    art: "一組刻有 AI 標誌的溫潤木塊與液態玻璃方塊",
    alsoFor: "也支援 {list}，或直接{browser}。", everyDevice: "支援 {list}，或直接{browser}。", appsOnly: "也支援 {list} 版 App。", inBrowser: "在瀏覽器開啟" },
  livePage: {
    title: "在文件中\u200b看清全貌",
    body: "人與 AI，通力協作，即時同步。每一處改動即時可見，每一個決策全員共享。電腦或手機上開啟，就是最新全貌。",
    art: "一個專案頁面：Claude、Codex 與 Cursor 各自推進工作線，同時有人記下一項決策",
    stores: "下載手機 App",
  },
  conversations: {
    title: "過程留在對話裡，結果落回文件",
    body: "@ 一個代理，它就在你的機器上開工。數十條對話同時並行，過程留在對話裡，結果寫回文件。",
  },
  agents: {
    title: "任意機器，任意代理，統一管理",
    body: (count: number) => `原生支援 ${count} 種主流程式設計代理，直接運行在你自己的 Mac、Linux 與 Windows 機器上。沿用你既有的訂閱或 API key，程式碼與憑證留在本地；一個額度用完，另一個立刻接手。`,
    matrixArt: "一個 Space 裡每台機器上的代理，以及它們各自在做什麼",
    listLabel: "任意機器，任意代理，統一管理",
  },
  why: {
    title: "為什麼選擇 xMatrix", others: "多開終端機與視窗",
    rows: [
      ["專案現況", "每個專案一份即時文件，隨工作推進自動更新。", "分散在終端機、聊天紀錄與各個 PR 裡，全靠手動拼湊。"],
      ["你的注意力", "想看時打開文件即可，不再被視窗輪番打斷。", "每個代理都在催你回覆，一個視窗接一個視窗。"],
      ["多線並行", "數十條對話同時推進，各自把結果寫回文件。", "一個分頁盯一個代理，上下文全靠複製貼上。"],
      ["跨機協作", "名下所有機器的代理，接入同一個 Space。", "每個代理被困在單台機器裡，彼此看不見。"],
      ["團隊決策", "寫進文件一次，所有成員與代理即時共享。", "每個代理都要重複交代，開新工作階段就全忘。"],
      ["隨時介入", "文件裡任意一行都能直接改，同段代理會自動等你。", "只能強行打斷代理，重新解釋，從頭再來。"],
    ],
    scenes: {
      terminal: "終端機", thread: "對話串", terminalLine: "claude › 修復登入中…", threadLine: "codex：用哪個分支？", prLine: "需要修改",
      page: "發佈", web: "網頁編輯器", mobile: "行動 App", docs: "發佈影片", progress: ["登入修復，檢查 3/5", "2.4 版建置 60%", "剪輯 2/4 個片段"], done: ["已合併，`v1.0.464` 上線", "2.4 版進 TestFlight", "已放上發佈頁"],
      pings: ["Claude 等待你的回覆", "Codex：用哪個分支？", "Cursor 正在等你"], quiet: "不再打擾",
      copied: "從 Claude 複製了 API", paste: "貼到 Codex", waiting: "Cursor 等待雙方",
      machines: ["Mac Studio", "Linux 伺服器", "Windows"], thisMachineOnly: "僅限本機",
      decided: "已拍板", decision: "週五上線，加上功能開關。", read: "已讀", forgot: "新工作階段：我們決定了什麼？",
      stop: "停止", again: "我再說明一次……", draft: ["編輯器會把", "每一次修改", "存進頁面。"], edited: "每次按鍵", agentWaits: "正在等你",
    },
  },
  connectors: {
    title: "連上常用服務，操作由你把關",
    body: "接入 GitHub、Linear、Sentry、Cloudflare 等常用服務。代理可以讀取上下文、回應外部事件，涉及對外寫入或敏感操作前先等你批准，且始終接觸不到你的原始金鑰。",
    label: "整合工具",
  },
  pricing: {
    title: "按人付費，代理不佔席位",
    body: "所有方案皆不限制代理數量。每個 Pro 席位每月含 5,000 代理點數，模型繼續使用你既有的訂閱或 API key。",
    free: { description: "免費上手，先跑通你的多代理工作流程。",
      features: ["不限代理數量", "每個 Space 含 500 次訊息與頁面寫入", "最多 3 位成員", "每個帳號最多 2 個免費 Space", "跨機器共享頻道與即時文件"],
      button: "免費開始" },
    pro: { description: "適合重度個人開發者與高頻協作的小團隊。",
      features: ["代理永不佔席位", "每席位每月 5,000 代理點數", "跨代理上下文接力與完整軌跡", "操作審批流與外部整合工具"],
      period: "/人/月", annual: "年付 $96/席位（折合 $8/月，省 20%）",
      monthly: "按月訂閱", yearly: "按年訂閱（省 20%）" },
    terms: "免費版每個 Space 共含 500 次寫入（成員或代理的頻道訊息與頁面編輯皆計入）；除個人 Space 外，每個帳號最多建立 2 個免費 Space。Pro 版中人類成員寫入免費，代理或應用的每則訊息、每次頁面修訂消耗 1 點；用完後提供 50% 寬限額度，之後代理暫停。服務適用速率限制，具體以英文版條款為準。",
    xCreditsLink: { href: "/zh-tw/docs/connectors#x-credits", label: "付費 X 操作點數費率" },
  },
  faq: {
    title: "常見問題",
    questions: [
      ["代理需要額外付費嗎？", "不需要。無論免費版還是 Pro 版，接入的代理數量都不受限制，Pro 僅按人類成員席位計費。模型呼叫直接走你既有的訂閱或 API key，不加價轉售。"],
      ["代理運行在哪裡？程式碼會上傳嗎？", "所有代理都運行在你自己的電腦或伺服器上，直接在你授權的本地資料夾與儲存庫裡工作。xMatrix 只負責跨機器協作與狀態同步，程式碼與本地模型憑證留在原處、絕不上傳至 xMatrix；啟用額度顯示時，本機 daemon 僅在本地用它們直連原廠查詢剩餘額度，且可隨時關閉。"],
      ["支援哪些程式設計代理？", "支援 Claude Code、Codex、Cursor、Gemini、Grok、Kimi、Copilot、OpenCode 等 35 種主流程式設計代理，全部透過同一套命令列接入。執行 xmatrix agent add 即可把本機工具加入 Space。"],
      ["我和代理同時編輯同一段文件會衝突嗎？", "不會，人永遠優先。只要偵測到你正在編輯某一段，代理會主動暫停等待，等你寫完再順著你的最新內容繼續，絕不覆蓋你的文字。"],
      ["需要一直盯著每個對話視窗嗎？", "不需要。具體執行在背景對話裡並行推進，重要結論與現況自動彙整到即時文件。平時只看文件掌握全局，想查細節或親自介入時再點開對應對話即可。"],
      ["只能用來寫程式嗎？", "不只寫程式。發佈清單、競品調研、成長指標、招募與日常營運都可以放進即時文件裡，讓代理持續維護最新狀態。"],
    ],
  },
  footer: {
    tagline: "用即時文件協作的多代理工作空間。進度、決策與待辦隨工作推進自動更新。",
    product: "產品", getApp: "下載 App", legal: "法律條款", compare: "競品比較", agents: "Agents", language: "語言",
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
    description: "チームと Claude Code・Codex・Cursor などのコーディングエージェントがライブドキュメント上で協働。並列スレッドで実務を進めながら、進捗・決定・残タスクを常に最新に保ちます。",
    shareDescription: "Attention is all you need. チームと AI コーディングエージェントがライブドキュメントで協働し、進捗と決定事項を常に最新に保ちます。",
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
    body: "人と AI が一体となってリアルタイムに協働。すべての変更がその場で見え、すべての決定が全員に共有されます。PC でもスマホでも、開けば最新の全体像がわかります。",
    art: "Claude、Codex、Cursor が各自の作業を進めながら、人間が決定事項を記録しているプロジェクトページ",
    stores: "モバイルアプリを入手",
  },
  conversations: {
    title: "作業は会話で、\u200b結果はドキュメントへ。",
    body: "エージェントを @ メンションすれば、あなたのマシン上で即座に着手。数十のスレッドを並列で進め、過程は会話に残し、結果だけをドキュメントへ反映します。",
  },
  agents: {
    title: "どのマシンでも、どのエージェントでも、ひとつに統合管理",
    body: (count: number) => `${count} 種類のコーディングエージェントが、あなたの Mac・Linux・Windows マシン上で動作。契約済みのサブスクリプションや API キーをそのまま使え、コードと認証情報はローカルに残ります。ひとつのクォータが尽きても、別のエージェントが即座に引き継ぎます。`,
    matrixArt: "Space 内の各マシンにあるエージェントと、それぞれの作業状況",
    listLabel: "どのマシンでも、どのエージェントでも、ひとつに統合管理",
  },
  why: {
    title: "なぜ xMatrix か", others: "タブとターミナルを行き来する運用",
    rows: [
      ["プロジェクトの現状", "プロジェクトごとに1つのライブドキュメント。進行に合わせて自動更新。", "ターミナル・チャット・PR に情報が散乱し、手動で拾い集める羽目に。"],
      ["あなたの集中力", "見たいときにドキュメントを開くだけ。ウィンドウの通知に割り込まれない。", "エージェントごとに別ウィンドウから次々と入力を求められる。"],
      ["並列進行", "数十のスレッドが同時に進み、成果を1つのドキュメントへ集約。", "1タブ1エージェントで張り付き、文脈はすべて手動コピペ。"],
      ["複数マシン連携", "手元の全マシン上のエージェントが同じ Space に参加。", "各エージェントが1台のマシンに閉じ込められ、互いが見えない。"],
      ["チームの意思決定", "ドキュメントに一度書けば、メンバーも全エージェントも即座に共有。", "エージェントごとに何度も説明し直し、新しいセッションで忘れられる。"],
      ["いつでも介入", "どの行も直接編集でき、同じ段落のエージェントは自動で待機。", "エージェントを強制停止し、説明し直して最初からやり直し。"],
    ],
    scenes: {
      terminal: "ターミナル", thread: "スレッド", terminalLine: "claude › 認証を修正中…", threadLine: "codex: どのブランチ？", prLine: "修正依頼あり",
      page: "リリース", web: "Web エディタ", mobile: "モバイルアプリ", docs: "紹介動画", progress: ["ログイン修正 チェック 3/5", "2.4 ビルド 60%", "4 シーン中 2 完了"], done: ["マージ済 `v1.0.464` 公開", "2.4 を TestFlight 配信", "公開ページに掲載済"],
      pings: ["Claude が入力待ち", "Codex: どのブランチ？", "Cursor が待機中"], quiet: "通知なし",
      copied: "Claude から API をコピー", paste: "Codex に貼り付け", waiting: "Cursor が両方を待機",
      machines: ["Mac Studio", "Linux サーバー", "Windows"], thisMachineOnly: "このマシン限定",
      decided: "決定", decision: "金曜日にフラグ付きで出荷。", read: "参照済", forgot: "新規セッション：何を決めた？",
      stop: "停止", again: "もう一度説明します…", draft: ["エディタは", "すべての変更を", "ページに保存します。"], edited: "入力のたびに", agentWaits: "待機中",
    },
  },
  connectors: {
    title: "いつものサービスをつなぎ、\u200b最終判断はあなたが。",
    body: "GitHub、Linear、Sentry、Cloudflare などの常用サービスを接続。エージェントが文脈を読み取りイベントに反応する一方、外部書き込みや重要な操作は必ずあなたの承認を待ち、元の認証情報には一切触れません。",
    label: "コネクタ",
  },
  pricing: {
    title: "課金は人のみ。エージェントは席を使いません。",
    body: "どのプランでもエージェント数は無制限。Pro は1シートあたり毎月 5,000 エージェントクレジット付きで、モデルはお手持ちのサブスクリプションや API キーをそのまま使えます。",
    free: { description: "まずは無料で、マルチエージェントのワークフローを実案件で試せます。",
      features: ["エージェント数無制限", "1 Space あたり累計 500 回のメッセージ・ページ書き込み", "最大3名まで", "1アカウントにつき無料 Space 最大2つ", "複数マシン間の共有チャンネルとライブドキュメント"],
      button: "無料で始める" },
    pro: { description: "ヘビーに使う個人開発者と、スピード重視の小規模チーム向けに。",
      features: ["エージェントのシート課金は一切なし", "1シートあたり毎月 5,000 エージェントクレジット", "エージェント間の文脈引き継ぎと完全な実行トレース", "操作承認フローと外部コネクタ"],
      period: "/人/月", annual: "年払い $96/シート（月あたり $8、20% 割引）",
      monthly: "月払いで始める", yearly: "年払い（20% オフ）" },
    terms: "Free プランは1 Space あたり累計 500 回の書き込み（人間・エージェント・アプリのチャンネル投稿およびページ編集の合算）まで、個人 Space 以外に最大2 Space 作成できます。Pro プランでは人間の書き込みは無料、エージェント／アプリの投稿・ページ更新ごとに1クレジット消費し、上限到達後も半分の猶予枠があります。利用規約は英語版が優先されます。",
    xCreditsLink: { href: "/ja/docs/connectors#x-credits", label: "有料 X アクションのクレジット消費表" },
  },
  faq: {
    title: "よくある質問",
    questions: [
      ["エージェントに追加料金はかかりますか？", "かかりません。Free でも Pro でも接続するエージェント数は無制限で、Pro は人間メンバーのシート数のみ課金されます。モデル呼び出しは既存のサブスクリプションや API キーを直接使うため、上乗せ料金もありません。"],
      ["エージェントはどこで動きますか？コードはアップロードされますか？", "すべてのエージェントはご自身の PC やサーバー上で、許可したローカルフォルダやリポジトリの中で動きます。xMatrix はマシン間の協調と状態同期だけを担い、コードとモデルの認証情報はローカルに残り xMatrix へ送信されません。クォータ表示を有効にしている場合のみ、ローカルデーモンが端末内から各プロバイダへ残量を直接照会し、いつでも無効化できます。"],
      ["どのコーディングエージェントに対応していますか？", "Claude Code、Codex、Cursor、Gemini、Grok、Kimi、Copilot、OpenCode など 35 種類の主要コーディングエージェントに同一 CLI で対応しています。xmatrix agent add を実行するだけで Space に接続できます。"],
      ["人間とエージェントが同じ段落を同時編集すると競合しますか？", "しません。常に人間が優先されます。あなたが編集中の段落にエージェントが差し掛かると自動で待機し、書き終えた最新の内容を引き継いで続けるため、あなたの文章を上書きすることはありません。"],
      ["すべての会話ウィンドウを監視し続ける必要がありますか？", "不要です。実作業はバックグラウンドのスレッドで並列に進み、重要な結論と現状がライブドキュメントにまとまります。普段はドキュメントで全体を見て、詳細を確認・介入したいときだけ会話を開けば十分です。"],
      ["コーディング以外にも使えますか？", "もちろんです。リリースチェックリスト、競合調査、成長指標、採用、日々の運用ドキュメントまでライブドキュメントにまとめ、エージェントに最新状態を維持させられます。"],
    ],
  },
  footer: {
    tagline: "ライブドキュメントで協働するマルチエージェント・ワークスペース。進捗、決定事項、次のアクションが作業に合わせて自動更新されます。",
    product: "製品", getApp: "アプリを入手", legal: "法務", compare: "他ツール比較", agents: "Agents", language: "言語",
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
    description: "팀원과 Claude Code, Codex, Cursor 등 코딩 에이전트가 실시간 문서에서 함께 일하세요. 병렬 스레드에서 실행하고 진행 상황과 결정 사항은 문서에 자동 반영됩니다.",
    shareDescription: "Attention is all you need. 실시간 문서에서 팀과 AI 코딩 에이전트가 협업하며 진행 상황과 결정 사항을 항상 최신으로 유지합니다.",
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
    body: "사람과 AI가 하나처럼 실시간으로 협업합니다. 모든 변경 사항은 즉시 보이고, 모든 결정은 모두가 공유합니다. 데스크톱이나 모바일에서 열면 바로 최신 전체 현황입니다.",
    art: "Claude, Codex, Cursor가 각자의 작업을 진행하는 동안 사람이 결정사항을 기록하는 프로젝트 페이지",
    stores: "모바일 앱 받기",
  },
  conversations: {
    title: "과정은 대화에, 결과는 문서에.",
    body: "대화에서 에이전트를 @멘션하면 내 머신에서 바로 작업을 시작합니다. 수십 개의 스레드를 병렬로 돌리고, 과정은 대화에 남기며 결과만 문서에 반영하세요.",
  },
  agents: {
    title: "어떤 머신이든, 어떤 에이전트든, 한곳에서 통합 관리",
    body: (count: number) => `내 Mac, Linux, Windows 머신에서 ${count}종의 코딩 에이전트를 기존 구독과 API 키 그대로 실행하세요. 코드와 자격 증명은 로컬에 남고, 하나의 할당량이 소진되면 다른 에이전트가 즉시 이어받습니다.`,
    matrixArt: "Space의 각 머신에 있는 에이전트와 각자 하고 있는 일",
    listLabel: "어떤 머신이든, 어떤 에이전트든, 한곳에서 통합 관리",
  },
  why: {
    title: "왜 xMatrix인가", others: "수많은 탭과 터미널 오가기",
    rows: [
      ["프로젝트 현황", "프로젝트당 하나의 실시간 문서가 작업에 맞춰 자동 최신화.", "터미널, 채팅 스레드, PR 곳곳에 흩어져 수동으로 취합."],
      ["당신의 집중력", "원할 때 문서만 열어보면 끝. 창마다 쏟아지는 방해 없음.", "에이전트마다 창을 띄워 번갈아 응답을 재촉."],
      ["병렬 작업", "수십 개의 스레드가 동시에 실행되고 결과를 한 문서에 반영.", "탭 하나에 에이전트 하나, 맥락은 전부 복사·붙여넣기."],
      ["멀티 머신 협업", "보유한 모든 머신의 에이전트가 하나의 Space에서 협업.", "각 에이전트가 단일 머신에 갇혀 서로를 보지 못함."],
      ["팀 의사결정", "문서에 한 번 기록하면 모든 팀원과 에이전트가 즉시 공유.", "에이전트마다 반복 설명하고 새 세션이면 전부 잊음."],
      ["언제든 개입", "문서의 어느 줄이든 바로 수정 가능. 같은 문단의 에이전트는 자동 대기.", "에이전트를 강제로 멈추고 다시 설명한 뒤 처음부터 재시작."],
    ],
    scenes: {
      terminal: "터미널", thread: "스레드", terminalLine: "claude › 인증 수정 중…", threadLine: "codex: 어떤 브랜치?", prLine: "수정 요청됨",
      page: "출시", web: "웹 에디터", mobile: "모바일 앱", docs: "출시 영상", progress: ["로그인 수정, 체크 3/5", "2.4 빌드 60%", "4장면 중 2장면 완료"], done: ["병합 완료, `v1.0.464` 배포", "2.4 TestFlight 업로드", "출시 페이지 반영"],
      pings: ["Claude가 응답 대기 중", "Codex: 어떤 브랜치?", "Cursor가 대기 중"], quiet: "방해 없음",
      copied: "Claude에서 API 복사", paste: "Codex에 붙여넣기", waiting: "Cursor가 둘 다 대기",
      machines: ["Mac Studio", "Linux 서버", "Windows"], thisMachineOnly: "이 머신만 가능",
      decided: "결정됨", decision: "금요일 출시, 피처 플래그 적용.", read: "읽음", forgot: "새 세션: 뭘 결정했죠?",
      stop: "중지", again: "다시 설명할게요…", draft: ["에디터가 ", "모든 변경사항을", " 페이지에 저장합니다."], edited: "매 입력마다", agentWaits: "대기 중",
    },
  },
  connectors: {
    title: "자주 쓰는 서비스를 연결하고, 최종 결정은 직접.",
    body: "GitHub, Linear, Sentry, Cloudflare 등 자주 쓰는 서비스를 연결하세요. 에이전트가 맥락을 읽고 실시간 이벤트에 반응하되, 민감한 외부 작업은 승인 후 실행하며 원본 자격 증명에는 절대 접근하지 못합니다.",
    label: "커넥터",
  },
  pricing: {
    title: "사람만 결제. 에이전트는 시트를 차지하지 않습니다.",
    body: "모든 플랜에서 에이전트 수는 무제한이며 시트를 차지하지 않습니다. Pro 시트당 매월 5,000 에이전트 크레딧이 포함되며 기존 모델 구독이나 API 키를 그대로 사용합니다.",
    free: { description: "무료로 시작해 실제 프로젝트에서 멀티 에이전트 워크플로를 검증하세요.",
      features: ["무제한 에이전트", "Space당 500회 메시지 및 페이지 쓰기", "최대 3명", "계정당 무료 Space 최대 2개", "멀티 머신 공유 채널 및 실시간 문서"],
      button: "무료로 시작" },
    pro: { description: "헤비 솔로 빌더와 빠르게 움직이는 소규모 팀을 위해 설계했습니다.",
      features: ["에이전트는 영구히 시트 미차지", "시트당 매월 5,000 에이전트 크레딧", "에이전트 간 컨텍스트 핸드오프 및 전체 트레이스", "작업 승인 플로 및 외부 커넥터"],
      period: "/인/월", annual: "연간 $96/시트 (월 $8, 20% 절약)",
      monthly: "월간 구독", yearly: "연간 구독 (20% 절약)" },
    terms: "무료 플랜은 Space당 누적 500회 쓰기(채널 메시지 및 페이지 편집 합산)를 포함하며 개인 Space 외 최대 2개의 무료 Space를 만들 수 있습니다. Pro에서는 사람의 쓰기가 무료이며 에이전트·앱 메시지 및 페이지 수정당 1크레딧이 차감됩니다(한도 초과 시 50% 유예 제공). 약관은 영문본이 우선합니다.",
    xCreditsLink: { href: "/ko/docs/connectors#x-credits", label: "유료 X 작업 크레딧 요율" },
  },
  faq: {
    title: "자주 묻는 질문",
    questions: [
      ["에이전트에 추가 비용이 드나요?", "아니요. 무료와 Pro 모두 연결하는 에이전트 수에 제한이 없으며 Pro는 사람 시트당 과금됩니다. 모델 호출은 기존 구독이나 API 키를 그대로 사용하며 추가 마진이 없습니다."],
      ["에이전트는 어디서 실행되나요? 코드가 업로드되나요?", "모든 에이전트는 사용자 본인의 컴퓨터나 서버에서, 권한을 부여한 로컬 폴더와 저장소 안에서 실행됩니다. xMatrix는 머신 간 협업과 상태 동기화만 담당하며 코드와 모델 자격 증명은 로컬에 남아 xMatrix로 전송되지 않습니다. 할당량 표시를 켠 경우에만 로컬 데몬이 기기 내에서 공급자에 잔여 할당량을 직접 조회하며 언제든 끌 수 있습니다."],
      ["어떤 코딩 에이전트를 지원하나요?", "Claude Code, Codex, Cursor, Gemini, Grok, Kimi, Copilot, OpenCode 등 35종의 주요 코딩 에이전트를 하나의 CLI로 지원합니다. xmatrix agent add를 실행해 내 머신의 도구를 Space에 연결하세요."],
      ["사람과 에이전트가 같은 문단을 동시에 편집하면 충돌하나요?", "아니요, 항상 사람이 우선합니다. 편집 중인 문단에 에이전트가 도달하면 자동으로 멈춰 기다렸다가 작성 완료된 최신 내용에 이어서 진행하므로 절대 덮어쓰지 않습니다."],
      ["모든 대화 창을 계속 지켜봐야 하나요?", "그럴 필요 없습니다. 실제 실행은 백그라운드 스레드에서 병렬로 진행되고 핵심 결론과 현황이 실시간 문서에 모입니다. 평소엔 문서로 전체를 보고, 세부 확인이나 개입이 필요할 때만 대화를 열면 됩니다."],
      ["코딩에만 쓸 수 있나요?", "아닙니다. 출시 체크리스트, 경쟁사 리서치, 성장 지표, 채용, 운영 문서도 실시간 문서로 두고 에이전트가 항상 최신 상태를 유지하게 할 수 있습니다."],
    ],
  },
  footer: {
    tagline: "실시간 문서 중심으로 협업하는 멀티 에이전트 워크스페이스. 진행 상황, 결정 사항, 다음 단계가 작업에 맞춰 자동 업데이트됩니다.",
    product: "제품", getApp: "앱 받기", legal: "법적 고지", compare: "대안 비교", agents: "Agents", language: "언어",
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
    description: "Colabora con tu equipo y agentes como Claude Code, Codex y Cursor en documentos vivos. Ejecuta hilos en paralelo mientras las páginas siguen al día.",
    shareDescription: "Attention is all you need. Colabora con tu equipo y agentes de código de IA en documentos vivos siempre actualizados.",
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
    body: "Personas e IA trabajando como uno, en tiempo real. Cada cambio se ve al instante y cada decisión se comparte con todos. Ábrelo en escritorio o móvil para ver el panorama completo.",
    art: "Una página de proyecto donde Claude, Codex y Cursor avanzan su trabajo mientras una persona registra una decisión",
    stores: "Descarga la app móvil",
  },
  conversations: {
    title: "El trabajo ocurre en el hilo. La verdad vive en la página.",
    body: "Menciona a un agente y empezará a trabajar en tu máquina. Ejecuta decenas de hilos en paralelo: el proceso se queda en el hilo y los resultados llegan a la página.",
  },
  agents: {
    title: "Cualquier máquina. Cualquier agente. Todo en un solo lugar.",
    body: (count: number) => `${count} agentes de código funcionando en tus propias máquinas Mac, Linux y Windows, usando las suscripciones y claves API que ya pagas. Tu código y credenciales se quedan en local, y cuando un agente agota su cuota, otro continúa el trabajo.`,
    matrixArt: "Los agentes de cada máquina de un Space y lo que hace cada uno",
    listLabel: "Cualquier máquina. Cualquier agente. Todo en un solo lugar.",
  },
  why: {
    title: "Por qué xMatrix", others: "Malabares entre pestañas y terminales",
    rows: [
      ["Dónde está todo", "Un documento vivo por proyecto, siempre actualizado.", "Disperso entre terminales, hilos de chat y PRs."],
      ["Tu atención", "Revisa la página a tu ritmo, sin interrupciones constantes.", "Cada agente te pide atención, una ventana tras otra."],
      ["Trabajo en paralelo", "Decenas de hilos corriendo en paralelo y reportando a una página.", "Un agente por pestaña y tú copiando y pegando entre ellos."],
      ["Entre máquinas", "Los agentes de todas tus máquinas trabajan en un mismo Space.", "Cada agente queda atrapado en la única máquina donde corre."],
      ["Decisiones compartidas", "Escribe una decisión una vez; cada persona y agente la lee.", "Vuelve a explicarlo a cada agente y repítelo en la siguiente sesión."],
      ["Tú al mando", "Edita cualquier línea directamente; el agente en ese párrafo te espera.", "Interrumpe al agente, vuelve a explicar y empieza de cero."],
    ],
    scenes: {
      terminal: "Terminal", thread: "Hilo", terminalLine: "claude › corrigiendo auth…", threadLine: "codex: ¿qué rama?", prLine: "Cambios pedidos",
      page: "Lanzamiento", web: "Editor web", mobile: "App móvil", docs: "Video de lanzamiento", progress: ["fix login, checks 3/5", "build 2.4 al 60%", "2 de 4 escenas listas"], done: ["fusionado en `v1.0.464`", "build 2.4 en `TestFlight`", "en la página de lanzamiento"],
      pings: ["Claude necesita tu respuesta", "Codex: ¿qué rama?", "Cursor está esperando"], quiet: "Sin interrupciones",
      copied: "API copiada de Claude", paste: "Pegar en Codex", waiting: "Cursor espera a ambos",
      machines: ["Mac Studio", "Servidor Linux", "Windows"], thisMachineOnly: "solo esta máquina",
      decided: "Decidido", decision: "Publicar el viernes con feature flag.", read: "leído", forgot: "Nueva sesión: ¿qué decidimos?",
      stop: "Detener", again: "Te explico de nuevo…", draft: ["El editor guarda ", "cada cambio", " en la página."], edited: "cada pulsación", agentWaits: "te espera",
    },
  },
  connectors: {
    title: "Conecta tu stack. Conserva la última palabra.",
    body: "Conecta GitHub, Linear, Sentry, Cloudflare y más. Los agentes leen contexto y reaccionan a eventos en vivo, mientras las acciones externas sensibles esperan tu aprobación y nunca ven tus credenciales reales.",
    label: "Conectores",
  },
  pricing: {
    title: "Las personas pagan. Los agentes no.",
    body: "Trae agentes ilimitados en todos los planes: nunca ocupan asiento. Cada asiento Pro incluye 5,000 créditos de agente al mes usando tus suscripciones o claves API existentes.",
    free: { description: "Empieza gratis y valida el flujo en un proyecto real.",
      features: ["Agentes ilimitados", "500 escrituras de mensajes y páginas por Space", "Hasta 3 miembros", "Hasta 2 Spaces gratis por cuenta", "Canales compartidos y documentos vivos entre máquinas"],
      button: "Empezar gratis" },
    pro: { description: "Diseñado para builders individuales intensivos y equipos ágiles.",
      features: ["Los agentes nunca ocupan asiento", "5,000 créditos de agente por asiento al mes", "Relevo de contexto entre agentes y trazas completas", "Flujo de aprobaciones y conectores externos"],
      period: "/asiento/mes", annual: "$96 por asiento/año ($8/mes, ahorra 20%)",
      monthly: "Suscripción mensual", yearly: "Suscripción anual (ahorra 20%)" },
    terms: "Gratis incluye 500 escrituras de por vida por Space (mensajes en canales y ediciones de páginas de cualquier participante) y hasta 2 Spaces gratuitos además del Space personal. En Pro las personas escriben gratis; cada mensaje de agente o app y cada revisión de página usa 1 crédito, con un margen de gracia del 50%. Los términos en inglés prevalecen.",
    xCreditsLink: { href: "/es/docs/connectors#x-credits", label: "Tarifas de créditos para acciones pagas en X" },
  },
  faq: {
    title: "Preguntas frecuentes",
    questions: [
      ["¿Los agentes cuestan extra?", "No. Todos los planes admiten agentes ilimitados y Pro cobra solo por asiento humano. Tus agentes siguen usando las suscripciones o claves API que ya tienes, sin recargos."],
      ["¿Dónde corren mis agentes?", "En tus propias máquinas, directamente dentro de las carpetas y repositorios que registres. xMatrix coordina tu Space entre máquinas mientras tu código y credenciales permanecen en local y nunca se suben a xMatrix. Si activas el indicador de cuota, el daemon local solo las usa en tu equipo para consultar el saldo con tu proveedor, y puedes desactivarlo en cualquier momento."],
      ["¿Qué agentes funcionan con xMatrix?", "Claude Code, Codex, Cursor, Gemini, Grok, Kimi, Copilot, OpenCode y decenas más, todos desde la misma CLI. Ejecuta xmatrix agent add para conectar los que ya tienes en tu máquina."],
      ["¿Qué pasa si una persona y un agente editan el mismo párrafo?", "Siempre gana la persona. Si un agente llega a un párrafo que estás editando, se detiene, espera a que termines y continúa desde tu último texto sin sobrescribir tus palabras."],
      ["¿Tengo que vigilar cada conversación?", "No. La ejecución ocurre en hilos paralelos mientras los resultados se resumen en el documento vivo. Lee la página para ver el estado general y abre un hilo solo cuando quieras los detalles."],
      ["¿Es solo para código?", "Para nada. Los equipos también usan agentes para mantener al día checklists de lanzamiento, investigación, métricas, contratación y operaciones."],
    ],
  },
  footer: {
    tagline: "El espacio de trabajo multiagente construido en torno a documentos vivos. Decisiones, avances y próximos pasos siempre actualizados.",
    product: "Producto", getApp: "Obtén la app", legal: "Legal", compare: "Comparativas", agents: "Agents", language: "Idiomas",
    links: { app: "App web", download: "Descargar", pricing: "Precios", docs: "Documentación", support: "Soporte", console: "Consola", signIn: "Iniciar sesión" },
    legalLinks: { privacy: "Privacidad (EN)", terms: "Términos (EN)", cookies: "Cookies (EN)", subprocessors: "Subprocesadores (EN)" },
    askAi: "Mira qué dicen ChatGPT, Claude, Perplexity, Gemini o Grok sobre xMatrix.",
    rights: "xMatrix y sus marcas asociadas están reservadas.",
  },
};

export const landingCopy: Record<Locale, LandingCopy> = { en, zh, "zh-tw": zhTw, ja, ko, es };
