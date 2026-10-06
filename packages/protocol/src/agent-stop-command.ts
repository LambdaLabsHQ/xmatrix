import { matchInteractionGrammar } from "./message-interaction-grammar.js";
import { isOperationalMentionStart, nonOperationalMentionRanges } from "./operational-mention-context.js";

export interface AgentStopCommand {
  target: string;
  all: boolean;
  reason?: string;
}

/** The stop command as it was written, so a client can hang the receipt on
 * that span instead of posting another message. */
export interface AgentStopInvocation extends AgentStopCommand {
  start: number;
  end: number;
  text: string;
}

/** The one stop-command grammar. The message authority reads it to fence a
 * Channel's Runs in the append transaction; the Hub reads it to deliver the
 * host stops afterwards. Offsets are UTF-16 positions in `body`. */
export function parseAgentStopInvocation(body: string): AgentStopInvocation | undefined {
  for (const rule of ["lifecycle.stop.v1", "channel.stop.v1", "channel.named-stop.v1"]) {
    const match = matchInteractionGrammar(rule, body)[0];
    if (!match || !isOperationalMentionStart(match.start, nonOperationalMentionRanges(body))) continue;
    const target = match.arguments.target!.replace(/^[@＠]/u, "");
    const reason = match.arguments.reason?.trim().slice(0, 500);
    // The span is the command alone; a reason after it stays prose.
    const end = match.start + body.slice(match.start, match.end - (match.arguments.reason?.length ?? 0)).trimEnd().length;
    return { start: match.start, end, text: body.slice(match.start, end),
      target, all: rule !== "lifecycle.stop.v1" && target.toLowerCase() === "all",
      ...(reason ? { reason } : {}) };
  }
  return undefined;
}

export function parseAgentStopCommand(body: string): AgentStopCommand | undefined {
  const invocation = parseAgentStopInvocation(body);
  if (!invocation) return undefined;
  return { target: invocation.target, all: invocation.all, ...(invocation.reason ? { reason: invocation.reason } : {}) };
}

/** What the stop chip can say. Accepting the request is not confirmation that
 * the process is gone; only the Workstation's stop receipt is. */
export type AgentStopPhase = "accepted" | "confirmed" | "failed" | "unconfirmed";

/** One Run a stop command fenced, projected for the mention it was written on. */
export interface SerializedAgentStop {
  stopId: string;
  channelId: string;
  sourceMessageId: string;
  runId: string;
  targetName: string;
  targetAvatarUrl?: string;
  instanceOrdinal?: string;
  /** The Machine as its owner named it. A hostname is not a Machine name. */
  machineName?: string;
  phase: AgentStopPhase;
  requestedAt: string;
  confirmedAt?: string;
}

export interface StopReceiptSummary {
  phase: AgentStopPhase;
  accepted: number;
  confirmed: number;
  failed: number;
  unconfirmed: number;
  /** Set when every receipt names the same Machine. */
  machineName?: string;
}

/** One chip for the whole command. Anything still accepted keeps the chip in
 * progress; otherwise a failure wins over an unconfirmed end. */
export function summarizeStopReceipts(stops: readonly SerializedAgentStop[]): StopReceiptSummary {
  const count = { accepted: 0, confirmed: 0, failed: 0, unconfirmed: 0 };
  for (const stop of stops) count[stop.phase] += 1;
  const names = [...new Set(stops.map(stop => stop.machineName).filter((name): name is string => Boolean(name)))];
  const phase: AgentStopPhase = count.accepted > 0 ? "accepted"
    : count.failed > 0 ? "failed"
    : count.unconfirmed > 0 || stops.length === 0 ? "unconfirmed"
    : "confirmed";
  return { phase, ...count, ...(names.length === 1 ? { machineName: names[0] } : {}) };
}
