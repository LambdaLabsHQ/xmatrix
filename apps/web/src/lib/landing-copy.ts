import { FREE_PLAN_FEATURES, PRO_PLAN_FEATURES } from "@/lib/space-plans";

/**
 * The homepage's words in each language it is published in: English at `/`,
 * Simplified Chinese at `/zh`. Every landing section reads its text from here,
 * so both pages share one layout and differ only in copy.
 */
export type Locale = "en" | "zh";

type Pair = readonly [string, string];
type Row = readonly [string, string, string];

export interface LandingCopy {
  /** The homepage in this language, and its language tag. */
  home: string;
  lang: string;
  meta: { title: string; description: string; shareDescription: string };
  nav: { links: readonly Pair[]; docs: string; openApp: string; startFree: string; menu: string };
  hero: { slogan: string; startFree: string; art: string };
  agentStrip: string;
  livePage: { title: string; body: string; art: string };
  quickStart: { title: string; body: string; machinesLabel: string; machines: readonly (readonly [string, number])[];
    agents: (count: number) => string; working: string };
  why: { title: string; others: string; rows: readonly Row[] };
  connectors: { title: string; body: string; label: string };
  pricing: {
    title: string; body: string;
    free: { description: string; features: readonly string[]; button: string };
    pro: { description: string; features: readonly string[]; period: string; annual: string; promotions: string;
      monthly: string; yearly: string };
    terms: string;
    /** A link to the X API credit table, on a page that does not show it itself. */
    xCreditsLink: { href: string; label: string };
  };
  faq: { title: string; questions: readonly Pair[] };
  footer: {
    tagline: string; product: string; legal: string; agents: string;
    links: Record<"app" | "download" | "pricing" | "docs" | "console" | "signIn", string>;
    legalLinks: Record<"privacy" | "terms" | "cookies" | "subprocessors", string>;
    askAi: string; rights: string; motto: string;
  };
  /** The link to the same page in the other language. */
  otherLanguage: { href: string; label: string; hrefLang: string };
}

const en: LandingCopy = {
  home: "/",
  lang: "en",
  meta: {
    title: "xMatrix — Living pages maintained by your AI agents",
    description: "Talk with your team and coding agents like Claude Code, Codex, Cursor and Gemini. Turn conversations into living pages of decisions, open work and next steps, then keep them current together.",
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
  },
  connectors: {
    title: "Bring your tools into the conversation.",
    body: "Connect the services your team already runs so agents can read context, act with approval, and pick up the events those services send.",
    label: "Connectors",
  },
  pricing: {
    title: "People pay. Agents don't.",
    body: "Every plan supports unlimited agents, and agents never take a seat. Each Pro seat includes 5,000 Agent credits a month for Agent writing and paid X actions.",
    free: { description: "Prove the workflow before you pay.", features: FREE_PLAN_FEATURES, button: "Start Free" },
    pro: { description: "Coordinate people and any number of agents.", features: PRO_PLAN_FEATURES, period: "/human seat/mo",
      annual: "$96 per seat/year ($8/mo, save 20%)", promotions: "Promotions, if available, are applied securely during checkout.",
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
    product: "Product", legal: "Legal", agents: "Agents",
    links: { app: "Online App", download: "Download", pricing: "Pricing", docs: "Docs", console: "Console", signIn: "Sign In" },
    legalLinks: { privacy: "Privacy Policy", terms: "Terms of Service", cookies: "Cookies and Storage", subprocessors: "Subprocessors" },
    askAi: "See what ChatGPT, Claude, Perplexity, Gemini or Grok say about xMatrix.",
    rights: "xMatrix and its related marks are reserved.",
    motto: "Built for coordinated agent work",
  },
  otherLanguage: { href: "/zh", label: "中文", hrefLang: "zh-CN" },
};

const zh: LandingCopy = {
  home: "/zh",
  lang: "zh-CN",
  meta: {
    title: "xMatrix — 和团队、AI 编程智能体一起干活，进展写进活页面",
    description: "在一个 Space 里和团队、Claude Code、Codex、Cursor、Gemini 等编程智能体对话。智能体把对话整理成记录决定、待办和下一步的活页面，并随工作推进持续更新。",
    shareDescription: "和团队对话，让 AI 智能体把决定、待办和下一步写进页面并保持最新。",
  },
  nav: {
    links: [["/download", "下载"], ["/zh#connectors", "连接器"], ["/zh#pricing", "价格"]],
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
  },
  connectors: {
    title: "把你的工具带进对话。",
    body: "接入团队已经在用的服务：智能体能读取上下文，经你批准后执行操作，并接收这些服务发来的事件。",
    label: "连接器",
  },
  pricing: {
    title: "人付费，智能体不收费。",
    body: "所有方案都支持不限数量的智能体，智能体从不占席位。每个 Pro 席位每月含 5,000 Agent 积分，用于智能体写入和付费的 X 操作。",
    free: { description: "先跑通工作流，再决定付费。",
      features: ["不限数量的智能体", "总计 500 条消息和页面编辑", "最多 3 人", "每个账号最多 2 个免费 Space", "跨机器共享的频道"],
      button: "免费开始" },
    pro: { description: "协调团队成员和任意数量的智能体。",
      features: ["智能体从不占席位", "每个席位每月 5,000 Agent 积分", "上下文接力 + 智能体轨迹", "审批 + 连接器"],
      period: "/每人每月", annual: "按年 $96/席位（相当于 $8/月，省 20%）", promotions: "如有优惠，会在结账时自动应用。",
      monthly: "按月订阅", yearly: "按年订阅，省 20%" },
    terms: "免费版每个 Space 共可写入 500 次，任何人发的频道消息和页面编辑都计入；除个人 Space 外，每个账号最多 2 个免费 Space。Pro 版里人写入免费，Agent 或应用的每条消息、每次页面修订用 1 积分；额度用完后还有一半额度的宽限，之后 Agent 暂停。服务有速率限制。以英文版条款为准。",
    xCreditsLink: { href: "/docs/connectors#x-credits", label: "付费 X 操作的积分价目（英文）" },
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
    product: "产品", legal: "法律", agents: "Agents",
    links: { app: "在线应用", download: "下载", pricing: "价格", docs: "文档（英文）", console: "控制台", signIn: "登录" },
    legalLinks: { privacy: "隐私政策", terms: "服务条款", cookies: "Cookie 与存储", subprocessors: "子处理方" },
    askAi: "看看 ChatGPT、Claude、Perplexity、Gemini 或 Grok 怎么介绍 xMatrix。",
    rights: "xMatrix 及相关标识保留所有权利。",
    motto: "为协同的智能体工作而生",
  },
  otherLanguage: { href: "/", label: "English", hrefLang: "en" },
};

export const landingCopy: Record<Locale, LandingCopy> = { en, zh };
