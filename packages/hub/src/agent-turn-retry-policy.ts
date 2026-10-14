import type { AgentInstanceTurnRetryMessage } from "@xmatrix/protocol/connections/agent-instance";

// Product policy lives only on the Hub. Hosts report outcomes, never budgets
// or deadlines, and a reconnect repeats the same request rather than work.
const DELAYS_MS = [5_000, 15_000, 30_000] as const;
export const TURN_RETRY_LIFETIME_MS = 120_000;
export const TURN_RETRY_DELIVERY_RECHECK_MS = 5_000;
export const TURN_RETRY_RUNTIME_PATH = "/internal/product-agent/turn-retry";
export const CAPACITY_CONTINUATION = "Continue the previous request that failed because the selected model was at capacity.";

export interface HubTurnRetry {
  operationId: string;
  threadId: string;
  turnId: string;
  requestId: string;
  attempt: number;
  attemptToken: string;
  state: "waiting" | "issued" | "completed" | "cancelled" | "exhausted" | "unsafe" | "expired" | "ineligible";
  dueAt: number;
  expiresAt: number;
  notice: string;
  errorMessage: string;
  agentLabel?: string;
}

export function parseHubTurnRetry(value: unknown): HubTurnRetry | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const r = value as HubTurnRetry;
  if (![r.operationId, r.threadId, r.turnId, r.requestId, r.attemptToken].every(value =>
      typeof value === "string" && /^[a-zA-Z0-9_-]{1,160}$/.test(value)) ||
      !Number.isInteger(r.attempt) || r.attempt < 0 || r.attempt > DELAYS_MS.length ||
      !Number.isSafeInteger(r.dueAt) || !Number.isSafeInteger(r.expiresAt) ||
      !["waiting", "issued", "completed", "cancelled", "exhausted", "unsafe", "expired", "ineligible"].includes(r.state) ||
      typeof r.notice !== "string" || r.notice.length > 100 || typeof r.errorMessage !== "string" || r.errorMessage.length > 600) return;
  return r;
}

export function advanceTurnRetry(previous: HubTurnRetry | undefined,
  report: AgentInstanceTurnRetryMessage, now: number, token: string): HubTurnRetry | undefined {
  if (report.action !== "failed") {
    if (!previous || previous.operationId !== report.operationId) return previous;
    if (!["waiting", "issued"].includes(previous.state)) return previous;
    return { ...previous, state: report.action, notice: report.action, dueAt: now };
  }
  if (!report.threadId || !report.turnId || !report.requestId) throw new Error("Turn retry failure scope is missing");
  // A duplicate report cannot spend another attempt or reopen a terminal state.
  if (previous?.operationId === report.operationId && previous.turnId === report.turnId) {
    if (previous.requestId !== report.requestId) throw new Error("Retry request identity changed");
    return previous;
  }
  if (previous && ["waiting", "issued"].includes(previous.state) && previous.operationId !== report.operationId)
    throw new Error("A different retry operation is already active");
  const continuing = previous?.operationId === report.operationId;
  if (continuing && (previous.state !== "issued" || previous.threadId !== report.threadId ||
      previous.attemptToken !== report.attemptToken)) throw new Error("Turn retry receipt does not match its permit");
  if (!continuing && report.attemptToken) throw new Error("Initial retry cannot name a permit");
  const used = continuing ? previous.attempt : 0;
  const capacity = report.errorMessage?.trim().toLowerCase().replace(/^codex error: /u, "")
    .startsWith("selected model is at capacity.");
  const state = !capacity ? "ineligible" : !report.safeToContinue ? "unsafe" : used >= DELAYS_MS.length ? "exhausted" : "waiting";
  const attempt = state === "waiting" ? used + 1 : used;
  // Hub retries only capacity failures. Any other error is reported where it
  // arrives, as the ordinary turn failure (see the Agent Instance port), so
  // this record posts no notice of its own.
  return { operationId: report.operationId, threadId: report.threadId, turnId: report.turnId,
    requestId: report.requestId, attempt, attemptToken: token, state,
    dueAt: state === "waiting" ? now + DELAYS_MS[used]! : now,
    expiresAt: continuing ? previous.expiresAt : now + TURN_RETRY_LIFETIME_MS,
    errorMessage: report.errorMessage!, notice: state === "waiting" ? `waiting:${attempt}` : state === "ineligible" ? "" : state };
}

export function turnRetryNotice(state: HubTurnRetry): string {
  const label = state.agentLabel?.replace(/[@＠`\r\n]/gu, " ").trim().slice(0, 160);
  const prefix = label ? `Agent ${label}: ` : "";
  const outcome = turnRetryOutcome(state);
  if (["waiting", "issued", "completed"].includes(state.state)) return prefix + outcome;
  // The host stays silent for these outcomes, so this notice is the only
  // place its original error appears. Mention sigils cannot summon anyone.
  const error = state.errorMessage.replace(/\s+/gu, " ").replace(/[@＠]/gu, "﹫").trim();
  return prefix + outcome + (error ? ` Error: ${error}` : "");
}

function turnRetryOutcome(state: HubTurnRetry): string {
  switch (state.state) {
    case "waiting": return `Model temporarily at capacity. Hub scheduled retry ${state.attempt}/3 for ${new Date(state.dueAt).toISOString()}, using the same model.`;
    case "issued": return `Hub requested model-capacity retry ${state.attempt}/3, using the same model.`;
    case "completed": return `Model-capacity retry completed successfully after ${state.attempt} ${state.attempt === 1 ? "retry" : "retries"}.`;
    case "cancelled": return "Model-capacity retry cancelled because the current work stopped or changed.";
    case "expired": return "Model-capacity retry expired without a confirmed continuation. No further retry was issued.";
    case "ineligible": return "Provider turn failed.";
    case "unsafe": return "Model-capacity failure was not retried because execution or output may already have occurred.";
    case "exhausted": return "Model remains at capacity after 3 retries. Hub stopped retrying.";
  }
}
