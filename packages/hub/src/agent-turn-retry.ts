import { dispatchProductMessageAppend } from "./product-message-append";
import { RuntimeAuthorityOperationError } from "./runtime-transport/runtime-operation-failure";
import type { AuthorityDatabase, DatabaseTransaction } from "@xmatrix/db";
import type { QueryResultRow } from "pg";
import type { AgentInstanceServerMessage, AgentInstanceTurnRetryMessage, ChannelTurnRetry } from "@xmatrix/protocol/connections/agent-instance";
import type { AgentInstanceRuntimeSession } from "./runtime-transport/agent-instance-port";
import type { Env } from "./types";
import { runtimeRepository } from "./runtime";
import { wakeAgentLaunchCoordinator } from "./agent-launch-coordinator-wake";
import { runtimeMessages, runtimeCommandId } from "./runtime-transport/runtime-messages";
import { productAgentSystemNoticeSenderSnapshot } from "./product-agent-mention-authority-adapter";
import { relayRuntimeCellsForOwners } from "./relay-authority-locator";
import { advanceTurnRetry, parseHubTurnRetry, turnRetryNotice, CAPACITY_CONTINUATION,
  TURN_RETRY_DELIVERY_RECHECK_MS, TURN_RETRY_ERROR_MAX_CHARS, TURN_RETRY_RUNTIME_PATH, type HubTurnRetry } from "./agent-turn-retry-policy";

export type RetryDecision = Extract<AgentInstanceServerMessage, { type: "agent_turn_retry_decision" }>;
const active = (r: HubTurnRetry) => r.state === "waiting" || r.state === "issued";

function reportIsValid(value: AgentInstanceTurnRetryMessage): boolean {
  const id = (v: unknown) => typeof v === "string" && /^[a-zA-Z0-9_-]{1,160}$/.test(v);
  return id(value.requestId) && id(value.operationId) &&
    ["failed", "completed", "cancelled"].includes(value.action) &&
    (value.action !== "failed" || id(value.threadId) && id(value.turnId) && typeof value.safeToContinue === "boolean" &&
      typeof value.errorMessage === "string" && value.errorMessage.length > 0 && value.errorMessage.length <= TURN_RETRY_ERROR_MAX_CHARS) &&
    (value.attemptToken === undefined || id(value.attemptToken));
}

async function save(tx: DatabaseTransaction, runId: string, state: HubTurnRetry, at: number | null): Promise<void> {
  await tx.query({ name: "runtime_capacity_retry_save_v1", text: `UPDATE data.runs
    SET capacity_retry_json=$2::jsonb,capacity_retry_at=$3::timestamptz WHERE run_id=$1`,
    values: [runId, JSON.stringify(state), at === null ? null : new Date(at).toISOString()], maxRows: 0 });
}

function decision(r: HubTurnRetry): RetryDecision {
  return { type: "agent_turn_retry_decision", requestId: r.requestId, operationId: r.operationId,
    threadId: r.threadId, turnId: r.turnId, attemptToken: r.attemptToken,
    action: "stop", reason: r.state };
}

/** Authenticated reports reach this owning authority; the host never supplies
 * an attempt number, delay, model replacement or continuation input. */
export async function reportAgentTurnRetry(env: Env, session: Readonly<AgentInstanceRuntimeSession>,
  report: AgentInstanceTurnRetryMessage): Promise<RetryDecision | undefined> {
  if (!reportIsValid(report)) throw new Error("Invalid model-capacity retry report");
  if (report.action === "failed" && !session.clientCapabilities?.includes("agent_turn_retry_channel_message"))
    return { type: "agent_turn_retry_decision", requestId: report.requestId!, operationId: report.operationId,
      threadId: report.threadId!, turnId: report.turnId!, attemptToken: "none", action: "stop", reason: "unsupported" };
  const now = Date.now();
  const state = await runtimeRepository(env).capacityRetryTransaction({
    requestId: report.requestId!, actorUserId: session.principal.ownerUserId,
    runId: session.run.runId, channelId: session.run.channelId,
    instanceId: session.run.instanceId, executionKey: session.principal.executionKey,
    operationId: report.operationId, terminalRetryReport: report.action !== "failed",
  }, async (tx, run, mayContinue) => {
    const previous = parseHubTurnRetry(run.capacity_retry_json);
    if (run.capacity_retry_json !== null && run.capacity_retry_json !== undefined && !previous) throw new Error("Retry state is invalid");
    let next = advanceTurnRetry(previous, report, now, crypto.randomUUID());
    if (!next || next.operationId !== report.operationId) return;
    next = { ...next, agentLabel: previous?.operationId === next.operationId && previous.agentLabel
      ? previous.agentLabel : `${session.principal.agentName}${session.run.channelInstanceId ? `:${session.run.channelInstanceId}` : ""}` };
    if (!mayContinue && active(next)) next = { ...next, state: "cancelled", notice: "cancelled", dueAt: now };
    await save(tx, session.run.runId, next, next.notice ? now : active(next) ? next.dueAt : null);
    return next;
  });
  if (!state) return { type: "agent_turn_retry_decision", requestId: report.requestId!,
    operationId: report.operationId, threadId: "none", turnId: "none", attemptToken: "none", action: "stop", reason: "not_pending" };
  // Durable work is handed to its Channel before the report may acknowledge.
  await wakeAgentLaunchCoordinator(env, session.run.channelId, ["turnRetry"]);
  // An issued retry is replayed through its committed Channel message, never a private input.
  if (!active(state)) return { ...decision(state), requestId: report.requestId! };
}

async function deliver(env: Env, run: QueryResultRow, message: RetryDecision): Promise<void> {
  if (!run.instance_id) return;
  const cells = relayRuntimeCellsForOwners(env, [String(run.owner_user_id)]);
  await Promise.all(cells.map(async cell => {
    const response = await cell.fetch(`https://relay-runtime.internal${TURN_RETRY_RUNTIME_PATH}`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ runId: run.run_id, instanceId: run.instance_id,
        ownerUserId: run.owner_user_id, channelId: run.channel_id, message }),
    });
    if (!response.ok) throw new Error("Retry delivery is unavailable");
  }));
}

/** Bounded, Channel-local work. Alarm timers are projections; only this Run
 * row owns its attempt budget, terminal fence and replay identity. */
export async function reconcileAgentTurnRetries(env: Env, database: AuthorityDatabase, channelId: string): Promise<void> {
  const now = Date.now();
  const rows = await database.transaction({ requestId: crypto.randomUUID(), operation: "runtime.retry.due" }, tx =>
    tx.query<QueryResultRow>({ name: "runtime_capacity_retry_due_v1", text: `SELECT run_id,owner_user_id
      FROM data.runs WHERE channel_id=$1 AND capacity_retry_at<=clock_timestamp()
      ORDER BY capacity_retry_at,run_id LIMIT 100`, values: [channelId], maxRows: 100 }));
  for (const row of rows) {
    const result = await runtimeRepository(env, database).capacityRetryTransaction({
      requestId: crypto.randomUUID(), actorUserId: String(row.owner_user_id), runId: String(row.run_id), channelId,
    }, async (tx, run, mayContinue) => {
      let state = parseHubTurnRetry(run.capacity_retry_json);
      if (!state) {
        await tx.query({ name: "runtime_capacity_retry_invalid_fence_v1", text: `UPDATE data.runs SET capacity_retry_at=NULL WHERE run_id=$1`,
          values: [run.run_id], maxRows: 0 });
        return;
      }
      if (!mayContinue && active(state)) state = { ...state, state: "cancelled", notice: "cancelled" };
      else if (active(state) && now >= state.expiresAt) state = { ...state, state: "expired", notice: "expired" };
      else if (state.state === "waiting" && !state.notice && now >= state.dueAt)
        state = { ...state, state: "issued", notice: "" };
      // A terminal notice whose audience disappeared has a finite lifetime.
      // The final state still remains in the owning Run for diagnosis.
      if (!active(state) && now > state.expiresAt + 30_000) {
        await save(tx, String(run.run_id), { ...state, notice: "" }, null);
        return;
      }
      await save(tx, String(run.run_id), state, state.notice ? now + TURN_RETRY_DELIVERY_RECHECK_MS
        : active(state) ? Math.max(state.dueAt, now + TURN_RETRY_DELIVERY_RECHECK_MS) : null);
      return { run, state };
    });
    if (!result) continue;
    const { run, state } = result;
    if (state.notice) {
      const id = runtimeCommandId("capacity-retry", `${run.run_id}:${state.operationId}:${state.notice}`);
      await runtimeMessages(env).append({ commandId: runtimeCommandId("agent-append", id), messageId: id,
        channelId, body: turnRetryNotice(state), messageKind: "xmatrix.system.turn-retry", principal: { kind: "user", id: String(run.owner_user_id) },
        senderSnapshot: productAgentSystemNoticeSenderSnapshot(String(run.owner_user_id)),
        residual: { appMetadata: { xmatrixProvenance: "system_fact", xmatrixSystemNotice: true,
          xmatrixTurnRetry: { instanceId: String(run.instance_id), state: state.state, attempt: state.attempt } } },
      }, { actorUserId: String(run.owner_user_id) }).catch(error => {
        if (!(error instanceof RuntimeAuthorityOperationError) || !error.committedIdentityConflict) throw error;
      });
      await runtimeRepository(env, database).capacityRetryTransaction({
        requestId: crypto.randomUUID(), actorUserId: String(run.owner_user_id), runId: String(run.run_id), channelId,
      }, async (tx, latest) => {
        const current = parseHubTurnRetry(latest.capacity_retry_json);
        if (current?.operationId === state.operationId && current.notice === state.notice)
          await save(tx, String(run.run_id), { ...current, notice: "" }, current.state === "waiting" ? current.dueAt : active(current) ? now + TURN_RETRY_DELIVERY_RECHECK_MS : null);
      });
    }
    if (state.state === "issued") {
      const id = runtimeCommandId("capacity-retry-message", `${run.run_id}:${state.attemptToken}`);
      // The instruction itself is a durable Channel message. Reusing this
      // command republishes the exact committed message through normal fanout.
      // A commit/publication failure leaves the Run due for bounded recovery.
      const published = await dispatchProductMessageAppend(env, channelId, { commandId: runtimeCommandId("agent-append", id), messageId: id,
        // Display names are untrusted data, not executable continuation input.
        channelId, body: `${CAPACITY_CONTINUATION}\n\n${turnRetryNotice({ ...state, agentLabel: undefined })}`,
        messageKind: "xmatrix.capacity-retry", principal: { kind: "user", id: String(run.owner_user_id) },
        xmatrixAuthor: true,
        residual: { appMetadata: { xmatrixProvenance: "system_fact", xmatrixSystemNotice: true,
          xmatrixTurnRetry: { version: 1, state: "issued", attempt: state.attempt,
            runId: String(run.run_id), instanceId: String(run.instance_id), ownerUserId: String(run.owner_user_id),
            operationId: state.operationId, requestId: state.requestId, attemptToken: state.attemptToken,
            expiresAt: state.expiresAt } satisfies ChannelTurnRetry } },
      });
      if (!published.ok) throw new Error("Channel retry message commit is unavailable");
    }
    else if (!active(state)) await deliver(env, run, decision(state));
  }
}
