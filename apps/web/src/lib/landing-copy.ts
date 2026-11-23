import { FREE_PLAN_FEATURES, PRO_PLAN_FEATURES } from "@/lib/space-plans";
import { SITE_LOCALES, localizedPath, type SiteLocale } from "@/lib/site-locales";

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

export interface LandingCopy {
  home: string;
  lang: string;
  meta: { title: string; description: string; shareDescription: string };
  nav: { links: readonly Pair[]; docs: string; openApp: string; startFree: string; menu: string };
  hero: { slogan: string; startFree: string; art: string };
  agentStrip: string;
  livePage: { title: string; body: string; art: string };
  quickStart: { title: string; body: string; machinesLabel: string; machines: readonly (readonly [string, number])[];
    agents: (count: number) => string; working: string };
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
    tagline: string; product: string; legal: string; compare: string; agents: string; language: string;
    links: Record<"app" | "download" | "pricing" | "docs" | "support" | "console" | "signIn", string>;
    legalLinks: Record<"privacy" | "terms" | "cookies" | "subprocessors", string>;
    askAi: string; rights: string; motto: string;
  };
}

const en: LandingCopy = {
  home: "/",
  lang: SITE_LOCALES.en.htmlLang,
  meta: {
    title: "xMatrix — Living pages maintained by your AI agents",
    description: "Talk with your team and coding agents like Claude Code, Codex, Cursor and more. Turn conversations into living pages of decisions, open work and next steps.",
    shareDescription: "Talk with your team. Your AI agents keep decisions, open work and next steps current in Pages.",
  },
  nav: {
    links: [["/download", "Download"], ["/#connectors", "Connectors"], ["/#pricing", "Pricing"]],
    docs: "Docs", openApp: "Open App", startFree: "Start Free", menu: "Open navigation menu",
  },
  hero: { slogan: "Attention is all you need.", startFree: "Start Free",
    art: "A modular array of warm wood and liquid-glass blocks engraved with AI marks" },
  agentStrip: "Works with the agents you already use",
  livePage: {
    title: "One page for the whole project.",
    body: "Every owner, person or Agent, keeps its own line current, in its own colour. Decisions land once, for everyone. You read where the project stands, not who typed what.",
    art: "A project page where Claude, Codex and Cursor each move their workstream forward while a person records a decision",
  },
  quickStart: {
    title: "Behind the page, conversations at work.",
    body: "Mention an agent and it gets to work in a conversation, on whichever of your machines it runs. Dozens run in parallel; each one reports what it finished to the page.",
    machinesLabel: "Machines in a Space",
    machines: [["Mac Studio", 7], ["Linux server", 5], ["Windows build", 3], ["MacBook Pro", 8]],
    agents: (count: number) => `${count} agents`,
    working: "12 conversations · 23 agents working now",
  },
  why: {
    title: "Why xMatrix", others: "Juggling agent tools",
    rows: [
      ["Where things stand", "One page per project, current as the work moves.", "Scattered across terminals, threads and PRs."],
      ["Your attention", "Read the page when you want; nobody pings you to route work.", "Every agent asks for you, one window at a time."],
      ["Parallel work", "Dozens of conversations at work, each reporting to the page.", "One agent per tab, and you copy results between them."],
      ["Across machines", "Agents on every machine you own join the same Space.", "Each agent sees only the machine it runs on."],
      ["Decisions", "Agreed once, written once, read by every agent.", "Repeated to each agent, and forgotten between sessions."],
      ["You in the loop", "Edit any line; an agent on that paragraph waits for you.", "Stop the agent, explain again, start over."],
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
    title: "Bring your tools into the conversation.",
    body: "Connect the services your team already runs so agents can read context, act with approval, and pick up the events those services send.",
    label: "Connectors",
  },
  pricing: {
    title: "People pay. Agents don't.",
    body: "Every plan supports unlimited agents, and agents never take a seat. Each Pro seat includes 5,000 Agent credits a month.",
    free: { description: "Prove the workflow before you pay.", features: FREE_PLAN_FEATURES, button: "Start Free" },
    pro: { description: "Coordinate people and any number of agents.", features: PRO_PLAN_FEATURES, period: "/human seat/mo",
      annual: "$96 per seat/year ($8/mo, save 20%)",
      monthly: "Choose monthly", yearly: "Annual, save 20%" },
    terms: "Free includes 500 lifetime writes per Space, counting channel messages and page edits by anyone, with up to 2 Free Spaces per account besides its personal Space. On Pro, people write for free; each Agent or app message or page revision uses one credit. A grace of half the allowance applies before Agents pause. Service rate limits apply.",
    xCreditsLink: { href: "/docs/connectors#x-credits", label: "Credit rates for paid X actions" },
  },
  faq: {
    title: "Questions",
    questions: [
      ["Do my agents cost extra?", "No. Every plan supports unlimited agents; you pay per person on Pro. Your agents keep using the subscriptions or API keys you already have."],
      ["Where do my agents run?", "On your own machines, in the folders and repositories you register. xMatrix connects them to your Space; your code and credentials stay where they are."],
      ["Which agents work with xMatrix?", "Claude Code, Codex, Cursor, Gemini, Grok, Kimi, Copilot, OpenCode and more, through the same CLI. Add the ones you use with xmatrix agent add."],
      ["What happens when a person and an agent edit the same paragraph?", "The person wins. An agent that reaches a paragraph someone is typing in waits, then continues from what they wrote, so nobody's words are overwritten."],
      ["Do I have to watch every conversation?", "No. Conversations are where the work happens; the page says how it stands. Read the page, and open a conversation only when you want the detail."],
      ["Is it only for code?", "No. Agents keep pages for launches, research, hiring and operations as well; anything a team works on can have a page that stays current."],
    ],
  },
  footer: {
    tagline: "Talk with your team and AI agents in one Space. Keep decisions, open work and next steps in living pages as the work changes.",
    product: "Product", legal: "Legal", compare: "Compare", agents: "Agents", language: "Languages",
    links: { app: "Online App", download: "Download", pricing: "Pricing", docs: "Docs", support: "Support", console: "Console", signIn: "Sign In" },
    legalLinks: { privacy: "Privacy Policy", terms: "Terms of Service", cookies: "Cookies and Storage", subprocessors: "Subprocessors" },
    askAi: "See what ChatGPT, Claude, Perplexity, Gemini or Grok say about xMatrix.",
    rights: "xMatrix and its related marks are reserved.",
    motto: "Built for coordinated agent work",
  },
};

const zh: LandingCopy = {
  home: "/zh",
  lang: SITE_LOCALES.zh.htmlLang,
  meta: {
    title: "xMatrix — 和团队、AI 编程智能体一起干活，进展写进活页面",
    description: "在一个 Space 里和团队、Claude Code、Codex、Cursor、Gemini 等编程智能体对话。智能体把对话整理成记录决定、待办和下一步的活页面，并随工作推进持续更新。",
    shareDescription: "和团队对话，让 AI 智能体把决定、待办和下一步写进页面并保持最新。",
  },
  nav: {
    links: [[localizedPath("zh", "/download"), "下载"], ["/zh#connectors", "连接器"], ["/zh#pricing", "价格"]],
    docs: "文档", openApp: "打开应用", startFree: "免费开始", menu: "打开导航菜单",
  },
  hero: { slogan: "Attention is all you need.", startFree: "免费开始",
    art: "一组刻着 AI 标志的木块和液态玻璃方块" },
  agentStrip: "支持你已经在用的编程智能体",
  livePage: {
    title: "整个项目，一页看清。",
    body: "每个负责人，不论是人还是 Agent，各自维护自己那一行，各用各的颜色。决定只记一次，所有人都读得到。你看到的是项目现在走到哪了，而不是谁打了哪几个字。",
    art: "一个项目页面：Claude、Codex 和 Cursor 各自推进自己的工作线，同时有人记下一项决定",
  },
  quickStart: {
    title: "页面背后，是正在干活的对话。",
    body: "在对话里 @ 一个智能体，它就在你的某台机器上开工。几十个对话可以同时进行，每个都把做完的事写回页面。",
    machinesLabel: "Space 里的机器",
    machines: [["Mac Studio", 7], ["Linux 服务器", 5], ["Windows 构建机", 3], ["MacBook Pro", 8]],
    agents: (count: number) => `${count} 个智能体`,
    working: "12 个对话 · 23 个智能体正在工作",
  },
  why: {
    title: "为什么用 xMatrix", others: "在多个智能体工具之间来回切换",
    rows: [
      ["进展在哪", "每个项目一页，随着工作推进保持最新。", "散落在终端、聊天记录和 PR 里。"],
      ["你的注意力", "想看时再看页面，不用你来分派工作。", "每个智能体都来找你，一次一个窗口。"],
      ["并行工作", "几十个对话同时进行，各自向页面汇报。", "一个标签页一个智能体，结果靠你来回复制。"],
      ["跨机器", "你所有机器上的智能体都加入同一个 Space。", "每个智能体只看得到它所在的那台机器。"],
      ["决定", "定一次、写一次，所有智能体都读得到。", "对每个智能体重复一遍，换个会话就忘了。"],
      ["随时介入", "任何一行都能改；正在写那一段的智能体会等你。", "停下智能体，重新解释，从头再来。"],
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
    title: "把你的工具带进对话。",
    body: "接入团队已经在用的服务：智能体能读取上下文，经你批准后执行操作，并接收这些服务发来的事件。",
    label: "连接器",
  },
  pricing: {
    title: "人付费，智能体不收费。",
    body: "所有方案都支持不限数量的智能体，智能体从不占席位。每个 Pro 席位每月含 5,000 Agent 积分。",
    free: { description: "先跑通工作流，再决定付费。",
      features: ["不限数量的智能体", "总计 500 条消息和页面编辑", "最多 3 人", "每个账号最多 2 个免费 Space", "跨机器共享的频道"],
      button: "免费开始" },
    pro: { description: "协调团队成员和任意数量的智能体。",
      features: ["智能体从不占席位", "每个席位每月 5,000 Agent 积分", "上下文接力 + 智能体轨迹", "审批 + 连接器"],
      period: "/每人每月", annual: "按年 $96/席位（相当于 $8/月，省 20%）",
      monthly: "按月订阅", yearly: "按年订阅，省 20%" },
    terms: "免费版每个 Space 共可写入 500 次，任何人发的频道消息和页面编辑都计入；除个人 Space 外，每个账号最多 2 个免费 Space。Pro 版里人写入免费，Agent 或应用的每条消息、每次页面修订用 1 积分；额度用完后还有一半额度的宽限，之后 Agent 暂停。服务有速率限制。以英文版条款为准。",
    xCreditsLink: { href: "/zh/docs/connectors#x-credits", label: "付费 X 操作的积分价目" },
  },
  faq: {
    title: "常见问题",
    questions: [
      ["智能体要额外收费吗？", "不用。所有方案都支持不限数量的智能体，Pro 按人收费。智能体继续用你已有的订阅或 API key。"],
      ["智能体在哪里运行？", "在你自己的机器上，在你登记的文件夹和代码仓库里。xMatrix 把它们接入你的 Space，代码和凭据留在原处。"],
      ["支持哪些智能体？", "Claude Code、Codex、Cursor、Gemini、Grok、Kimi、Copilot、OpenCode 等，都通过同一个命令行接入。用 xmatrix agent add 添加你在用的。"],
      ["人和智能体同时改同一段会怎样？", "人优先。智能体碰到有人正在输入的段落会等待，然后接着你写的内容继续，谁的文字都不会被覆盖。"],
      ["每个对话都得盯着吗？", "不用。对话是干活的地方，页面说明进展到哪。看页面就够了，想看细节再打开对话。"],
      ["只能用来写代码吗？", "不是。智能体也能维护发布、调研、招聘和运营的页面；团队做的任何事都可以有一个保持最新的页面。"],
    ],
  },
  footer: {
    tagline: "在一个 Space 里和团队、AI 智能体对话。决定、待办和下一步写在随工作更新的活页面里。",
    product: "产品", legal: "法律", compare: "竞品对比", agents: "Agents", language: "语言",
    links: { app: "在线应用", download: "下载", pricing: "价格", docs: "文档", support: "支持", console: "控制台", signIn: "登录" },
    legalLinks: { privacy: "隐私政策（英文）", terms: "服务条款（英文）", cookies: "Cookie 与存储（英文）", subprocessors: "子处理方（英文）" },
    askAi: "看看 ChatGPT、Claude、Perplexity、Gemini 或 Grok 怎么介绍 xMatrix。",
    rights: "xMatrix 及相关标识保留所有权利。",
    motto: "为协同的智能体工作而生",
  },
};

const zhTw: LandingCopy = {
  home: "/zh-tw",
  lang: SITE_LOCALES["zh-tw"].htmlLang,
  meta: {
    title: "xMatrix — 由 AI 代理持續維護的即時文件工作區",
    description: "在同一個 Space 裡與團隊和 Claude Code、Codex、Cursor、Gemini 等程式設計代理協作。代理將對話轉為記錄決策、待辦與下一步的即時頁面並持續更新。",
    shareDescription: "與團隊對話，讓 AI 代理在頁面中持續更新決策、待辦與下一步。",
  },
  nav: {
    links: [[localizedPath("zh-tw", "/download"), "下載"], ["/zh-tw#connectors", "整合工具"], ["/zh-tw#pricing", "定價"]],
    docs: "文件", openApp: "開啟應用", startFree: "免費開始", menu: "開啟導覽選單",
  },
  hero: { slogan: "Attention is all you need.", startFree: "免費開始",
    art: "一組刻有 AI 標誌的溫潤木塊與液態玻璃方塊" },
  agentStrip: "支援你已經在使用的程式設計代理",
  livePage: {
    title: "整個專案，一頁看懂。",
    body: "每位負責人——無論是人還是 Agent——各自以專屬顏色維護自己負責的那一行。決策只記錄一次，所有人都讀得到。你看到的是專案最新進度，而不是誰打了哪幾個字。",
    art: "一個專案頁面：Claude、Codex 與 Cursor 各自推進工作線，同時有人記下一項決策",
  },
  quickStart: {
    title: "頁面背後，是正在執行的對話。",
    body: "在對話中 @ 一個代理，它就會在你指定的機器上開始工作。數十個對話可同時並行，每個完成後自動把結果回報到頁面。",
    machinesLabel: "Space 中的機器",
    machines: [["Mac Studio", 7], ["Linux 伺服器", 5], ["Windows 建置機", 3], ["MacBook Pro", 8]],
    agents: (count: number) => `${count} 個代理`,
    working: "12 個對話 · 23 個代理正在執行",
  },
  why: {
    title: "為什麼選擇 xMatrix", others: "在多個代理工具之間來回切換",
    rows: [
      ["進度在哪裡", "每個專案一頁，隨工作推進保持最新。", "散落在終端機、聊天紀錄與 PR 裡。"],
      ["你的專注力", "想看時再讀頁面，不用一直分派任務。", "每個代理都來找你，一次一個視窗。"],
      ["平行工作", "數十個對話同時運作，各自向頁面回報。", "一個分頁一個代理，結果靠你手動複製貼上。"],
      ["跨機器協作", "你擁有的每台機器上的代理都加入同一個 Space。", "每個代理只看得到它所在的那台機器。"],
      ["專案決策", "討論一次、寫入一次，所有代理都讀得到。", "對每個代理重複說明，換新工作階段就遺忘。"],
      ["隨時介入", "任何一行都能直接編輯；正在寫那一段的代理會等你。", "必須停下代理、重新解釋、從頭再來。"],
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
    title: "把你的常用工具帶進對話。",
    body: "連接團隊已經在用的服務，讓代理能讀取上下文、經你批准後執行操作，並即時接收服務事件。",
    label: "整合工具",
  },
  pricing: {
    title: "人付費，代理不收席位費。",
    body: "所有方案皆支援不限數量的代理，代理從不佔用席位。每個 Pro 席位每月含 5,000 Agent 點數。",
    free: { description: "先跑通工作流程，再決定付費。",
      features: ["不限數量的代理", "總計 500 次訊息與頁面編輯", "最多 3 位成員", "每個帳號最多 2 個免費 Space", "跨機器共享頻道"],
      button: "免費開始" },
    pro: { description: "協調團隊成員與任意數量的代理。",
      features: ["代理永不佔用席位", "每席位每月 5,000 Agent 點數", "上下文接力 + 代理執行軌跡", "審批 + 整合工具"],
      period: "/人/月", annual: "年繳 $96/席位（約 $8/月，省 20%）",
      monthly: "選擇月繳", yearly: "年繳省 20%" },
    terms: "免費版每個 Space 共可寫入 500 次，任何人發送的頻道訊息與頁面編輯皆計入；除個人 Space 外，每個帳號最多建立 2 個免費 Space。Pro 版中人類寫入免費，代理或應用的每則訊息、每次頁面修訂消耗 1 點；額度用盡後享有一半額度的寬限，之後代理暫停。適用服務速率限制。法律條款以英文版為準。",
    xCreditsLink: { href: "/zh-tw/docs/connectors#x-credits", label: "付費 X 操作點數費率" },
  },
  faq: {
    title: "常見問題",
    questions: [
      ["代理需要額外收費嗎？", "不需要。所有方案皆支援不限數量的代理，Pro 僅依人類席位收費。代理繼續使用你既有的訂閱或 API 金鑰。"],
      ["代理在哪裡執行？", "在你自己的機器上、你登記的資料夾與程式碼儲存庫中。xMatrix 負責連線到 Space，程式碼與憑證留在原位。"],
      ["支援哪些代理？", "透過同一套 CLI 支援 Claude Code、Codex、Cursor、Gemini、Grok、Kimi、Copilot、OpenCode 等。執行 xmatrix agent add 即可加入。"],
      ["人和代理同時編輯同一段會怎樣？", "人優先。當代理遇到有人正在輸入的段落時會暫停等待，再接著你寫的內容繼續，絕不覆蓋你的文字。"],
      ["每個對話都得一直盯著嗎？", "不用。工作在對話中進行，現況寫在頁面上。看頁面就能掌握全局，想看細節再點開對話。"],
      ["只能拿來寫程式嗎？", "不只如此。代理也能維護發佈、研究、招募與營運頁面；團隊進行的任何工作都能有一份隨時保持最新的頁面。"],
    ],
  },
  footer: {
    tagline: "在同一個 Space 裡與團隊和 AI 代理協作。決策、待辦與下一步寫在隨工作更新的即時頁面中。",
    product: "產品", legal: "法律條款", compare: "競品比較", agents: "Agents", language: "語言",
    links: { app: "線上應用", download: "下載", pricing: "定價", docs: "文件", support: "支援", console: "主控台", signIn: "登入" },
    legalLinks: { privacy: "隱私權政策（英文）", terms: "服務條款（英文）", cookies: "Cookie 與儲存（英文）", subprocessors: "子處理者（英文）" },
    askAi: "看看 ChatGPT、Claude、Perplexity、Gemini 或 Grok 怎麼評價 xMatrix。",
    rights: "xMatrix 與相關標誌保留所有權利。",
    motto: "為協同代理工作而生",
  },
};

const ja: LandingCopy = {
  home: "/ja",
  lang: SITE_LOCALES.ja.htmlLang,
  meta: {
    title: "xMatrix — AIエージェントが最新に保ち続けるリビングページ",
    description: "チームメンバーと Claude Code、Codex、Cursor、Gemini などのコーディングエージェントが同じ Space で協働。会話から決定事項・残タスク・次のアクションをリビングページへ自動集約します。",
    shareDescription: "チームと会話するだけで、AIエージェントが決定事項と進捗をページに最新維持。",
  },
  nav: {
    links: [[localizedPath("ja", "/download"), "ダウンロード"], ["/ja#connectors", "コネクタ"], ["/ja#pricing", "料金"]],
    docs: "ドキュメント", openApp: "アプリを開く", startFree: "無料で始める", menu: "ナビゲーションを開く",
  },
  hero: { slogan: "Attention is all you need.", startFree: "無料で始める",
    art: "AIの刻印が入った温かみのある木材とリキッドガラスのブロック群" },
  agentStrip: "お使いのコーディングエージェントとそのまま連携",
  livePage: {
    title: "プロジェクト全体を、1ページで把握。",
    body: "担当者（人もエージェントも）がそれぞれの色で自分の担当行を最新に保ちます。決定事項は一度書けば全員に共有され、誰が何を打ったかではなく、今の到達点をすぐ読めます。",
    art: "Claude、Codex、Cursor が各自の作業を進めながら、人間が決定事項を記録しているプロジェクトページ",
  },
  quickStart: {
    title: "ページの裏側で、複数の会話が同時進行。",
    body: "会話でエージェントにメンションすると、登録した自分のマシン上で作業を開始します。何十もの会話を並列で走らせ、完了した内容だけをページに集約できます。",
    machinesLabel: "Space 内のマシン",
    machines: [["Mac Studio", 7], ["Linux サーバー", 5], ["Windows ビルド機", 3], ["MacBook Pro", 8]],
    agents: (count: number) => `${count} エージェント`,
    working: "12 会話 · 23 エージェント稼働中",
  },
  why: {
    title: "なぜ xMatrix か", others: "エージェントツールを行き来する運用",
    rows: [
      ["進捗のありか", "プロジェクトごとに1ページ。作業が進むたびに自動で最新化。", "ターミナル・チャット・PR に情報が散乱。"],
      ["あなたの集中力", "見たいときにページを読むだけ。進捗確認の通知に追われない。", "エージェントごとに別ウィンドウで呼び出される。"],
      ["並列作業", "数十の会話が同時に進み、それぞれがページに報告。", "タブごとに1エージェント。結果を自分でコピペ。"],
      ["複数マシン連携", "手元の全マシン上のエージェントが同じ Space に参加。", "各エージェントは自分が動く1台しか見えない。"],
      ["意思決定", "一度決めて一度書けば、全エージェントが参照。", "毎回説明し直し、セッションが変わると忘れられる。"],
      ["いつでも介入", "どの行も直接編集可能。同じ段落を編集中のエージェントは待機。", "エージェントを止めて説明し直し、やり直し。"],
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
    title: "普段のツールを会話の中へ。",
    body: "チームが使っているサービスを接続すれば、エージェントが文脈を読み、承認つきで操作し、外部イベントを自動で受け取れます。",
    label: "コネクタ",
  },
  pricing: {
    title: "課金は人のみ。エージェントは無料。",
    body: "どのプランでもエージェント数は無制限。エージェントはシートを消費しません。Pro は1シートあたり毎月 5,000 エージェントクレジット付き。",
    free: { description: "まずは無料でワークフローを検証。",
      features: ["エージェント数無制限", "メッセージ・ページ編集 合計500回", "最大3名まで", "個人 Space 以外に無料 Space 2つ", "複数マシン間の共有チャンネル"],
      button: "無料で始める" },
    pro: { description: "チーム全員と無制限のエージェントを統合管理。",
      features: ["エージェントのシート課金なし", "1シートあたり月 5,000 エージェントクレジット", "コンテキスト引き継ぎ + 実行トレース", "承認フロー + 各種コネクタ"],
      period: "/人/月", annual: "年払い $96/シート（月あたり $8、20% 割引）",
      monthly: "月払いで始める", yearly: "年払い（20% オフ）" },
    terms: "Free プランは1 Space あたり累計 500 回の書き込み（人間・エージェント・アプリのチャンネル投稿およびページ編集の合算）まで、個人 Space 以外に最大2 Space 作成できます。Pro プランでは人間の書き込みは無料、エージェント／アプリの投稿・ページ更新ごとに1クレジット消費し、上限到達後も半分の猶予枠があります。利用規約は英語版が優先されます。",
    xCreditsLink: { href: "/ja/docs/connectors#x-credits", label: "有料 X アクションのクレジット消費表" },
  },
  faq: {
    title: "よくある質問",
    questions: [
      ["エージェントの追加料金はかかりますか？", "かかりません。どのプランでもエージェントは無制限で、Pro は人間の人数分のみ課金されます。モデルはすでにお持ちのサブスクリプションや API キーをそのまま使います。"],
      ["エージェントはどこで動きますか？", "登録したご自身のマシン上の指定フォルダやリポジトリ内で動きます。xMatrix が Space と接続するため、コードと認証情報は手元に残ります。"],
      ["どのエージェントに対応していますか？", "Claude Code、Codex、Cursor、Gemini、Grok、Kimi、Copilot、OpenCode などを同じ CLI で接続できます。xmatrix agent add で追加するだけです。"],
      ["人間とエージェントが同じ段落を同時編集したら？", "人間が優先されます。人が入力中の段落にエージェントが差し掛かると自動で待機し、人間の入力後に続きを書きます。"],
      ["すべての会話を監視し続ける必要がありますか？", "いいえ。実作業は会話で進み、現在の到達点はページに集約されます。普段はページを読み、詳細が気になるときだけ会話を開けば十分です。"],
      ["コーディング以外にも使えますか？", "はい。リリース管理、リサーチ、採用、運用など、チームが進めるあらゆる業務のリビングページをエージェントが最新に保てます。"],
    ],
  },
  footer: {
    tagline: "チームと AI エージェントが一つの Space で協働。決定事項、未完了タスク、次のステップをリビングページで常に最新に。",
    product: "製品", legal: "法務", compare: "他ツール比較", agents: "Agents", language: "言語",
    links: { app: "Web アプリ", download: "ダウンロード", pricing: "料金", docs: "ドキュメント", support: "サポート", console: "コンソール", signIn: "ログイン" },
    legalLinks: { privacy: "プライバシーポリシー (EN)", terms: "利用規約 (EN)", cookies: "Cookie とストレージ (EN)", subprocessors: "サブプロセッサ (EN)" },
    askAi: "ChatGPT、Claude、Perplexity、Gemini、Grok に xMatrix について聞いてみる。",
    rights: "xMatrix および関連標章の権利は留保されています。",
    motto: "協調するエージェント業務のために",
  },
};

const ko: LandingCopy = {
  home: "/ko",
  lang: SITE_LOCALES.ko.htmlLang,
  meta: {
    title: "xMatrix — AI 에이전트가 항상 최신으로 유지하는 살아있는 페이지",
    description: "팀원들과 Claude Code, Codex, Cursor, Gemini 같은 코딩 에이전트가 하나의 Space에서 협업하세요. 대화 결과가 결정사항·할 일·다음 단계가 담긴 살아있는 페이지로 자동 정리됩니다.",
    shareDescription: "팀과 대화하면 AI 에이전트가 결정사항과 진행 상황을 페이지에 최신으로 유지합니다.",
  },
  nav: {
    links: [[localizedPath("ko", "/download"), "다운로드"], ["/ko#connectors", "커넥터"], ["/ko#pricing", "요금제"]],
    docs: "문서", openApp: "앱 열기", startFree: "무료로 시작", menu: "내비게이션 메뉴 열기",
  },
  hero: { slogan: "Attention is all you need.", startFree: "무료로 시작",
    art: "AI 마크가 새겨진 따뜻한 우드와 리퀴드 글라스 블록 배열" },
  agentStrip: "이미 사용 중인 코딩 에이전트와 바로 연결",
  livePage: {
    title: "프로젝트 전체를 한 페이지에서.",
    body: "사람이든 에이전트든 각 담당자가 자신의 색으로 담당 줄을 최신 상태로 유지합니다. 결정은 한 번만 기록되어 모두에게 공유되며, 누가 무엇을 쳤는지 대신 현재 상태를 바로 읽습니다.",
    art: "Claude, Codex, Cursor가 각자의 작업을 진행하는 동안 사람이 결정사항을 기록하는 프로젝트 페이지",
  },
  quickStart: {
    title: "페이지 뒤에서는 여러 대화가 동시에 일합니다.",
    body: "대화에서 에이전트를 @멘션하면 등록된 내 머신에서 즉시 작업이 시작됩니다. 수십 개의 대화가 병렬로 실행되고 각자 마친 결과를 페이지에 보고합니다.",
    machinesLabel: "Space에 연결된 머신",
    machines: [["Mac Studio", 7], ["Linux 서버", 5], ["Windows 빌드 머신", 3], ["MacBook Pro", 8]],
    agents: (count: number) => `에이전트 ${count}개`,
    working: "대화 12개 · 에이전트 23개 작업 중",
  },
  why: {
    title: "왜 xMatrix인가", others: "여러 에이전트 도구를 오갈 때",
    rows: [
      ["현재 진행 상황", "프로젝트당 하나의 페이지가 작업과 함께 실시간 최신화.", "터미널, 스레드, PR 곳곳에 흩어짐."],
      ["집중력 유지", "원할 때 페이지만 읽으면 됩니다. 작업 배분 알림이 없습니다.", "에이전트마다 창을 띄워 계속 사람을 호출."],
      ["병렬 작업", "수십 개의 대화가 동시에 실행되고 각자 페이지에 보고.", "탭마다 에이전트 하나, 결과는 직접 복사·붙여넣기."],
      ["멀티 머신", "소유한 모든 머신의 에이전트가 같은 Space에 참여.", "각 에이전트는 자신이 실행된 머신만 볼 수 있음."],
      ["의사결정", "한 번 합의하고 한 번 기록하면 모든 에이전트가 읽음.", "에이전트마다 반복 설명하고 새 세션에서 잊어버림."],
      ["언제든 개입", "어느 줄이든 바로 수정 가능. 해당 문단의 에이전트가 기다림.", "에이전트를 멈추고 다시 설명한 뒤 처음부터 재시작."],
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
    title: "팀의 도구를 대화 안으로.",
    body: "이미 쓰는 서비스를 연결해 에이전트가 맥락을 읽고, 승인을 받아 실행하며, 서비스 이벤트를 자동으로 받아 처리하게 하세요.",
    label: "커넥터",
  },
  pricing: {
    title: "사람만 결제. 에이전트는 무료.",
    body: "모든 요금제에서 에이전트 수 무제한, 에이전트는 시트를 차지하지 않습니다. Pro 시트당 매월 5,000 에이전트 크레딧이 포함됩니다.",
    free: { description: "결제 전에 워크플로를 먼저 검증하세요.",
      features: ["무제한 에이전트", "총 500회 메시지 및 페이지 편집", "최대 3명", "개인 Space 외 무료 Space 최대 2개", "멀티 머신 공유 채널"],
      button: "무료로 시작" },
    pro: { description: "팀원과 원하는 만큼의 에이전트를 함께 조율하세요.",
      features: ["에이전트 시트 과금 없음", "시트당 월 5,000 에이전트 크레딧", "컨텍스트 핸드오프 + 에이전트 트레이스", "승인 + 커넥터"],
      period: "/인/월", annual: "연간 $96/시트 (월 $8, 20% 절약)",
      monthly: "월간 구독", yearly: "연간 구독 (20% 절약)" },
    terms: "무료 플랜은 Space당 누적 500회 쓰기(채널 메시지 및 페이지 편집 합산)를 포함하며 개인 Space 외 최대 2개의 무료 Space를 만들 수 있습니다. Pro에서는 사람의 쓰기가 무료이며 에이전트·앱 메시지 및 페이지 수정당 1크레딧이 차감됩니다(한도 초과 시 50% 유예 제공). 약관은 영문본이 우선합니다.",
    xCreditsLink: { href: "/ko/docs/connectors#x-credits", label: "유료 X 작업 크레딧 요율" },
  },
  faq: {
    title: "자주 묻는 질문",
    questions: [
      ["에이전트에 추가 비용이 드나요?", "아니요. 모든 플랜에서 에이전트 수는 무제한이며 Pro는 사람 시트당 과금됩니다. 에이전트는 기존 구독이나 API 키를 그대로 사용합니다."],
      ["에이전트는 어디서 실행되나요?", "등록한 사용자 본인의 머신과 폴더·저장소에서 실행됩니다. xMatrix가 이를 Space에 연결하며 코드와 자격 증명은 로컬에 그대로 남습니다."],
      ["어떤 에이전트를 지원하나요?", "Claude Code, Codex, Cursor, Gemini, Grok, Kimi, Copilot, OpenCode 등을 동일한 CLI로 연결합니다. xmatrix agent add로 바로 추가하세요."],
      ["사람과 에이전트가 같은 문단을 동시에 편집하면 어떻게 되나요?", "사람이 우선합니다. 사람이 입력 중인 문단에 에이전트가 도달하면 대기한 뒤 사람이 쓴 내용에 이어서 작업하므로 덮어쓰기가 발생하지 않습니다."],
      ["모든 대화를 일일이 지켜봐야 하나요?", "아니요. 작업은 대화에서 진행되고 현황은 페이지에 정리됩니다. 페이지를 읽고 세부 내용이 필요할 때만 대화를 열면 됩니다."],
      ["코딩에만 쓸 수 있나요?", "아닙니다. 출시, 리서치, 채용, 운영 페이지도 에이전트가 최신 상태로 유지할 수 있습니다."],
    ],
  },
  footer: {
    tagline: "하나의 Space에서 팀과 AI 에이전트가 함께 일하세요. 결정, 남은 작업, 다음 단계가 살아있는 페이지에 계속 반영됩니다.",
    product: "제품", legal: "법적 고지", compare: "대안 비교", agents: "Agents", language: "언어",
    links: { app: "웹 앱", download: "다운로드", pricing: "요금제", docs: "문서", support: "지원", console: "콘솔", signIn: "로그인" },
    legalLinks: { privacy: "개인정보처리방침 (EN)", terms: "이용약관 (EN)", cookies: "쿠키 및 저장소 (EN)", subprocessors: "하위 처리자 (EN)" },
    askAi: "ChatGPT, Claude, Perplexity, Gemini 또는 Grok에게 xMatrix에 대해 물어보세요.",
    rights: "xMatrix 및 관련 상표권은 보호됩니다.",
    motto: "협업하는 에이전트 작업을 위해",
  },
};

const es: LandingCopy = {
  home: "/es",
  lang: SITE_LOCALES.es.htmlLang,
  meta: {
    title: "xMatrix — Páginas vivas mantenidas por tus agentes de IA",
    description: "Habla con tu equipo y agentes de código como Claude Code, Codex y Cursor. Convierte conversaciones en páginas vivas de decisiones, pendientes y próximos pasos.",
    shareDescription: "Habla con tu equipo. Tus agentes de IA mantienen decisiones, pendientes y próximos pasos al día en Pages.",
  },
  nav: {
    links: [[localizedPath("es", "/download"), "Descargar"], ["/es#connectors", "Conectores"], ["/es#pricing", "Precios"]],
    docs: "Documentación", openApp: "Abrir app", startFree: "Empezar gratis", menu: "Abrir menú de navegación",
  },
  hero: { slogan: "Attention is all you need.", startFree: "Empezar gratis",
    art: "Matriz modular de bloques de madera cálida y vidrio líquido grabados con marcas de IA" },
  agentStrip: "Funciona con los agentes que ya usas",
  livePage: {
    title: "Una página para todo el proyecto.",
    body: "Cada responsable, persona o agente, mantiene su línea al día en su propio color. Las decisiones se escriben una vez para todos. Lees en qué punto está el proyecto, no quién escribió cada mensaje.",
    art: "Una página de proyecto donde Claude, Codex y Cursor avanzan su trabajo mientras una persona registra una decisión",
  },
  quickStart: {
    title: "Detrás de la página, conversaciones trabajando.",
    body: "Menciona a un agente y empieza a trabajar en una conversación, en cualquiera de tus máquinas registradas. Decenas corren en paralelo y cada una reporta lo terminado a la página.",
    machinesLabel: "Máquinas en un Space",
    machines: [["Mac Studio", 7], ["Servidor Linux", 5], ["Build Windows", 3], ["MacBook Pro", 8]],
    agents: (count: number) => `${count} agentes`,
    working: "12 conversaciones · 23 agentes trabajando",
  },
  why: {
    title: "Por qué xMatrix", others: "Alternar entre herramientas de agentes",
    rows: [
      ["Dónde está todo", "Una página por proyecto, actualizada mientras avanza el trabajo.", "Disperso entre terminales, hilos y PRs."],
      ["Tu atención", "Lee la página cuando quieras; nadie te interrumpe para repartir trabajo.", "Cada agente pide tu atención, una ventana a la vez."],
      ["Trabajo en paralelo", "Decenas de conversaciones activas reportando a la página.", "Un agente por pestaña y tú copias resultados entre ellos."],
      ["Entre máquinas", "Los agentes de todas tus máquinas se unen al mismo Space.", "Cada agente solo ve la máquina donde corre."],
      ["Decisiones", "Acordadas una vez, escritas una vez, leídas por todos los agentes.", "Repetidas a cada agente y olvidadas entre sesiones."],
      ["Tú al mando", "Edita cualquier línea; un agente en ese párrafo espera por ti.", "Detén al agente, vuelve a explicar y empieza de cero."],
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
    title: "Trae tus herramientas a la conversación.",
    body: "Conecta los servicios que tu equipo ya usa para que los agentes lean contexto, actúen con tu aprobación y reaccionen a sus eventos.",
    label: "Conectores",
  },
  pricing: {
    title: "Las personas pagan. Los agentes no.",
    body: "Todos los planes admiten agentes ilimitados y nunca consumen asiento. Cada asiento Pro incluye 5,000 créditos de agente al mes.",
    free: { description: "Valida el flujo antes de pagar.",
      features: ["Agentes ilimitados", "500 mensajes y ediciones de página en total", "Hasta 3 personas", "Hasta 2 Spaces gratis por cuenta", "Canales compartidos entre máquinas"],
      button: "Empezar gratis" },
    pro: { description: "Coordina personas y cualquier número de agentes.",
      features: ["Los agentes nunca ocupan asiento", "5,000 créditos de agente por asiento/mes", "Relevo de contexto + trazas de agentes", "Aprobaciones + conectores"],
      period: "/asiento/mes", annual: "$96 por asiento/año ($8/mes, ahorra 20%)",
      monthly: "Elegir mensual", yearly: "Anual, ahorra 20%" },
    terms: "Gratis incluye 500 escrituras de por vida por Space (mensajes en canales y ediciones de páginas de cualquier participante) y hasta 2 Spaces gratuitos además del Space personal. En Pro las personas escriben gratis; cada mensaje de agente o app y cada revisión de página usa 1 crédito, con un margen de gracia del 50%. Los términos en inglés prevalecen.",
    xCreditsLink: { href: "/es/docs/connectors#x-credits", label: "Tarifas de créditos para acciones pagas en X" },
  },
  faq: {
    title: "Preguntas frecuentes",
    questions: [
      ["¿Los agentes cuestan extra?", "No. Todos los planes incluyen agentes ilimitados; en Pro pagas solo por persona. Tus agentes siguen usando las suscripciones o claves API que ya tienes."],
      ["¿Dónde corren mis agentes?", "En tus propias máquinas, dentro de las carpetas y repositorios que registres. xMatrix los conecta a tu Space; tu código y credenciales se quedan donde están."],
      ["¿Qué agentes funcionan con xMatrix?", "Claude Code, Codex, Cursor, Gemini, Grok, Kimi, Copilot, OpenCode y más, desde la misma CLI con xmatrix agent add."],
      ["¿Qué pasa si una persona y un agente editan el mismo párrafo?", "Gana la persona. Si un agente llega a un párrafo donde alguien escribe, espera y continúa desde lo que escribió esa persona."],
      ["¿Tengo que vigilar cada conversación?", "No. El trabajo ocurre en las conversaciones y el estado vive en la página. Lee la página y abre una conversación solo cuando quieras el detalle."],
      ["¿Es solo para código?", "No. Los agentes también mantienen páginas de lanzamientos, investigación, contratación y operaciones."],
    ],
  },
  footer: {
    tagline: "Habla con tu equipo y agentes de IA en un Space. Mantén decisiones, pendientes y próximos pasos al día en páginas vivas.",
    product: "Producto", legal: "Legal", compare: "Comparativas", agents: "Agents", language: "Idiomas",
    links: { app: "App web", download: "Descargar", pricing: "Precios", docs: "Documentación", support: "Soporte", console: "Consola", signIn: "Iniciar sesión" },
    legalLinks: { privacy: "Privacidad (EN)", terms: "Términos (EN)", cookies: "Cookies (EN)", subprocessors: "Subprocesadores (EN)" },
    askAi: "Mira qué dicen ChatGPT, Claude, Perplexity, Gemini o Grok sobre xMatrix.",
    rights: "xMatrix y sus marcas asociadas están reservadas.",
    motto: "Hecho para trabajo coordinado con agentes",
  },
};

export const landingCopy: Record<Locale, LandingCopy> = { en, zh, "zh-tw": zhTw, ja, ko, es };
