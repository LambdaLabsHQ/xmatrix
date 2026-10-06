import { hasOperationalAgentInvocation, parseAgentStopInvocation, parseAutoLaunchMentions,
  type SerializedAgentMessageTarget, type AgentInvocationQueryPage, type SerializedFirstMessageLaunchChoice, type SerializedAgentContinuation, type SerializedAgentInvocationRejection, type SerializedAgentLaunch, type SerializedAgentMessageExecution, type SerializedAgentStop } from "@xmatrix/protocol";

export class InvocationAccessError extends Error {
  constructor(readonly status: number) { super("Invocation access could not be confirmed"); }
}

export interface InvocationSourceMessage { id: string; messageId?: string; body: string; sentAt: string; senderKind?: "agent" | "app" | "user" | "system" }
export function invocationSourceMessages<T extends InvocationSourceMessage>(messages: readonly T[], visibleIds?: readonly string[]): T[] {
  const visible = visibleIds === undefined ? undefined : new Set(visibleIds);
  const candidates = visible ? messages.filter((message) => visible.has(message.messageId || message.id)) : messages.slice(-20);
  // An Agent's stop command carries a receipt chip too, like a Human's.
  return candidates.filter((message) => message.senderKind === "user" || hasOperationalAgentInvocation(message.body) ||
    parseAutoLaunchMentions(message.body).length > 0 || parseAgentStopInvocation(message.body) !== undefined);
}

/** One channel reader, bounded pages and a single cancellation/deadline budget.
 * An incomplete scan is an error, never a falsely complete partial result. */
export async function loadInvocationPages(input: {
  channelId: string; sourceMessageIds: readonly string[]; signal: AbortSignal;
  fetchPage: (request: { sourceMessageIds: string[]; pageSize: 100; cursor: string | null }, signal: AbortSignal) => Promise<AgentInvocationQueryPage>;
}): Promise<AgentInvocationQueryPage> {
  const sourceIds = [...new Set(input.sourceMessageIds)];
  if (sourceIds.length > 1_000) throw new Error("Too many visible invocation messages");
  const controller = new AbortController();
  const cancel = () => controller.abort(input.signal.reason);
  input.signal.addEventListener("abort", cancel, { once: true });
  if (input.signal.aborted) cancel();
  const timeout = setTimeout(() => controller.abort(new Error("Invocation status refresh timed out")), 30_000);
  const launches: SerializedAgentLaunch[] = [];
  const rejections: SerializedAgentInvocationRejection[] = [];
  const continuations: SerializedAgentContinuation[] = [];
  const executions: SerializedAgentMessageExecution[] = [];
  const launchIds = new Set<string>();
  const rejectionIds = new Set<string>();
  const continuationIds = new Set<string>();
  const executionIds = new Set<string>();
  const targets: SerializedAgentMessageTarget[] = [];
  const targetIds = new Set<string>();
  const launchChoices: SerializedFirstMessageLaunchChoice[] = [];
  const stops: SerializedAgentStop[] = [];
  const stopIds = new Set<string>();
  try {
    for (let offset = 0; offset < sourceIds.length; offset += 100) {
      const sourceMessageIds = sourceIds.slice(offset, offset + 100);
      const selected = new Set(sourceMessageIds);
      const cursors = new Set<string>();
      let cursor: string | null = null;
      for (let pageNumber = 0; pageNumber < 50; pageNumber++) {
        if (controller.signal.aborted) throw controller.signal.reason ?? new Error("Invocation read cancelled");
        const page = await input.fetchPage({ sourceMessageIds, pageSize: 100, cursor }, controller.signal);
        if (controller.signal.aborted) throw controller.signal.reason ?? new Error("Invocation read cancelled");
        if (!Array.isArray(page.launches) || page.launches.length > 100 ||
            (page.rejections !== undefined && (!Array.isArray(page.rejections) || page.rejections.length > 100)) ||
            (page.continuations !== undefined && (!Array.isArray(page.continuations) || page.continuations.length > 100)) ||
            (page.executions !== undefined && (!Array.isArray(page.executions) || page.executions.length > 100)) ||
            (page.targets !== undefined && (!Array.isArray(page.targets) || page.targets.length > 100))) {
          throw new Error("Invalid invocation page");
        }
        for (const launch of page.launches) {
          if (launch.channelId !== input.channelId || !selected.has(launch.sourceMessageId) ||
              typeof launch.launchId !== "string" || launchIds.has(launch.launchId)) throw new Error("Invocation page scope or ordering changed");
          launchIds.add(launch.launchId);
          launches.push(launch);
        }
        for (const rejection of page.rejections ?? []) {
          if (rejection.channelId !== input.channelId || !selected.has(rejection.sourceMessageId) ||
              typeof rejection.invocationId !== "string" || rejectionIds.has(rejection.invocationId)) throw new Error("Invocation rejection scope or ordering changed");
          rejectionIds.add(rejection.invocationId);
          rejections.push(rejection);
        }
        for (const continuation of page.continuations ?? []) {
          if (continuation.channelId !== input.channelId || !selected.has(continuation.sourceMessageId) ||
              typeof continuation.runId !== "string" || continuationIds.has(continuation.runId)) {
            throw new Error("Continuation page scope or ordering changed");
          }
          continuationIds.add(continuation.runId);
          continuations.push(continuation);
        }
        for (const execution of page.executions ?? []) {
          if (execution.channelId !== input.channelId || !selected.has(execution.sourceMessageId) ||
              typeof execution.id !== "string" || executionIds.has(execution.id)) {
            throw new Error("Execution page scope or ordering changed");
          }
          executionIds.add(execution.id);
          executions.push(execution);
        }
        if (page.launchChoices !== undefined && (!Array.isArray(page.launchChoices) || page.launchChoices.length > 100)) {
          throw new Error("Invalid invocation page");
        }
        if (page.stops !== undefined && (!Array.isArray(page.stops) || page.stops.length > 500)) {
          throw new Error("Invalid invocation page");
        }
        for (const choice of page.launchChoices ?? []) {
          if (choice.channelId !== input.channelId || !selected.has(choice.messageId) ||
              launchChoices.some(known => known.messageId === choice.messageId)) throw new Error("Launch choice scope changed");
          launchChoices.push(choice);
        }
        for (const stop of page.stops ?? []) {
          if (stop.channelId !== input.channelId || !selected.has(stop.sourceMessageId) ||
              typeof stop.stopId !== "string" || stopIds.has(stop.stopId)) throw new Error("Stop receipt scope or ordering changed");
          stopIds.add(stop.stopId);
          stops.push(stop);
        }
        for (const target of page.targets ?? []) {
          if (target.channelId !== input.channelId || !selected.has(target.sourceMessageId) ||
              typeof target.id !== "string" || targetIds.has(target.id)) throw new Error("Target page scope or ordering changed");
          targetIds.add(target.id); targets.push(target);
        }
        if (page.nextCursor === undefined || page.nextCursor === null) break;
        if (typeof page.nextCursor !== "string" || !page.nextCursor || page.nextCursor.length > 2_000 ||
            cursors.has(page.nextCursor) || pageNumber === 49) throw new Error("Invocation pagination did not complete");
        cursors.add(page.nextCursor);
        cursor = page.nextCursor;
      }
    }
    return { launches, rejections, continuations, executions, targets, launchChoices, stops, nextCursor: null };
  } finally {
    clearTimeout(timeout);
    input.signal.removeEventListener("abort", cancel);
  }
}
