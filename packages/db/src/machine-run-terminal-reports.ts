import type { QueryResultRow } from "pg";
import type { AuthorityDatabase, DatabaseTransaction } from "./contracts.js";

export type MachineRunTerminalEvent = "machine_run_exited" | "machine_stop_result";

/** A committed terminal report the coordinator still has to finalize. */
export interface MachineRunTerminalReport {
  runId: string;
  eventType: MachineRunTerminalEvent;
  ownerUserId: string;
  ownerEmail: string;
  machineId: string;
  hostId: string;
  hostName?: string;
  channelId: string;
  connectionEpoch: number;
  requestId: string;
  payload: Record<string, unknown>;
  stopPurpose?: "reborn-predecessor";
  attempts: number;
  leaseOwner: string;
}

const CLAIM_LIMIT = 20;
const LEASE_SECONDS = 60;
const MAX_BACKOFF_SECONDS = 300;

/**
 * Recorded inside the machine-control transaction that accepts the report, so
 * the daemon's acknowledgement means the Authority owns the Run's
 * finalization. The first report of each (Run, event) wins; a retried report
 * finds its row and changes nothing.
 */
export async function recordMachineRunTerminalReport(tx: DatabaseTransaction, input: {
  runId: string; eventType: MachineRunTerminalEvent; ownerUserId: string; ownerEmail: string;
  machineId: string; hostId: string; hostName?: string; channelId: string; connectionEpoch: number;
  requestId: string; payload: Record<string, unknown>; stopPurpose?: "reborn-predecessor";
}): Promise<void> {
  await tx.query({ name: "machine_run_terminal_report_record_v1", text: `INSERT INTO
    data.machine_run_terminal_reports
    (run_id,event_type,owner_user_id,owner_email,machine_id,hostname,channel_id,
     connection_epoch,request_id,payload_json,stop_purpose)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11)
    ON CONFLICT (run_id,event_type) DO NOTHING`, values: [input.runId, input.eventType,
    input.ownerUserId, input.ownerEmail, input.machineId, input.hostName || input.hostId || null,
    input.channelId, input.connectionEpoch, input.requestId, JSON.stringify(input.payload),
    input.stopPurpose ?? null], maxRows: 0 });
}

function report(row: QueryResultRow): MachineRunTerminalReport {
  return {
    runId: String(row.run_id), eventType: String(row.event_type) as MachineRunTerminalEvent,
    ownerUserId: String(row.owner_user_id), ownerEmail: String(row.owner_email),
    machineId: String(row.machine_id), hostId: row.hostname == null ? "" : String(row.hostname),
    ...(row.hostname ? { hostName: String(row.hostname) } : {}),
    channelId: String(row.channel_id), connectionEpoch: Number(row.connection_epoch),
    requestId: String(row.request_id), payload: row.payload_json as Record<string, unknown>,
    ...(row.stop_purpose === "reborn-predecessor" ? { stopPurpose: "reborn-predecessor" as const } : {}),
    attempts: Number(row.attempts), leaseOwner: String(row.lease_owner),
  };
}

/** Coordinator side: bounded, leased claims and exact settlements. */
export class PostgresMachineRunTerminalReportRepository {
  constructor(private readonly database: AuthorityDatabase) {}

  async claim(leaseOwner: string, channelId: string): Promise<MachineRunTerminalReport[]> {
    return this.database.transaction({ requestId: leaseOwner, operation: "machine.run-terminal.claim" },
      async (tx) => (await tx.query<QueryResultRow>({ name: "machine_run_terminal_report_claim_v2",
        text: `WITH due AS (
          SELECT run_id,event_type FROM data.machine_run_terminal_reports
          WHERE channel_id=$2 AND state='pending' AND next_attempt_at<=clock_timestamp()
            AND (lease_until IS NULL OR lease_until<clock_timestamp())
          ORDER BY next_attempt_at,run_id,event_type LIMIT ${CLAIM_LIMIT} FOR UPDATE SKIP LOCKED
        ) UPDATE data.machine_run_terminal_reports report SET lease_owner=$1,
          lease_until=clock_timestamp()+interval '${LEASE_SECONDS} seconds',attempts=report.attempts+1
        FROM due WHERE report.run_id=due.run_id AND report.event_type=due.event_type
        RETURNING report.*`, values: [leaseOwner, channelId], maxRows: CLAIM_LIMIT })).map(report));
  }

  /** Finalized rows are kept a week for diagnosis, then deleted in bounded batches. */
  async pruneFinalized(channelId: string): Promise<number> {
    return this.database.transaction({ requestId: `machine-run-terminal-prune:${crypto.randomUUID()}`,
      operation: "machine.run-terminal.prune" }, async (tx) => (await tx.query({
      name: "machine_run_terminal_report_prune_v2", text: `DELETE FROM data.machine_run_terminal_reports
        WHERE (run_id,event_type) IN (SELECT run_id,event_type FROM data.machine_run_terminal_reports
          WHERE channel_id=$1 AND state='finalized' AND finalized_at<clock_timestamp()-interval '7 days'
          ORDER BY finalized_at LIMIT 500 FOR UPDATE SKIP LOCKED) RETURNING run_id`,
      values: [channelId], maxRows: 500 })).length);
  }

  /** Finalized, or retried with exponential backoff. Only the lease holder may settle. */
  async settle(input: { report: MachineRunTerminalReport; finalized: boolean; errorCode?: string }): Promise<void> {
    const { report: claimed } = input;
    const backoffSeconds = Math.min(MAX_BACKOFF_SECONDS, 2 ** Math.min(claimed.attempts, 9));
    await this.database.transaction({ requestId: claimed.leaseOwner, operation: "machine.run-terminal.settle" },
      (tx) => tx.query({ name: "machine_run_terminal_report_settle_v1", text: `UPDATE
        data.machine_run_terminal_reports SET
          state=CASE WHEN $4 THEN 'finalized' ELSE 'pending' END,
          finalized_at=CASE WHEN $4 THEN clock_timestamp() ELSE NULL END,
          next_attempt_at=CASE WHEN $4 THEN next_attempt_at
            ELSE clock_timestamp()+make_interval(secs => $5) END,
          last_error_code=$6,lease_owner=NULL,lease_until=NULL
        WHERE run_id=$1 AND event_type=$2 AND lease_owner=$3 AND state='pending'`,
      values: [claimed.runId, claimed.eventType, claimed.leaseOwner, input.finalized, backoffSeconds,
        input.errorCode?.slice(0, 200) ?? null], maxRows: 0 }));
  }
}
