import type { QueryResultRow } from "pg";
import type { AuthorityDatabase, DatabaseTransaction } from "./contracts.js";
import type { DatabasePlacementContext } from "./context.js";
import { ControlError } from "./control-error.js";
import { inActiveSpace } from "./page-control.js";
import { channelCapabilityPredicate } from "./channel-capability-policy.js";

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
  /**
   * The work on this holding broke off rather than ended: its turn failed, or
   * no turn ever took it. A turn that ended in order, or was interrupted and
   * not taken up again, is not this.
   */
  brokeOff: boolean;
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
  /** The outside streams the program now waits on, as the evaluator names them; an event is matched against these. */
  waits: unknown[];
  /** What the program said in this step (`say`), to be posted to its conversation. */
  notices: { noticeId: string; recipient: string; body: string }[];
}
/**
 * A pass that could not be made here and is to be tried again: the program
 * is left exactly as it is, and only the time of its next pass moves.
 */
export interface NornProgramRetry { retryAtMs: number }
export type NornStep<T> = (state: NornProgramState) => { write: NornProgramWrite | NornProgramRetry | null; result: T };

interface Scope { requestId: string; channelId: string; programId: string }

/**
 * Whether anything still works on a delivered request `r`: an execution of
 * its delivery message under way, a launch for it being prepared, waiting for
 * quota or starting, or a Run it started that has not taken the message yet.
 * With none of these an unanswered request has been abandoned.
 */
/** An Instance that takes a message sent to it: live with a live Run, or at rest where the message wakes it. */
const instanceTakesMessages = (instance: string) => `((${instance}.status IN ('online','busy','idle') AND EXISTS (SELECT 1
      FROM data.runs live WHERE live.run_id=${instance}.run_id AND live.status IN ('starting','running')))
    OR ${instance}.rest_state IN ('sleeping','interrupted'))`;
/** The Instance that holds request `r`: the one it was handed to, or the one its delivery started. */
const requestInstance = (r: string) => `COALESCE(${r}.instance_id,(SELECT launch.instance_id FROM data.agent_launches launch
    WHERE launch.channel_id=${r}.channel_id AND launch.trigger_id=${r}.delivery_message_id LIMIT 1))`;
/** The person who holds request `r` can still read its conversation. A person's request needs nothing working on it. */
const NORN_REQUEST_HELD_BY_PERSON_SQL = `(r.holder_user_id IS NOT NULL AND EXISTS (SELECT 1 FROM data.channels held_in
      WHERE held_in.space_id=r.space_id AND held_in.channel_id=r.channel_id
        AND ${channelCapabilityPredicate({ capability: "message_content_read", channelAlias: "held_in",
          principalKindSql: "'user'", principalIdSql: "r.holder_user_id" })}))`;
const NORN_REQUEST_WORKED_SQL = `(${NORN_REQUEST_HELD_BY_PERSON_SQL} OR EXISTS (SELECT 1 FROM data.agent_message_executions execution
      WHERE execution.channel_id=r.channel_id AND execution.source_message_id=r.delivery_message_id
        AND execution.state IN ('accepted','running'))
    -- A turn that was interrupted (a newer message arrived) has not ended the work: its Instance goes on in its
    -- next turn and may still answer. Only once that Instance has ended a later turn is the request left behind.
    OR EXISTS (SELECT 1 FROM data.agent_message_executions cut JOIN data.instances going ON going.instance_id=cut.instance_id
      WHERE cut.channel_id=r.channel_id AND cut.source_message_id=r.delivery_message_id AND cut.state='interrupted'
        AND ${instanceTakesMessages("going")}
        AND NOT EXISTS (SELECT 1 FROM data.agent_message_executions later WHERE later.instance_id=cut.instance_id
          AND later.started_at_millis>cut.started_at_millis AND later.state IN ('completed','failed','unknown')))
    OR EXISTS (SELECT 1 FROM data.registration_launch_intents intent
      WHERE intent.channel_id=r.channel_id AND intent.source_message_id=r.delivery_message_id AND intent.state='preparing')
    OR EXISTS (SELECT 1 FROM data.agent_quota_retries quota
      WHERE quota.channel_id=r.channel_id AND quota.source_message_id=r.delivery_message_id
        AND quota.state IN ('offered','waiting','dispatching'))
    OR EXISTS (SELECT 1 FROM data.agent_launches launch JOIN data.runs run ON run.run_id=launch.run_id
      WHERE launch.channel_id=r.channel_id AND launch.trigger_id=r.delivery_message_id
        AND (launch.state IN ('prepared','queued','admitted','spawned') OR (run.status IN ('starting','running')
          AND NOT EXISTS (SELECT 1 FROM data.agent_message_executions taken
            WHERE taken.run_id=launch.run_id AND taken.source_message_id=r.delivery_message_id))))
    OR (r.instance_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM data.agent_message_executions taken
        WHERE taken.instance_id=r.instance_id AND taken.source_message_id=r.delivery_message_id)
      AND EXISTS (SELECT 1 FROM data.instances held WHERE held.instance_id=r.instance_id AND ${instanceTakesMessages("held")})))`;
/** How request `q` of program `owner` ended, when its holder ended it: an answer, a refusal, a failure. */
const endedByHolder = (q: string, owner: string) =>
  `(${owner}.ledger_json->'requests'->${q}.request_id->'reply'->>'tag' IN ('Answered','Refused','Broke'))`;
/**
 * Whether the Instance of request `r` stays in the conversation. It stays
 * while any request it holds is open, and while a program it started (a
 * question it asked) still runs, so the answer finds it. In a Page program's
 * conversation it also stays as the one a running program asks again by name,
 * and as the one that ended a request last: after the program, a person who
 * writes there reaches the Agent that did the work. Every other Instance a
 * request started is let go once its request has ended.
 */
const NORN_INSTANCE_STAYS_SQL = `(EXISTS (SELECT 1 FROM data.norn_requests other
      JOIN data.norn_programs theirs ON theirs.space_id=other.space_id AND theirs.program_id=other.program_id
    WHERE other.space_id=r.space_id AND other.channel_id=r.channel_id AND other.delivered_at IS NOT NULL
      AND other.holder_user_id IS NULL AND ${requestInstance("other")}=${requestInstance("r")}
      AND (other.settled_at IS NULL
        OR (theirs.page_id IS NOT NULL AND theirs.state='running' AND other.holder<>'@auto'
          AND NOT EXISTS (SELECT 1 FROM data.norn_requests later WHERE later.space_id=other.space_id
            AND later.program_id=other.program_id AND later.holder=other.holder AND later.delivered_at IS NOT NULL
            AND later.settled_at>other.settled_at))
        OR (theirs.page_id IS NOT NULL AND ${endedByHolder("other", "theirs")}
          AND NOT EXISTS (SELECT 1 FROM data.norn_requests newer
              JOIN data.norn_programs newest ON newest.space_id=newer.space_id AND newest.program_id=newer.program_id
            WHERE newer.space_id=other.space_id AND newer.channel_id=other.channel_id AND newer.delivered_at IS NOT NULL
              AND newer.holder_user_id IS NULL AND newer.settled_at>other.settled_at AND newest.page_id IS NOT NULL
              AND ${endedByHolder("newer", "newest")}))))
    OR EXISTS (SELECT 1 FROM data.norn_programs asking WHERE asking.space_id=r.space_id AND asking.channel_id=r.channel_id
      AND asking.state='running' AND asking.author_kind='agent' AND asking.author_id=${requestInstance("r")}))`;
/** A delivered request `r` that has ended, whose Instance is to be let go and has not been yet. */
const NORN_REQUEST_UNRELEASED_SQL = `(r.settled_at IS NOT NULL AND r.delivered_at IS NOT NULL AND r.released_at IS NULL
    AND r.holder_user_id IS NULL AND NOT ${NORN_INSTANCE_STAYS_SQL})`;
/** A request a person held that has ended: its card still says it waits on them. */
const NORN_REQUEST_UNCLOSED_SQL = "(r.settled_at IS NOT NULL AND r.holder_user_id IS NOT NULL AND r.released_at IS NULL)";
const NORN_REQUEST_ABANDONED_SQL = `(r.delivered_at IS NOT NULL AND r.settled_at IS NULL AND NOT ${NORN_REQUEST_WORKED_SQL})`;
/** No turn on request `r` ended in order or was cut short by a newer message: whatever took it failed, or nothing took it. */
const NORN_REQUEST_BROKE_OFF_SQL = `(NOT EXISTS (SELECT 1 FROM data.agent_message_executions ended
    WHERE ended.channel_id=r.channel_id AND ended.source_message_id=r.delivery_message_id AND ended.state NOT IN ('failed','unknown')))`;
/**
 * Why the ledger's evidence holds a holding that was given up on: the host
 * handed the request to a new Instance because the work on it broke off.
 */
export const NORN_HANDED_ON_REASON = "The work broke off, and the request was handed to a new Instance";

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
    (SELECT MIN(r.settled_at) FROM data.norn_requests r WHERE r.channel_id=$1 AND ${NORN_REQUEST_UNRELEASED_SQL}),
    (SELECT MIN(r.settled_at) FROM data.norn_requests r WHERE r.channel_id=$1 AND ${NORN_REQUEST_UNCLOSED_SQL}),
    (SELECT MIN(n.created_at) FROM data.norn_notices n WHERE n.channel_id=$1 AND n.posted_at IS NULL))`;
/** The Channels with any program still running or unreported: `p` is the program. */
export const NORN_PROGRAM_OPEN_SQL = "(p.state='running' OR p.reported_at IS NULL)";

/** A delivery message of a program whose authority is this user: xMatrix's own message that may start a Run. */
export const NORN_DELIVERY_SOURCE_SQL = `EXISTS (SELECT 1 FROM data.norn_requests request
    JOIN data.norn_programs program ON program.space_id=request.space_id AND program.program_id=request.program_id
    WHERE request.space_id=$1 AND request.channel_id=$2 AND request.delivery_message_id=$3
      AND request.settled_at IS NULL AND program.authority_user_id=$4)`;

const requestRow = (row: QueryResultRow): NornRequestRow => ({ requestId: String(row.request_id), requestRef: String(row.request_ref),
  epoch: Number(row.epoch), holder: String(row.holder), deliveryMessageId: String(row.delivery_message_id),
  delivered: row.delivered_at !== null, settled: row.settled_at !== null, abandoned: row.abandoned === true,
  brokeOff: row.broke_off === true });
const unavailable = () => new ControlError("norn_request_unavailable", 404, "No such request");

/** The message that delivers one holding of a request. A handover is a new holding, so a new message. */
export const NORN_DELIVERY_PREFIX = "norn:";
export const nornDeliveryMessageId = (requestRef: string, epoch: number) => `${NORN_DELIVERY_PREFIX}${requestRef}:${epoch}`;

export class PostgresNornProgramRepository {
  constructor(private readonly database: AuthorityDatabase, private readonly placement: DatabasePlacementContext) {}

  private transaction<T>(requestId: string, operation: string, body: (tx: DatabaseTransaction) => Promise<T>): Promise<T> {
    return this.database.transaction({ requestId: requestId.slice(0, 200), operation: `norn.${operation}`, placement: this.placement }, body);
  }

  private async pass<T>(tx: DatabaseTransaction, program: QueryResultRow, step: NornStep<T>): Promise<T> {
    const scope = [this.placement.spaceId, String(program.program_id)];
    const rows = await tx.query<QueryResultRow>({ name: "norn_request_index_v2", text: `SELECT r.request_id,r.request_ref,r.epoch,
        r.holder,r.delivery_message_id,r.delivered_at,r.settled_at,${NORN_REQUEST_ABANDONED_SQL} AS abandoned,
        ${NORN_REQUEST_BROKE_OFF_SQL} AS broke_off,
        floor(extract(epoch from clock_timestamp())*1000)::text AS now_millis
      FROM (SELECT 1) one LEFT JOIN data.norn_requests r ON r.space_id=$1 AND r.program_id=$2
      ORDER BY r.created_at,r.request_id LIMIT 10000`, values: scope, maxRows: 10_000 });
    const { write, result } = step({ spaceId: this.placement.spaceId, channelId: String(program.channel_id),
      programId: String(program.program_id), source: String(program.source), ledger: program.ledger_json,
      nowMs: Number(rows[0]!.now_millis), stopReason: program.stop_reason === null ? null : String(program.stop_reason),
      requests: rows.filter(row => row.request_id !== null).map(requestRow) });
    if (!write) return result;
    if ("retryAtMs" in write) {
      await tx.query({ name: "norn_program_retry_v1", text: `UPDATE data.norn_programs SET next_due_at=$3,updated_at=clock_timestamp()
        WHERE space_id=$1 AND program_id=$2`, values: [...scope, new Date(write.retryAtMs).toISOString()], maxRows: 0 });
      return result;
    }
    await tx.query({ name: "norn_program_write_v2", text: `UPDATE data.norn_programs SET ledger_json=$3::jsonb,state=$4,
        next_due_at=$5,waits_json=$6::jsonb,stop_reason=NULL,revision=revision+1,updated_at=clock_timestamp()
      WHERE space_id=$1 AND program_id=$2`, values: [...scope, JSON.stringify(write.ledger), write.state,
      write.nextDueMs === null || write.state !== "running" ? null : new Date(write.nextDueMs).toISOString(),
      write.state === "running" && write.waits.length ? JSON.stringify(write.waits) : null], maxRows: 0 });
    // A new holding (another epoch) is delivered again; an unchanged one keeps its delivery.
    await tx.query({ name: "norn_request_write_v3", text: `INSERT INTO data.norn_requests
        (space_id,channel_id,program_id,request_id,request_ref,epoch,holder,delivery_message_id,settled_at)
      SELECT $1,$3,$2,entry.request_id,entry.request_ref,entry.epoch,entry.holder,entry.delivery_message_id,
        CASE WHEN entry.settled THEN clock_timestamp() END
      FROM jsonb_to_recordset($4::jsonb) AS entry(request_id text,request_ref text,epoch bigint,holder text,
        delivery_message_id text,settled boolean)
      ON CONFLICT (space_id,program_id,request_id) DO UPDATE SET epoch=EXCLUDED.epoch,holder=EXCLUDED.holder,
        delivery_message_id=CASE WHEN norn_requests.epoch=EXCLUDED.epoch THEN norn_requests.delivery_message_id
          ELSE 'norn:'||norn_requests.request_ref||':'||EXCLUDED.epoch END,
        delivered_at=CASE WHEN norn_requests.epoch=EXCLUDED.epoch THEN norn_requests.delivered_at END,
        instance_id=CASE WHEN norn_requests.epoch=EXCLUDED.epoch THEN norn_requests.instance_id END,
        holder_user_id=CASE WHEN norn_requests.epoch=EXCLUDED.epoch THEN norn_requests.holder_user_id END,
        settled_at=COALESCE(norn_requests.settled_at,EXCLUDED.settled_at)`,
      values: [...scope, String(program.channel_id), JSON.stringify(write.requests.map(request => ({
        request_id: request.requestId, request_ref: request.requestRef, epoch: request.epoch, holder: request.holder,
        delivery_message_id: nornDeliveryMessageId(request.requestRef, request.epoch), settled: request.settled })))], maxRows: 0 });
    if (write.notices.length) await tx.query({ name: "norn_notice_write_v1", text: `INSERT INTO data.norn_notices
        (space_id,channel_id,program_id,notice_id,recipient,body)
      SELECT $1,$3,$2,entry.notice_id,entry.recipient,entry.body
      FROM jsonb_to_recordset($4::jsonb) AS entry(notice_id text,recipient text,body text)
      ON CONFLICT (space_id,program_id,notice_id) DO NOTHING`,
      values: [...scope, String(program.channel_id), JSON.stringify(write.notices.map(notice => ({
        notice_id: notice.noticeId, recipient: notice.recipient, body: notice.body })))], maxRows: 0 });
    return result;
  }

  /**
   * Starts the program a committed message carries, and runs its first pass.
   * The message is the program's identity, so a repeat starts nothing.
   */
  async start<T>(input: Scope & { authorKind: "user" | "agent"; authorId: string; authorityUserId: string; source: string;
    /** The Page block the program lives in, when it does. */
    page?: { pageId: string; name: string };
    ledger: (nowMs: number) => unknown }, step: NornStep<T>): Promise<T | undefined> {
    return this.transaction(input.requestId, "start", async tx => {
      const [created] = await tx.query<QueryResultRow>({ name: "norn_program_start_v2", text: `INSERT INTO data.norn_programs
          (space_id,channel_id,program_id,author_kind,author_id,authority_user_id,source,ledger_json,state,page_id,page_name)
        SELECT message.space_id,message.channel_id,message.message_id,$4,$5,$6,$7,'{}'::jsonb,'running',$8,$9
        FROM data.messages message WHERE message.space_id=$1 AND message.channel_id=$2 AND message.message_id=$3
          AND message.deleted_at IS NULL AND message.recalled_at IS NULL
        ON CONFLICT (space_id,program_id) DO NOTHING
        RETURNING *,floor(extract(epoch from clock_timestamp())*1000)::text AS now_millis`,
        values: [this.placement.spaceId, input.channelId, input.programId, input.authorKind, input.authorId,
          input.authorityUserId, input.source, input.page?.pageId ?? null, input.page?.name ?? null], maxRows: 1 });
      if (!created) return undefined;
      return this.pass(tx, { ...created, ledger_json: input.ledger(Number(created.now_millis)) }, step);
    });
  }

  /**
   * The program's text changed where it lives. The same ledger is evaluated
   * against the new text, as whoever changed it: what was already asked in the
   * same words stays asked, and nothing is asked twice.
   */
  async revise<T>(input: Scope & { source: string; authorityUserId: string }, step: NornStep<T>): Promise<T | undefined> {
    return this.transaction(input.requestId, "revise", async tx => {
      const [program] = await tx.query<QueryResultRow>({ name: "norn_program_revise_v1", text: `UPDATE data.norn_programs
        SET source=$4,authority_user_id=$5,updated_at=clock_timestamp()
        WHERE space_id=$1 AND channel_id=$2 AND program_id=$3 AND state='running' RETURNING *`,
        values: [this.placement.spaceId, input.channelId, input.programId, input.source, input.authorityUserId], maxRows: 1 });
      return program ? this.pass(tx, program, step) : undefined;
    });
  }

  /** The program's block left its Page: its next pass ends it and cancels what it left open. */
  async remove(input: Scope): Promise<void> {
    await this.transaction(input.requestId, "remove", tx => tx.query({ name: "norn_program_remove_v1", text: `UPDATE
      data.norn_programs SET stop_reason='Removed from its page',updated_at=clock_timestamp()
      WHERE space_id=$1 AND channel_id=$2 AND program_id=$3 AND state='running' AND stop_reason IS NULL`,
      values: [this.placement.spaceId, input.channelId, input.programId], maxRows: 0 }));
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
      const deliveries = await tx.query<QueryResultRow>({ name: "norn_channel_deliveries_v3", text: `SELECT r.program_id,
          r.request_id,r.request_ref,r.epoch,r.holder,r.delivery_message_id,p.authority_user_id,p.page_id,
          p.ledger_json->'requests'->r.request_id AS request_json,there.instance_id AS there_instance_id,there.mention AS there_mention,
          -- An earlier holding of this request broke off: whoever takes it now reads what that one had done.
          EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p.ledger_json->'evidence')='array'
              THEN p.ledger_json->'evidence' ELSE '[]'::jsonb END) gave_up
            WHERE gave_up->>'request'=r.request_id AND gave_up->>'reason'=$2) AS handed_on,
          -- A person takes part in this program, so what its Agents do is for a person to follow.
          EXISTS (SELECT 1 FROM data.norn_requests person WHERE person.space_id=r.space_id AND person.program_id=r.program_id
            AND person.holder_user_id IS NOT NULL) AS with_person
        FROM data.norn_requests r JOIN data.norn_programs p ON p.space_id=r.space_id AND p.program_id=r.program_id
          -- A Page's program asks the same participant again where it already is: the Instance that last
          -- answered it for this program, if that one still takes messages.
          LEFT JOIN LATERAL (SELECT instance.instance_id,
              '@'||COALESCE(registration.display_name,binding.harness)||':'||instance.channel_instance_id AS mention
            FROM data.norn_requests earlier JOIN data.instances instance ON instance.instance_id=${requestInstance("earlier")}
              JOIN data.run_agent_registrations binding ON binding.run_id=instance.run_id
              LEFT JOIN data.space_agent_registrations registration ON registration.space_id=binding.space_id
                AND registration.owner_user_id=binding.owner_user_id AND registration.machine_id=binding.machine_id
                AND registration.harness=binding.harness
            WHERE p.page_id IS NOT NULL AND earlier.space_id=r.space_id AND earlier.program_id=r.program_id
              -- Whoever fits is chosen anew each time: only a participant asked for by name is asked again where it is.
              AND r.holder<>'@auto' AND earlier.holder=r.holder AND earlier.settled_at IS NOT NULL AND instance.channel_id=r.channel_id
              AND ${instanceTakesMessages("instance")}
              -- A request handed on goes to an Instance that has not had it.
              AND NOT EXISTS (SELECT 1 FROM data.agent_message_executions had WHERE had.instance_id=instance.instance_id
                AND had.channel_id=r.channel_id AND had.source_message_id LIKE 'norn:'||r.request_ref||':%')
            ORDER BY earlier.settled_at DESC LIMIT 1) there ON TRUE
        WHERE r.channel_id=$1 AND r.settled_at IS NULL AND r.delivered_at IS NULL
        ORDER BY r.created_at,r.request_id LIMIT 200`, values: [input.channelId, NORN_HANDED_ON_REASON], maxRows: 200 });
      const reports = await tx.query<QueryResultRow>({ name: "norn_channel_reports_v2", text: `SELECT p.program_id,p.state,
          p.authority_user_id,p.page_id,p.page_name,p.ledger_json->'ended' AS ended_json,
          -- A Page's program that ends is told to people: what it asked and of whom, and who answered it.
          CASE WHEN p.page_id IS NOT NULL THEN p.ledger_json->'requests' END AS requests_json,
          (SELECT COALESCE(jsonb_agg(DISTINCT jsonb_build_object('userId',person.holder_user_id,'name',person.holder)),'[]'::jsonb)
            FROM data.norn_requests person WHERE person.space_id=p.space_id AND person.program_id=p.program_id
              AND person.holder_user_id IS NOT NULL) AS people_json,
          (SELECT COALESCE(NULLIF(h.handle,''),NULLIF(h.name,''),m.display_name) FROM data.space_members m
              LEFT JOIN control.auth_users h ON h.id=m.user_id
            WHERE m.space_id=p.space_id AND m.user_id=p.authority_user_id) AS authority_name,
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
      const releases = await tx.query<QueryResultRow>({ name: "norn_channel_releases_v4", text: `SELECT r.program_id,r.request_id,
          p.authority_user_id,started.run_id,started.mention
        FROM data.norn_requests r JOIN data.norn_programs p ON p.space_id=r.space_id AND p.program_id=r.program_id
          LEFT JOIN LATERAL (SELECT CASE WHEN run.status IN ('starting','running') THEN run.run_id END AS run_id,
              lower(registration.display_name||':'||instance.channel_instance_id::text) AS mention
            FROM data.instances instance JOIN data.runs run ON run.run_id=instance.run_id
              JOIN data.run_agent_registrations binding ON binding.run_id=instance.run_id
              JOIN data.space_agent_registrations registration ON registration.space_id=binding.space_id
                AND registration.owner_user_id=binding.owner_user_id AND registration.machine_id=binding.machine_id
                AND registration.harness=binding.harness
            WHERE instance.instance_id=${requestInstance("r")} LIMIT 1) started ON TRUE
        WHERE r.channel_id=$1 AND ${NORN_REQUEST_UNRELEASED_SQL} ORDER BY r.settled_at,r.request_id LIMIT 200`, values, maxRows: 200 });
      // A person's request that has ended: its card is told how, and stops waiting on them.
      const closings = await tx.query<QueryResultRow>({ name: "norn_channel_closings_v1", text: `SELECT r.program_id,r.request_id,
          r.holder,r.holder_user_id,r.delivery_message_id,p.ledger_json->'requests'->r.request_id->'reply' AS reply_json
        FROM data.norn_requests r JOIN data.norn_programs p ON p.space_id=r.space_id AND p.program_id=r.program_id
        WHERE r.channel_id=$1 AND ${NORN_REQUEST_UNCLOSED_SQL} ORDER BY r.settled_at,r.request_id LIMIT 200`, values, maxRows: 200 });
      const notices = await tx.query<QueryResultRow>({ name: "norn_channel_notices_v1", text: `SELECT n.program_id,n.notice_id,
          n.recipient,n.body,p.authority_user_id,p.page_id
        FROM data.norn_notices n JOIN data.norn_programs p ON p.space_id=n.space_id AND p.program_id=n.program_id
        WHERE n.channel_id=$1 AND n.posted_at IS NULL ORDER BY n.created_at,n.notice_id LIMIT 200`, values, maxRows: 200 });
      return {
        closings: closings.map(row => ({ programId: String(row.program_id), requestId: String(row.request_id),
          holder: String(row.holder), holderUserId: String(row.holder_user_id), deliveryMessageId: String(row.delivery_message_id),
          reply: row.reply_json as unknown })),
        notices: notices.map(row => ({ programId: String(row.program_id), noticeId: String(row.notice_id),
          recipient: String(row.recipient), body: String(row.body), authorityUserId: String(row.authority_user_id),
          onPage: row.page_id !== null })),
        releases: releases.map(row => ({ programId: String(row.program_id), requestId: String(row.request_id),
          authorityUserId: String(row.authority_user_id), runId: typeof row.run_id === "string" ? row.run_id : null,
          mention: typeof row.mention === "string" ? row.mention : null })),
        passes: passes.map(row => String(row.program_id)),
        deliveries: deliveries.map(row => ({ programId: String(row.program_id), requestId: String(row.request_id),
          requestRef: String(row.request_ref), epoch: Number(row.epoch), holder: String(row.holder),
          deliveryMessageId: String(row.delivery_message_id), authorityUserId: String(row.authority_user_id),
          onPage: row.page_id !== null, handedOn: row.handed_on === true, withPerson: row.with_person === true,
          there: typeof row.there_instance_id === "string" && typeof row.there_mention === "string"
            ? { instanceId: row.there_instance_id, mention: row.there_mention } : null,
          request: row.request_json as unknown })),
        reports: reports.map(row => ({ programId: String(row.program_id), state: String(row.state),
          authorMention: typeof row.author_mention === "string" ? row.author_mention : null, onPage: row.page_id !== null,
          name: typeof row.page_name === "string" ? row.page_name : null,
          authorityUserId: String(row.authority_user_id), ended: row.ended_json as unknown, requests: row.requests_json as unknown,
          authorityName: typeof row.authority_name === "string" ? row.authority_name : null,
          people: (Array.isArray(row.people_json) ? row.people_json as { userId?: unknown; name?: unknown }[] : [])
            .flatMap(person => typeof person.userId === "string" && typeof person.name === "string"
              ? [{ userId: person.userId, name: person.name }] : []) })),
      };
    });
  }

  /** The delivery message of this holding was appended and its launch dispatched. */
  async delivered(input: Scope & { ledgerRequestId: string; epoch: number;
    /** The Instance the request was handed to, when it went to one already there. */
    instanceId?: string;
    /** The person the request went to. */
    holderUserId?: string }): Promise<void> {
    await this.transaction(input.requestId, "delivered", tx => tx.query({ name: "norn_request_delivered_v3", text: `UPDATE
      data.norn_requests SET delivered_at=clock_timestamp(),instance_id=$5,holder_user_id=$6 WHERE space_id=$1 AND program_id=$2
        AND request_id=$3 AND epoch=$4 AND delivered_at IS NULL`, values: [this.placement.spaceId, input.programId,
        input.ledgerRequestId, input.epoch, input.instanceId ?? null, input.holderUserId ?? null], maxRows: 0 }));
  }

  /**
   * The people a name addresses in this conversation: each member who can
   * read it and whose name or handle is `matches`. The caller delivers only
   * when that is exactly one person.
   */
  async people(input: { requestId: string; channelId: string; matches: (name: string) => boolean }): Promise<string[]> {
    return this.transaction(input.requestId, "people", async tx => {
      const rows = await tx.query<QueryResultRow>({ name: "norn_channel_people_v1", text: `SELECT m.user_id,
          COALESCE(NULLIF(h.name,''),m.display_name,'') AS name,h.handle
        FROM data.channels c JOIN data.space_members m ON m.space_id=c.space_id LEFT JOIN control.auth_users h ON h.id=m.user_id
        WHERE c.space_id=$1 AND c.channel_id=$2 AND ${channelCapabilityPredicate({ capability: "message_content_read",
          channelAlias: "c", principalKindSql: "'user'", principalIdSql: "m.user_id" })}
        ORDER BY m.user_id LIMIT 10000`, values: [this.placement.spaceId, input.channelId], maxRows: 10_000 });
      return rows.filter(row => [row.name, row.handle].some(name => typeof name === "string" && name && input.matches(name)))
        .map(row => String(row.user_id));
    });
  }

  /** The open request this person holds by its reference; undefined when there is none. */
  async personRequest(input: { requestId: string; requestRef: string; userId: string }) {
    return this.transaction(input.requestId, "person-request", async tx => {
      const [row] = await tx.query<QueryResultRow>({ name: "norn_request_person_v1", text: `SELECT r.channel_id,r.program_id,
          r.request_id,r.epoch,r.delivery_message_id FROM data.norn_requests r
        WHERE r.space_id=$1 AND r.request_ref=$2 AND r.holder_user_id=$3 AND r.settled_at IS NULL AND r.delivered_at IS NOT NULL
        LIMIT 1`, values: [this.placement.spaceId, input.requestRef, input.userId], maxRows: 1 });
      return row ? { channelId: String(row.channel_id), programId: String(row.program_id), ledgerRequestId: String(row.request_id),
        epoch: Number(row.epoch), deliveryMessageId: String(row.delivery_message_id) } : undefined;
    });
  }

  /** The Instance this ended request started was stopped or retired, or had already gone. */
  async released(input: Scope & { ledgerRequestId: string }): Promise<void> {
    await this.transaction(input.requestId, "released", tx => tx.query({ name: "norn_request_released_v1", text: `UPDATE
      data.norn_requests SET released_at=clock_timestamp() WHERE space_id=$1 AND program_id=$2 AND request_id=$3
        AND settled_at IS NOT NULL AND released_at IS NULL`, values: [this.placement.spaceId, input.programId, input.ledgerRequestId],
      maxRows: 0 }));
  }

  /** What the program said was posted to its conversation. */
  async noticed(input: Scope & { noticeId: string }): Promise<void> {
    await this.transaction(input.requestId, "noticed", tx => tx.query({ name: "norn_notice_posted_v1", text: `UPDATE
      data.norn_notices SET posted_at=clock_timestamp() WHERE space_id=$1 AND program_id=$2 AND notice_id=$3
        AND posted_at IS NULL`, values: [this.placement.spaceId, input.programId, input.noticeId], maxRows: 0 }));
  }

  /** The program's end was told to the Channel. */
  async reported(input: Scope): Promise<void> {
    await this.transaction(input.requestId, "reported", tx => tx.query({ name: "norn_program_reported_v1", text: `UPDATE
      data.norn_programs SET reported_at=clock_timestamp() WHERE space_id=$1 AND program_id=$2 AND state<>'running'
        AND reported_at IS NULL`, values: [this.placement.spaceId, input.programId], maxRows: 0 }));
  }

  /**
   * The open request a Run answers by its reference. The Run holds it only if
   * the request's delivery message started the Run or one of its turns, or the
   * request was handed to the Run's Instance.
   */
  async heldRequest(input: { requestId: string; channelId: string; requestRef: string; runId: string; instanceId: string }) {
    return this.transaction(input.requestId, "held-request", async tx => {
      const [row] = await tx.query<QueryResultRow>({ name: "norn_request_held_v2", text: `SELECT r.program_id,r.request_id,r.epoch,
          r.holder,r.settled_at,(r.instance_id=$5 OR EXISTS (SELECT 1 FROM data.agent_launches launch WHERE launch.run_id=$4
              AND launch.channel_id=r.channel_id AND launch.trigger_id=r.delivery_message_id)
            OR EXISTS (SELECT 1 FROM data.agent_message_executions execution WHERE execution.run_id=$4
              AND execution.channel_id=r.channel_id AND execution.source_message_id=r.delivery_message_id)) AS held
        FROM data.norn_requests r WHERE r.space_id=$1 AND r.channel_id=$2 AND r.request_ref=$3 LIMIT 1`,
        values: [this.placement.spaceId, input.channelId, input.requestRef, input.runId, input.instanceId], maxRows: 1 });
      if (!row) throw unavailable();
      if (row.held !== true) throw new ControlError("norn_request_not_held", 403, "This request is not yours to answer");
      if (row.settled_at !== null) throw new ControlError("norn_request_ended", 409, "The request has already ended");
      return { programId: String(row.program_id), requestId: String(row.request_id), epoch: Number(row.epoch), holder: String(row.holder) };
    });
  }

  /** The open requests this Run holds, and those of the programs its Instance started. */
  async openRequests(input: { requestId: string; channelId: string; runId: string; instanceId: string }) {
    return this.transaction(input.requestId, "open-requests", async tx => (await tx.query<QueryResultRow>({
      name: "norn_requests_open_v2", text: `SELECT r.request_ref,r.holder,r.program_id,
          p.ledger_json->'requests'->r.request_id->>'text' AS text,
          p.ledger_json->'requests'->r.request_id->>'by' AS by_millis,
          (p.author_kind='agent' AND p.author_id=$4) AS asked,
          (r.instance_id=$4 OR EXISTS (SELECT 1 FROM data.agent_launches launch WHERE launch.run_id=$3
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

class NornSpaceError extends ControlError {
  constructor(code: string, status: number) { super(code, status, "The Space is unavailable"); }
}

/**
 * A request by its reference, as `userId` may see it: only if they can read
 * its conversation. Undefined otherwise, the same for "no such request".
 */
export async function readNornRequest(database: AuthorityDatabase, input: { requestId: string; spaceId: string; requestRef: string; userId: string }) {
  return inActiveSpace(database, { requestId: input.requestId, operation: "norn.request", spaceId: input.spaceId }, NornSpaceError,
    async tx => {
      const [row] = await tx.query<QueryResultRow>({ name: "norn_request_view_v1", text: `SELECT r.channel_id,r.holder,
          p.ledger_json->'requests'->r.request_id AS request_json
        FROM data.norn_requests r JOIN data.norn_programs p ON p.space_id=r.space_id AND p.program_id=r.program_id
          JOIN data.channels c ON c.space_id=r.space_id AND c.channel_id=r.channel_id
        WHERE r.space_id=$1 AND r.request_ref=$2 AND ${channelCapabilityPredicate({ capability: "message_content_read",
          channelAlias: "c", principalKindSql: "'user'", principalIdSql: "$3" })} LIMIT 1`,
        values: [input.spaceId, input.requestRef, input.userId], maxRows: 1 });
      return row ? { channelId: String(row.channel_id), holder: String(row.holder), request: row.request_json as unknown } : undefined;
    });
}

/**
 * A program by its message, as `userId` may see it: only if they can read its
 * conversation. Undefined otherwise, the same for "no such program".
 */
export async function readNornProgram(database: AuthorityDatabase, input: { requestId: string; spaceId: string; programId: string; userId: string }) {
  return inActiveSpace(database, { requestId: input.requestId, operation: "norn.program", spaceId: input.spaceId }, NornSpaceError,
    async tx => {
      const [row] = await tx.query<QueryResultRow>({ name: "norn_program_view_v1", text: `SELECT p.channel_id,p.page_name,p.source,p.state,p.ledger_json
        FROM data.norn_programs p JOIN data.channels c ON c.space_id=p.space_id AND c.channel_id=p.channel_id
        WHERE p.space_id=$1 AND p.program_id=$2 AND ${channelCapabilityPredicate({ capability: "message_content_read",
          channelAlias: "c", principalKindSql: "'user'", principalIdSql: "$3" })} LIMIT 1`,
        values: [input.spaceId, input.programId, input.userId], maxRows: 1 });
      return row ? { channelId: String(row.channel_id), name: row.page_name === null ? null : String(row.page_name),
        source: String(row.source), state: String(row.state), ledger: row.ledger_json as unknown } : undefined;
    });
}

/**
 * The latest program of each named block of a Page, with its ledger. Read by
 * Space, because a Page's programs each work in a conversation of their own.
 * The caller has read the Page as whoever asks.
 */
export async function readPageNornPrograms(database: AuthorityDatabase, input: { requestId: string; spaceId: string; pageId: string }) {
  return inActiveSpace(database, { requestId: input.requestId, operation: "norn.page-programs", spaceId: input.spaceId }, NornSpaceError,
    async tx => (await tx.query<QueryResultRow>({
      name: "norn_page_programs_v1", text: `SELECT DISTINCT ON (p.page_name) p.page_name,p.program_id,p.channel_id,p.source,p.state,
          p.ledger_json,(SELECT count(*) FROM data.norn_programs earlier WHERE earlier.space_id=p.space_id
            AND earlier.page_id=p.page_id AND earlier.page_name=p.page_name)::int AS runs
        FROM data.norn_programs p WHERE p.space_id=$1 AND p.page_id=$2
        ORDER BY p.page_name,p.created_at DESC LIMIT 200`, values: [input.spaceId, input.pageId], maxRows: 200 }))
      .map(row => ({ name: String(row.page_name), programId: String(row.program_id), channelId: String(row.channel_id),
        source: String(row.source), state: String(row.state), runs: Number(row.runs), ledger: row.ledger_json as unknown })));
}

/**
 * The running programs on this shard that wait on an outside stream, with
 * what each waits on, for an event to be matched against. Only a program
 * whose authority may use its Space's connected apps now is told of an event:
 * owner, admin or member, as for a Page's schedule.
 */
export async function readWaitingNornPrograms(database: AuthorityDatabase, input: { requestId: string; spaceId?: string }) {
  return database.transaction({ requestId: input.requestId, operation: "norn.waiting-programs" }, async tx =>
    (await tx.query<QueryResultRow>({ name: "norn_waiting_programs_v1", text: `SELECT p.space_id,p.channel_id,p.program_id,
        p.authority_user_id,p.waits_json
      FROM data.norn_programs p JOIN data.space_members member ON member.space_id=p.space_id
        AND member.user_id=p.authority_user_id AND member.role NOT IN ('viewer','participant')
      WHERE p.state='running' AND p.waits_json IS NOT NULL AND ($1::text IS NULL OR p.space_id=$1)
      ORDER BY p.program_id LIMIT 1000`, values: [input.spaceId ?? null], maxRows: 1000 }))
      .map(row => ({ spaceId: String(row.space_id), channelId: String(row.channel_id), programId: String(row.program_id),
        authorityUserId: String(row.authority_user_id), waits: Array.isArray(row.waits_json) ? row.waits_json as unknown[] : [] })));
}
