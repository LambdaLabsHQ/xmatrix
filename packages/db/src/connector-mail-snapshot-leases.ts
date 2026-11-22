import type { QueryResultRow } from "pg";
import type { AuthorityDatabase } from "./contracts.js";
import { AppControlError, appRequestFields } from "./app-control.js";

export const MAIL_SNAPSHOT_KEY_PREFIX = "connector-mail-snapshots/";
export const MAIL_SNAPSHOT_KEY_PATTERN = /^connector-mail-snapshots\/[A-Za-z0-9_-]{43}$/u;

const DEFAULT_DUE_LIMIT = 50;
const MAX_DUE_LIMIT = 100;
const DEFAULT_RETRY_BASE_MS = 15_000;
const MAX_RETRY_DELAY_MS = 300_000;

export type MailSnapshotLeaseState = "staged" | "delete_pending";

export interface MailSnapshotLease {
  objectKey: string;
  commandId: string;
  state: MailSnapshotLeaseState;
  expiresAt: string;
  nextAttemptAt: string;
  attempts: number;
}

interface MailSnapshotLeaseRow extends QueryResultRow {
  object_key: string;
  command_id: string;
  state: MailSnapshotLeaseState;
  expires_at: Date | string;
  next_attempt_at: Date | string;
  attempts: number | string;
}

function validObjectKey(value: string): string {
  if (typeof value !== "string" || !MAIL_SNAPSHOT_KEY_PATTERN.test(value)) {
    throw new AppControlError("invalid_app_request", 400, "Invalid mail snapshot object key");
  }
  return value;
}

function validTimestamp(value: string, field: string): string {
  const parsed = Date.parse(value);
  if (typeof value !== "string" || !Number.isFinite(parsed)) {
    throw new AppControlError("invalid_app_request", 400, `Invalid ${field}`);
  }
  return new Date(parsed).toISOString();
}

function requestIdOf(value: string): string {
  return appRequestFields.text(value, "requestId", 200);
}

function leaseFromRow(row: MailSnapshotLeaseRow): MailSnapshotLease {
  return {
    objectKey: row.object_key,
    commandId: row.command_id,
    state: row.state,
    expiresAt: new Date(row.expires_at).toISOString(),
    nextAttemptAt: new Date(row.next_attempt_at).toISOString(),
    attempts: Number(row.attempts),
  };
}

/**
 * Primary operational lease owner for temporary Gmail upload snapshots staged
 * in R2. Never stores mailbox content, tokens outside the exact object key, or
 * references to general attachment objects.
 */
export class PostgresMailSnapshotLeaseRepository {
  constructor(private readonly database: AuthorityDatabase) {
    if (database.cacheMode !== "disabled") {
      throw new AppControlError("cached_authority_forbidden", 500, "Mail snapshot lease authority requires uncached PostgreSQL");
    }
  }

  /** Record an exact snapshot key and expiry obligation before writing bytes to R2. */
  async reserve(input: { requestId: string; objectKey: string; commandId: string; expiresAt: string }): Promise<MailSnapshotLease> {
    const objectKey = validObjectKey(input.objectKey);
    const commandId = appRequestFields.text(input.commandId, "commandId", 200);
    const expiresAt = validTimestamp(input.expiresAt, "expiresAt");
    return this.database.transaction(
      { requestId: requestIdOf(input.requestId), operation: "app.mail-snapshot-lease.reserve" },
      async (tx) => {
        const rows = await tx.query<MailSnapshotLeaseRow>({
          name: "mail_snapshot_lease_reserve_v1",
          text: `INSERT INTO control.connector_mail_snapshot_leases
              (object_key, command_id, state, expires_at, next_attempt_at)
            VALUES ($1, $2, 'staged', $3::timestamptz, $3::timestamptz)
            RETURNING object_key, command_id, state, expires_at, next_attempt_at, attempts`,
          values: [objectKey, commandId, expiresAt],
          maxRows: 1,
        });
        return leaseFromRow(rows[0] as MailSnapshotLeaseRow);
      },
    );
  }

  /** Remove a lease once its exact object has been deleted from R2 (idempotent). */
  async markDeleted(input: { requestId: string; objectKey: string }): Promise<boolean> {
    const objectKey = validObjectKey(input.objectKey);
    return this.database.transaction(
      { requestId: requestIdOf(input.requestId), operation: "app.mail-snapshot-lease.delete" },
      async (tx) => {
        const rows = await tx.query<QueryResultRow>({
          name: "mail_snapshot_lease_delete_v1",
          text: "DELETE FROM control.connector_mail_snapshot_leases WHERE object_key=$1 RETURNING object_key",
          values: [objectKey],
          maxRows: 1,
        });
        return rows.length > 0;
      },
    );
  }

  /** Transition a lease to retryable deletion with bounded exponential backoff. */
  async markDeleteFailed(input: { requestId: string; objectKey: string; baseDelayMs?: number; now?: string }): Promise<MailSnapshotLease | null> {
    const objectKey = validObjectKey(input.objectKey);
    const baseDelayMs = Math.min(Math.max(Math.trunc(input.baseDelayMs ?? DEFAULT_RETRY_BASE_MS), 0), MAX_RETRY_DELAY_MS);
    const now = input.now === undefined ? null : validTimestamp(input.now, "now");
    return this.database.transaction(
      { requestId: requestIdOf(input.requestId), operation: "app.mail-snapshot-lease.retry" },
      async (tx) => {
        const rows = await tx.query<MailSnapshotLeaseRow>({
          name: "mail_snapshot_lease_retry_v1",
          text: `UPDATE control.connector_mail_snapshot_leases
            SET state='delete_pending',
                attempts=attempts + 1,
                next_attempt_at=COALESCE($3::timestamptz, clock_timestamp())
                  + make_interval(secs => LEAST($4::double precision, ($2::double precision / 1000.0) * power(2.0, LEAST(attempts, 5)))),
                updated_at=COALESCE($3::timestamptz, clock_timestamp())
            WHERE object_key=$1
            RETURNING object_key, command_id, state, expires_at, next_attempt_at, attempts`,
          values: [objectKey, baseDelayMs, now, MAX_RETRY_DELAY_MS / 1000],
          maxRows: 1,
        });
        return rows[0] ? leaseFromRow(rows[0]) : null;
      },
    );
  }

  /** Bounded, resumable keyset page of leases whose expiry or retry deadline has arrived. */
  async due(input: { requestId: string; limit?: number; afterObjectKey?: string; now?: string }): Promise<MailSnapshotLease[]> {
    const limit = Math.min(Math.max(Math.trunc(input.limit ?? DEFAULT_DUE_LIMIT), 1), MAX_DUE_LIMIT);
    const afterObjectKey = input.afterObjectKey === undefined ? null : validObjectKey(input.afterObjectKey);
    const now = input.now === undefined ? null : validTimestamp(input.now, "now");
    return this.database.transaction(
      { requestId: requestIdOf(input.requestId), operation: "app.mail-snapshot-lease.due", statement: "single_read" },
      async (tx) => {
        const rows = await tx.query<MailSnapshotLeaseRow>({
          name: "mail_snapshot_lease_due_v1",
          text: `SELECT object_key, command_id, state, expires_at, next_attempt_at, attempts
            FROM control.connector_mail_snapshot_leases
            WHERE next_attempt_at <= COALESCE($1::timestamptz, clock_timestamp())
              AND ($2::text IS NULL OR object_key > $2)
            ORDER BY object_key ASC
            LIMIT $3`,
          values: [now, afterObjectKey, limit],
          maxRows: limit,
        });
        return rows.map(leaseFromRow);
      },
    );
  }
}
