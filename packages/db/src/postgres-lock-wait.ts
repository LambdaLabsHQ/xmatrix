import type { ClientConfig, QueryResult } from "pg";

const STATES = ["active", "idle in transaction", "idle in transaction (aborted)", "idle", "unknown"];
const WAITS = ["Lock", "Client", "IO", "IPC", "LWLock", "Timeout", "Activity", "BufferPin", "none", "other"];
const OWNERS = ["execution-report", "runtime", "message", "launch", "other"];
interface Backend {
  state: string;
  wait: string;
  owner: string;
  ageMs: number;
}
export interface PostgresLockWait {
  status: "sampled" | "missing" | "busy" | "unavailable";
  waiter?: Backend;
  blockers: readonly Backend[];
}

/** Shared by capture and the Sentry reader; reject unknown fields, labels and identities. */
export function parsePostgresLockWait(value: unknown): PostgresLockWait | undefined {
  if (!value || typeof value !== "object") return;
  const item = value as PostgresLockWait;
  if (Object.keys(item).some(key => !["status", "waiter", "blockers"].includes(key)) ||
      !["sampled", "missing", "busy", "unavailable"].includes(item.status) ||
      !Array.isArray(item.blockers) || item.blockers.length > 4) return;
  const valid = (backend: Backend) => backend && Object.keys(backend).length === 4 &&
    Object.keys(backend).every(key => ["state", "wait", "owner", "ageMs"].includes(key)) &&
    STATES.includes(backend.state) && WAITS.includes(backend.wait) && OWNERS.includes(backend.owner) &&
    Number.isSafeInteger(backend.ageMs) && backend.ageMs >= 0 && backend.ageMs <= 120_000;
  if (item.status === "sampled" ? !valid(item.waiter!) : item.waiter !== undefined || item.blockers.length) return;
  if (!item.blockers.every(valid)) return;
  return Object.freeze({ status: item.status, ...(item.waiter ? { waiter: Object.freeze({ ...item.waiter }) } : {}),
    blockers: Object.freeze(item.blockers.map(backend => Object.freeze({ ...backend }))) });
}

interface DiagnosticClient {
  on?(event: "error", listener: () => void): unknown;
  connect(): Promise<unknown>;
  query(input: { text: string; values: unknown[] }): Promise<QueryResult>;
  end(): Promise<void>;
}
// At most one extra connection per isolate, only while the execution-owner query is slow.
let sampling = false;
const projection = (alias: string) => `json_build_object(
  'state',CASE WHEN ${alias}.state IN ('active','idle in transaction','idle in transaction (aborted)','idle')
    THEN ${alias}.state ELSE 'unknown' END,
  'wait',CASE WHEN ${alias}.wait_event_type IS NULL THEN 'none'
    WHEN ${alias}.wait_event_type IN ('Lock','Client','IO','IPC','LWLock','Timeout','Activity','BufferPin')
    THEN ${alias}.wait_event_type ELSE 'other' END,
  'owner',CASE ${alias}.application_name WHEN 'xmatrix-execution-report' THEN 'execution-report'
    WHEN 'xmatrix-hub-runtime' THEN 'runtime' WHEN 'xmatrix-hub-message-authority' THEN 'message'
    WHEN 'xmatrix-agent-launch-coordinator' THEN 'launch' ELSE 'other' END,
  'ageMs',LEAST(120000,GREATEST(0,COALESCE(EXTRACT(epoch FROM (clock_timestamp()-${alias}.xact_start))*1000,0)))::int)`;

/** Sample while the row lock is still waiting: after 55P03 the wait edge has already disappeared. */
async function sample(backendPid: number, config: ClientConfig,
  factory: (config: ClientConfig) => DiagnosticClient): Promise<PostgresLockWait> {
  if (sampling) return { status: "busy", blockers: [] };
  sampling = true;
  let client: DiagnosticClient | undefined;
  try {
    client = factory({ ...config, application_name: "xmatrix-lock-diagnostic",
      connectionTimeoutMillis: 250, query_timeout: 250, statement_timeout: 250 });
    // A direct pg Client also emits connection errors; diagnostic transport
    // failures must not become an uncaught event on the command's request.
    client.on?.("error", () => {});
    await client.connect();
    const result = await client.query({ text: `SELECT ${projection("waiter")} AS waiter,
        CASE WHEN blocker.pid IS NOT NULL THEN ${projection("blocker")} END AS blocker
      FROM pg_stat_activity waiter
      LEFT JOIN LATERAL (SELECT unnest(pg_blocking_pids(waiter.pid)) AS pid LIMIT 4) blocked ON true
      LEFT JOIN pg_stat_activity blocker ON blocker.pid=blocked.pid
      WHERE waiter.pid=$1 AND waiter.datname=current_database() LIMIT 4`, values: [backendPid] });
    return parsePostgresLockWait(result.rows.length ? { status: "sampled", waiter: result.rows[0]!.waiter,
      blockers: result.rows.flatMap(row => row.blocker ? [row.blocker] : []) }
      : { status: "missing", blockers: [] }) ?? { status: "unavailable", blockers: [] };
  } catch {
    return { status: "unavailable", blockers: [] };
  } finally {
    await client?.end().catch(() => undefined);
    sampling = false;
  }
}

/** The owner awaits any started sample; fast queries cancel the timer without opening a connection. */
export function watchExecutionOwnerWait(queryName: string, backendPid: number | undefined,
  options: { connectionString: string; lockTimeoutMs: number; clientFactory: (config: ClientConfig) => DiagnosticClient },
): (() => Promise<PostgresLockWait | undefined>) | undefined {
  if (queryName !== "runtime_execution_report_owner_v4" || !backendPid) return;
  let pending: Promise<PostgresLockWait> | undefined;
  const timer = setTimeout(() => {
    pending = sample(backendPid, { connectionString: options.connectionString }, options.clientFactory);
  }, Math.min(500, Math.max(1, Math.floor(options.lockTimeoutMs / 2))));
  return async () => { clearTimeout(timer); return pending; };
}
