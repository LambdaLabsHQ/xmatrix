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
    unknown: {
      title: (agent: string) => `${agent} couldn't finish this turn`,
      explanation: "",
      steps: ["Reply to it to try again."],
    },
  },
  relativeTime: (at: string | undefined, now: number) => relativeTime("en", at, now),
};

export type ProblemCopy = typeof en;

const zh: ProblemCopy = {
  stepsLabel: "怎么修复",
  detailsLabel: "详情",
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
    unknown: {
      title: (agent) => `${agent} 这一轮没有做完`,
      explanation: "",
      steps: ["回复它重试。"],
    },
  },
  relativeTime: (at, now) => relativeTime("zh", at, now),
};

export const PROBLEM_COPY: Record<OnboardingLocale, ProblemCopy> = { en, zh };
