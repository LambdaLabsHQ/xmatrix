import { harnessDisplayVersion, harnessTooOldSentence, type HarnessTooOld, type OnboardingLocale } from "@xmatrix/protocol";

/* The words of a new person's first ten minutes, in English and Chinese
   (onboarding-locale.ts picks one): the welcome conversation, the reply to
   a first message no agent could answer, the three
   setup steps, the cards, Bring them in, the empty Space and Agents
   screens, and the download card. Only the first of the two sentences
   xMatrix teaches appears here; everything else is plain instructions. */


const en = {
  listNames: (names: string[]) => names.length <= 1 ? names[0] ?? ""
    : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`,
  /** Between words: Chinese runs sentences together. */
  gap: " ",
  comma: ", ",
  period: ".",
  agentToInstall: "Agent to install",
  bringAgents: "Bring your agents into xMatrix. They keep running on your own computer, and xMatrix connects them to your conversations and pages.",
  /** Above Bring them in, in reply to a first message no agent could answer. */
  unanswered: "No agent can answer this yet. Bring one in from your computer, then send your message again.",
  worksWith: (names: string, all: boolean) => all ? `Works with ${names}` : `Works with ${names} and `,
  more: (count: number) => `${count} more`,
  runCommand: "Run this on your computer",
  signInOnComputer: "On your computer, open xmatrix.sh and sign in with this same email",
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
  signedOut: (program: string, machine: string) =>
    `${program} on ${machine} is not signed in, so it cannot take work yet. Sign it in here:`,
  signIn: "Sign in",
  /** A program that is set up on its own machine, not signed in from here. */
  cannotTakeWork: (program: string, machine: string) => `${program} on ${machine} can't take work yet.`,
  itSays: "It says:",
  setUpThere: (command: string) => `Run ${command} in a terminal on that computer, set it up as it asks, then check again.`,
  stillCannot: "It still can't take work.",
  /** After a signed-out notice's sign-in: its summon was sent again. */
  signedInResent: "Your message went to it again.",
  resendFailed: "Your message could not be sent again. Send it once more.",
  sendAgain: "Send your message again to continue.",
  noAgentYet: (machine: string) => `${machine} has no agent yet. Install one there and it shows up here:`,
  tryAgain: "Try again",
  noTerminal: "No terminal?",
  phoneDownload: ["Download the desktop app on that computer from ", "xmatrix.sh/download", "."],
  download: ["Download the desktop app", ". It finds the agents installed there."],
  server: (copied: boolean) => ["Setting up a server? ", copied ? "Copied" : "Copy a setup prompt",
    " for an agent already running there, or ", "read the steps", "."],
  preparingCommand: "Preparing a command…",
  copy: (copied: boolean): string => copied ? "Copied" : "Copy",
  agentsIn: (names: string, one: boolean) =>
    `${names} ${one ? "is" : "are"} in. Mention ${one ? "it" : "one"} here to give ${one ? "it" : "them"} work, or start with one of these:`,
  /* The first task should end in a page about the person's own work, which is
     where xMatrix makes sense; each starter asks for one. A page explaining
     xMatrix itself kept people learning the tool instead of using it. */
  /* What xMatrix is for, one card each: talking, several agents at once, the
     live page, every computer. One click shows it. */
  talk: { title: "Start a new conversation", detail: "Say what you want done. No need to @ anyone: xMatrix picks an AI to take it." },
  together: { title: "Get several AIs working together", detail: (a: string, b: string) =>
    `@${a} and @${b} split the work and pass it between them. You watch it come together.`,
    needsTwo: "Bring in one more AI, and they can work together.",
    draft: (a: string, b: string) => `@${a} @${b} Work on this together and split it between you: ` },
  machines: { title: "Connect another computer", detail: "Your work machine, your home machine, a server. Their AIs meet in one conversation." },
  /* The live document people came for: a page they write in, with an agent writing beside them. */
  coWrite: { title: "Write something with AI", detail: (agent: string) => `You write a line. @${agent} writes the next.`,
    pageTitle: "What I'm working on",
    firstLine: (agent: string) => `Write the first line here. @${agent} writes the next.`,
    /** Beside a co-writing Agent's face: how long it has been thinking, and that it went quiet. */
    thinkingFor: (seconds: number) => seconds < 60 ? `thinking ${seconds}s` : `thinking ${Math.floor(seconds / 60)} min`,
    quiet: "went quiet",
    switchTo: (agent: string) => `Write with @${agent} instead` },
  bringWorkConnect: "Bring your work in. Connect GitHub, and your repositories become pages.",
  bringWorkRepos: "Pick a repository. It becomes pages, yours to review first.",
  connectGitHub: "Connect GitHub",
  draftFrom: (repo: string) => repo,
  draftingFrom: (repo: string) => `Turning ${repo} into pages. They wait in Pages for your review.`,
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
  /** Above the composer once a Space nears or passes the point its writes are refused (space-allowance-notice.tsx). */
  allowance: {
    freeLow: (remaining: number, limit: number) =>
      `${remaining} of ${limit} free writes left in this Space (messages and page edits, by people and Agents alike). When they run out, new messages and Agent replies can't be saved.`,
    freeUsed: (limit: number | null) =>
      `This Space has used all ${limit === null ? "its" : limit} free messages and page edits. New messages and Agent replies can't be saved until it upgrades to Pro.`,
    creditsPaused: (resetsOn: string | null) =>
      `This Space's Agent credits are used up for this month, so Agent replies are paused${resetsOn ? ` until ${resetsOn}` : ""}. Your own messages still go through.`,
    upgrade: "Upgrade to Pro",
    buyCredits: "Buy credits",
    askOwnerUpgrade: "Ask the Space owner to upgrade.",
    askOwnerCredits: "Ask the Space owner to buy credits.",
  },
  allPlatforms: "All platforms and preview builds",
};

export type OnboardingCopy = typeof en;

const zh: OnboardingCopy = {
  listNames: (names) => names.length <= 1 ? names[0] ?? ""
    : `${names.slice(0, -1).join("、")} 和 ${names[names.length - 1]}`,
  gap: "",
  comma: "、",
  period: "。",
  agentToInstall: "要安装的 Agent",
  bringAgents: "把你的 Agent 带进 xMatrix。它们照常在你自己的电脑上运行，xMatrix 把它们接到你的对话和页面里。",
  unanswered: "这条消息还没有 Agent 能回。先把电脑上的 Agent 带进来，再发一次。",
  worksWith: (names, all) => all ? `支持 ${names}` : `支持 ${names}，还有`,
  more: (count) => `另外 ${count} 个`,
  runCommand: "在你的电脑上运行这条命令",
  signInOnComputer: "在电脑上打开 xmatrix.sh，用同一个邮箱登录",
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
  signedOut: (program, machine) => `${machine} 上的 ${program} 还没登录，登录之前接不了活。在这里登录：`,
  signIn: "登录",
  cannotTakeWork: (program, machine) => `${machine} 上的 ${program} 还不能接活。`,
  itSays: "它说：",
  setUpThere: (command) => `在那台电脑的终端里运行 ${command}，按提示设置好，然后再查一次。`,
  stillCannot: "还是不能接活。",
  signedInResent: "你的消息已重新交给它。",
  resendFailed: "消息没能重新发出，请再发一次。",
  sendAgain: "再发一次消息就能继续。",
  noAgentYet: (machine) => `${machine} 上还没有 Agent。在那台电脑上装一个，它就会出现在这里：`,
  tryAgain: "重试",
  noTerminal: "没有终端？",
  phoneDownload: ["在那台电脑上打开 ", "xmatrix.sh/download", " 下载桌面 App。"],
  download: ["下载桌面 App", "，它会找到电脑上装好的 Agent。"],
  server: (copied) => ["要接一台服务器？", copied ? "已复制" : "复制一段设置提示",
    "发给已经在那里运行的 Agent，或者", "看操作步骤", "。"],
  preparingCommand: "正在生成命令…",
  copy: (copied) => copied ? "已复制" : "复制",
  agentsIn: (names, one) =>
    `${names} 已接入。在这里 @ ${one ? "它" : "其中一个"}就能派活，也可以从下面选一个开始：`,
  talk: { title: "开一个新对话", detail: "说一件你想做的事。不用 @ 谁，xMatrix 会挑一个 AI 来接。" },
  together: { title: "让多个 AI 一起协作", detail: (a, b) => `@${a} 和 @${b} 分工干活、互相接力，你看着事情做成。`,
    needsTwo: "再接一个 AI，就能让它们一起协作。", draft: (a, b) => `@${a} @${b} 你们分工合作，一起把这件事做完：` },
  machines: { title: "再接一台电脑", detail: "公司的、家里的电脑或服务器，上面的 AI 能在同一个对话里碰头。" },
  coWrite: { title: "和 AI 一起写点什么", detail: (agent) => `你写一句，@${agent} 接一句。`,
    pageTitle: "我手上的事",
    firstLine: (agent) => `在这里写下第一句，@${agent} 会接着写。`,
    thinkingFor: (seconds) => seconds < 60 ? `想了 ${seconds} 秒` : `想了 ${Math.floor(seconds / 60)} 分钟`,
    quiet: "没有动静了",
    switchTo: (agent) => `改让 @${agent} 来写` },
  bringWorkConnect: "把工作带进来。连上 GitHub，仓库就成了页面。",
  bringWorkRepos: "选一个仓库，它会变成几页。你看过，才算数。",
  connectGitHub: "连接 GitHub",
  draftFrom: (repo) => repo,
  draftingFrom: (repo) => `正在把 ${repo} 写成页面，写好会在 Pages 里等你过目。`,
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
  allowance: {
    freeLow: (remaining, limit) =>
      `这个 Space 的免费额度还剩 ${remaining} / ${limit} 次（消息和页面编辑合计，人和 Agent 都算）。用完后，新消息和 Agent 回复都无法保存。`,
    freeUsed: (limit) =>
      `这个 Space 的${limit === null ? "" : ` ${limit} 次`}免费额度已用完，新消息和 Agent 回复都无法保存。升级到 Pro 即可继续使用。`,
    creditsPaused: (resetsOn) =>
      `这个 Space 本月的 Agent credit 已用完，Agent 回复已暂停${resetsOn ? `，${resetsOn} 恢复` : ""}。你自己发的消息不受影响。`,
    upgrade: "升级到 Pro",
    buyCredits: "购买 credit",
    askOwnerUpgrade: "请 Space 所有者升级。",
    askOwnerCredits: "请 Space 所有者购买 credit。",
  },
  allPlatforms: "所有平台和预览版",
};

export const ONBOARDING_COPY: Record<OnboardingLocale, OnboardingCopy> = { en, zh };
