/**
 * Platform-admin audit trail.
 *
 * Every operator read and action is written to `control.admin_audit_events`
 * on the directory shard before its result is returned, so a read that could
 * not be recorded is not served. Rows carry the actor, the kind of read or
 * action, and the target id — never what was read.
 */

import {
  ADMIN_AUDIT_MAX_ROWS,
  type AdminAuditAction,
  type AdminAuditEvent,
} from "@xmatrix/protocol";
import type { AuthorityDatabase } from "@xmatrix/db";
import type { QueryResultRow } from "pg";

import { createPostgresAuthorityFleet } from "./postgres-authority-fleet";
import type { Env } from "./types";

export interface AdminAuditRecord {
  actorUserId: string;
  actorEmail?: string;
  action: AdminAuditAction;
  targetKind?: string;
  targetId?: string;
}

interface AuditRow extends QueryResultRow {
  event_id: string;
  actor_user_id: string;
  actor_email: string | null;
  action: AdminAuditAction;
  target_kind: string | null;
  target_id: string | null;
  created_at: Date | string;
}

function auditDatabase(env: Env): AuthorityDatabase {
  return createPostgresAuthorityFleet(env, {
    applicationName: "xmatrix-hub-admin-audit",
    statementTimeoutMs: 5_000,
    transactionTimeoutMs: 10_000,
    lockTimeoutMs: 2_000,
  }).directoryDatabase;
}

export async function recordAdminAudit(
  env: Env,
  record: AdminAuditRecord,
  database: AuthorityDatabase = auditDatabase(env),
): Promise<void> {
  const eventId = crypto.randomUUID();
  await database.transaction({
    requestId: `admin-audit:${eventId}`,
    operation: "admin.audit.record",
  }, (transaction) => transaction.query({
    name: "admin_audit_record_v1",
    text: `INSERT INTO control.admin_audit_events
      (event_id, actor_user_id, actor_email, action, target_kind, target_id, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, now())`,
    values: [
      eventId,
      record.actorUserId,
      record.actorEmail?.slice(0, 320) || null,
      record.action,
      record.targetKind ?? null,
      record.targetId?.slice(0, 300) ?? null,
    ],
    maxRows: 0,
  }));
}

export async function listAdminAudit(
  env: Env,
  limit: number,
  database: AuthorityDatabase = auditDatabase(env),
): Promise<AdminAuditEvent[]> {
  const bounded = Math.min(Math.max(1, Math.floor(limit)), ADMIN_AUDIT_MAX_ROWS);
  const rows = await database.transaction({
    requestId: `admin-audit-list:${crypto.randomUUID()}`,
    operation: "admin.audit.list",
  }, (transaction) => transaction.query<AuditRow>({
    name: "admin_audit_list_v1",
    text: `SELECT event_id, actor_user_id, actor_email, action, target_kind, target_id, created_at
      FROM control.admin_audit_events ORDER BY created_at DESC, event_id LIMIT $1`,
    values: [bounded],
    maxRows: bounded,
  }));
  return rows.map((row) => ({
    eventId: row.event_id,
    actorUserId: row.actor_user_id,
    ...(row.actor_email ? { actorEmail: row.actor_email } : {}),
    action: row.action,
    ...(row.target_kind ? { targetKind: row.target_kind } : {}),
    ...(row.target_id ? { targetId: row.target_id } : {}),
    createdAt: (row.created_at instanceof Date ? row.created_at : new Date(row.created_at)).toISOString(),
  }));
}
