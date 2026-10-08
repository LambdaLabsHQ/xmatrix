import { reconcileReborn } from "./reborn-reconcile";
import { finalizeMachineRunTerminalReports } from "./machine-run-terminal-finalizer";
import { reconcileRegistrationRevocations } from "./registration-revocation-reconcile";
import { ControlError, reconcileRegistrationPreparationCancellations } from "@xmatrix/db";
import { cleanAgentRuntimeMessageSource, sha256Hex, TERMINAL_RUN_STATUS_SQL } from "@xmatrix/protocol";
import { withInitialMessageSource, PostgresChannelSpaceDirectory, PostgresEntitySpaceDirectory, type AuthorityDatabase,
  type EntitySpaceRouteMutation } from "@xmatrix/db";
import type { QueryResultRow } from "pg";

import { createPostgresAuthorityFleet, type HubAuthorityEnv } from "./postgres-authority-fleet";
import { isRecoverableLaunchFailure } from "./live-run-admission";
import { recordAgentLaunchCoordinator } from "./postgres-coordination-observability";
import { machineDaemonCommand, machineRepository } from "./machines";
import type { Env } from "./types";
import { channelAutomationDueAt, runChannelAutomation } from "./channel-automation-work";

const CLAIM_LIMIT = 100;
const MAX_CONCURRENCY = 8;
// Claim is already bounded to 100. Keeping the per-machine batch at the same
// bound guarantees one durable issue transaction and one reverse wake for all
// launches claimed for that physical daemon in this coordinator round.
const MACHINE_BATCH_LIMIT = CLAIM_LIMIT;
const BACKOFF_SECONDS = [1, 2, 5, 10, 30] as const;

export interface LaunchRow extends QueryResultRow {
  launch_id: string;
  channel_id: string;
  space_id: string;
  owner_user_id: string;
  run_id: string;
  instance_id: string;
  execution_key: string;
  control_id: string;
  machine_id: string;
  hostname: string | null;
  state: string;
  spawn_payload_json: Record<string, unknown>;
  attempt: number;
  run_version: number;
  /** Null for a background session, which has no Channel Instance to route. */
  instance_version: number | null;
  route_version: number;
  route_updated_at: string;
  placement_epoch: number;
  prepared_at: string | Date | null;
  wake_requested_at: string | Date | null;
  next_attempt_at: string | Date;
  oldest_eligible_at: string | Date | null;
  eligible_count: number;
  directory_published: boolean;
  command_durable_at: string | Date | null;
  connected_at?: string | Date | null;
}

export interface ClaimedAgentLaunch {
  shard: { shardId: string; database: AuthorityDatabase };
  row: LaunchRow;
}

export interface AgentLaunchPublicationPort {
  publishDirectory(mutations: readonly EntitySpaceRouteMutation[]): Promise<void>;
  issueBatch(rows: readonly LaunchRow[]): Promise<Record<string, unknown>>;
  readBatch(rows: readonly LaunchRow[]): Promise<Record<string, unknown>>;
  settle(database: AuthorityDatabase, shardId: string,
    settlements: readonly LaunchSettlement[]): Promise<void>;
}

export interface LaunchSettlement {
  row: LaunchRow;
  state: "queued" | "spawned" | "failed";
  retryable: boolean;
  daemonOffline: boolean;
  commandDurableAt?: string;
  spawnedAt?: string;
  errorStage?: string;
  errorCode?: string;
  errorMessage?: string;
  incrementAttempt?: boolean;
}

export interface AgentLaunchCoordinatorEnv extends HubAuthorityEnv {
  JEV_AI_GATEWAY_API_KEY?: string;
}

export interface AgentLaunchWakeTarget {
  channelId: string;
  /** The exact Launches a wake names; empty sweeps every due Launch of the Channel. */
  launchIds: readonly string[];
  /** Verified placement returned by the same prepare authority transaction. */
  shardId?: string;
}

/**
 * A launch this shard's round can act on: the rows the claim's result joins
 * (its Run, its Space's control head and active placement on this shard).
 * Selecting the bounded batch by anything looser let rows that the join then
 * dropped — a Run removed or re-keyed, a Space placed elsewhere — be leased and
 * silently discarded. Never settled, they kept the oldest `next_attempt_at`,
 * and a hundred of them held the head of the queue on every sweep: a new
 * launch whose one targeted wake was missed then stayed `prepared` for good.
 */
const CLAIMABLE_LAUNCH_SQL = `EXISTS (SELECT 1 FROM data.runs claim_run WHERE claim_run.run_id=launch.run_id)
          AND EXISTS (SELECT 1 FROM data.space_control_heads claim_head WHERE claim_head.space_id=launch.space_id)
          AND EXISTS (SELECT 1 FROM control.space_placement claim_placement
            WHERE claim_placement.space_id=launch.space_id AND claim_placement.shard_id=$3
              AND claim_placement.state='active' AND claim_placement.target_shard_id IS NULL)`;

/**
 * A Launch the coordinator still has to act on. Once its spawn is recorded a
 * re-read can no longer change it: settlement keeps a spawned Launch spawned
 * whatever the command says. Its Instance connecting, its Run ending or a stop
 * moves it, and each of those writes the row or wakes the Channel. A Channel
 * About session has no Instance: its spawn result connects its Launch.
 */
const ACTIVE_LAUNCH_SQL = `(launch.state IN ('prepared','queued','admitted') OR
            (launch.state='spawned' AND (launch.spawned_at IS NULL OR launch.command_durable_at IS NULL)) OR
            (launch.state='connected' AND launch.spawned_at IS NULL))`;

export async function claim(database: AuthorityDatabase, shardId: string, owner: string,
  target?: AgentLaunchWakeTarget): Promise<LaunchRow[]> {
  const claimedAt = new Date().toISOString();
  return database.transaction({ requestId: owner, operation: "launch.coordinator.claim" }, async (tx) =>
    [...await tx.query<LaunchRow>({ name: "agent_launch_coordinator_claim_v7", text: `WITH eligible AS
      MATERIALIZED (SELECT next_attempt_at FROM data.agent_launches launch
        WHERE ${ACTIVE_LAUNCH_SQL} AND next_attempt_at<=clock_timestamp()
          AND (lease_until IS NULL OR lease_until<clock_timestamp())
          AND ($5::text IS NULL OR channel_id=$5::text) AND ($4::text[] IS NULL OR launch_id=ANY($4::text[]))
          AND ${CLAIMABLE_LAUNCH_SQL}
        ORDER BY next_attempt_at,launch_id LIMIT $7
      ), eligible_stats AS (SELECT COUNT(*)::integer AS eligible_count,
          MIN(next_attempt_at) AS oldest_eligible_at FROM eligible
      ), due AS (
        SELECT launch_id FROM data.agent_launches launch
        WHERE ${ACTIVE_LAUNCH_SQL} AND next_attempt_at<=clock_timestamp()
          AND (lease_until IS NULL OR lease_until<clock_timestamp())
          AND ($5::text IS NULL OR channel_id=$5::text) AND ($4::text[] IS NULL OR launch_id=ANY($4::text[]))
          AND ${CLAIMABLE_LAUNCH_SQL}
        ORDER BY next_attempt_at,launch_id LIMIT $1 FOR UPDATE OF launch SKIP LOCKED
      ), claimed AS (
        UPDATE data.agent_launches launch SET lease_owner=$2,lease_until=clock_timestamp()+interval '30 seconds',
          wake_requested_at=COALESCE(wake_requested_at,$6::timestamptz),
          updated_at=GREATEST(updated_at,$6::timestamptz)
        FROM due WHERE launch.launch_id=due.launch_id RETURNING launch.*
      ) SELECT claimed.*,run.version AS run_version,instance.version AS instance_version,
          head.commit_sequence AS route_version,head.updated_at AS route_updated_at,
          placement.placement_epoch,eligible_stats.eligible_count,
          eligible_stats.oldest_eligible_at,
          EXISTS (SELECT 1 FROM control.entity_space_routes run_route
            WHERE run_route.entity_kind='run' AND run_route.entity_id=claimed.run_id
              AND run_route.space_id=claimed.space_id AND run_route.shard_id=$3
              AND run_route.placement_epoch=placement.placement_epoch
              AND run_route.state='active')
          AND (instance.instance_id IS NULL OR EXISTS (SELECT 1 FROM control.entity_space_routes instance_route
            WHERE instance_route.entity_kind='instance'
              AND instance_route.entity_id=claimed.instance_id
              AND instance_route.space_id=claimed.space_id AND instance_route.shard_id=$3
              AND instance_route.placement_epoch=placement.placement_epoch
              AND instance_route.state='active')) AS directory_published
        FROM claimed JOIN data.runs run ON run.run_id=claimed.run_id
        -- A Channel About session is a background Run with no Channel Instance.
        LEFT JOIN data.instances instance ON instance.instance_id=claimed.instance_id
        JOIN data.space_control_heads head ON head.space_id=claimed.space_id
        JOIN control.space_placement placement ON placement.space_id=claimed.space_id
          AND placement.shard_id=$3 AND placement.state='active'
          AND placement.target_shard_id IS NULL
        CROSS JOIN eligible_stats
        ORDER BY claimed.next_attempt_at,claimed.launch_id`,
      values: [CLAIM_LIMIT, owner, shardId, target?.launchIds.length ? [...target.launchIds] : null,
        target?.channelId ?? null, claimedAt, CLAIM_LIMIT + 1], maxRows: CLAIM_LIMIT })]);
}

export async function reconcileRunlessLaunches(database: AuthorityDatabase, shardId: string, channelId: string): Promise<void> {
  // A launch whose Run no longer exists can never be claimed or spawned. Settle
  // it as failed so it neither lingers as pending nor is mistaken for work.
  await database.transaction({ requestId: `runless-launch:${shardId}`,
    operation: "launch.coordinator.runless" }, (tx) => tx.query({
      name: "agent_launch_coordinator_runless_v2", text: `WITH runless AS MATERIALIZED (
          SELECT launch.launch_id FROM data.agent_launches launch
          WHERE launch.channel_id=$1 AND launch.state IN ('prepared','queued','admitted','spawned')
            AND NOT EXISTS (SELECT 1 FROM data.runs run WHERE run.run_id=launch.run_id)
            AND (launch.lease_until IS NULL OR launch.lease_until<clock_timestamp())
          ORDER BY launch.next_attempt_at,launch.launch_id LIMIT 100 FOR UPDATE OF launch SKIP LOCKED
        ) UPDATE data.agent_launches launch SET state='failed',retryable=FALSE,
          error_stage='run_missing',error_code='launch_run_missing',
          error_message='The launch no longer has a Run to start',
          version=launch.version+1,updated_at=clock_timestamp(),
          finished_at=COALESCE(launch.finished_at,clock_timestamp())
        FROM runless WHERE launch.launch_id=runless.launch_id`,
    values: [channelId], maxRows: 0,
  }));
}

export async function reconcileEndedRunLaunches(database: AuthorityDatabase, shardId: string, channelId: string): Promise<void> {
  // A Run can end before its Instance ever connects (a wrapper that fails at
  // startup). Its Launch would then stay spawned for good. Settle it.
  await database.transaction({ requestId: `ended-run-launch:${shardId}`,
    operation: "launch.coordinator.ended-run" }, (tx) => tx.query({
      name: "agent_launch_coordinator_ended_run_v2", text: `WITH ended AS MATERIALIZED (
          SELECT launch.launch_id FROM data.agent_launches launch
          JOIN data.runs run ON run.run_id=launch.run_id
          WHERE launch.channel_id=$1 AND launch.state IN ('prepared','queued','admitted','spawned')
            AND run.status IN (${TERMINAL_RUN_STATUS_SQL})
            AND (launch.lease_until IS NULL OR launch.lease_until<clock_timestamp())
          ORDER BY launch.next_attempt_at,launch.launch_id LIMIT 100 FOR UPDATE OF launch SKIP LOCKED
        ) UPDATE data.agent_launches launch SET state='failed',retryable=FALSE,
          error_stage='run_ended',error_code='launch_run_ended',
          error_message='The Run ended before its Instance connected',
          version=launch.version+1,updated_at=clock_timestamp(),
          finished_at=COALESCE(launch.finished_at,clock_timestamp())
        FROM ended WHERE launch.launch_id=ended.launch_id`,
    values: [channelId], maxRows: 0,
  }));
}

async function settleMany(database: AuthorityDatabase, shardId: string,
  settlements: readonly LaunchSettlement[]): Promise<void> {
  if (settlements.length === 0) return;
  const owner = `agent-launch:${shardId}`;
  await database.transaction({ requestId: `${owner}:settle`,
    operation: "launch.coordinator.settle-many" }, (tx) => tx.query({
      name: "agent_launch_coordinator_settle_many_v3", text: `WITH input AS (
          SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(
            launch_id text,state text,retryable boolean,daemon_offline boolean,
            command_durable_at timestamptz,spawned_at timestamptz,error_stage text,
            error_code text,error_message text,increment_attempt boolean,delay_seconds integer)
        ), updated_launches AS (
        UPDATE data.agent_launches launch SET
          state=CASE
            WHEN launch.state IN ('connected','cancelled') THEN launch.state
            WHEN input.state='queued' AND launch.state IN ('admitted','spawned') THEN launch.state
            WHEN input.state='failed' AND launch.state IN ('spawned','connected') THEN launch.state
            ELSE input.state END,
          attempt=launch.attempt+CASE WHEN input.increment_attempt THEN 1 ELSE 0 END,
          -- A Launch queued on an offline Machine waits on the Machine, whose
          -- reconnect wakes this Channel: re-reading it backs off with its age
          -- (a tenth of it, up to 15 minutes) instead of every 30 seconds for
          -- days. On 2026-10-08 49 such Launches kept 34 Channels spinning.
          next_attempt_at=clock_timestamp()+CASE WHEN input.daemon_offline AND input.state='queued'
            THEN GREATEST((input.delay_seconds::text||' seconds')::interval,
              LEAST(interval '15 minutes',(clock_timestamp()-launch.created_at)/10))
            ELSE (input.delay_seconds::text||' seconds')::interval END,
          lease_owner=NULL,lease_until=NULL,
          command_durable_at=COALESCE(launch.command_durable_at,input.command_durable_at),
          spawned_at=COALESCE(launch.spawned_at,input.spawned_at),
          last_reconciled_at=clock_timestamp(),daemon_offline=input.daemon_offline,
          error_stage=input.error_stage,error_code=input.error_code,
          error_message=left(input.error_message,2000),retryable=input.retryable,
          version=launch.version+1,updated_at=clock_timestamp(),
          finished_at=CASE WHEN input.state='failed' AND launch.state NOT IN ('connected','cancelled')
            THEN clock_timestamp() ELSE launch.finished_at END
        FROM input WHERE launch.launch_id=input.launch_id AND launch.lease_owner=$2
        RETURNING launch.run_id,launch.state,launch.retryable,launch.finished_at
        ), failed_runs AS (
          UPDATE data.runs run SET status='failed',version=version+1,
            updated_at=updated.finished_at,finished_at=updated.finished_at
          FROM updated_launches updated WHERE updated.state='failed' AND updated.retryable=FALSE
            AND run.run_id=updated.run_id AND run.status='starting'
          RETURNING run.run_id
        ) SELECT count(*) AS updated_count FROM updated_launches`,
      values: [JSON.stringify(settlements.map((settlement) => ({
        launch_id: settlement.row.launch_id, state: settlement.state,
        retryable: settlement.retryable, daemon_offline: settlement.daemonOffline,
        command_durable_at: settlement.commandDurableAt ?? null,
        spawned_at: settlement.spawnedAt ?? null,
        error_stage: settlement.errorStage ?? null,
        error_code: settlement.errorCode ?? null,
        error_message: settlement.errorMessage ?? null,
        increment_attempt: settlement.incrementAttempt === true,
        delay_seconds: settlement.retryable
          ? BACKOFF_SECONDS[Math.min(Number(settlement.row.attempt), BACKOFF_SECONDS.length - 1)]
          : settlement.daemonOffline ? 30 : 5,
      }))), owner], maxRows: 1,
    }));
}

function chunks<T>(items: readonly T[], maximum: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += maximum) result.push(items.slice(index, index + maximum));
  return result;
}

async function batchId(rows: readonly LaunchRow[]): Promise<string> {
  const digest = await sha256Hex(rows.map((row) => row.control_id).sort().join("\n"));
  return `product:machine-spawn-batch:${digest.slice(0, 64)}`;
}

function routeMutations(shardId: string, rows: readonly LaunchRow[]): EntitySpaceRouteMutation[] {
  return rows.flatMap((row) => (row.instance_version === null ? ["run"] as const : ["run", "instance"] as const).map((kind) => ({
    kind,
    entityId: kind === "run" ? row.run_id : row.instance_id,
    spaceId: row.space_id,
    shardId,
    placementEpoch: Number(row.placement_epoch),
    entityVersion: Number(kind === "run" ? row.run_version : row.instance_version),
    routeVersion: Number(row.route_version),
    state: "active" as const,
    updatedAt: row.route_updated_at,
  })));
}

function machineKey(row: LaunchRow): string {
  return JSON.stringify([row.owner_user_id, row.machine_id]);
}

/** The Channel message this Launch's spawn carries as its initial prompt, if any. */
function launchInitialSource(row: LaunchRow) {
  const candidate = cleanAgentRuntimeMessageSource(row.initial_source_json);
  return candidate?.channelId === row.channel_id && candidate.messageId === row.trigger_id ? candidate : undefined;
}

export function machineSpawnCommand(row: LaunchRow): Record<string, unknown> {
  const source = launchInitialSource(row);
  return { ...withInitialMessageSource(row.spawn_payload_json, source),
    ...(source ? { sourceMessageId: source.messageId } : {}),
    type: "machine_spawn_agent", requestId: row.control_id, spaceId: row.space_id,
    channelId: row.channel_id, runId: row.run_id, instanceId: row.instance_id,
    executionKey: row.execution_key, launchId: row.launch_id };
}

function commandExpected(row: LaunchRow): Record<string, unknown> {
  return { type: "machine_spawn_agent", requestId: row.control_id, runId: row.run_id,
    executionKey: row.execution_key, instanceId: row.instance_id, launchId: row.launch_id };
}

function settlementsFromCommandRows(rows: readonly LaunchRow[], payload: Record<string, unknown>): LaunchSettlement[] {
  const delivered = Number(payload.delivered);
  const daemonOffline = !(Number.isFinite(delivered) && delivered > 0);
  const commands = Array.isArray(payload.commands) ? payload.commands : [];
  const byId = new Map(commands.flatMap((value) => value && typeof value === "object" &&
      !Array.isArray(value) && typeof value.controlId === "string"
    ? [[value.controlId, value as Record<string, unknown>] as const] : []));
  return rows.map((row) => {
    const command = byId.get(row.control_id);
    const settlement = commandSettlement(row, command, daemonOffline);
    // A connected Launch is only re-read to record when it spawned. Its
    // Instance connecting proves the spawn, so a command that cannot say when
    // (missing, still pending, or failed) records the connection instead of
    // being re-read every round.
    if (row.state === "connected" && !settlement.spawnedAt && row.connected_at) return {
      row, state: "spawned", retryable: false, daemonOffline: false,
      ...(settlement.commandDurableAt ? { commandDurableAt: settlement.commandDurableAt } : {}),
      spawnedAt: new Date(row.connected_at).toISOString() };
    return settlement;
  });
}

function commandSettlement(row: LaunchRow, command: Record<string, unknown> | undefined,
  daemonOffline: boolean): LaunchSettlement {
  if (!command || command.status === "missing") return { row, state: "queued", retryable: true,
    daemonOffline, errorStage: "command_issue", errorCode: "machine_command_missing",
    errorMessage: "Durable Machine command could not be reconciled", incrementAttempt: true };
  const commandDurableAt = typeof command.createdAt === "string" ? command.createdAt : undefined;
  const result = command.result && typeof command.result === "object" && !Array.isArray(command.result)
    ? command.result as Record<string, unknown> : null;
  if ((command.status === "completed" || command.status === "failed") && result) {
    if (result.ok === true) return { row, state: "spawned", retryable: false, daemonOffline: false,
      ...(commandDurableAt ? { commandDurableAt } : {}),
      ...(typeof result.spawnedAt === "string" ? { spawnedAt: result.spawnedAt }
        : typeof command.completedAt === "string" ? { spawnedAt: command.completedAt } : {}) };
    return { row, state: "failed", retryable: isRecoverableLaunchFailure(result.error),
      daemonOffline: false, ...(commandDurableAt ? { commandDurableAt } : {}),
      errorStage: "daemon_spawn", errorCode: "daemon_spawn_failed",
      errorMessage: typeof result.error === "string" ? result.error : "Machine spawn failed" };
  }
  return { row, state: "queued", retryable: false, daemonOffline,
    ...(commandDurableAt ? { commandDurableAt } : {}) };
}


function unavailableSettlements(rows: readonly LaunchRow[], error: unknown,
  errorCode: string, fallback: string): LaunchSettlement[] {
  return rows.map((row): LaunchSettlement => ({ row, state: "queued", retryable: true,
    daemonOffline: true, errorStage: "command_issue", errorCode,
    errorMessage: error instanceof Error ? error.message : fallback, incrementAttempt: true }));
}

async function mapLimit<T>(items: readonly T[], limit: number, task: (item: T) => Promise<void>) {
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const item = items[cursor++];
      if (item) await task(item);
    }
  }));
}

/** Executable, dependency-injected publication core used by service and behavior tests. */
export async function publishClaimedAgentLaunches(
  claimed: readonly ClaimedAgentLaunch[],
  port: AgentLaunchPublicationPort,
): Promise<void> {
  if (claimed.length === 0) return;
  try {
    const mutations = claimed.flatMap(({ shard, row }) => row.directory_published
      ? [] : routeMutations(shard.shardId, [row]));
    for (const part of chunks(mutations, 200)) await port.publishDirectory(part);
  } catch (error) {
    const shards = [...new Set(claimed.map((item) => item.shard.shardId))];
    await Promise.all(shards.map((shardId) => {
      const shard = claimed.find((item) => item.shard.shardId === shardId)!.shard;
      return port.settle(shard.database, shardId,
        claimed.filter((item) => item.shard.shardId === shardId).map(({ row }) => ({ row,
          state: "queued", retryable: true, daemonOffline: true, errorStage: "directory_publish",
          errorCode: "directory_publish_unavailable",
          errorMessage: error instanceof Error ? error.message : "Directory publication failed",
          incrementAttempt: true })));
    }));
    return;
  }
  const grouped = new Map<string, ClaimedAgentLaunch[]>();
  for (const item of claimed) grouped.set(machineKey(item.row),
    [...(grouped.get(machineKey(item.row)) || []), item]);
  await mapLimit([...grouped.values()], MAX_CONCURRENCY, async (items) => {
    const rows = items.map((item) => item.row);
    const settlements: LaunchSettlement[] = [];
    const delivery = rows.filter((row) => !row.command_durable_at &&
      (row.state === "prepared" || row.state === "queued"));
    const deliveryIds = new Set(delivery.map((row) => row.launch_id));
    const reconciliation = rows.filter((row) => !deliveryIds.has(row.launch_id));
    for (const part of chunks(delivery, MACHINE_BATCH_LIMIT)) {
      try {
        settlements.push(...settlementsFromCommandRows(part, await port.issueBatch(part)));
      } catch (error) {
        if (!(error instanceof ControlError)) {
          settlements.push(...unavailableSettlements(part, error,
            "launch_publish_unavailable", "Launch publication failed"));
          continue;
        }
        const retryable = error.status >= 500 || error.retryable;
        settlements.push(...part.map((row): LaunchSettlement => ({ row,
          state: retryable ? "queued" : "failed", retryable, daemonOffline: true,
          errorStage: "command_issue", errorCode: error.code, errorMessage: error.message,
          incrementAttempt: retryable })));
      }
    }
    for (const part of chunks(reconciliation, MACHINE_BATCH_LIMIT)) {
      try {
        settlements.push(...settlementsFromCommandRows(part, await port.readBatch(part)));
      } catch (error) {
        settlements.push(...unavailableSettlements(part, error,
          "command_reconcile_unavailable", "Command reconciliation failed"));
      }
    }
    const shardIds = [...new Set(items.map((item) => item.shard.shardId))];
    await Promise.all(shardIds.map((shardId) => {
      const shard = items.find((item) => item.shard.shardId === shardId)!.shard;
      const launchIds = new Set(items.filter((item) => item.shard.shardId === shardId)
        .map((item) => item.row.launch_id));
      return port.settle(shard.database, shardId,
        settlements.filter((settlement) => launchIds.has(settlement.row.launch_id)));
    }));
  });
}

/** How long one reconciliation step may hold its round. A step past it keeps
 * running on its own but the round moves on, and the next round skips that
 * step until it settles, so one slow dependency cannot stall the rest. */
export const RECONCILE_STEP_DEADLINE_MS = 20_000;

const attemptAt = (row: string) => `GREATEST(${row}.next_attempt_at, COALESCE(${row}.lease_until, ${row}.next_attempt_at))`;

/** One page of the Channels on a shard with any open coordinated work, due now
 *  or later, in channel_id order: the cutover hands each of them to its own
 *  coordinator, which then keeps its own alarm. */
export async function channelsWithWork(database: AuthorityDatabase, shardId: string,
  afterChannelId: string, limit: number): Promise<string[]> {
  return database.transaction({ requestId: `agent-launch:channels-with-work:${shardId}`,
    operation: "launch.coordinator.channels-with-work" }, async (tx) =>
    (await tx.query<{ channel_id: string }>({ name: "agent_launch_channels_with_work_v4", text: `SELECT channel_id FROM (
        SELECT launch.channel_id FROM data.agent_launches launch
          WHERE ${ACTIVE_LAUNCH_SQL} AND ${CLAIMABLE_LAUNCH_SQL.replace("$3", "$1")}
        UNION SELECT intent.channel_id FROM data.agent_reborn_intents intent
          WHERE intent.state IN ('waiting','prepared') OR (intent.state='failed' AND intent.failure_notified_at IS NULL)
        UNION SELECT report.channel_id FROM data.machine_run_terminal_reports report
        UNION SELECT stop.channel_id FROM data.registration_stop_intents stop WHERE stop.state='pending'
        UNION SELECT prep.channel_id FROM data.registration_launch_intents prep
          WHERE prep.state='preparing' OR (prep.state='aborted' AND prep.cancellation_completed=FALSE)
        UNION SELECT run.channel_id FROM data.run_agent_registrations b JOIN data.runs run ON run.run_id=b.run_id AND run.owner_user_id=b.owner_user_id
          JOIN data.channels c ON c.channel_id=run.channel_id AND c.space_id=b.space_id
          WHERE run.status IN (${TERMINAL_RUN_STATUS_SQL})
            AND (EXISTS (SELECT 1 FROM data.instances i WHERE i.run_id=run.run_id AND i.channel_id=run.channel_id)
              OR EXISTS (SELECT 1 FROM data.agent_launches l WHERE l.run_id=run.run_id AND l.channel_id=run.channel_id))
            AND NOT EXISTS (SELECT 1 FROM data.registration_stop_intents s WHERE s.run_id=run.run_id)
      ) work WHERE channel_id>$2 ORDER BY channel_id LIMIT $3`,
      values: [shardId, afterChannelId, limit], maxRows: limit })).map(row => String(row.channel_id)));
}

/**
 * When one Channel next has coordinated work, across every kind it owns. Each
 * term mirrors the exact predicate its `run` step selects on, so a due time is
 * always actionable: a term that could fire without its step being able to act
 * would spin the Channel's alarm.
 */
/** The coordinated work one pass can do, each run by its own step. */
export type CoordinatorStep = "registrationPreparation" | "registrationStop" | "runTerminal" | "reborn" | "launch";

/** When each kind of this Channel's work is next due; a kind with none is absent. */
export type ChannelStepDue = Partial<Record<CoordinatorStep, number>>;

function dueTime(value: string | Date | null | undefined): number | undefined {
  const due = value ? Date.parse(String(value)) : Number.NaN;
  return Number.isFinite(due) ? due : undefined;
}

/** The earliest due time across a Channel's work, or undefined when it has none. */
export function earliestDue(due: Partial<Record<string, number>>): number | undefined {
  const times = Object.values(due).filter((time): time is number => time !== undefined);
  return times.length ? Math.min(...times) : undefined;
}

/** One read of when each kind of this Channel's work is next due, so a timed
 *  pass runs only the steps that have work instead of every step. */
export async function nextChannelStepDue(database: AuthorityDatabase, shardId: string, channelId: string): Promise<ChannelStepDue> {
  return database.transaction({ requestId: `agent-launch:next-due:${channelId}`,
    operation: "launch.coordinator.next-due" }, async (tx) => {
    const rows = await tx.query<Record<"launch_due" | "reborn_due" | "report_due" | "preparation_due" | "stop_due",
      string | Date | null>>({ name: "agent_launch_channel_step_due_v1",
      text: `SELECT LEAST(
        (SELECT MIN(${attemptAt("launch")}) FROM data.agent_launches launch
          WHERE launch.channel_id=$1 AND ${ACTIVE_LAUNCH_SQL} AND ${CLAIMABLE_LAUNCH_SQL.replace("$3", "$2")}),
        -- A Launch whose Run is gone or ended is settled by the runless and
        -- ended-run steps, which a timed pass runs as Launch work.
        (SELECT MIN(COALESCE(launch.lease_until, launch.next_attempt_at)) FROM data.agent_launches launch
          WHERE launch.channel_id=$1 AND launch.state IN ('prepared','queued','admitted','spawned')
            AND NOT EXISTS (SELECT 1 FROM data.runs run WHERE run.run_id=launch.run_id
              AND run.status NOT IN (${TERMINAL_RUN_STATUS_SQL})))) AS launch_due,
        (SELECT MIN(CASE WHEN intent.state IN ('waiting','prepared')
            THEN LEAST(intent.expires_at, ${attemptAt("intent")}) ELSE ${attemptAt("intent")} END)
          FROM data.agent_reborn_intents intent WHERE intent.channel_id=$1
            AND (intent.state IN ('waiting','prepared') OR (intent.state='failed' AND intent.failure_notified_at IS NULL))) AS reborn_due,
        LEAST((SELECT MIN(${attemptAt("report")}) FROM data.machine_run_terminal_reports report
          WHERE report.channel_id=$1 AND report.state='pending'),
        (SELECT MIN(report.finalized_at)+interval '7 days' FROM data.machine_run_terminal_reports report
          WHERE report.channel_id=$1 AND report.state='finalized')) AS report_due,
        LEAST((SELECT MIN(prep.next_check_at) FROM data.registration_launch_intents prep
          WHERE prep.channel_id=$1 AND prep.state='preparing'),
        (SELECT MIN(prep.updated_at) FROM data.registration_launch_intents prep
          WHERE prep.channel_id=$1 AND prep.state='aborted' AND prep.cancellation_completed=FALSE
            AND NOT EXISTS (SELECT 1 FROM data.runs run WHERE run.run_id=prep.run_id))) AS preparation_due,
        LEAST((SELECT MIN(${attemptAt("stop")}) FROM data.registration_stop_intents stop
          WHERE stop.channel_id=$1 AND stop.state='pending'),
        (SELECT MIN(run.updated_at) FROM data.run_agent_registrations b JOIN data.runs run ON run.run_id=b.run_id AND run.owner_user_id=b.owner_user_id
          JOIN data.channels c ON c.channel_id=run.channel_id AND c.space_id=b.space_id
          WHERE run.channel_id=$1 AND run.status IN (${TERMINAL_RUN_STATUS_SQL})
            AND (EXISTS (SELECT 1 FROM data.instances i WHERE i.run_id=run.run_id AND i.channel_id=run.channel_id)
              OR EXISTS (SELECT 1 FROM data.agent_launches l WHERE l.run_id=run.run_id AND l.channel_id=run.channel_id))
            AND NOT EXISTS (SELECT 1 FROM data.registration_stop_intents s WHERE s.run_id=run.run_id))) AS stop_due`,
      values: [channelId, shardId], maxRows: 1 });
    const row = rows[0];
    const due: ChannelStepDue = {};
    const set = (step: CoordinatorStep, value: string | Date | null | undefined) => {
      const time = dueTime(value);
      if (time !== undefined) due[step] = time;
    };
    set("launch", row?.launch_due); set("reborn", row?.reborn_due); set("runTerminal", row?.report_due);
    set("registrationPreparation", row?.preparation_due); set("registrationStop", row?.stop_due);
    return due;
  });
}

/** How long a resolved Channel route serves later passes before it is read again. */
const LOCATED_ROUTE_TTL_MS = 60_000;

/** Channels one handover page wakes. */
export const HANDOVER_PAGE_LIMIT = 200;

/** Stateless publisher: PostgreSQL Launch rows remain the only business facts. */
export class RelayPostgresAgentLaunchCoordinatorService {
  /** Reconciliation steps still running past their deadline. */
  private readonly overdue = new Set<string>();
  /** Channel routes this coordinator resolved recently. */
  private readonly located = new Map<string, { shardId: string; until: number }>();

  constructor(private readonly env: AgentLaunchCoordinatorEnv,
    private readonly stepDeadlineMs = RECONCILE_STEP_DEADLINE_MS,
    /** Keeps work that outlives a pass, such as post-commit message interpretation, alive. */
    private readonly waitUntil: (task: Promise<unknown>) => void = (task) => { void task; }) {}

  enabled(): boolean {
    return true;
  }

  private fleet() {
    return createPostgresAuthorityFleet(this.env, {
      applicationName: "xmatrix-agent-launch-coordinator", statementTimeoutMs: 5_000,
      transactionTimeoutMs: 10_000, lockTimeoutMs: 2_000,
    });
  }

  /** One reconciliation step under the round's deadline. */
  async boundedStep(name: string, work: () => Promise<unknown>, stepMs: Record<string, number>): Promise<void> {
    if (this.overdue.has(name)) { stepMs[name] = -1; return; }
    const startedAt = performance.now();
    // A failed step leaves its work due, so the next pass retries it; the
    // failure itself is logged rather than swallowed, or nobody learns of it.
    const running = Promise.resolve().then(work).then(() => undefined, (error: unknown) => {
      console.warn("PostgreSQL Agent Launch reconciliation step failed", { step: name,
        errorCode: error && typeof error === "object" && "code" in error && typeof error.code === "string"
          ? error.code : error instanceof Error ? error.name : "unknown" });
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = await Promise.race([running.then(() => false),
      new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(true), this.stepDeadlineMs); })]);
    clearTimeout(timer);
    stepMs[name] = Math.round(performance.now() - startedAt);
    if (!late) return;
    this.overdue.add(name);
    console.warn("PostgreSQL Agent Launch reconciliation step overran its deadline", { step: name,
      deadlineMs: this.stepDeadlineMs });
    void running.finally(() => this.overdue.delete(name));
  }

  /**
   * One Channel's coordinated work, in dependency order: registration
   * preparations, terminal reports (a stopped predecessor unblocks its reborn),
   * reborns, launch repair, routing retries, then claiming and publishing its
   * Launches. Every step reads only this Channel and runs under the deadline.
   */
  /**
   * `woken`: a writer told this Channel about an event, rather than its alarm
   * firing; such a pass runs every step. `due`: the steps a timed pass found
   * due when it was scheduled — only those run, so a Channel waiting on one
   * kind of work does not pay a transaction for every other kind.
   */
  async runChannel(route: { channelId: string; shardId?: string }, woken = false,
    due?: ReadonlySet<CoordinatorStep | "automation">): Promise<number> {
    if (!this.enabled()) return 0;
    const startedAt = performance.now();
    const fleet = this.fleet();
    const shard = await this.shardFor(fleet, route);
    const { channelId } = route;
    const stepMs: Record<string, number> = {};
    const runs = (name: CoordinatorStep | "automation") => woken || !due || due.has(name);
    const step = (name: CoordinatorStep | "automation" | "endedRun" | "runless",
      kind: CoordinatorStep | "automation", work: () => Promise<unknown>) =>
      runs(kind) ? this.boundedStep(`${name}:${channelId}`, work, stepMs) : Promise.resolve();
    await step("registrationPreparation", "registrationPreparation", () => reconcileRegistrationPreparationCancellations(
      shard.database, fleet.directoryDatabase, channelId));
    // An authority change or a Run ending woke this Channel: re-check its
    // registration Runs, then deliver and confirm their stops.
    await step("registrationStop", "registrationStop", () => reconcileRegistrationRevocations(
      shard.database, fleet.directoryDatabase, shard.shardId, this.env, channelId, woken));
    await step("runTerminal", "runTerminal", () => finalizeMachineRunTerminalReports(this.env as Env, fleet.directoryDatabase, channelId));
    await step("reborn", "reborn", () => reconcileReborn(shard.database, shard.shardId, this.env, fleet.directoryDatabase, channelId));
    await step("endedRun", "launch", () => reconcileEndedRunLaunches(shard.database, shard.shardId, channelId));
    await step("runless", "launch", () => reconcileRunlessLaunches(shard.database, shard.shardId, channelId));
    await step("automation", "automation", () => runChannelAutomation(this.env as Env,
      { shard: shard.database, directory: fleet.directoryDatabase }, channelId,
      this.waitUntil));
    const claimed = runs("launch")
      ? await this.claimAndPublish({ channelId, shardId: shard.shardId, launchIds: [] }) : 0;
    const elapsedMs = performance.now() - startedAt;
    if (elapsedMs > 5_000) console.log("PostgreSQL Agent Launch Channel pass was slow", {
      channelId, elapsedMs: Math.round(elapsedMs), stepMs });
    return claimed;
  }

  /** One handover page: Channels with open work on the cursor's shard, then
   *  the next shard. `next` is null once every shard is exhausted. */
  async channelsWithWorkPage(cursor?: { shard: number; after: string }): Promise<{
    channels: Array<{ channelId: string; shardId: string }>; next: { shard: number; after: string } | null }> {
    if (!this.enabled()) return { channels: [], next: null };
    const shards = this.fleet().physicalShards;
    let index = cursor?.shard ?? 0, after = cursor?.after ?? "";
    while (index < shards.length) {
      const shard = shards[index]!;
      const page = await channelsWithWork(shard.database, shard.shardId, after, HANDOVER_PAGE_LIMIT);
      if (page.length === HANDOVER_PAGE_LIMIT) return { channels: page.map(channelId => ({ channelId, shardId: shard.shardId })),
        next: { shard: index, after: page.at(-1)! } };
      if (page.length) return { channels: page.map(channelId => ({ channelId, shardId: shard.shardId })),
        next: index + 1 < shards.length ? { shard: index + 1, after: "" } : null };
      index += 1; after = "";
    }
    return { channels: [], next: null };
  }

  /** When each kind of this Channel's work is next due; empty when it has none. */
  async nextDue(target: { channelId: string; shardId?: string }): Promise<ChannelStepDue & { automation?: number }> {
    if (!this.enabled()) return {};
    const fleet = this.fleet();
    const shard = await this.shardFor(fleet, target);
    const [steps, automation] = await Promise.all([
      nextChannelStepDue(shard.database, shard.shardId, target.channelId),
      channelAutomationDueAt(this.env as Env, shard.database, target.channelId),
    ]);
    return automation === undefined ? steps : { ...steps, automation };
  }

  /** When this Channel's coordinator should next look, or undefined when it has no work. */
  async nextDueAt(target: { channelId: string; shardId?: string }): Promise<number | undefined> {
    return earliestDue(await this.nextDue(target));
  }

  private async shardFor(fleet: ReturnType<RelayPostgresAgentLaunchCoordinatorService["fleet"]>,
    target: { channelId: string; shardId?: string }) {
    if (target.shardId) {
      const shard = fleet.physicalShards.find((candidate) => candidate.shardId === target.shardId);
      if (!shard) throw new Error("Agent Launch wake shard is not configured");
      return shard;
    }
    // A pass and its rescheduling both need the route; one directory read
    // serves them both, and a Channel that moves is read again a minute on.
    const cached = this.located.get(target.channelId);
    const shardId = cached && cached.until > Date.now() ? cached.shardId : await (async () => {
      const route = await new PostgresChannelSpaceDirectory(fleet.directoryDatabase).resolve({
        requestId: `agent-launch:wake:${target.channelId}`,
        operation: "launch.coordinator.target-locate",
      }, target.channelId);
      if (!route) throw new Error("Agent Launch wake Channel route is unavailable");
      this.located.set(target.channelId, { shardId: route.shardId, until: Date.now() + LOCATED_ROUTE_TTL_MS });
      return route.shardId;
    })();
    const shard = fleet.physicalShards.find((candidate) => candidate.shardId === shardId);
    if (!shard) throw new Error("Agent Launch wake shard is not configured");
    return shard;
  }

  /** Claim due Launches (all, or one wake's exact targets) and publish them to their machines. */
  async claimAndPublish(target?: AgentLaunchWakeTarget): Promise<number> {
    if (!this.enabled()) return 0;
    const startedAt = performance.now();
    const fleet = this.fleet();
    const stepMs: Record<string, number> = {};
    const step = async (name: string, work: () => Promise<unknown>) => {
      const stepStartedAt = performance.now();
      try { await work(); } finally { stepMs[name] = Math.round(performance.now() - stepStartedAt); }
    };
    const directory = new PostgresEntitySpaceDirectory(fleet.directoryDatabase);
    const targetShards = target ? [await this.shardFor(fleet, target)] : fleet.physicalShards;
    let claimResults: PromiseSettledResult<{ shard: typeof targetShards[number]; rows: LaunchRow[] }>[] = [];
    await step("claim", async () => {
      claimResults = await Promise.allSettled(targetShards.map(async (shard) => ({
        shard, rows: await claim(shard.database, shard.shardId, `agent-launch:${shard.shardId}`, target),
      })));
    });
    const claimed = claimResults.flatMap((result) => result.status === "fulfilled"
      ? result.value.rows.map((row) => ({ shard: result.value.shard, row })) : []);
    if (claimed.length === 0 && claimResults.every((result) => result.status === "rejected")) {
      throw new Error("Every PostgreSQL Agent Launch shard is unavailable");
    }
    const claimedAt = Date.now();
    const age = (later: number, earlier: string | Date | null): number => {
      const value = earlier ? Date.parse(String(earlier)) : Number.NaN;
      return Number.isFinite(value) ? Math.max(0, later - value) : 0;
    };
    const observe = () => {
      const observation = {
        env: this.env as Env,
        outcome: "ok" as const,
        preparedToWakeMs: Math.max(0, ...claimed.map(({ row }) => {
          const wake = row.wake_requested_at
            ? Date.parse(String(row.wake_requested_at)) : Number.NaN;
          const prepared = row.prepared_at ? Date.parse(String(row.prepared_at)) : Number.NaN;
          return Number.isFinite(wake) && Number.isFinite(prepared)
            ? Math.max(0, wake - prepared) : 0;
        })),
        wakeToClaimMs: Math.max(0, ...claimed.map(({ row }) => age(claimedAt, row.wake_requested_at))),
        claimBatchSize: claimed.length,
        eligibleCount: claimResults.reduce((sum, result) => result.status === "fulfilled"
          ? sum + Number(result.value.rows[0]?.eligible_count ?? 0) : sum, 0),
        oldestEligibleAgeMs: Math.max(0, ...claimed.map(({ row }) =>
          age(claimedAt, row.oldest_eligible_at))),
        maintainMs: performance.now() - startedAt,
      };
      recordAgentLaunchCoordinator(observation);
      if (observation.wakeToClaimMs > 1_000 || observation.oldestEligibleAgeMs > 5_000 ||
          observation.maintainMs > 5_000) {
        // Name the Launch that has waited longest, so a row every round re-claims
        // without progress is identifiable from the log alone.
        const stalest = claimed.reduce<LaunchRow | undefined>((oldest, { row }) =>
          !oldest || age(claimedAt, row.wake_requested_at) > age(claimedAt, oldest.wake_requested_at)
            ? row : oldest, undefined);
        console.log("PostgreSQL Agent Launch coordinator was slow", {
          ...(claimed[0] ? {
            spaceId: claimed[0].row.space_id,
            channelId: claimed[0].row.channel_id,
          } : {}),
          ...(stalest ? { stalestLaunch: {
            launchId: stalest.launch_id, channelId: stalest.channel_id, machineId: stalest.machine_id,
            state: stalest.state, attempt: Number(stalest.attempt),
            commandDurable: Boolean(stalest.command_durable_at),
            waitedMs: Math.round(age(claimedAt, stalest.wake_requested_at)),
          } } : {}),
          wakeToClaimMs: Math.round(observation.wakeToClaimMs),
          oldestEligibleAgeMs: Math.round(observation.oldestEligibleAgeMs),
          claimBatchSize: observation.claimBatchSize,
          eligibleCount: observation.eligibleCount,
          maintainMs: Math.round(observation.maintainMs),
          stepMs,
        });
      }
    };
    if (claimed.length === 0) {
      observe();
      return 0;
    }

    await step("publish", () => publishClaimedAgentLaunches(claimed, {
      publishDirectory: (mutations) => directory.publishMany({
        requestId: "agent-launch:directory-batch",
        operation: "launch.directory-publish-many",
      }, mutations),
      issueBatch: async (rows) => {
        const first = rows[0]!;
        return machineDaemonCommand(this.env, {
          commandId: await batchId(rows), action: "issue_batch", ownerUserId: first.owner_user_id,
          ownerEmail: `${first.owner_user_id.replace(/[^a-zA-Z0-9._-]/gu, "_")}@unknown.invalid`,
          machineId: first.machine_id, hostId: first.hostname ?? "", payload: {}, metadata: {}, capabilities: [],
          commands: rows.map((row) => ({ controlId: row.control_id, commandType: "spawn",
            payload: machineSpawnCommand(row) })),
          principal: { kind: "user", id: first.owner_user_id },
        });
      },
      readBatch: (rows) => {
        const first = rows[0]!;
        return machineRepository(this.env).statusMany({
          requestId: crypto.randomUUID(), ownerUserId: first.owner_user_id,
          machineId: first.machine_id, hostId: first.hostname ?? "",
          commands: rows.map((row) => ({ controlId: row.control_id, expected: commandExpected(row) })),
        });
      },
      settle: settleMany,
    }));
    observe();
    return claimed.length;
  }
}
