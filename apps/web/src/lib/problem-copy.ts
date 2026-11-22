import type { OnboardingLocale } from "@xmatrix/protocol";

/* The words of a problem card (problem-card.tsx), in English and Chinese,
   picked by the same locale as the first-ten-minutes path
   (onboarding-locale.ts). Each sentence says what happened or what to do;
   codes stay in Details. */

function relativeTime(locale: OnboardingLocale, at: string | undefined, now: number): string | undefined {
  const then = at ? Date.parse(at) : Number.NaN;
  if (!Number.isFinite(then)) return undefined;
  const seconds = Math.round((then - now) / 1000);
  const format = new Intl.RelativeTimeFormat(locale === "zh" ? "zh-CN" : "en", { numeric: "auto" });
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [["day", 86_400], ["hour", 3_600], ["minute", 60]];
  for (const [unit, size] of units) if (Math.abs(seconds) >= size) return format.format(Math.round(seconds / size), unit);
  return format.format(0, "minute");
}

const en = {
  stepsLabel: "To fix it",
  detailsLabel: "Details",
  quotaResets: (at: string) => `Quota resets: ${at}`,
  noProviderDetail: "The program did not report a specific error.",
  errorCode: (code: string) => `Error code: ${code}`,
  copy: "Copy",
  copied: "Copied",
  sendAgain: "Send again",
  sending: "Sending…",
  resent: "Your message went to it again.",
  resendFailed: "Your message could not be sent again. Send it once more.",
  openMachine: "Open this computer",
  machineOffline: {
    title: (machine: string | undefined) => machine ? `${machine} is offline` : "The computer this agent runs on is offline",
    explanation: (mention: string) => `${mention} didn't start, because xMatrix can't reach that computer right now. Nothing was run.`,
    someoneElses: "This computer belongs to someone else in this Space. Ask them to bring it back, or address another agent.",
    stepsLabel: "To bring it back",
    powerOn: (machine: string | undefined) => `Make sure ${machine ?? "that computer"} is on and connected to the internet.`,
    openApp: "Open the xMatrix desktop app on it.",
    openAppOrRun: "Open the xMatrix desktop app on it, or run this in its terminal:",
    sendAgain: "When it's back online, send your message again.",
    offline: (lastSeen: string | undefined) => lastSeen ? `Still offline · last seen ${lastSeen}` : "Still offline",
    online: (machine: string | undefined) => `${machine ?? "The computer"} is back online`,
    waiting: "Waiting for it to come back…",
  },
  /* The desktop App could not start its background service (space-agent-setup.ts daemonProblem). */
  daemon: {
    tryAgain: "Try again",
    tryingAgain: "Trying again…",
    exitCode: (code: number) => `Exit code: ${code}`,
    task_permission_denied: {
      title: "Windows didn't let xMatrix register its background service",
      explanation: "This computer's permissions blocked creating the task that starts xMatrix when you sign in. This is common on computers a company or school manages. Agents can't start here until it's registered.",
      steps: [
        "Quit xMatrix, right-click its icon and choose Run as administrator, then click Try again.",
        "No administrator rights? Ask your IT team to allow creating a scheduled task for your account, or connect another computer instead.",
      ],
    },
    file_in_use: {
      title: "An older xMatrix is still running and blocked the update",
      explanation: "xMatrix couldn't replace its command-line tool because a background service from an earlier version still has the file open.",
      steps: [
        "Quit xMatrix completely: xMatrix menu → Quit, or close all its windows.",
        "Open Task Manager, find every xmatrix.exe under Details, and choose End task.",
        "Open xMatrix again and click Try again.",
      ],
    },
    stopped_by_setup: {
      title: "The background service was stopped while it was starting",
      explanation: "Windows ended it from outside, which usually happens when an older service is being replaced during setup.",
      steps: [
        "Click Try again; it usually starts the second time.",
        "If it keeps happening, restart the computer and open xMatrix again.",
      ],
    },
  },
  /* An Agent's turn did not finish (turn-failure-notice.tsx turnProblem). */
  turn: {
    usage_limited: {
      title: (agent: string) => `${agent}'s provider quota is used up`,
      explanation: "Its provider account has no usage or balance left, so this turn could not finish.",
      steps: ["Wait for the provider quota to reset, or top up a prepaid account, before asking this agent to continue.",
        "To continue sooner, hand the work to another agent with available quota."],
    },
    rate_limited: {
      title: (agent: string) => `${agent} was rate limited by its provider`,
      explanation: "The provider turned down more requests for now (HTTP 429), so this turn didn't finish.",
      steps: ["Wait a few minutes, then reply to it to continue.",
        "If its subscription quota is used up, it can continue once the quota resets; in a hurry, hand the work to another agent."],
    },
    provider_refused: {
      title: (agent: string) => `The provider refused ${agent}'s request`,
      explanation: "The provider answered 401 or 403: usually an expired sign-in, a restricted account, or a network that blocks it.",
      steps: ["Sign it in again on the computer it runs on.",
        "If that computer uses a proxy or a company network, make sure it can reach the provider.",
        "Then reply to it to continue."],
    },
    unreachable: {
      title: (agent: string) => `${agent} couldn't reach its provider`,
      explanation: "The network between the computer it runs on and its provider failed (a timeout or a dropped connection).",
      steps: ["Check that computer's network and proxy.", "Then reply to it to continue."],
    },
    process_exited: {
      title: (agent: string) => `${agent}'s program stopped in the middle of the turn`,
      explanation: "The program running it exited unexpectedly, so this turn didn't finish.",
      steps: ["Reply to it to try again.", "If it keeps happening, update it on the computer it runs on."],
    },
    no_status: {
      title: (agent: string) => `${agent} couldn't finish this turn`,
      explanation: "This turn stopped without an HTTP status or an error code from the provider.",
      steps: ["Reply to it to continue."],
    },
    unknown: {
      title: (agent: string) => `${agent} couldn't finish this turn`,
      explanation: "",
      steps: ["Reply to it to try again."],
    },
    continueLabel: "To continue",
    continued: (agent: string) => `${agent} continued afterward`,
  },
  /* A handoff that started no successor (mention-invocation-chip.tsx MentionRefusedLifecycleChip).
     `other` is the handoff to write instead, already filled with the source. */
  handoff: {
    stepsLabel: "What you can do",
    rawLabel: "What xMatrix recorded",
    registration_quota_exhausted: {
      title: (source: string, successor: string) => `${successor} couldn't take over ${source}: out of quota`,
      explanation: (source: string, successor: string) => `${source} has stopped and its work is kept, but every ${successor} that could continue it has used up its provider quota, so no new Agent started.`,
      steps: (_source: string, successor: string, other: string) => [`Hand it to another Agent: send ${other}. xMatrix picks one that still has quota.`,
        `Or wait until ${successor}'s quota resets, then send the same handoff again.`],
    },
    no_machine: {
      title: (_source: string, successor: string) => `No machine here can run ${successor}`,
      explanation: (source: string, successor: string) => `${source} has stopped and its work is kept, but none of the machines this conversation can use runs ${successor}, so no new Agent started.`,
      steps: (_source: string, successor: string, other: string) => [`Hand it to another Agent: send ${other}.`,
        `Or connect a machine that runs ${successor}, then send the same handoff again.`],
    },
    registration_daemon_offline: {
      title: (_source: string, successor: string) => `The computer that runs ${successor} is offline`,
      explanation: (source: string, successor: string) => `${source} has stopped and its work is kept, but xMatrix can't reach the computer ${successor} runs on, so no new Agent started.`,
      steps: (_source: string, _successor: string, other: string) => ["Turn that computer on and open xMatrix there, then send the same handoff again.",
        `Or hand it to another Agent: send ${other}.`],
    },
    handoff_source_stop_pending: {
      title: (source: string) => `${source} is still stopping`,
      explanation: (source: string, successor: string) => `A handoff stops ${source} before ${successor} starts. Its computer hasn't confirmed the stop yet, so ${successor} hasn't started.`,
      steps: (source: string) => [`Wait until ${source} shows Stopped, then send the same handoff again.`],
    },
    handoff_source_stop_unavailable: {
      title: (source: string) => `${source} couldn't be stopped for the handoff`,
      explanation: (source: string, successor: string) => `A handoff stops ${source} before ${successor} starts, and that stop didn't go through. ${source} keeps its work; nothing new started.`,
      steps: (source: string) => [`Check that the computer ${source} runs on is online, then send the same handoff again.`],
    },
    handoff_location_conflict: {
      title: (source: string, successor: string) => `${successor} has to continue where ${source} worked`,
      explanation: (source: string) => `A handoff keeps ${source}'s repository or directory. This one asked for a different repo: or pwd:, so nothing was stopped or started.`,
      steps: () => ["Remove the repo: or pwd: condition and send the handoff again."],
    },
    handoff_source_not_transferable: {
      title: (source: string) => `${source} can't be handed off`,
      explanation: (source: string) => `${source} works for this Space's management or a direct conversation, and stays where it is. Nothing was stopped or started.`,
      steps: (_source: string, successor: string) => [`Start ${successor} on its own instead.`],
    },
    invalid_registration_launch: {
      title: () => "This handoff couldn't be read",
      explanation: () => "Nothing was stopped or started.",
      steps: (source: string) => [`Write it as ${source}:handoff:@<agent>, for example ${source}:handoff:@auto.`],
    },
    failed: {
      title: (source: string, successor: string) => `${source} wasn't handed off to ${successor}`,
      explanation: () => "",
      steps: (source: string, _successor: string, other: string) => [`Check whether ${source} is still running, then send the handoff again, or send ${other}.`],
    },
  },
  relativeTime: (at: string | undefined, now: number) => relativeTime("en", at, now),
};

export type ProblemCopy = typeof en;

const zh: ProblemCopy = {
  stepsLabel: "怎么修复",
  detailsLabel: "详情",
  quotaResets: (at) => `额度重置时间：${at}`,
  noProviderDetail: "运行程序没有提供具体错误。",
  errorCode: (code) => `错误码：${code}`,
  copy: "复制",
  copied: "已复制",
  sendAgain: "重新发送",
  sending: "正在发送…",
  resent: "你的消息已重新交给它。",
  resendFailed: "消息没能重新发出，请再发一次。",
  openMachine: "打开这台电脑",
  machineOffline: {
    title: (machine) => machine ? `${machine} 离线了` : "运行这个 Agent 的电脑离线了",
    explanation: (mention) => `${mention} 没有启动：xMatrix 现在连不上那台电脑，什么都没有运行。`,
    someoneElses: "这是 Space 里其他人的电脑。请对方让它重新上线，或者换一个 Agent。",
    stepsLabel: "怎么恢复",
    powerOn: (machine) => `确认 ${machine ?? "那台电脑"} 已开机并联网。`,
    openApp: "在这台电脑上打开 xMatrix 桌面 App。",
    openAppOrRun: "在这台电脑上打开 xMatrix 桌面 App，或者在它的终端里运行：",
    sendAgain: "重新上线后，再发送一次消息。",
    offline: (lastSeen) => lastSeen ? `仍然离线 · 最后在线 ${lastSeen}` : "仍然离线",
    online: (machine) => `${machine ?? "这台电脑"} 已重新上线`,
    waiting: "等它重新上线…",
  },
  daemon: {
    tryAgain: "重试",
    tryingAgain: "正在重试…",
    exitCode: (code) => `退出码：${code}`,
    task_permission_denied: {
      title: "Windows 不允许 xMatrix 注册后台服务",
      explanation: "这台电脑的权限设置拦住了 xMatrix 创建登录时自动启动的任务，公司或学校管理的电脑上很常见。注册成功之前，Agent 在这台电脑上起不来。",
      steps: [
        "退出 xMatrix，右键它的图标选择「以管理员身份运行」，再点「重试」。",
        "没有管理员权限？请 IT 允许你的账户创建计划任务，或者换一台电脑接入。",
      ],
    },
    file_in_use: {
      title: "旧版 xMatrix 还在运行，挡住了更新",
      explanation: "xMatrix 没能替换命令行工具：旧版本的后台服务还占着这个文件。",
      steps: [
        "完全退出 xMatrix：菜单 xMatrix → Quit，或者关闭它的所有窗口。",
        "打开「任务管理器」，在「详细信息」里找到所有 xmatrix.exe，逐个「结束任务」。",
        "重新打开 xMatrix，点「重试」。",
      ],
    },
    stopped_by_setup: {
      title: "后台服务在启动过程中被关掉了",
      explanation: "Windows 从外部结束了它，通常是安装过程中正在替换旧的服务。",
      steps: [
        "点「重试」，第二次一般就能起来。",
        "如果反复出现，重启电脑后再打开 xMatrix。",
      ],
    },
  },
  turn: {
    usage_limited: {
      title: (agent) => `${agent} 的服务商额度已用尽`,
      explanation: "它使用的服务商账号没有剩余额度或余额，这一轮无法继续。",
      steps: ["等服务商额度重置后（预付费账号要先充值），再让这个 Agent 继续。", "需要尽快继续的话，交给还有额度的其他 Agent 接手。"],
    },
    rate_limited: {
      title: (agent) => `${agent} 被服务商限流了`,
      explanation: "服务商暂时拒绝了更多请求（HTTP 429），这一轮没有做完。",
      steps: ["等几分钟，再回复它让它接着做。", "如果是订阅额度用完了，要等额度重置；着急的话换一个 Agent 接手。"],
    },
    provider_refused: {
      title: (agent) => `服务商拒绝了 ${agent} 的请求`,
      explanation: "服务商返回了 401 或 403：通常是登录过期、账号受限，或者所在的网络被拦截。",
      steps: ["在运行它的电脑上重新登录。", "如果那台电脑用了代理或公司网络，确认它能访问服务商。", "然后回复它让它接着做。"],
    },
    unreachable: {
      title: (agent) => `${agent} 连不上服务商`,
      explanation: "运行它的电脑和服务商之间的网络出了问题（超时或连接被断开）。",
      steps: ["检查那台电脑的网络和代理。", "恢复后回复它让它接着做。"],
    },
    process_exited: {
      title: (agent) => `${agent} 的程序中途退出了`,
      explanation: "运行它的程序意外退出，这一轮没有做完。",
      steps: ["回复它重试。", "如果反复出现，在运行它的电脑上更新它。"],
    },
    no_status: {
      title: (agent) => `${agent} 这一轮没有做完`,
      explanation: "服务商没有返回 HTTP 状态或错误码，这一轮停在了当时的位置。",
      steps: ["回复它，让它接着做。"],
    },
    unknown: {
      title: (agent) => `${agent} 这一轮没有做完`,
      explanation: "",
      steps: ["回复它重试。"],
    },
    continueLabel: "接着做",
    continued: (agent) => `${agent} 后来继续了`,
  },
  handoff: {
    stepsLabel: "接下来可以",
    rawLabel: "xMatrix 的原始记录",
    registration_quota_exhausted: {
      title: (source, successor) => `${successor} 额度用完了，没能接手 ${source}`,
      explanation: (source, successor) => `${source} 已经停下，工作都保留着；但所有能接手的 ${successor} 都用完了服务商额度，所以没有新的 Agent 启动。`,
      steps: (_source, successor, other) => [`换一个 Agent 接手：发送 ${other}，xMatrix 会挑一个还有额度的。`,
        `或者等 ${successor} 的额度重置后，再发一次同样的交接。`],
    },
    no_machine: {
      title: (_source, successor) => `这里没有能运行 ${successor} 的电脑`,
      explanation: (source, successor) => `${source} 已经停下，工作都保留着；但这个对话能用的电脑上都没有 ${successor}，所以没有新的 Agent 启动。`,
      steps: (_source, successor, other) => [`换一个 Agent 接手：发送 ${other}。`,
        `或者接入一台装了 ${successor} 的电脑，再发一次同样的交接。`],
    },
    registration_daemon_offline: {
      title: (_source, successor) => `运行 ${successor} 的电脑离线了`,
      explanation: (source, successor) => `${source} 已经停下，工作都保留着；但 xMatrix 连不上运行 ${successor} 的电脑，所以没有新的 Agent 启动。`,
      steps: (_source, _successor, other) => ["打开那台电脑并启动 xMatrix，再发一次同样的交接。",
        `或者换一个 Agent 接手：发送 ${other}。`],
    },
    handoff_source_stop_pending: {
      title: (source) => `${source} 还在停止中`,
      explanation: (source, successor) => `交接会先停下 ${source} 再启动 ${successor}。它的电脑还没确认已经停下，所以 ${successor} 还没启动。`,
      steps: (source) => [`等 ${source} 显示 Stopped 后，再发一次同样的交接。`],
    },
    handoff_source_stop_unavailable: {
      title: (source) => `没能停下 ${source} 来交接`,
      explanation: (source, successor) => `交接会先停下 ${source} 再启动 ${successor}，这一步没有成功。${source} 的工作都还在，没有启动新的 Agent。`,
      steps: (source) => [`确认运行 ${source} 的电脑在线，再发一次同样的交接。`],
    },
    handoff_location_conflict: {
      title: (source, successor) => `${successor} 只能在 ${source} 原来的位置接着做`,
      explanation: (source) => `交接会沿用 ${source} 的仓库或目录，这次却指定了别的 repo: 或 pwd:，所以什么都没停、什么都没启动。`,
      steps: () => ["去掉 repo: 或 pwd: 条件，再发一次交接。"],
    },
    handoff_source_not_transferable: {
      title: (source) => `${source} 不能交接`,
      explanation: (source) => `${source} 负责这个 Space 的管理或私聊对话，会一直留在原处。什么都没停、什么都没启动。`,
      steps: (_source, successor) => [`需要的话，直接单独启动 ${successor}。`],
    },
    invalid_registration_launch: {
      title: () => "这条交接没法识别",
      explanation: () => "什么都没停、什么都没启动。",
      steps: (source) => [`写成 ${source}:handoff:@<agent>，比如 ${source}:handoff:@auto。`],
    },
    failed: {
      title: (source, successor) => `${source} 没有交接给 ${successor}`,
      explanation: () => "",
      steps: (source, _successor, other) => [`先看看 ${source} 是否还在运行，再发一次交接，或者发送 ${other}。`],
    },
  },
  relativeTime: (at, now) => relativeTime("zh", at, now),
};

export const PROBLEM_COPY: Record<OnboardingLocale, ProblemCopy> = { en, zh };
