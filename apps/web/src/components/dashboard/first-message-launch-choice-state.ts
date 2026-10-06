import { FIRST_MESSAGE_LAUNCH_HOLD_LIMIT_MS, FIRST_MESSAGE_LAUNCH_WINDOW_MS, type InteractionDecisionWindow,
  type InteractionLaunchOption } from "@xmatrix/protocol";

/** What a new conversation's first message shows about which Agent starts. */
export type LaunchChoiceView =
  /** The author may still choose. `recommended` is Jev's reading once known
   * (`null`: start nothing); `deadlineAt` counts down only once the author sees it. */
  | { kind: "open"; deadlineAt?: number; recommended?: string | null }
  /** The window closed with nothing chosen and Jev has not decided yet. */
  | { kind: "reading"; recommended?: string | null }
  /** A harness was decided; its `@<harness>` reply shows the launch. */
  | { kind: "chosen"; option: InteractionLaunchOption; by: "author" | "jev" }
  /** `failureCode`: Jev could not decide, so nothing started. */
  | { kind: "none"; by: "author" | "jev"; failureCode?: string }
  /** Nothing was decided and nothing will be: the message offered no choice. */
  | { kind: "hidden" };

/** Jev has read the message: its pick, "start nothing", or why it could not. */
export function launchChoiceRead(window: InteractionDecisionWindow | undefined): boolean {
  return window !== undefined && (window.recommendation !== undefined || window.failureCode !== undefined);
}

/**
 * `window` is the Hub's decision window (`launch-choice.v1`). The author has
 * three seconds from `seenAt`, when Jev's reading first appeared on their
 * screen; the Hub's deadline follows (it starts the window when it writes the
 * reading, and the author's `shown` moves it on). Until then the choice stays
 * open without a countdown for as long as the Hub says it is open, so whether
 * it can still be chosen never depends on this device's clock. The author's
 * own fresh message shows before the Hub's record arrives.
 */
export function launchChoiceView(window: InteractionDecisionWindow | undefined,
  offer: { sentAt?: string; seenAt?: number }, now: number): LaunchChoiceView {
  if (!window) return launchChoiceOffered(offer.sentAt, now) ? { kind: "open" } : { kind: "hidden" };
  const recommended = window.recommendation;
  const read = recommended !== undefined ? { recommended } : {};
  const decided = window.decision;
  const option = decided?.optionId ? window.options.find(item => item.optionId === decided.optionId) : undefined;
  if (decided && option) {
    return { kind: "chosen", option, by: decided.by };
  }
  if (decided) return { kind: "none", by: decided.by };
  const deadlineAt = offer.seenAt === undefined ? undefined : offer.seenAt + FIRST_MESSAGE_LAUNCH_WINDOW_MS;
  if (deadlineAt !== undefined ? now < deadlineAt : window.open === true) {
    return { kind: "open", ...(deadlineAt !== undefined ? { deadlineAt } : {}), ...read };
  }
  // Jev could not decide and nobody chose: nothing starts.
  if (window.failureCode) return { kind: "none", by: "jev", failureCode: window.failureCode };
  return { kind: "reading", ...read };
}

/** Poll quickly only while a choice is open or being decided. */
export function launchChoicePollInterval(views: readonly LaunchChoiceView[]): number | undefined {
  if (views.some(view => view.kind === "open")) return 500;
  if (views.some(view => view.kind === "reading")) return 1_000;
  return undefined;
}

/** The author's first message may still offer the choice: the Hub holds it
 * open at most this long after sending. */
export function launchChoiceOffered(sentAt: string | undefined, now: number): boolean {
  const sent = sentAt ? Date.parse(sentAt) : NaN;
  return Number.isFinite(sent) && now < sent + FIRST_MESSAGE_LAUNCH_HOLD_LIMIT_MS;
}
