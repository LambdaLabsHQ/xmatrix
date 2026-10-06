import { PostgresRegistrationRebornRepository, PostgresSpacePlacementDirectory, WAKE_FAILED_SQL,
  type AuthorityDatabase } from "@xmatrix/db";
import { rebornFailureReason } from "@xmatrix/protocol";
import type { QueryResultRow } from "pg";
import { ControlError } from "@xmatrix/db";
import type { HubAuthorityEnv } from "./postgres-authority-fleet";
import { machineCommandStatus, machineDaemonCommand, machineRepository } from "./machines";
import { retryablePostgresFailure } from "./postgres-error-classification";
import { dispatchProductAgentSystemNotice } from "./product-agent-mention-authority-adapter";

interface RebornRow extends QueryResultRow {
  intent_id: string; space_id: string; channel_id: string; actor_user_id: string;
  owner_user_id: string; source_run_id: string; source_instance_id: string;
  machine_id: string; hostname: string | null; stop_control_id: string;
  stop_required: boolean; stop_payload_json: Record<string, unknown>;
  state: string; lease_owner: string; successor_run_id: string; spawn_payload_json: Record<string, unknown>;
  run_input_json?: Record<string, unknown>;
  error_code: string | null;
  error_detail?: string | null;
  /** `wake` answers no message (docs/instance-sleep.md §3); NULL predates the column. */
  kind?: "reborn" | "handoff" | "wake" | null;
}
export interface RebornReconcilePort {
  stop(row: RebornRow): Promise<unknown>;
  status(row: RebornRow): Promise<Record<string, unknown>>;
  spawn(row: RebornRow): Promise<unknown>;
  spawnStatus(row: RebornRow): Promise<Record<string, unknown>>;
  advance(row: RebornRow): Promise<Record<string, unknown>>;
  notifyFailure(row: RebornRow, body: string): Promise<void>;
}

const REBORN_FAILURE_DETAIL_LIMIT = 1000;

/** What a failed step said about itself, bounded for its notice. */
function failureDetail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const detail = value.replace(/\s+/gu, " ").trim();
  return detail ? detail.slice(0, REBORN_FAILURE_DETAIL_LIMIT) : null;
}

export function rebornFailureNotice(code: string, detail?: string | null): string {
  const failure = rebornFailureReason(code);
  const reason = failureDetail(detail);
  return `Reborn failed [${failure.code}]. ${failure.reason} ` +
    (reason ? `Reason: ${reason} ` : "") +
    "Check the original Instance and permissions before retrying. This request was not completed successfully.";
}

/** The message that asked for this reborn, so its failure answers it there. */
export function rebornRequestMessageId(row: Pick<RebornRow, "run_input_json">): string | undefined {
  const source = row.run_input_json?.invocationSource;
  const id = source && typeof source === "object" && !Array.isArray(source)
    ? (source as Record<string, unknown>).sourceMessageId : undefined;
  return typeof id === "string" && id.trim() ? id : undefined;
}

const UNDELIVERABLE_NOTICE_CODES = new Set(["channel_not_found", "forbidden"]);

/** Postgres refusing a statement as malformed or mistyped (SQLSTATE classes 22
 * and 42) refuses it the same way on every retry. Deferring it retried a
 * same-machine handoff every 5 seconds until it expired, while the Channel had
 * been told the work was already handed on. */
function permanentSqlState(code: string): boolean {
  return /^(?:22|42)[0-9A-Z]{3}$/u.test(code);
}

function errorCodeOf(error: unknown): string {
  return error instanceof Error && "code" in error ? String(error.code) : "reborn_retry";
}

/** The stored reason a wake failed: its code, then what the failing step said. */
export function wakeFailureReason(row: Pick<RebornRow, "error_code" | "error_detail">): string {
  const code = rebornFailureReason(row.error_code ?? "reborn_failed").code;
  const detail = failureDetail(row.error_detail);
  return (detail ? `${code}: ${detail}` : code).slice(0, 200);
}

/** A failed wake is its Instance's state, shown where the Instance is shown;
 * no message asked for it, so none answers it. */
async function settleWakeFailure(database: AuthorityDatabase, row: RebornRow): Promise<void> {
  await database.transaction({ requestId: `wake-failed:${row.intent_id}`, operation: "wake.failed" }, async tx => {
    await tx.query({ name: "wake_failure_instance_v1", text: WAKE_FAILED_SQL,
      values: [row.source_instance_id, wakeFailureReason(row), new Date().toISOString(),
        row.channel_id], maxRows: 1 });
    await tx.query({ name: "reborn_failure_notified_v1", text: REBORN_FAILURE_NOTIFIED_SQL,
      values: [row.intent_id, row.lease_owner], maxRows: 0 });
  });
}

/** A failed reborn or handoff answers the message that asked for it. */
async function settleRebornFailure(database: AuthorityDatabase, row: RebornRow,
  step: <T>(operation: () => Promise<T>) => Promise<T>, port: RebornReconcilePort): Promise<void> {
  try {
    await step(() => port.notifyFailure(row,
      rebornFailureNotice(row.error_code ?? "reborn_failed", row.error_detail)));
  } catch (error) {
    // No retry can post into an archived, deleted or forbidden Channel.
    // Retrying it every round kept the global Launch coordinator busy.
    if (!UNDELIVERABLE_NOTICE_CODES.has(errorCodeOf(error))) throw error;
    console.warn("Reborn failure notice undeliverable", { intentId: row.intent_id, code: errorCodeOf(error) });
  }
  await database.transaction({ requestId: `reborn-notified:${row.intent_id}`, operation: "reborn.notified" },
    async tx => {
      await tx.query({ name: "reborn_failure_notified_v1", text: REBORN_FAILURE_NOTIFIED_SQL,
        values: [row.intent_id, row.lease_owner], maxRows: 0 });
      // An explicit reborn of a resting Instance that failed leaves it resting
      // no longer: its notice already said why.
      await tx.query({ name: "reborn_failure_rest_retire_v1", text: `UPDATE data.instances
        SET rest_state=NULL,version=version+1,updated_at=GREATEST(updated_at,clock_timestamp())
        WHERE instance_id=$1 AND status='offline' AND rest_state IN ('sleeping','interrupted')`,
      values: [row.source_instance_id], maxRows: 0 });
    });
}

const REBORN_FAILURE_NOTIFIED_SQL = `UPDATE data.agent_reborn_intents
  SET failure_notified_at=clock_timestamp(),lease_until=NULL,lease_owner=NULL
  WHERE intent_id=$1 AND state='failed' AND lease_owner=$2`;

/** A lease bounds duplicate coordination; exact command ids and DB fences own safety. */
export async function reconcileRebornWithPort(database: AuthorityDatabase, shardId: string,
  port: RebornReconcilePort, channelId: string): Promise<number> {
  const leaseOwner = `reborn:${crypto.randomUUID()}`;
  const rows = await database.transaction({ requestId: `reborn-claim:${shardId}`, operation: "reborn.claim" },
    async tx => {
      await tx.query({ name: "reborn_expire_v2", text: `UPDATE data.agent_reborn_intents SET
        state='failed',error_code='reborn_expired',updated_at=clock_timestamp(),lease_until=NULL,lease_owner=NULL
        WHERE intent_id IN (SELECT intent_id FROM data.agent_reborn_intents
          WHERE channel_id=$1 AND state IN ('waiting','prepared') AND expires_at<=clock_timestamp()
          ORDER BY next_attempt_at,intent_id LIMIT 20 FOR UPDATE SKIP LOCKED)`, values: [channelId], maxRows: 0 });
      return tx.query<RebornRow>({ name: "reborn_claim_v2", text: `WITH due AS (
        SELECT intent_id FROM data.agent_reborn_intents WHERE channel_id=$2 AND
          ((state IN ('waiting','prepared') AND expires_at>clock_timestamp()) OR
            (state='failed' AND failure_notified_at IS NULL))
          AND next_attempt_at<=clock_timestamp()
          AND (lease_until IS NULL OR lease_until<clock_timestamp())
        ORDER BY next_attempt_at,intent_id LIMIT 5 FOR UPDATE SKIP LOCKED)
        UPDATE data.agent_reborn_intents intent SET lease_until=clock_timestamp()+interval '30 seconds',lease_owner=$1,
          next_attempt_at=clock_timestamp()+interval '5 seconds'
        FROM due WHERE intent.intent_id=due.intent_id RETURNING intent.*`, values: [leaseOwner, channelId], maxRows: 5 });
    });
  await Promise.all(rows.map(async row => {
    let errorCode: string | null = null;
    let errorDetail: string | null = null;
    const deadline = Date.now() + 20_000;
    const step = async <T>(operation: () => Promise<T>): Promise<T> => {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error("Reborn reconciliation budget exhausted");
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([operation(), new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("Reborn reconciliation timed out")), remaining);
        })]);
      } finally { if (timer !== undefined) clearTimeout(timer); }
    };
    /** A daemon command or status read: a definite rejection fails the intent as
     * `rejected`; an outage leaves it for the next round. */
    const daemonStep = async <T>(operation: () => Promise<T>, rejected: string): Promise<T | undefined> => {
      try {
        return await step(operation);
      } catch (error) {
        if (error instanceof ControlError && error.status >= 400 && error.status < 500 && error.status !== 429) {
          errorCode = rejected;
          errorDetail = failureDetail(`${error.code}: ${error.message}`);
          return undefined;
        }
        if (error instanceof ControlError || retryablePostgresFailure(error)) return undefined;
        throw error;
      }
    };
    try {
      if (row.state === "failed") {
        if (row.kind === "wake") await settleWakeFailure(database, row);
        else await settleRebornFailure(database, row, step, port);
        return;
      }
      let current = await step(() => port.advance(row));
      if (current.state === "waiting" && row.stop_required) {
        if (await daemonStep(() => port.stop(row), "reborn_stop_rejected") === undefined) return;
        const status = await daemonStep(() => port.status(row), "reborn_stop_status_rejected");
        if (!status) return;
        if (status.status === "failed") { errorCode = "reborn_stop_failed"; return; }
        if (status.status !== "completed") return;
        current = await step(() => port.advance(row));
      }
      if (current.state !== "prepared") return;
      // A registered successor's binding (allocation, environment revision) is
      // only complete once advance reserved it; spawn exactly that payload.
      const spawnRow = current.spawnPayload && typeof current.spawnPayload === "object"
        ? { ...row, spawn_payload_json: current.spawnPayload as Record<string, unknown> } : row;
      if (await daemonStep(() => port.spawn(spawnRow), "reborn_spawn_rejected") === undefined) return;
      const spawned = await daemonStep(() => port.spawnStatus(spawnRow), "reborn_spawn_status_rejected");
      if (!spawned) return;
      const status = spawned as { status?: unknown; result?: { ok?: boolean; error?: unknown } };
      if (status.status === "failed" || status.status === "completed" && status.result?.ok !== true) {
        errorCode = "reborn_spawn_failed";
        errorDetail = failureDetail(status.result?.error);
      } else if (status.status === "completed" && status.result?.ok === true) {
        await database.transaction({ requestId: `reborn-complete:${row.intent_id}`, operation: "reborn.complete" },
          tx => tx.query({ name: "reborn_complete_v1", text: `UPDATE data.agent_reborn_intents
            SET state='spawned',updated_at=clock_timestamp(),lease_until=NULL,lease_owner=NULL
            WHERE intent_id=$1 AND state='prepared' AND lease_owner=$2`, values: [row.intent_id, row.lease_owner], maxRows: 0 }));
      }
    } catch (error) {
      const code = errorCodeOf(error);
      if (row.state !== "failed" && ["reborn_source_changed", "reborn_source_fenced", "reborn_expired", "forbidden", "not_found", "channel_not_found", "invalid_runtime_request"].includes(code)) {
        errorCode = code;
      } else if (row.state !== "failed" && permanentSqlState(code)) {
        errorCode = "reborn_internal_error";
        errorDetail = `PostgreSQL ${code}`;
      }
      console.warn("Reborn continuation deferred", { intentId: row.intent_id, code });
    } finally {
      await database.transaction({ requestId: `reborn-settle:${row.intent_id}`, operation: "reborn.settle" },
        tx => tx.query({ name: "reborn_defer_v1", text: `UPDATE data.agent_reborn_intents SET
          state=CASE WHEN $2::text IS NULL THEN state ELSE 'failed' END,error_code=COALESCE($2,error_code),
          error_detail=CASE WHEN $2::text IS NULL THEN error_detail ELSE $4 END,
          lease_until=NULL,lease_owner=NULL,next_attempt_at=clock_timestamp()+interval '5 seconds',updated_at=clock_timestamp()
          WHERE intent_id=$1 AND state IN ('waiting','prepared','failed') AND lease_owner=$3`,
        values: [row.intent_id, errorCode, row.lease_owner, errorDetail], maxRows: 0 }));
    }
  }));
  return rows.length;
}

/** The read of the exact stop this intent issued. A reborn's stop keeps the
 * Instance; a handoff's retires it and carries no `preserveInstanceForReborn`,
 * so the authority must expect what this intent stored, not always a reborn. */
export function continuationStopStatusQuery(row: { stop_control_id: string; source_run_id: string;
  source_instance_id: string; owner_user_id: string; machine_id: string; hostname: string | null;
  stop_payload_json: Record<string, unknown> }) {
  return {
    controlId: row.stop_control_id, runId: row.source_run_id, instanceId: row.source_instance_id,
    ownerUserId: row.owner_user_id, machineId: row.machine_id, hostId: row.hostname ?? "",
    preserveInstanceForReborn: row.stop_payload_json.preserveInstanceForReborn === true,
  };
}

export async function reconcileReborn(database: AuthorityDatabase, shardId: string,
  env: HubAuthorityEnv, directory: AuthorityDatabase | undefined, channelId: string): Promise<number> {
  const machines = machineRepository(env);
  return reconcileRebornWithPort(database, shardId, {
    notifyFailure: async (row, body) => {
      const notice = { env, actorUserId: row.actor_user_id, channelId: row.channel_id,
        sourceMessageId: `reborn-failure:${row.intent_id}`, body,
        metadata: { rebornIntentId: row.intent_id, rebornInstanceId: row.source_instance_id,
          rebornErrorCode: row.error_code } };
      const replyToMessageId = rebornRequestMessageId(row);
      try {
        await dispatchProductAgentSystemNotice({ ...notice, ...(replyToMessageId ? { replyToMessageId } : {}) });
      } catch (error) {
        // The asking message may have been deleted since; the notice still lands.
        if (!replyToMessageId || errorCodeOf(error) !== "invalid_reply_target") throw error;
        await dispatchProductAgentSystemNotice(notice);
      }
    },
    stop: row => machineDaemonCommand(env, {
      commandId: `reborn-stop:${row.stop_control_id}`, action: "issue", controlId: row.stop_control_id,
      commandType: "stop", ownerUserId: row.owner_user_id,
      ownerEmail: `${row.owner_user_id.replace(/[^a-zA-Z0-9._-]/gu, "_")}@unknown.invalid`,
      machineId: row.machine_id, hostId: row.hostname ?? "", metadata: {}, capabilities: [],
      payload: row.stop_payload_json, principal: { kind: "user", id: row.owner_user_id },
    }),
    status: row => machineCommandStatus(machines, "rebornStop", continuationStopStatusQuery(row)),
    spawn: row => machineDaemonCommand(env, {
      commandId: `reborn-spawn:${row.successor_run_id}`, action: "issue",
      controlId: row.spawn_payload_json.requestId, commandType: "spawn", ownerUserId: row.owner_user_id,
      ownerEmail: `${row.owner_user_id.replace(/[^a-zA-Z0-9._-]/gu, "_")}@unknown.invalid`,
      machineId: row.machine_id, hostId: row.hostname ?? "", metadata: {}, capabilities: [],
      payload: row.spawn_payload_json, principal: { kind: "user", id: row.owner_user_id },
    }),
    spawnStatus: row => machineCommandStatus(machines, "spawn", {
      controlId: String(row.spawn_payload_json.requestId), runId: row.successor_run_id,
      // A reborn keeps the predecessor's Instance; a handoff spawns a new one.
      instanceId: row.spawn_payload_json.instanceId, executionKey: row.spawn_payload_json.executionKey,
      ownerUserId: row.owner_user_id, machineId: row.machine_id, hostId: row.hostname ?? "",
    }),
    advance: async row => {
      // Every successor is a registration Run: its allocation and binding are
      // reserved through the registration authority.
      if (!directory) throw new Error("Continuation needs the registration directory");
      const placement = await new PostgresSpacePlacementDirectory(directory).resolve(
        { requestId: `reborn-placement:${row.intent_id}`, operation: "registration.reborn.placement" }, row.space_id);
      return new PostgresRegistrationRebornRepository(database, directory, { spaceId: placement.spaceId,
        shardId: placement.shardId, placementEpoch: placement.placementEpoch })
        .advance({ intentId: row.intent_id, actorUserId: row.actor_user_id, channelId: row.channel_id });
    },
  }, channelId);
}
