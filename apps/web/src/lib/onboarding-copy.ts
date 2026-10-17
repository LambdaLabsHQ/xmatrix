import { harnessDisplayVersion, harnessTooOldSentence, type HarnessTooOld, type OnboardingLocale, type OnboardingStarter } from "@xmatrix/protocol";

/* The words of a new person's first ten minutes, in English and Chinese
   (onboarding-locale.ts picks one): the welcome conversation, the three
   setup steps, the starters, Bring them in, the empty Space and Agents
   screens, and the download card. Only the first of the two sentences
   xMatrix teaches appears here; everything else is plain instructions. */

type Starter = { id: OnboardingStarter; title: string; detail: string; message: string };

const en = {
  /** Which language this is, for words the Hub writes (the setup email). */
  locale: "en" as OnboardingLocale,
  listNames: (names: string[]) => names.length <= 1 ? names[0] ?? ""
    : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`,
  /** Between words: Chinese runs sentences together. */
  gap: " ",
  comma: ", ",
  period: ".",
  agentToInstall: "Agent to install",
  bringAgents: "Bring your agents into xMatrix. They keep running on your own computer, and xMatrix connects them to your conversations and pages.",
  worksWith: (names: string, all: boolean) => all ? `Works with ${names}` : `Works with ${names} and `,
  more: (count: number) => `${count} more`,
  runCommand: "Run this on your computer",
  otherPlatform: (windows: boolean): string => windows ? "macOS or Linux?" : "Windows?",
  waitingForComputer: "Waiting for your computer…",
  checkTerminal: "Nothing yet? The terminal says what went wrong.",
  tryDesktop: "Still nothing? The desktop app connects without a terminal.",
  approveHere: "Approve it here",
  signingIn: "Signing in…",
  /** Around the code, after the hostname. */
  wantsToConnect: [" wants to connect with code ", "."],
  sameCodeOnly: "Approve it only if the terminal shows the same code.",
  approve: "Approve",
  notMine: "Not mine",
  turnOnFound: "Turn on the agents it finds",
  looking: "Looking…",
  found: (names: string) => `Found ${names}.`,
  bringThemIn: "Bring them in",
  tooOld: (tooOld: HarnessTooOld) => harnessTooOldSentence(tooOld),
  nothingUntilUpdated: "Nothing is sent to it until it is updated.",
  noAgentYet: (machine: string) => `${machine} has no agent yet. Install one there and it shows up here:`,
  tryAgain: "Try again",
  noTerminal: "No terminal?",
  phoneDownload: ["Download the desktop app on that computer from ", "xmatrix.sh/download", "."],
  download: ["Download the desktop app", ". It finds the agents installed there."],
  server: (copied: boolean) => ["Setting up a server? ", copied ? "Copied" : "Copy a setup prompt",
    " for an agent already running there, or ", "read the steps", "."],
  emailOffer: "On your phone? Email this to yourself and open it on your computer.",
  sendToComputer: "Send to my computer",
  emailSent: "Sent to your email. Open it on your computer to continue there.",
  /** The page the emailed link opens on the computer, while it signs in and opens the Space. */
  continueSetup: "Opening your setup…",
  preparingCommand: "Preparing a command…",
  copy: (copied: boolean): string => copied ? "Copied" : "Copy",
  agentsIn: (names: string, one: boolean) =>
    `${names} ${one ? "is" : "are"} in. Mention ${one ? "it" : "one"} here to give ${one ? "it" : "them"} work, or start with one of these:`,
  /* The first task should end in a page, which is where xMatrix makes sense;
     each starter asks for one. The last names the canonical runbook on
     purpose: an agent asked to explain xMatrix from memory invents an answer. */
  starters: [
    { id: "project", title: "Write a page about my project", detail: "What it is, where it stands and what is still open.",
      message: "Write a page about a project I'm working on: what it is, where it stands and what is still open. Ask me which project first." },
    { id: "plan", title: "Plan something with me", detail: "The plan stays in a page as we go.",
      message: "Help me plan something I'm working on, and keep the plan in a page as we go." },
    { id: "xmatrix", title: "Show me how to hand you work", detail: "Reads xmatrix.sh/start.md and writes it up as a page.",
      message: "Read https://xmatrix.sh/start.md and write a page on how I should hand you work through xMatrix." },
  ] as Starter[],
  installedTitle: "Your installed agents",
  installedBody: "Turn them on to summon them. Choose a working folder when you send the first task.",
  enabling: "Enabling…",
  manageMachines: "Manage machines",
  discoveringTitle: "Looking for agents on this machine",
  discoveringBody: "Checking which agent runtimes are installed and which directories they have worked in.",
  foundOn: (agents: string, host: string) => `Found ${agents} on ${host}`,
  andMore: (first: string, more: number) => `${first} and ${more} more`,
  anAgent: "an agent",
  turnOnInstalled: "Turn on the installed agents so they can take work.",
  serviceStopped: "The background service that launches agents on this machine is not running yet.",
  startIt: "Start it",
  /* The App could not start its background service, said as what it means
     for the person; the CLI's own lines follow it for whoever reads them. */
  daemonFailure: (stage: string): string => stage === "cli_install"
    ? "xMatrix couldn't install its command-line tool on this computer, so agents can't start here yet."
    : stage === "service_start"
      ? "This computer didn't let xMatrix start its background service, so agents can't start here yet."
      : "xMatrix's background service stopped right after it started, so agents can't start here yet.",
  failureReported: "These details were sent to xMatrix so we can fix this.",
  tryingAgain: "Trying again…",
  detectedBy: "Detected by checking installed commands. Manage installed harnesses and their Space switches from Machines.",
  usedHere: "used on this machine",
  chooseFolderLater: "You will choose the folder it works in when you send the first task.",
  enable: "Enable",
  noRuntimeTitle: (host: string) => `No agent runtime found on ${host}`,
  noRuntimeBody: "xMatrix launches an agent CLI that already lives on a machine — it does not ship one. Install one here, or point xMatrix at the machine you actually code on.",
  checkAgain: "Check again",
  unreachableTitle: "Cannot reach xMatrix right now",
  unreachableBody: "This Space's agents could not be loaded, so nothing here is up to date. Your agents and their work are unaffected — this is a connection problem, not a change to the Space.",
  enableInstalledTitle: "Enable an installed harness",
  connectAgentsTitle: "Connect your agents",
  enableOrInstall: "Turn on an installed harness in the list, or install one from Machines.",
  downloadFor: (platform: "macOS" | "Windows" | "Android") => `Download for ${platform}`,
  appleSiliconDetail: "For Apple Silicon (M-series) Macs.",
  intelDetail: "For Intel-based Macs.",
  windowsDetail: "Stable installer for Windows x64.",
  androidDetail: "Install the stable Android APK.",
  getXMatrix: "Get xMatrix",
  useOnWeb: "Use xMatrix on the web",
  chooseBelow: "Choose a download below, or open the web app on any device.",
  noNative: (platform: string) => `A native ${platform} download is not available here. Open the web app to stay connected.`,
  openWebApp: "Open web app",
  otherMac: (name: string) => `${name} Mac`,
  allPlatforms: "All platforms and preview builds",
};

export type OnboardingCopy = typeof en;

const zh: OnboardingCopy = {
  locale: "zh",
  listNames: (names) => names.length <= 1 ? names[0] ?? ""
    : `${names.slice(0, -1).join("、")} 和 ${names[names.length - 1]}`,
  gap: "",
  comma: "、",
  period: "。",
  agentToInstall: "要安装的 Agent",
  bringAgents: "把你的 Agent 带进 xMatrix。它们照常在你自己的电脑上运行，xMatrix 把它们接到你的对话和页面里。",
  worksWith: (names, all) => all ? `支持 ${names}` : `支持 ${names}，还有`,
  more: (count) => `另外 ${count} 个`,
  runCommand: "在你的电脑上运行这条命令",
  otherPlatform: (windows) => windows ? "用 macOS 或 Linux？" : "用 Windows？",
  waitingForComputer: "正在等你的电脑连上…",
  checkTerminal: "还没反应？终端里会写哪里出了错。",
  tryDesktop: "还是不行？桌面 App 不用终端也能连上。",
  approveHere: "在这里批准",
  signingIn: "正在登录…",
  wantsToConnect: [" 请求连接，验证码 ", "。"],
  sameCodeOnly: "终端里显示的是同一个验证码，才批准。",
  approve: "批准",
  notMine: "不是我的",
  turnOnFound: "开启找到的 Agent",
  looking: "正在查找…",
  found: (names) => `找到了 ${names}。`,
  bringThemIn: "全部带进来",
  tooOld: (tooOld) => `${tooOld.machineName ? `${tooOld.machineName} 上的 ` : ""}${tooOld.program} 是 ` +
    `${harnessDisplayVersion(tooOld.version)}，版本太旧，xMatrix 需要 ${tooOld.minimumVersion} 或更新。`,
  nothingUntilUpdated: "更新之前不会给它派活。",
  noAgentYet: (machine) => `${machine} 上还没有 Agent。在那台电脑上装一个，它就会出现在这里：`,
  tryAgain: "重试",
  noTerminal: "没有终端？",
  phoneDownload: ["在那台电脑上打开 ", "xmatrix.sh/download", " 下载桌面 App。"],
  download: ["下载桌面 App", "，它会找到电脑上装好的 Agent。"],
  server: (copied) => ["要接一台服务器？", copied ? "已复制" : "复制一段设置提示",
    "发给已经在那里运行的 Agent，或者", "看操作步骤", "。"],
  emailOffer: "在用手机？把它发到自己的邮箱，在电脑上打开。",
  sendToComputer: "发到我的电脑",
  emailSent: "已发到你的邮箱。在电脑上打开邮件，就能接着往下做。",
  continueSetup: "正在打开你的接入步骤…",
  preparingCommand: "正在生成命令…",
  copy: (copied) => copied ? "已复制" : "复制",
  agentsIn: (names, one) =>
    `${names} 已接入。在这里 @ ${one ? "它" : "其中一个"}就能派活，也可以从下面选一个开始：`,
  starters: [
    { id: "project", title: "给我的项目写一个页面", detail: "它是什么、做到哪了、还有什么没做完。",
      message: "给我正在做的一个项目写一个页面：它是什么、做到哪了、还有什么没做完。先问我是哪个项目。" },
    { id: "plan", title: "和我一起做个计划", detail: "边聊边把计划写进页面。",
      message: "帮我规划一件正在做的事，边聊边把计划写进一个页面。" },
    { id: "xmatrix", title: "教我怎么给你派活", detail: "读 xmatrix.sh/start.md，整理成一个页面。",
      message: "读 https://xmatrix.sh/start.md，写一个页面，讲我该怎么通过 xMatrix 给你派活。" },
  ],
  installedTitle: "你已安装的 Agent",
  installedBody: "开启后就能召唤它们。发第一个任务时再选工作目录。",
  enabling: "正在开启…",
  manageMachines: "管理电脑",
  discoveringTitle: "正在查找这台电脑上的 Agent",
  discoveringBody: "看看装了哪些 Agent，以及它们在哪些目录工作过。",
  foundOn: (agents, host) => `在 ${host} 上找到了 ${agents}`,
  andMore: (first, more) => `${first} 等 ${more + 1} 个`,
  anAgent: "Agent",
  turnOnInstalled: "开启已安装的 Agent，它们就能接活。",
  serviceStopped: "这台电脑上负责启动 Agent 的后台服务还没运行。",
  startIt: "启动",
  daemonFailure: (stage) => stage === "cli_install"
    ? "xMatrix 没能在这台电脑上装好命令行工具，所以 Agent 暂时还起不来。"
    : stage === "service_start"
      ? "这台电脑没让 xMatrix 启动后台服务，所以 Agent 暂时还起不来。"
      : "xMatrix 的后台服务刚启动就停了，所以 Agent 暂时还起不来。",
  failureReported: "这些信息已经发给 xMatrix，我们会据此修复。",
  tryingAgain: "正在重试…",
  detectedBy: "通过检查已安装的命令找到。在「Machines」里管理已安装的 Agent 和它们在各 Space 的开关。",
  usedHere: "在这台电脑上用过",
  chooseFolderLater: "发第一个任务时，再选它工作的目录。",
  enable: "开启",
  noRuntimeTitle: (host) => `${host} 上没有找到 Agent`,
  noRuntimeBody: "xMatrix 启动的是电脑上已经装好的 Agent 命令行，本身不带。在这里装一个，或者换到你平时写代码的那台电脑。",
  checkAgain: "再查一次",
  unreachableTitle: "现在连不上 xMatrix",
  unreachableBody: "这个 Space 的 Agent 没读出来，这里显示的不是最新状态。你的 Agent 和它们的工作不受影响，只是连接出了问题。",
  enableInstalledTitle: "开启一个已安装的 Agent",
  connectAgentsTitle: "接入你的 Agent",
  enableOrInstall: "在列表里开启已安装的 Agent，或者在「Machines」里装一个。",
  downloadFor: (platform) => `下载 ${platform} 版`,
  appleSiliconDetail: "适用于 Apple 芯片（M 系列）的 Mac。",
  intelDetail: "适用于 Intel 芯片的 Mac。",
  windowsDetail: "Windows x64 稳定版安装包。",
  androidDetail: "安装稳定版 Android APK。",
  getXMatrix: "下载 xMatrix",
  useOnWeb: "使用网页版 xMatrix",
  chooseBelow: "在下面选一个下载，或者在任何设备上打开网页版。",
  noNative: (platform) => `${platform} 暂时没有原生 App，打开网页版就能随时查看。`,
  openWebApp: "打开网页版",
  otherMac: (name) => name === "Intel" ? "Intel 芯片的 Mac" : "Apple 芯片的 Mac",
  allPlatforms: "所有平台和预览版",
};

export const ONBOARDING_COPY: Record<OnboardingLocale, OnboardingCopy> = { en, zh };
