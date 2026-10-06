import { ControlError } from "./control-error.js";
import { hostnameMetadata } from "./hostname-metadata.js";
import type { QueryResultRow } from "pg";

import type { AuthorityDatabase } from "./contracts.js";
import { ACTIVE_RUN_STATUS_SQL } from "@xmatrix/protocol";
import { commandDigest as digest } from "./command-digest.js";
import { commandFields } from "./command-fields.js";
import { readScopedCommandReplay, storeScopedCommandReplay } from "./command-replay.js";

const REPLAY_TTL_MS = 30 * 24 * 60 * 60 * 1_000;


export class WorkspaceControlError extends ControlError {
  override name = "WorkspaceControlError";
}

const { text, object: record } = commandFields((field) =>
  new WorkspaceControlError("invalid_workspace_request", 400, `${field} is invalid`));

function path(value: unknown): string {
  const result = text(value, "canonicalCwd", 4_000);
  if (!result.startsWith("/") && !/^[A-Za-z]:[\\/]/u.test(result)) {
    throw new WorkspaceControlError("invalid_workspace_request", 400, "canonicalCwd must be absolute");
  }
  return result;
}


function timestamp(value: unknown, field: string): string {
  const result = text(value, field, 100);
  if (!Number.isFinite(Date.parse(result))) {
    throw new WorkspaceControlError("invalid_workspace_request", 400, `${field} is invalid`);
  }
  return result;
}

function workspace(row: QueryResultRow): Record<string, unknown> {
  const metadata = (row.metadata_json ?? {}) as Record<string, unknown>;
  const metadataText = (key: string) => typeof metadata[key] === "string" && metadata[key]
    ? String(metadata[key]) : undefined;
  const strings = (key: string) => Array.isArray(metadata[key])
    ? (metadata[key] as unknown[]).filter((item): item is string => typeof item === "string" && Boolean(item.trim()))
    : [];
  const canonicalCwd = String(row.canonical_cwd);
  const hostName = metadataText("hostname") || metadataText("hostName");
  return {
    ownerUserId: String(row.owner_user_id), machineId: String(row.machine_id),
    hostId: metadataText("hostname") || metadataText("hostId") || hostName || "", ...(hostName ? { hostName } : {}),
    ...(metadataText("hostname") ? { hostname: metadataText("hostname") } : {}),
    canonicalCwd,
    displayName: metadataText("displayName") || canonicalCwd.split(/[\\/]/u).filter(Boolean).at(-1) || canonicalCwd,
    ...(metadataText("repoRoot") ? { repoRoot: metadataText("repoRoot") } : {}),
    ...(metadataText("gitRemote") ? { gitRemote: metadataText("gitRemote") } : {}),
    ...(metadataText("gitBranch") ? { gitBranch: metadataText("gitBranch") } : {}),
    runtimesSeen: strings("runtimesSeen"), boundChannelIds: strings("boundChannelIds"),
    visibility: metadata.visibility === "channel" || metadata.visibility === "space"
      ? metadata.visibility : "private",
    createdAt: new Date(row.created_at as string | Date).toISOString(),
    updatedAt: new Date(row.updated_at as string | Date).toISOString(),
    lastSeenAt: metadataText("lastSeenAt") || new Date(row.updated_at as string | Date).toISOString(),
    metadata,
  };
}

export class PostgresWorkspaceRepository {
  constructor(private readonly database: AuthorityDatabase) {
    if (database.cacheMode !== "disabled") throw new WorkspaceControlError(
      "cached_authority_forbidden", 500, "Workspace authority requires uncached PostgreSQL",
    );
  }

  async mutate(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const kind = input.kind;
    if (kind !== "workspace_put" && kind !== "workspace_remove") {
      throw new WorkspaceControlError("invalid_workspace_request", 400, "workspace command is invalid");
    }
    const requestId = text(input.commandId, "commandId", 200);
    const ownerUserId = text(input.actorUserId, "actorUserId");
    const machineId = text(input.machineId, "machineId", 160);
    const canonicalCwd = path(input.canonicalCwd);
    const at = timestamp(input.at, "at");
    const expected = input.expectedVersion === undefined ? undefined : Number(input.expectedVersion);
    if (expected !== undefined && (!Number.isSafeInteger(expected) || expected < 0)) {
      throw new WorkspaceControlError("invalid_workspace_request", 400, "expectedVersion is invalid");
    }
    const metadata = kind === "workspace_put" ? hostnameMetadata(record(input.metadata, "metadata")) : undefined;
    const requestDigest = await digest({ ...input, at: undefined });
    return this.database.transaction({ requestId, operation: `workspace.${kind}` }, async (tx) => {
      const replay = { scopeKind: "user", scopeId: ownerUserId, commandId: requestId, commandKind: kind, requestDigest };
      const prior = await readScopedCommandReplay(tx, "workspace_replay_read_v1", replay, () =>
        new WorkspaceControlError("idempotency_mismatch", 409, "command id was reused"));
      if (prior) return { ...prior, reused: true };
      const rows = await tx.query<QueryResultRow>({ name: "workspace_current_lock_v1",
        text: `SELECT owner_user_id,version FROM data.workspaces
          WHERE machine_id = $1 AND canonical_cwd = $2 FOR UPDATE`,
        values: [machineId, canonicalCwd], maxRows: 1 });
      const current = rows[0];
      if (current && current.owner_user_id !== ownerUserId) {
        throw new WorkspaceControlError("forbidden", 403, "workspace owner mismatch");
      }
      const currentVersion = Number(current?.version ?? 0);
      if (expected !== undefined && expected !== currentVersion) {
        throw new WorkspaceControlError("conflict", 409, "workspace version changed");
      }
      if (kind === "workspace_remove") {
        if (!current) throw new WorkspaceControlError("not_found", 404, "workspace not found");
        const live = await tx.query({ name: "workspace_live_run_v1",
          text: `SELECT run_id FROM data.runs WHERE workspace_machine_id = $1
            AND workspace_canonical_cwd = $2 AND status IN (${ACTIVE_RUN_STATUS_SQL}) LIMIT 1`,
          values: [machineId, canonicalCwd], maxRows: 1 });
        if (live[0]) throw new WorkspaceControlError("conflict", 409, "workspace has a live run");
        await tx.query({ name: "workspace_remove_v1",
          text: `DELETE FROM data.workspaces WHERE machine_id = $1 AND canonical_cwd = $2
            AND owner_user_id = $3 AND version = $4`,
          values: [machineId, canonicalCwd, ownerUserId, currentVersion], maxRows: 0 });
      } else if (current) {
        await tx.query({ name: "workspace_update_v1",
          text: `UPDATE data.workspaces SET metadata_json = $1::jsonb,version = $2,updated_at = $3
            WHERE machine_id = $4 AND canonical_cwd = $5 AND owner_user_id = $6 AND version = $7`,
          values: [JSON.stringify(metadata), currentVersion + 1, at, machineId, canonicalCwd,
            ownerUserId, currentVersion], maxRows: 0 });
      } else {
        await tx.query({ name: "workspace_insert_v1",
          text: `INSERT INTO data.workspaces
            (workspace_id,owner_user_id,machine_id,canonical_cwd,search_rank_sequence,
             version,metadata_json,created_at,updated_at)
            VALUES ($1,$2,$3,$4,$5,1,$6::jsonb,$7,$7)`,
          values: [JSON.stringify([machineId, canonicalCwd]), ownerUserId, machineId, canonicalCwd,
            `workspace:${at}:${requestId}`, JSON.stringify(metadata), at], maxRows: 0 });
      }
      const result = { commandId: requestId, kind, entityId: JSON.stringify([machineId, canonicalCwd]),
        entityVersion: currentVersion + 1, reused: false, projectionMutations: [],
        recipientChanges: [{ userId: ownerUserId, visibilityScopeId: `user:${ownerUserId}`,
          change: "entitlement_changed" }] };
      await storeScopedCommandReplay(tx, "workspace_replay_write_v1", { ...replay, result, at, ttlMs: REPLAY_TTL_MS });
      return result;
    });
  }

  async list(input: {
    requestId: string;
    ownerUserId: string;
    limit: number;
    cursor?: string | null;
    machineId?: string;
  }) {
    const requestId = text(input.requestId, "requestId", 200);
    const ownerUserId = text(input.ownerUserId, "ownerUserId");
    const machineId = input.machineId === undefined
      ? null
      : text(input.machineId, "machineId", 160);
    const limit = Number(input.limit);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
      throw new WorkspaceControlError("invalid_workspace_request", 400, "limit is invalid");
    }
    let after: [string, string] | null = null;
    if (input.cursor) {
      try {
        const value = JSON.parse(atob(input.cursor));
        if (Array.isArray(value) && value.length === 2 && value.every((item) => typeof item === "string")) {
          after = value as [string, string];
        } else throw new Error("invalid");
      } catch {
        throw new WorkspaceControlError("invalid_workspace_request", 400, "cursor is invalid");
      }
    }
    return this.database.transaction({ requestId, operation: "workspace.list" }, async (tx) => {
      // A retired Machine's directories leave the list with it.
      const rows = await tx.query<QueryResultRow>({ name: "workspace_list_v3",
        text: `SELECT * FROM data.workspaces w WHERE owner_user_id = $1 AND machine_id IS NOT NULL
          AND ($2::text IS NULL OR machine_id = $2)
          AND NOT EXISTS (SELECT 1 FROM data.machines m WHERE m.owner_user_id = w.owner_user_id
            AND m.machine_id = w.machine_id AND m.retired_at IS NOT NULL)
          AND ($3::text IS NULL OR (machine_id,canonical_cwd) > ($3,$4))
          ORDER BY machine_id,canonical_cwd LIMIT $5`,
        values: [ownerUserId, machineId, after?.[0] ?? null, after?.[1] ?? null, limit + 1],
        maxRows: limit + 1 });
      const page = rows.slice(0, limit);
      const last = page.at(-1);
      return { workspaces: page.map(workspace), cursor: rows.length > limit && last
        ? btoa(JSON.stringify([last.machine_id, last.canonical_cwd])) : null };
    });
  }

  async getExact(input: {
    requestId: string;
    ownerUserId: string;
    machineId: string;
    canonicalCwd: string;
  }): Promise<{ workspace: Record<string, unknown> }> {
    const requestId = text(input.requestId, "requestId", 200);
    const ownerUserId = text(input.ownerUserId, "ownerUserId");
    const machineId = text(input.machineId, "machineId", 160);
    const canonicalCwd = path(input.canonicalCwd);
    return this.database.transaction({ requestId, operation: "workspace.get_exact" }, async (tx) => {
      const rows = await tx.query<QueryResultRow>({
        name: "workspace_get_exact_v1",
        text: `SELECT * FROM data.workspaces
          WHERE owner_user_id = $1 AND machine_id = $2 AND canonical_cwd = $3
          LIMIT 1`,
        values: [ownerUserId, machineId, canonicalCwd],
        maxRows: 1,
      });
      if (!rows[0]) throw new WorkspaceControlError(
        "not_found", 404, "workspace is not registered for this machine",
      );
      return { workspace: workspace(rows[0]) };
    });
  }
}
