import { databaseFailureEvidence } from "@xmatrix/db";
import { reportError } from "@xmatrix/protocol/error-reporting";

const LOCK_MODES = new Set(["AccessShareLock", "RowShareLock", "RowExclusiveLock", "ShareUpdateExclusiveLock",
  "ShareLock", "ShareRowExclusiveLock", "ExclusiveLock", "AccessExclusiveLock"]);
const RELATIONS = new Set(["runs", "instances", "run_agent_registrations", "channels", "page_claims",
  "pages", "page_revisions", "space_agent_registrations", "space_agent_registration_access"]);

/** Only the wait graph and known relation survive; never DETAIL's SQL or tuple values. */
export function postgresConflictDiagnostic(error: unknown): Record<string, string> {
  const value = error as { code?: unknown; detail?: unknown; where?: unknown } | null;
  if (value?.code !== "40P01") return {};
  const detail = typeof value.detail === "string" ? value.detail.slice(0, 8_000) : "";
  const processes = new Map<string, number>();
  const process = (id: string) => {
    if (!processes.has(id)) processes.set(id, processes.size + 1);
    return processes.get(id)!;
  };
  const edges: string[] = [];
  for (const match of detail.matchAll(/Process (\d+) waits for ([A-Za-z]+) on (transaction|relation|tuple|object) [^;\n]{1,100}; blocked by process (\d+)\./gu)) {
    if (edges.length === 4) break;
    if (LOCK_MODES.has(match[2]!)) edges.push(`${process(match[1]!)}>${process(match[4]!)}:${match[2]}:${match[3]}`);
  }
  const where = typeof value.where === "string" ? value.where.slice(0, 1_000) : "";
  const relation = /while (?:locking|updating|deleting) tuple \(\d+,\d+\) in relation "([a-z_]+)"/u.exec(where)?.[1];
  return { postgres_conflict_locks: edges.join(";") || "unavailable",
    postgres_conflict_relation: relation && RELATIONS.has(relation) ? relation : "unavailable" };
}

/** One exception event retains the failing named query and PG's bounded wait graph. */
export function reportPostgresConflict(error: unknown): void {
  const attempts = databaseFailureEvidence(error);
  reportError(error, { operation: "postgres.transaction-conflict", ids: {
    ...(attempts.length ? { database_failure_attempts: JSON.stringify(attempts) } : {}),
    ...postgresConflictDiagnostic(error),
  } });
  console.warn("PostgreSQL transaction lost a conflict", error);
}

/** The issue reader accepts only this content-free projection from Sentry. */
export function postgresConflictMetadata(extra: Record<string, unknown>): string[] {
  const lines: string[] = [];
  const locks = extra.postgres_conflict_locks;
  if (typeof locks === "string" && locks.length <= 400 && (locks === "unavailable" ||
      locks.split(";").length <= 4 && locks.split(";").every(edge => {
        const match = /^[1-8]>[1-8]:([A-Za-z]+):(transaction|relation|tuple|object)$/u.exec(edge);
        return match && LOCK_MODES.has(match[1]!);
      }))) lines.push(`PostgreSQL deadlock waits (local process aliases): ${locks}`);
  const relation = extra.postgres_conflict_relation;
  if (typeof relation === "string" && (relation === "unavailable" || RELATIONS.has(relation))) {
    lines.push(`PostgreSQL deadlock relation: ${relation}`);
  }
  return lines;
}
