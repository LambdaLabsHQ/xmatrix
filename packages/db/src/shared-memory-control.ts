import type { QueryResultRow } from "pg";
import { utf8ByteLength } from "@xmatrix/protocol";
import { commandDigest as digest, commandJson as stable } from "./command-digest.js";

import type { AuthorityDatabase } from "./contracts.js";
import { commandFields } from "./command-fields.js";
import { ControlError } from "./control-error.js";
import { readScopedCommandReplay, storeScopedCommandReplay } from "./command-replay.js";

const VALUE_BYTES = 64 * 1024;
const WORKSPACE_ROWS = 10_000;
const WORKSPACE_BYTES = 64 * 1024 * 1024;
const GLOBAL_BYTES = 512 * 1024 * 1024;
const REPLAY_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
const EXPIRY_RECLAIM_LIMIT = 256;
const ACTIVE_EXPIRY_PREDICATE = "(expires_at IS NULL OR expires_at > clock_timestamp())";


export class SharedMemoryControlError extends ControlError {
  override name = "SharedMemoryControlError";
}

const { text } = commandFields((field) =>
  new SharedMemoryControlError("invalid_shared_memory_request", 400, `${field} is invalid`));


export class PostgresSharedMemoryRepository {
  constructor(private readonly database: AuthorityDatabase) {
    if (database.cacheMode !== "disabled") throw new SharedMemoryControlError(
      "cached_authority_forbidden", 500, "Shared Memory authority requires uncached PostgreSQL",
    );
  }

  async put(input: Record<string, unknown>) {
    return this.mutate("put-shared-memory", input);
  }

  async remove(input: Record<string, unknown>) {
    return this.mutate("delete-shared-memory", input);
  }

  private async mutate(kind: "put-shared-memory" | "delete-shared-memory",
    input: Record<string, unknown>) {
    const commandId = text(input.commandId, "commandId", 200);
    const owner = text(input.ownerUserId, "ownerUserId", 200);
    const workspace = input.workspaceId === undefined ? owner : text(input.workspaceId, "workspaceId", 200);
    const key = text(input.key, "key", 512);
    if (key === "assistant:memory:snapshot.v1") throw new SharedMemoryControlError(
      "reserved_shared_memory_key", 400, "key is reserved for a typed API",
    );
    const now = new Date().toISOString();
    const ttl = input.ttlMs === undefined ? undefined : Number(input.ttlMs);
    if (ttl !== undefined && (!Number.isSafeInteger(ttl) || ttl < 1 || ttl > 30 * 24 * 60 * 60_000)) {
      throw new SharedMemoryControlError("invalid_shared_memory_request", 400, "ttlMs is invalid");
    }
    const valueJson = kind === "put-shared-memory" ? stable(input.value) : undefined;
    const encodedBytes = valueJson === undefined ? 0 : utf8ByteLength(valueJson);
    if (encodedBytes > VALUE_BYTES) throw new SharedMemoryControlError(
      "shared_memory_too_large", 409, "shared memory value exceeds 64 KiB",
    );
    const requestDigest = await digest({ commandId, owner, workspace, key,
      ...(kind === "put-shared-memory" ? { value: input.value, ttl } : {}) });
    return this.database.transaction({ requestId: commandId, operation: `shared-memory.${kind}` },
      async (tx) => {
        const replay = { scopeKind: "user", scopeId: owner, commandId, commandKind: kind, requestDigest };
        const prior = await readScopedCommandReplay(tx, "shared_memory_replay_read_v1", replay, () =>
          new SharedMemoryControlError("idempotency_conflict", 409, "commandId was reused"));
        if (prior) return prior;
        await tx.query({ name: "shared_memory_expire_reclaim_v1",
          text: `DELETE FROM data.shared_memory_workspace_entries
            WHERE ctid IN (
              SELECT ctid FROM data.shared_memory_workspace_entries
              WHERE expires_at IS NOT NULL AND expires_at <= clock_timestamp()
              ORDER BY expires_at, owner_user_id, workspace_id, memory_key
              LIMIT $1
            )`,
          values: [EXPIRY_RECLAIM_LIMIT], maxRows: 0 });
        const currentRows = await tx.query<QueryResultRow>({ name: "shared_memory_current_lock_v1",
          text: `SELECT encoded_bytes, expires_at FROM data.shared_memory_workspace_entries
            WHERE owner_user_id = $1 AND workspace_id = $2 AND memory_key = $3 FOR UPDATE`,
          values: [owner, workspace, key], maxRows: 1 });
        if (kind === "put-shared-memory") {
          const usage = await tx.query<QueryResultRow>({ name: "shared_memory_usage_v1",
            text: `SELECT COUNT(*) AS rows_count,COALESCE(SUM(encoded_bytes),0) AS workspace_bytes,
              (SELECT COALESCE(SUM(encoded_bytes),0) FROM data.shared_memory_workspace_entries
                WHERE ${ACTIVE_EXPIRY_PREDICATE}) AS global_bytes
              FROM data.shared_memory_workspace_entries
              WHERE owner_user_id = $1 AND workspace_id = $2 AND ${ACTIVE_EXPIRY_PREDICATE}`,
            values: [owner, workspace], maxRows: 1 });
          const currentLive = Boolean(currentRows[0] && (currentRows[0].expires_at == null ||
            new Date(currentRows[0].expires_at as string | Date).getTime() > Date.now()));
          const rowDelta = currentLive ? 0 : 1;
          const byteDelta = encodedBytes - (currentLive ? Number(currentRows[0]?.encoded_bytes ?? 0) : 0);
          if (Number(usage[0]?.rows_count ?? 0) + rowDelta > WORKSPACE_ROWS ||
              Number(usage[0]?.workspace_bytes ?? 0) + byteDelta > WORKSPACE_BYTES) {
            throw new SharedMemoryControlError("shared_memory_workspace_backpressure", 503,
              "shared memory workspace budget is exhausted", true);
          }
          if (Number(usage[0]?.global_bytes ?? 0) + byteDelta > GLOBAL_BYTES) {
            throw new SharedMemoryControlError("shared_memory_global_backpressure", 503,
              "shared memory global budget is exhausted", true);
          }
          await tx.query({ name: "shared_memory_put_v1",
            text: `INSERT INTO data.shared_memory_workspace_entries
              (owner_user_id,workspace_id,memory_key,value_json,encoded_bytes,version,
               created_at,updated_at,expires_at)
              VALUES ($1,$2,$3,$4::jsonb,$5,1,$6,$6,$7)
              ON CONFLICT (owner_user_id,workspace_id,memory_key) DO UPDATE SET
                value_json = EXCLUDED.value_json,encoded_bytes = EXCLUDED.encoded_bytes,
                version = data.shared_memory_workspace_entries.version + 1,
                updated_at = EXCLUDED.updated_at,expires_at = EXCLUDED.expires_at`,
            values: [owner, workspace, key, valueJson, encodedBytes, now,
              ttl === undefined ? null : new Date(Date.parse(now) + ttl).toISOString()], maxRows: 0 });
        } else {
          await tx.query({ name: "shared_memory_delete_v1",
            text: `DELETE FROM data.shared_memory_workspace_entries
              WHERE owner_user_id = $1 AND workspace_id = $2 AND memory_key = $3`,
            values: [owner, workspace, key], maxRows: 0 });
        }
        const result = { ok: true, key };
        await storeScopedCommandReplay(tx, "shared_memory_replay_write_v1",
          { ...replay, result, at: now, ttlMs: REPLAY_TTL_MS });
        return result;
      });
  }

  async get(input: { requestId: string; ownerUserId: string; workspaceId?: string;
    key?: string; prefix?: string; limit: number }) {
    const requestId = text(input.requestId, "requestId", 200);
    const owner = text(input.ownerUserId, "ownerUserId", 200);
    const workspace = input.workspaceId === undefined ? owner : text(input.workspaceId, "workspaceId", 200);
    const key = input.key === undefined ? undefined : text(input.key, "key", 512);
    const prefix = input.prefix === undefined ? "" : String(input.prefix);
    if (utf8ByteLength(prefix) > 512 || !Number.isSafeInteger(input.limit) ||
        input.limit < 1 || input.limit > 200) throw new SharedMemoryControlError(
      "invalid_shared_memory_request", 400, "Shared Memory query is invalid",
    );
    return this.database.transaction({ requestId, operation: "shared-memory.get" }, async (tx) => {
      const rows = await tx.query<QueryResultRow>({ name: "shared_memory_get_v1",
        text: key ? `SELECT * FROM data.shared_memory_workspace_entries
          WHERE owner_user_id = $1 AND workspace_id = $2 AND memory_key = $3
            AND (expires_at IS NULL OR expires_at > clock_timestamp()) LIMIT 1`
          : `SELECT * FROM data.shared_memory_workspace_entries
          WHERE owner_user_id = $1 AND workspace_id = $2 AND memory_key >= $3 AND memory_key < $4
            AND (expires_at IS NULL OR expires_at > clock_timestamp()) ORDER BY memory_key LIMIT $5`,
        values: key ? [owner, workspace, key]
          : [owner, workspace, prefix, `${prefix}\uffff`, input.limit], maxRows: key ? 1 : input.limit });
      if (key) return rows[0] ? { key, value: rows[0].value_json,
        ...(rows[0].expires_at ? { expiresAt: new Date(rows[0].expires_at as Date).toISOString() } : {}) }
        : { key, value: null };
      return { entries: rows.map((row) => ({ key: row.memory_key, value: row.value_json,
        ...(row.expires_at ? { expiresAt: new Date(row.expires_at as Date).toISOString() } : {}) })) };
    });
  }
}
