import type { ClientConfig, QueryResult } from "pg";

const STATES = ["active", "idle in transaction", "idle in transaction (aborted)", "idle", "unknown"];
const WAITS = ["Lock", "Client", "IO", "IPC", "LWLock", "Timeout", "Activity", "BufferPin", "none", "other"];
const OWNERS = ["execution-report", "runtime", "message", "launch", "catalog", "other"];
/** A transaction's `application_name` is `<application> <operation>` (PostgreSQL keeps
 * 63 bytes), so a lock's evidence names the operation holding it as `op:<operation>`. */
const OPERATION_OWNER = /^op:[a-z][a-z0-9_.:-]{0,61}$/u;
// Only these code-owned labels can cross from pg_stat_activity into diagnostics.
const CONTENT_LOCK_QUERIES = [
  "channel_capability_content_new_work_v3", "channel_capability_content_terminalize_v3",
  "content_authorize_user_v2", "content_authorize_agent_v3", "content_idempotency_read_v1",
  "content_restricted_object_fence_v1", "content_restricted_retirement_v1",
  "content_intent_existing_v1", "content_intent_gc_cancel_v1", "content_intent_insert_v1",
  "content_decision_intent_mark_v1", "content_ref_existing_v1", "content_ref_intent_lock_v1",
  "content_object_insert_v1", "content_object_lock_v1", "content_ref_insert_v1",
  "content_object_holders_v1", "content_ref_owner_hold_v1", "content_ref_intent_consume_v1",
  "content_ref_gc_cancel_v1", "storage_usage_meter_v1", "storage_usage_open_v1",
  "official_space_billing_mutex_v1", "official_space_apple_pending_v1",
  "official_space_seat_subscription_v1", "official_space_seat_count_v1",
  "content_head_advance_v1", "content_outbox_v1", "content_idempotency_write_v1", "unclassified",
];

/** No extra round trip: retain only a fixed label on the two known content lock holders. */
export function contentLockQueryText(operation: string, name: string, text: string): string {
  if (operation !== "content.ref.commit" && operation !== "content.intent.create") return text;
  const label = CONTENT_LOCK_QUERIES.includes(name) ? name : "unclassified";
  return `/* xmatrix-content:${label} */ ${text}`;
}

interface Backend {
  state: string;
  wait: string;
  owner: string;
  ageMs: number;
  queryName?: string;
  queryAgeMs?: number;
  stateAgeMs?: number;
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
  const duration = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= 120_000;
  const valid = (backend: Backend) => backend &&
    Object.keys(backend).every(key => ["state", "wait", "owner", "ageMs", "queryName", "queryAgeMs", "stateAgeMs"].includes(key)) &&
    STATES.includes(backend.state) && WAITS.includes(backend.wait) &&
    (OWNERS.includes(backend.owner) || OPERATION_OWNER.test(backend.owner)) && duration(backend.ageMs) &&
    (backend.queryName === undefined || CONTENT_LOCK_QUERIES.includes(backend.queryName)) &&
    (backend.queryAgeMs === undefined || duration(backend.queryAgeMs)) &&
    (backend.stateAgeMs === undefined || duration(backend.stateAgeMs));
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
// Lock and single-read diagnostics share at most one extra connection per isolate.
let sampling = false;
const age = (expression: string) =>
  `LEAST(120000,GREATEST(0,COALESCE(EXTRACT(epoch FROM (clock_timestamp()-${expression}))*1000,0)))::int`;
const projection = (alias: string) => `json_strip_nulls(json_build_object(
  'state',CASE WHEN ${alias}.state IN ('active','idle in transaction','idle in transaction (aborted)','idle')
    THEN ${alias}.state ELSE 'unknown' END,
  'wait',CASE WHEN ${alias}.wait_event_type IS NULL THEN 'none'
    WHEN ${alias}.wait_event_type IN ('Lock','Client','IO','IPC','LWLock','Timeout','Activity','BufferPin')
    THEN ${alias}.wait_event_type ELSE 'other' END,
  'owner',CASE WHEN ${alias}.application_name ~ '^[^ ]+ [a-z][a-z0-9_.:-]{0,61}$'
      THEN 'op:'||split_part(${alias}.application_name,' ',2)
    ELSE CASE ${alias}.application_name WHEN 'xmatrix-execution-report' THEN 'execution-report'
    WHEN 'xmatrix-hub-runtime' THEN 'runtime' WHEN 'xmatrix-hub-message-authority' THEN 'message'
    WHEN 'xmatrix-agent-launch-coordinator' THEN 'launch'
    WHEN 'xmatrix-hub-channel-catalog' THEN 'catalog' ELSE 'other' END END,
  'ageMs',${age(`${alias}.xact_start`)},
  'queryAgeMs',${age(`${alias}.query_start`)},
  'stateAgeMs',${age(`${alias}.state_change`)},
  'queryName',CASE WHEN split_part(${alias}.query,' */ ',1) IN
    (${CONTENT_LOCK_QUERIES.map(name => `'/* xmatrix-content:${name}'`).join(",")})
    THEN substring(split_part(${alias}.query,' */ ',1) FROM 20) END))`;

/** Sample while the row lock is still waiting: after 55P03 the wait edge has already disappeared. */
async function sample(selector: number | string, config: ClientConfig,
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
      WHERE ${typeof selector === "number" ? "waiter.pid=$1" : "starts_with(waiter.query,$1) AND waiter.pid<>pg_backend_pid() AND waiter.state='active'"}
        AND waiter.datname=current_database() LIMIT 4`, values: [selector] });
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
export function watchPostgresLockWait(queryName: string, backendPid: number | undefined,
  options: { connectionString: string; lockTimeoutMs: number; clientFactory: (config: ClientConfig) => DiagnosticClient },
): (() => Promise<PostgresLockWait | undefined>) | undefined {
  if (!(["runtime_execution_report_owner_v5", "message_append_preflight_v4", "channel_mutation_root_lock_v2",
    "channel_mutation_head_advance_v1",
    // HUB-BJ: every daemon command first waits on its Machine's advisory scope.
    "machine_control_scope_lock_v2",
    // HUB-BH: runtime commits also contend on the shared Space control head.
    "runtime_control_head_advance_v1", "machine_lifecycle_head_advance_v1"].includes(queryName) ||
      // Every Channel capability check and lifecycle lock waits on the same Channel row (HUB-AZ, HUB-BA).
      /^channel_(capability|lifecycle_lock)_[a-z_]+_v[0-9]+$/u.test(queryName)) || !backendPid) return;
  return watch(backendPid, Math.min(500, Math.max(1, Math.floor(options.lockTimeoutMs / 2))), options);
}

/** A single read has no stable backend PID through transaction pooling. Match only
 * this attempt's ephemeral SQL prefix; never retain that prefix in the evidence. */
export function watchPostgresReadWait(queryName: string, text: string,
  options: { connectionString: string; clientFactory: (config: ClientConfig) => DiagnosticClient },
): { text: string; finish: () => Promise<PostgresLockWait | undefined> } | undefined {
  if (queryName !== "space_placement_resolve_v1" && !queryName.startsWith("channel_catalog_")) return;
  const prefix = `/* xmatrix-read-${crypto.randomUUID()} */`;
  return { text: `${prefix} ${text}`, finish: watch(prefix, 500, options) };
}

function watch(selector: number | string, delayMs: number,
  options: { connectionString: string; clientFactory: (config: ClientConfig) => DiagnosticClient },
): () => Promise<PostgresLockWait | undefined> {
  let pending: Promise<PostgresLockWait> | undefined;
  const timer = setTimeout(() => {
    pending = sample(selector, { connectionString: options.connectionString }, options.clientFactory);
  }, delayMs);
  return async () => { clearTimeout(timer); return pending; };
}
