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
  relativeTime: (at, now) => relativeTime("zh", at, now),
};

export const PROBLEM_COPY: Record<OnboardingLocale, ProblemCopy> = { en, zh };
