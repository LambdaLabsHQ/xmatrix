import { registrationKeyFromRow } from "./agent-registration-rows.js";
import type { QueryResultRow } from "pg";
import type { AgentRegistrationKey, SpaceAgentRegistrationKey } from "@xmatrix/protocol";
import type { AuthorityDatabase, DatabaseTransaction } from "./contracts.js";
import { channelCapabilityPredicate } from "./channel-capability-policy.js";
import { requireRunRegistrationAccess } from "./agent-registration-run.js";
import { RegistrationAccessError } from "./agent-registration-errors.js";
import { commitRuntime } from "./runtime-control.js";
import { ACTIVE_RUN_STATUS_SQL, isTerminalRunStatus, TERMINAL_RUN_STATUS_SQL } from "@xmatrix/protocol";

export interface RegistrationStopIntent {
  runId: string; instanceId: string; channelId: string; key: SpaceAgentRegistrationKey;
  hostId: string; executionKey: string; allocationId: string; controlId: string;
  generation: number; leaseOwner: string;
}

function intent(row: QueryResultRow): RegistrationStopIntent {
  return { runId: String(row.run_id), instanceId: String(row.instance_id), channelId: String(row.channel_id),
    key: { spaceId: String(row.space_id), ownerUserId: String(row.owner_user_id), machineId: String(row.machine_id), harness: String(row.harness) },
    hostId: typeof row.hostname === "string" ? row.hostname : "", executionKey: String(row.execution_key), allocationId: String(row.allocation_id),
    controlId: String(row.control_id), generation: Number(row.generation), leaseOwner: String(row.lease_owner) };
}

/** Marks a stop parked on its host; see `settle`. */
const PARKED = "registration_stop_parked";

// Shared by discovery and ledger completion; discovery is always rechecked
// through requireRunRegistrationAccess before creating physical control.
const withdrawnExecution = `(a.grant_state IS DISTINCT FROM 'active'
            OR COALESCE(a.grant_execution_revision,a.grant_revision)<>b.grant_execution_revision
            OR COALESCE(a.policy_execution_revision,a.policy_revision)<>b.policy_execution_revision
            OR NOT EXISTS (SELECT 1 FROM data.space_members m WHERE m.space_id=b.space_id AND m.user_id=b.owner_user_id)
            OR NOT (${channelCapabilityPredicate({ capability: "runtime_continue", channelAlias: "c",
              principalKindSql: "'user'", principalIdSql: "b.actor_user_id" })})
            OR (r.status='starting' AND (a.grant_revision<>b.grant_revision
              OR a.policy_revision<>b.policy_revision)))`;

/** Internal shard coordinator. There is no public command that accepts a
 * caller-authored stop target or permission-withdrawal decision. */
export class PostgresRegistrationRevocationRepository {
  constructor(private readonly database: AuthorityDatabase) {
    if (database.cacheMode !== "disabled") throw new RegistrationAccessError("cached_authority_forbidden", 500);
  }

  /** The registrations this Channel's unfinished Runs execute under, so the
   * coordinator can read their machine environments from the directory. */
  async activeRegistrations(channelId: string): Promise<AgentRegistrationKey[]> {
    const rows = await this.database.transaction({ requestId: `registration-active:${crypto.randomUUID()}`,
      operation: "registration.revocation.active" }, tx => tx.query({ name: "registration_revocation_active_keys_v1",
      text: `SELECT DISTINCT b.owner_user_id,b.machine_id,b.harness FROM data.run_agent_registrations b
        JOIN data.runs r ON r.run_id=b.run_id AND r.owner_user_id=b.owner_user_id
        WHERE r.channel_id=$1 AND r.status IN (${ACTIVE_RUN_STATUS_SQL})
          AND NOT EXISTS (SELECT 1 FROM data.registration_stop_intents s WHERE s.run_id=r.run_id)
        ORDER BY b.owner_user_id,b.machine_id,b.harness LIMIT 50`, values: [channelId], maxRows: 50 }));
    return rows.map(registrationKeyFromRow);
  }

  /** Re-evaluate one Channel's registration Runs against current authority:
   * a withdrawn or ended execution gets its stop intent and fence. Run by the
   * Channel's coordinator when an authority change or a Run ending wakes it.
   * `disabled` are registrations whose owner turned them off on their machine,
   * read by the caller from the directory; their Runs stop in every Space. */
  async prepare(channelId: string, disabled: readonly AgentRegistrationKey[] = []): Promise<number> {
    const disabledJson = JSON.stringify(disabled.map(key => ({ owner: key.ownerUserId, machine: key.machineId,
      harness: key.harness })));
    const isDisabled = (row: QueryResultRow) => disabled.some(key => key.ownerUserId === String(row.owner_user_id) &&
      key.machineId === String(row.machine_id) && key.harness === String(row.harness));
    const batch = await this.database.transaction({ requestId: `registration-revoke:${crypto.randomUUID()}`,
      operation: "registration.revocation.prepare" }, async tx => {
      const candidates = await tx.query({ name: "registration_revocation_candidates_v5", text: `SELECT
        r.run_id,r.channel_id,r.owner_user_id,r.status,r.version,r.metadata_json,COALESCE(i.instance_id,l.instance_id) AS instance_id,
        b.space_id,b.machine_id,b.harness,b.allocation_id
        FROM data.run_agent_registrations b JOIN data.runs r ON r.run_id=b.run_id AND r.owner_user_id=b.owner_user_id
        LEFT JOIN data.instances i ON i.run_id=r.run_id AND i.channel_id=r.channel_id
        LEFT JOIN data.agent_launches l ON l.run_id=r.run_id AND l.channel_id=r.channel_id
        JOIN data.channels c ON c.channel_id=r.channel_id AND c.space_id=b.space_id
        LEFT JOIN data.space_agent_registration_access a ON a.space_id=b.space_id AND a.owner_user_id=b.owner_user_id
          AND a.machine_id=b.machine_id AND a.harness=b.harness
        WHERE r.channel_id=$1
          AND COALESCE(i.instance_id,l.instance_id) IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM data.registration_stop_intents s WHERE s.run_id=r.run_id)
          AND (r.status IN (${TERMINAL_RUN_STATUS_SQL}) OR ${withdrawnExecution}
            OR EXISTS (SELECT 1 FROM jsonb_to_recordset($2::jsonb) AS off(owner text,machine text,harness text)
              WHERE off.owner=b.owner_user_id AND off.machine=b.machine_id AND off.harness=b.harness))
        ORDER BY CASE WHEN length(r.metadata_json->>'executionKey') BETWEEN 1 AND 300 THEN 0 ELSE 1 END,
          r.updated_at,r.run_id LIMIT 10 FOR UPDATE OF r SKIP LOCKED`, values: [channelId, disabledJson], maxRows: 10 });
      let prepared = 0, incomplete = false;
      for (const row of candidates) {
        let reason = "registration_run_terminal";
        const terminal = isTerminalRunStatus(row.status);
        try {
          if (terminal) throw new RegistrationAccessError(reason, 403);
          if (isDisabled(row)) throw new RegistrationAccessError("registration_environment_disabled", 403);
          await requireRunRegistrationAccess(tx, { runId: String(row.run_id), channelId: String(row.channel_id),
            phase: row.status === "starting" ? "admission" : "continuation",
            error: (code, status) => new RegistrationAccessError(code, status) });
          continue; // The prefilter is not authorization; current authority won.
        } catch (error) {
          if (!(error instanceof RegistrationAccessError) ||
              ![403,404].includes(error.status)) throw error;
          reason = error.code;
        }
        const metadata = row.metadata_json as Record<string, unknown> | null;
        const observation = metadata?.hostname ?? metadata?.hostId;
        const hostId = typeof observation === "string" && observation.trim() && observation.length <= 160
          ? observation : null;
        const executionKey = metadata?.executionKey;
        if (typeof executionKey !== "string" || !executionKey.trim() || executionKey.length > 300 ||
            row.owner_user_id === null) {
          incomplete = true;
          continue; // Missing evidence cannot authorize a guessed physical target.
        }
        const controlId = `registration-stop:${crypto.randomUUID()}`;
        await tx.query({ name: "registration_revocation_intent_v1", text: `INSERT INTO data.registration_stop_intents
          (run_id,space_id,owner_user_id,machine_id,harness,instance_id,channel_id,hostname,execution_key,allocation_id,reason_code,control_id)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, values: [row.run_id,row.space_id,row.owner_user_id,
          row.machine_id,row.harness,row.instance_id,row.channel_id,hostId,executionKey,row.allocation_id,reason,controlId], maxRows: 0 });
        await tx.query({ name: "registration_revocation_fence_v1", text: `WITH cancelled AS (
          UPDATE data.agent_launches SET state='cancelled',retryable=FALSE,lease_owner=NULL,lease_until=NULL,
            version=version+1,updated_at=clock_timestamp(),finished_at=clock_timestamp()
          WHERE run_id=$1 AND state IN ('prepared','queued','admitted','spawned') RETURNING launch_id
        ) UPDATE data.runs SET status='stopping',version=version+1,updated_at=clock_timestamp()
          WHERE run_id=$1 AND status IN (${ACTIVE_RUN_STATUS_SQL})`, values: [row.run_id], maxRows: 0 });
        if (!terminal) await commitRuntime(tx, String(row.space_id), { commandId: controlId, kind: "run_transition",
          entityId: row.run_id, entityVersion: Number(row.version)+1, status: "stopping", reason }, new Date().toISOString());
        prepared++;
      }
      return { prepared, incomplete };
    });
    if (batch.incomplete) throw new RegistrationAccessError("registration_run_target_missing", 503);
    return batch.prepared;
  }

  /** Complete the ledger entries this Channel's settled executions close. */
  async completeChanges(channelId: string): Promise<number> {
    return this.database.transaction({ requestId: `registration-changes:${crypto.randomUUID()}`,
      operation: "registration.revocation.complete-changes" }, tx => completeRegistrationAccessChanges(tx, { channelId }));
  }

  /** Due stops, plus — when the Channel was just woken — stops parked on a
   * host that had not picked up their command. The wake is the event that
   * can have changed them (a terminal report, a reconnect), so parked stops
   * cost nothing until one arrives. */
  async claim(channelId: string, includeParked = false): Promise<RegistrationStopIntent[]> {
    const leaseOwner = `registration-stop-worker:${crypto.randomUUID()}`;
    return this.database.transaction({ requestId: leaseOwner, operation: "registration.revocation.claim" }, async tx => {
      const rows = await tx.query({ name: "registration_revocation_claim_v3", text: `WITH due AS (
        SELECT run_id FROM data.registration_stop_intents WHERE channel_id=$2 AND state='pending'
          AND (next_attempt_at<=clock_timestamp() OR ($3::boolean AND last_error_code='${PARKED}'))
          AND (lease_until IS NULL OR lease_until<clock_timestamp()) ORDER BY next_attempt_at,run_id LIMIT 5 FOR UPDATE SKIP LOCKED
      ) UPDATE data.registration_stop_intents s SET lease_owner=$1,lease_until=clock_timestamp()+interval '30 seconds',
        next_attempt_at=clock_timestamp()+interval '10 seconds' FROM due WHERE s.run_id=due.run_id RETURNING s.*`,
      values: [leaseOwner, channelId, includeParked], maxRows: 5 });
      return rows.map(intent);
    });
  }

  /** Missing/expired/failed command evidence may replace its delivery attempt,
   * never the exact Run target. Silence never completes a stop.
   *
   * A stop whose command waits on its host is parked: its next look is an
   * hour away unless a wake of its Channel claims it sooner (see `claim`).
   * Any other deferred stop backs off with its age: a tenth of the time it has
   * been pending, between 10 seconds and an hour, so a stop deferred for its
   * first hour retries as before. A fixed 10-second retry kept every stop for
   * an offline host cycling through the shared connection pool, and enough of
   * them starved user requests of connections; a 5-minute ceiling still kept
   * every Channel holding a days-old deferred stop running a full coordinator
   * pass several times an hour. */
  async settle(input: { intent: RegistrationStopIntent; completed?: boolean; replaceCommand?: boolean;
    parked?: boolean; errorCode?: string }) {
    const row = input.intent;
    if (input.completed && input.replaceCommand) throw new RegistrationAccessError("invalid_stop_settlement", 400);
    await this.database.transaction({ requestId: row.leaseOwner, operation: "registration.revocation.settle" }, tx => tx.query({
      name: "registration_revocation_settle_v3", text: `UPDATE data.registration_stop_intents SET
        state=CASE WHEN $4 THEN 'completed' ELSE 'pending' END,completed_at=CASE WHEN $4 THEN clock_timestamp() ELSE NULL END,
        control_id=CASE WHEN $5 THEN $6 ELSE control_id END,generation=generation+CASE WHEN $5 THEN 1 ELSE 0 END,
        lease_owner=NULL,lease_until=NULL,next_attempt_at=clock_timestamp()+CASE WHEN $8::boolean THEN interval '1 hour'
          ELSE LEAST(interval '1 hour',GREATEST(interval '10 seconds',(clock_timestamp()-created_at)/10)) END,
        last_error_code=CASE WHEN $8::boolean THEN '${PARKED}' ELSE $7 END
        WHERE run_id=$1 AND lease_owner=$2 AND generation=$3 AND state='pending'`,
      values: [row.runId,row.leaseOwner,row.generation,input.completed===true,input.replaceCommand===true,
        `registration-stop:${crypto.randomUUID()}`,input.errorCode?.slice(0,100) ?? null,
        input.parked === true && !input.completed && !input.replaceCommand], maxRows: 0 }));
  }
}

/** Complete only bounded ledger entries whose affected executions have all
 * settled — for one Channel's registrations, or for one registration key as
 * its change is recorded. Pending physical stops always keep the corresponding ledger entry open. */
export async function completeRegistrationAccessChanges(tx: DatabaseTransaction,
  scope: { channelId: string } | { key: SpaceAgentRegistrationKey }): Promise<number> {
  const byChannel = "channelId" in scope;
  const scopeSql = byChannel
    ? `EXISTS (SELECT 1 FROM data.run_agent_registrations touched JOIN data.runs touched_run ON touched_run.run_id=touched.run_id
            WHERE touched_run.channel_id=$1 AND touched.space_id=d.space_id AND touched.owner_user_id=d.owner_user_id
              AND touched.machine_id=d.machine_id AND touched.harness=d.harness)`
    : `d.space_id=$1 AND d.owner_user_id=$2 AND d.machine_id=$3 AND d.harness=$4`;
  const rows = await tx.query({ name: byChannel ? "registration_revocation_changes_complete_channel_v2"
    : "registration_revocation_changes_complete_key_v2", text: `WITH settled AS (
        SELECT d.space_id,d.owner_user_id,d.machine_id,d.harness,d.authority,d.revision
        FROM data.registration_access_changes d
        WHERE d.reconcile_state='pending'
          AND ${scopeSql}
          AND NOT EXISTS (SELECT 1 FROM data.registration_stop_intents s
            WHERE s.space_id=d.space_id AND s.owner_user_id=d.owner_user_id
              AND s.machine_id=d.machine_id AND s.harness=d.harness AND s.state='pending')
          AND NOT EXISTS (SELECT 1 FROM data.run_agent_registrations b
            JOIN data.runs r ON r.run_id=b.run_id
            JOIN data.channels c ON c.channel_id=r.channel_id AND c.space_id=b.space_id
            LEFT JOIN data.space_agent_registration_access a ON a.space_id=b.space_id
              AND a.owner_user_id=b.owner_user_id AND a.machine_id=b.machine_id AND a.harness=b.harness
            WHERE b.space_id=d.space_id AND b.owner_user_id=d.owner_user_id
              AND b.machine_id=d.machine_id AND b.harness=d.harness
              AND ((r.status IN (${ACTIVE_RUN_STATUS_SQL}) AND ${withdrawnExecution})
                OR (r.status IN (${TERMINAL_RUN_STATUS_SQL}) AND NOT EXISTS (
                  SELECT 1 FROM data.registration_stop_intents done WHERE done.run_id=r.run_id AND done.state='completed'))))
        ORDER BY d.created_at,d.space_id,d.owner_user_id,d.machine_id,d.harness,d.authority,d.revision
        LIMIT 20 FOR UPDATE OF d SKIP LOCKED
      ) UPDATE data.registration_access_changes d SET reconcile_state='completed' FROM settled s
        WHERE d.space_id=s.space_id AND d.owner_user_id=s.owner_user_id AND d.machine_id=s.machine_id
          AND d.harness=s.harness AND d.authority=s.authority AND d.revision=s.revision RETURNING d.revision`,
  values: byChannel ? [scope.channelId] : [scope.key.spaceId, scope.key.ownerUserId, scope.key.machineId, scope.key.harness],
  maxRows: 20 });
  return rows.length;
}
