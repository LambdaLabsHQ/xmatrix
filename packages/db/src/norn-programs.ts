import type { QueryResultRow } from "pg";
import type { AuthorityDatabase, DatabaseTransaction } from "./contracts.js";
import type { DatabasePlacementContext } from "./context.js";
import { ControlError } from "./control-error.js";

/**
 * Norn programs (docs/architecture/norn-host.md). A program's request ledger
 * is one JSON value in its row and the only authority for what was asked and
 * answered. The evaluator lives in the Hub: every write here runs a `step`
 * the caller supplies, inside the transaction that holds the program's row.
 */

/** A request as its index row holds it. */
export interface NornRequestRow {
  requestId: string; requestRef: string; epoch: number; holder: string;
  deliveryMessageId: string; delivered: boolean; settled: boolean;
  /** Delivered, unanswered, and nothing is working on it any more. */
  abandoned: boolean;
}
/** What a step reads: the program, the authority's clock and the index. */
export interface NornProgramState {
  spaceId: string; channelId: string; programId: string; source: string; ledger: unknown;
  nowMs: number; stopReason: string | null; requests: NornRequestRow[];
}
/** What a step writes: the whole ledger, and each request the index must hold. */
export interface NornProgramWrite {
  ledger: unknown; state: "running" | "completed" | "failed"; nextDueMs: number | null;
  requests: { requestId: string; requestRef: string; epoch: number; holder: string; settled: boolean }[];
}
export type NornStep<T> = (state: NornProgramState) => { write: NornProgramWrite | null; result: T };

interface Scope { requestId: string; channelId: string; programId: string }

/**
 * Whether anything still works on a delivered request `r`: an execution of
 * its delivery message under way, a launch for it being prepared, waiting for
 * quota or starting, or a Run it started that has not taken the message yet.
 * With none of these an unanswered request has been abandoned.
 */
const NORN_REQUEST_WORKED_SQL = `(EXISTS (SELECT 1 FROM data.agent_message_executions execution
      WHERE execution.channel_id=r.channel_id AND execution.source_message_id=r.delivery_message_id
        AND execution.state IN ('accepted','running'))
    OR EXISTS (SELECT 1 FROM data.registration_launch_intents intent
      WHERE intent.channel_id=r.channel_id AND intent.source_message_id=r.delivery_message_id AND intent.state='preparing')
    OR EXISTS (SELECT 1 FROM data.agent_quota_retries quota
      WHERE quota.channel_id=r.channel_id AND quota.source_message_id=r.delivery_message_id
        AND quota.state IN ('offered','waiting','dispatching'))
    OR EXISTS (SELECT 1 FROM data.agent_launches launch JOIN data.runs run ON run.run_id=launch.run_id
      WHERE launch.channel_id=r.channel_id AND launch.trigger_id=r.delivery_message_id
        AND (launch.state IN ('prepared','queued','admitted','spawned') OR (run.status IN ('starting','running')
          AND NOT EXISTS (SELECT 1 FROM data.agent_message_executions taken
            WHERE taken.run_id=launch.run_id AND taken.source_message_id=r.delivery_message_id)))))`;
/** A delivered request `r` that has ended, whose Run has not been let go yet. */
const NORN_REQUEST_UNRELEASED_SQL = "(r.settled_at IS NOT NULL AND r.delivered_at IS NOT NULL AND r.released_at IS NULL)";
const NORN_REQUEST_ABANDONED_SQL = `(r.delivered_at IS NOT NULL AND r.settled_at IS NULL AND NOT ${NORN_REQUEST_WORKED_SQL})`;

/**
 * When a Channel's programs next need a pass, a delivery or a report; NULL
 * with none. `$1` is the Channel. Each term is exactly what `nornChannelWork`
 * selects, so a due time always has work behind it.
 */
export const NORN_CHANNEL_DUE_SQL = `LEAST(
    (SELECT MIN(CASE WHEN p.stop_reason IS NOT NULL THEN p.updated_at ELSE p.next_due_at END)
      FROM data.norn_programs p WHERE p.channel_id=$1 AND p.state='running'),
    (SELECT MIN(p.updated_at) FROM data.norn_programs p
      WHERE p.channel_id=$1 AND p.state<>'running' AND p.reported_at IS NULL),
    (SELECT MIN(r.created_at) FROM data.norn_requests r
      WHERE r.channel_id=$1 AND r.settled_at IS NULL AND r.delivered_at IS NULL),
    (SELECT MIN(r.delivered_at) FROM data.norn_requests r WHERE r.channel_id=$1 AND ${NORN_REQUEST_ABANDONED_SQL}),
    (SELECT MIN(r.settled_at) FROM data.norn_requests r WHERE r.channel_id=$1 AND ${NORN_REQUEST_UNRELEASED_SQL}))`;
/** The Channels with any program still running or unreported: `p` is the program. */
export const NORN_PROGRAM_OPEN_SQL = "(p.state='running' OR p.reported_at IS NULL)";

/** A delivery message of a program whose authority is this user: xMatrix's own message that may start a Run. */
export const NORN_DELIVERY_SOURCE_SQL = `EXISTS (SELECT 1 FROM data.norn_requests request
    JOIN data.norn_programs program ON program.space_id=request.space_id AND program.program_id=request.program_id
    WHERE request.space_id=$1 AND request.channel_id=$2 AND request.delivery_message_id=$3
      AND request.settled_at IS NULL AND program.authority_user_id=$4)`;

const requestRow = (row: QueryResultRow): NornRequestRow => ({ requestId: String(row.request_id), requestRef: String(row.request_ref),
  epoch: Number(row.epoch), holder: String(row.holder), deliveryMessageId: String(row.delivery_message_id),
  delivered: row.delivered_at !== null, settled: row.settled_at !== null, abandoned: row.abandoned === true });
const unavailable = () => new ControlError("norn_request_unavailable", 404, "No such request");

/** The message that delivers one holding of a request. A handover is a new holding, so a new message. */
export const nornDeliveryMessageId = (requestRef: string, epoch: number) => `norn:${requestRef}:${epoch}`;

export class PostgresNornProgramRepository {
  constructor(private readonly database: AuthorityDatabase, private readonly placement: DatabasePlacementContext) {}

  private transaction<T>(requestId: string, operation: string, body: (tx: DatabaseTransaction) => Promise<T>): Promise<T> {
    return this.database.transaction({ requestId: requestId.slice(0, 200), operation: `norn.${operation}`, placement: this.placement }, body);
  }

  private async pass<T>(tx: DatabaseTransaction, program: QueryResultRow, step: NornStep<T>): Promise<T> {
    const scope = [this.placement.spaceId, String(program.program_id)];
    const rows = await tx.query<QueryResultRow>({ name: "norn_request_index_v1", text: `SELECT r.request_id,r.request_ref,r.epoch,
        r.holder,r.delivery_message_id,r.delivered_at,r.settled_at,${NORN_REQUEST_ABANDONED_SQL} AS abandoned,
        floor(extract(epoch from clock_timestamp())*1000)::text AS now_millis
      FROM (SELECT 1) one LEFT JOIN data.norn_requests r ON r.space_id=$1 AND r.program_id=$2
      ORDER BY r.created_at,r.request_id LIMIT 10000`, values: scope, maxRows: 10_000 });
    const { write, result } = step({ spaceId: this.placement.spaceId, channelId: String(program.channel_id),
      programId: String(program.program_id), source: String(program.source), ledger: program.ledger_json,
      nowMs: Number(rows[0]!.now_millis), stopReason: program.stop_reason === null ? null : String(program.stop_reason),
      requests: rows.filter(row => row.request_id !== null).map(requestRow) });
    if (!write) return result;
    await tx.query({ name: "norn_program_write_v1", text: `UPDATE data.norn_programs SET ledger_json=$3::jsonb,state=$4,
        next_due_at=$5,stop_reason=NULL,revision=revision+1,updated_at=clock_timestamp()
      WHERE space_id=$1 AND program_id=$2`, values: [...scope, JSON.stringify(write.ledger), write.state,
      write.nextDueMs === null || write.state !== "running" ? null : new Date(write.nextDueMs).toISOString()], maxRows: 0 });
    // A new holding (another epoch) is delivered again; an unchanged one keeps its delivery.
    await tx.query({ name: "norn_request_write_v1", text: `INSERT INTO data.norn_requests
        (space_id,channel_id,program_id,request_id,request_ref,epoch,holder,delivery_message_id,settled_at)
      SELECT $1,$3,$2,entry.request_id,entry.request_ref,entry.epoch,entry.holder,entry.delivery_message_id,
        CASE WHEN entry.settled THEN clock_timestamp() END
      FROM jsonb_to_recordset($4::jsonb) AS entry(request_id text,request_ref text,epoch bigint,holder text,
        delivery_message_id text,settled boolean)
      ON CONFLICT (space_id,program_id,request_id) DO UPDATE SET epoch=EXCLUDED.epoch,holder=EXCLUDED.holder,
        delivery_message_id=CASE WHEN norn_requests.epoch=EXCLUDED.epoch THEN norn_requests.delivery_message_id
          ELSE 'norn:'||norn_requests.request_ref||':'||EXCLUDED.epoch END,
        delivered_at=CASE WHEN norn_requests.epoch=EXCLUDED.epoch THEN norn_requests.delivered_at END,
        settled_at=COALESCE(norn_requests.settled_at,EXCLUDED.settled_at)`,
      values: [...scope, String(program.channel_id), JSON.stringify(write.requests.map(request => ({
        request_id: request.requestId, request_ref: request.requestRef, epoch: request.epoch, holder: request.holder,
        delivery_message_id: nornDeliveryMessageId(request.requestRef, request.epoch), settled: request.settled })))], maxRows: 0 });
    return result;
  }

  /**
   * Starts the program a committed message carries, and runs its first pass.
   * The message is the program's identity, so a repeat starts nothing.
   */
  async start<T>(input: Scope & { authorKind: "user" | "agent"; authorId: string; authorityUserId: string; source: string;
    ledger: (nowMs: number) => unknown }, step: NornStep<T>): Promise<T | undefined> {
    return this.transaction(input.requestId, "start", async tx => {
      const [created] = await tx.query<QueryResultRow>({ name: "norn_program_start_v1", text: `INSERT INTO data.norn_programs
          (space_id,channel_id,program_id,author_kind,author_id,authority_user_id,source,ledger_json,state)
        SELECT message.space_id,message.channel_id,message.message_id,$4,$5,$6,$7,'{}'::jsonb,'running'
        FROM data.messages message WHERE message.space_id=$1 AND message.channel_id=$2 AND message.message_id=$3
          AND message.deleted_at IS NULL AND message.recalled_at IS NULL
        ON CONFLICT (space_id,program_id) DO NOTHING
        RETURNING *,floor(extract(epoch from clock_timestamp())*1000)::text AS now_millis`,
        values: [this.placement.spaceId, input.channelId, input.programId, input.authorKind, input.authorId,
          input.authorityUserId, input.source], maxRows: 1 });
      if (!created) return undefined;
      return this.pass(tx, { ...created, ledger_json: input.ledger(Number(created.now_millis)) }, step);
    });
  }

  /** One step on a running program, holding its row. `undefined`: no such running program in this Channel. */
  async advance<T>(input: Scope, step: NornStep<T>): Promise<T | undefined> {
    return this.transaction(input.requestId, "advance", async tx => {
      const [program] = await tx.query<QueryResultRow>({ name: "norn_program_lock_v1", text: `SELECT * FROM data.norn_programs
        WHERE space_id=$1 AND channel_id=$2 AND program_id=$3 AND state='running' FOR UPDATE`,
        values: [this.placement.spaceId, input.channelId, input.programId], maxRows: 1 });
      return program ? this.pass(tx, program, step) : undefined;
    });
  }

  /** What this Channel's programs need now: passes, deliveries and reports. */
  async channelWork(input: { requestId: string; channelId: string }) {
    return this.transaction(input.requestId, "channel-work", async tx => {
      const values = [input.channelId];
      const passes = await tx.query<QueryResultRow>({ name: "norn_channel_passes_v1", text: `SELECT p.program_id
        FROM data.norn_programs p WHERE p.channel_id=$1 AND p.state='running' AND (p.stop_reason IS NOT NULL
          OR p.next_due_at<=clock_timestamp() OR EXISTS (SELECT 1 FROM data.norn_requests r
            WHERE r.space_id=p.space_id AND r.program_id=p.program_id AND ${NORN_REQUEST_ABANDONED_SQL}))
        ORDER BY p.created_at,p.program_id LIMIT 200`, values, maxRows: 200 });
      const deliveries = await tx.query<QueryResultRow>({ name: "norn_channel_deliveries_v1", text: `SELECT r.program_id,
          r.request_id,r.request_ref,r.epoch,r.holder,r.delivery_message_id,p.authority_user_id,
          p.ledger_json->'requests'->r.request_id AS request_json
        FROM data.norn_requests r JOIN data.norn_programs p ON p.space_id=r.space_id AND p.program_id=r.program_id
        WHERE r.channel_id=$1 AND r.settled_at IS NULL AND r.delivered_at IS NULL
        ORDER BY r.created_at,r.request_id LIMIT 200`, values, maxRows: 200 });
      const reports = await tx.query<QueryResultRow>({ name: "norn_channel_reports_v1", text: `SELECT p.program_id,p.state,
          p.authority_user_id,p.ledger_json->'ended' AS ended_json,
          (SELECT '@'||COALESCE(registration.display_name,binding.harness)||':'||instance.channel_instance_id
            FROM data.instances instance JOIN data.run_agent_registrations binding ON binding.run_id=instance.run_id
              LEFT JOIN data.space_agent_registrations registration ON registration.space_id=binding.space_id
                AND registration.owner_user_id=binding.owner_user_id AND registration.machine_id=binding.machine_id
                AND registration.harness=binding.harness
            WHERE p.author_kind='agent' AND instance.instance_id=p.author_id LIMIT 1) AS author_mention
        FROM data.norn_programs p WHERE p.channel_id=$1 AND p.state<>'running' AND p.reported_at IS NULL
        ORDER BY p.updated_at,p.program_id LIMIT 200`, values, maxRows: 200 });
      // The Instance a request started exists for that request alone. Once the request has ended, its Run is
      // stopped if still live, and the Instance is retired if it rests: an Instance at rest outlives its Run.
      const releases = await tx.query<QueryResultRow>({ name: "norn_channel_releases_v2", text: `SELECT r.program_id,r.request_id,
          p.authority_user_id,started.run_id,started.mention
        FROM data.norn_requests r JOIN data.norn_programs p ON p.space_id=r.space_id AND p.program_id=r.program_id
          LEFT JOIN LATERAL (SELECT CASE WHEN run.status IN ('starting','running') THEN run.run_id END AS run_id,
              lower(registration.display_name||':'||instance.channel_instance_id::text) AS mention
            FROM data.agent_launches launch JOIN data.instances instance ON instance.instance_id=launch.instance_id
              JOIN data.runs run ON run.run_id=instance.run_id
              JOIN data.run_agent_registrations binding ON binding.run_id=launch.run_id
              JOIN data.space_agent_registrations registration ON registration.space_id=binding.space_id
                AND registration.owner_user_id=binding.owner_user_id AND registration.machine_id=binding.machine_id
                AND registration.harness=binding.harness
            WHERE launch.channel_id=r.channel_id AND launch.trigger_id=r.delivery_message_id LIMIT 1) started ON TRUE
        WHERE r.channel_id=$1 AND ${NORN_REQUEST_UNRELEASED_SQL} ORDER BY r.settled_at,r.request_id LIMIT 200`, values, maxRows: 200 });
      return {
        releases: releases.map(row => ({ programId: String(row.program_id), requestId: String(row.request_id),
          authorityUserId: String(row.authority_user_id), runId: typeof row.run_id === "string" ? row.run_id : null,
          mention: typeof row.mention === "string" ? row.mention : null })),
        passes: passes.map(row => String(row.program_id)),
        deliveries: deliveries.map(row => ({ programId: String(row.program_id), requestId: String(row.request_id),
          requestRef: String(row.request_ref), epoch: Number(row.epoch), holder: String(row.holder),
          deliveryMessageId: String(row.delivery_message_id), authorityUserId: String(row.authority_user_id),
          request: row.request_json as unknown })),
        reports: reports.map(row => ({ programId: String(row.program_id), state: String(row.state),
          authorMention: typeof row.author_mention === "string" ? row.author_mention : null,
          authorityUserId: String(row.authority_user_id), ended: row.ended_json as unknown })),
      };
    });
  }

  /** The delivery message of this holding was appended and its launch dispatched. */
  async delivered(input: Scope & { ledgerRequestId: string; epoch: number }): Promise<void> {
    await this.transaction(input.requestId, "delivered", tx => tx.query({ name: "norn_request_delivered_v1", text: `UPDATE
      data.norn_requests SET delivered_at=clock_timestamp() WHERE space_id=$1 AND program_id=$2 AND request_id=$3
        AND epoch=$4 AND delivered_at IS NULL`, values: [this.placement.spaceId, input.programId, input.ledgerRequestId, input.epoch],
      maxRows: 0 }));
  }

  /** The Instance this ended request started was stopped or retired, or had already gone. */
  async released(input: Scope & { ledgerRequestId: string }): Promise<void> {
    await this.transaction(input.requestId, "released", tx => tx.query({ name: "norn_request_released_v1", text: `UPDATE
      data.norn_requests SET released_at=clock_timestamp() WHERE space_id=$1 AND program_id=$2 AND request_id=$3
        AND settled_at IS NOT NULL AND released_at IS NULL`, values: [this.placement.spaceId, input.programId, input.ledgerRequestId],
      maxRows: 0 }));
  }

  /** The program's end was told to the Channel. */
  async reported(input: Scope): Promise<void> {
    await this.transaction(input.requestId, "reported", tx => tx.query({ name: "norn_program_reported_v1", text: `UPDATE
      data.norn_programs SET reported_at=clock_timestamp() WHERE space_id=$1 AND program_id=$2 AND state<>'running'
        AND reported_at IS NULL`, values: [this.placement.spaceId, input.programId], maxRows: 0 }));
  }

  /**
   * The open request a Run answers by its reference. The Run holds it only if
   * the request's delivery message started the Run or one of its turns.
   */
  async heldRequest(input: { requestId: string; channelId: string; requestRef: string; runId: string }) {
    return this.transaction(input.requestId, "held-request", async tx => {
      const [row] = await tx.query<QueryResultRow>({ name: "norn_request_held_v1", text: `SELECT r.program_id,r.request_id,r.epoch,
          r.holder,r.settled_at,(EXISTS (SELECT 1 FROM data.agent_launches launch WHERE launch.run_id=$4
              AND launch.channel_id=r.channel_id AND launch.trigger_id=r.delivery_message_id)
            OR EXISTS (SELECT 1 FROM data.agent_message_executions execution WHERE execution.run_id=$4
              AND execution.channel_id=r.channel_id AND execution.source_message_id=r.delivery_message_id)) AS held
        FROM data.norn_requests r WHERE r.space_id=$1 AND r.channel_id=$2 AND r.request_ref=$3 LIMIT 1`,
        values: [this.placement.spaceId, input.channelId, input.requestRef, input.runId], maxRows: 1 });
      if (!row) throw unavailable();
      if (row.held !== true) throw new ControlError("norn_request_not_held", 403, "This request is not yours to answer");
      if (row.settled_at !== null) throw new ControlError("norn_request_ended", 409, "The request has already ended");
      return { programId: String(row.program_id), requestId: String(row.request_id), epoch: Number(row.epoch), holder: String(row.holder) };
    });
  }

  /** The open requests this Run holds, and those of the programs its Instance started. */
  async openRequests(input: { requestId: string; channelId: string; runId: string; instanceId: string }) {
    return this.transaction(input.requestId, "open-requests", async tx => (await tx.query<QueryResultRow>({
      name: "norn_requests_open_v1", text: `SELECT r.request_ref,r.holder,r.program_id,
          p.ledger_json->'requests'->r.request_id->>'text' AS text,
          p.ledger_json->'requests'->r.request_id->>'by' AS by_millis,
          (p.author_kind='agent' AND p.author_id=$4) AS asked,
          (EXISTS (SELECT 1 FROM data.agent_launches launch WHERE launch.run_id=$3
              AND launch.channel_id=r.channel_id AND launch.trigger_id=r.delivery_message_id)
            OR EXISTS (SELECT 1 FROM data.agent_message_executions execution WHERE execution.run_id=$3
              AND execution.channel_id=r.channel_id AND execution.source_message_id=r.delivery_message_id)) AS held
        FROM data.norn_requests r JOIN data.norn_programs p ON p.space_id=r.space_id AND p.program_id=r.program_id
        WHERE r.space_id=$1 AND r.channel_id=$2 AND r.settled_at IS NULL
        ORDER BY r.created_at,r.request_id LIMIT 200`,
      values: [this.placement.spaceId, input.channelId, input.runId, input.instanceId], maxRows: 200 }))
      .filter(row => row.held === true || row.asked === true)
      .map(row => ({ requestRef: String(row.request_ref), holder: String(row.holder), programId: String(row.program_id),
        text: String(row.text ?? ""), by: row.by_millis === null ? null : new Date(Number(row.by_millis)).toISOString(),
        held: row.held === true, asked: row.asked === true })));
  }
}
