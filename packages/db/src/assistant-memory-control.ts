import type { QueryResultRow } from "pg";
import { utf8ByteLength } from "@xmatrix/protocol";
import { commandDigest as digest, commandJson as stable } from "./command-digest.js";

import type { AuthorityDatabase, DatabaseTransaction } from "./contracts.js";
import { commandFields } from "./command-fields.js";
import { ControlError } from "./control-error.js";

const MAX_BYTES = 64 * 1024;
const MAX_ENTRIES = 80;
const REPLAY_TTL_MS = 30 * 24 * 60 * 60 * 1_000;


export class AssistantMemoryControlError extends ControlError {
  override name = "AssistantMemoryControlError";
}

function text(value: unknown, field: string, maximum: number): string {
  const result = typeof value === "string" ? value.trim() : "";
  if (!result || result.length > maximum) throw new AssistantMemoryControlError(
    "invalid_assistant_memory", 400, `${field} is invalid`,
  );
  return result;
}

const { object } = commandFields((field) =>
  new AssistantMemoryControlError("invalid_assistant_memory", 400, `${field} is invalid`));


function sourceRefs(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 12).flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const row = item as Record<string, unknown>;
    if (typeof row.label !== "string" || !row.label.trim()) return [];
    return [{ kind: ["channel", "message", "work_item", "issue", "pull_request", "url"]
      .includes(String(row.kind)) ? row.kind : "channel", label: row.label.trim().slice(0, 160),
    ...(typeof row.channelId === "string" ? { channelId: row.channelId.trim().slice(0, 120) } : {}),
    ...(typeof row.messageId === "string" ? { messageId: row.messageId.trim().slice(0, 120) } : {}),
    ...(typeof row.url === "string" ? { url: row.url.trim().slice(0, 500) } : {}) }];
  });
}

function empty(now: string) {
  return { schemaVersion: 1, entries: [], updatedAt: now };
}

function apply(currentValue: unknown, updateValue: unknown, now: string) {
  const current: Record<string, unknown> = currentValue && typeof currentValue === "object" &&
      !Array.isArray(currentValue)
    ? currentValue as Record<string, unknown> : empty(now);
  const update = object(updateValue, "update");
  if (update.deleteEntryIds !== undefined && !Array.isArray(update.deleteEntryIds)) {
    throw new AssistantMemoryControlError("invalid_assistant_memory", 400, "deleteEntryIds is invalid");
  }
  if (update.upsertEntries !== undefined && !Array.isArray(update.upsertEntries)) {
    throw new AssistantMemoryControlError("invalid_assistant_memory", 400, "upsertEntries is invalid");
  }
  const entries = new Map<string, Record<string, unknown>>();
  for (const item of Array.isArray(current.entries) ? current.entries : []) {
    if (item && typeof item === "object" && !Array.isArray(item) &&
        typeof (item as Record<string, unknown>).id === "string") {
      entries.set(String((item as Record<string, unknown>).id), item as Record<string, unknown>);
    }
  }
  for (const id of update.deleteEntryIds as unknown[] ?? []) if (typeof id === "string") entries.delete(id.trim());
  for (const value of update.upsertEntries as unknown[] ?? []) {
    const row = object(value, "upsertEntries[]");
    const id = typeof row.id === "string" && row.id.trim()
      ? row.id.trim().slice(0, 120) : `amem:${crypto.randomUUID()}`;
    const previous = entries.get(id);
    entries.set(id, { id,
      kind: ["preference", "goal", "commitment", "work_item", "checkpoint"].includes(String(row.kind))
        ? row.kind : "checkpoint",
      title: text(row.title, "entry.title", 160), body: text(row.body, "entry.body", 4_000),
      status: ["active", "resolved", "archived"].includes(String(row.status))
        ? row.status : previous?.status ?? "active",
      sourceRefs: sourceRefs(row.sourceRefs ?? previous?.sourceRefs),
      createdAt: previous?.createdAt ?? now, updatedAt: now });
  }
  const checkpoint = update.checkpoint === undefined ? current.checkpoint : (() => {
    const value = object(update.checkpoint, "checkpoint");
    return { summary: text(value.summary, "checkpoint.summary", 6_000),
      sourceRefs: sourceRefs(value.sourceRefs), updatedAt: now };
  })();
  const result = { schemaVersion: 1,
    entries: [...entries.values()].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
      .slice(0, MAX_ENTRIES), ...(checkpoint ? { checkpoint } : {}), updatedAt: now };
  if (utf8ByteLength(stable(result)) > MAX_BYTES) {
    throw new AssistantMemoryControlError("assistant_memory_too_large", 409,
      "assistant memory exceeds its bounded size");
  }
  return result;
}

async function replay(tx: DatabaseTransaction, owner: string, commandId: string,
  requestDigest: string): Promise<Record<string, unknown> | null> {
  const rows = await tx.query<QueryResultRow>({ name: "assistant_memory_replay_read_v1",
    text: `SELECT command_kind,request_digest,result_json FROM control.scoped_control_command_replays
      WHERE scope_kind = 'user' AND scope_id = $1 AND command_id = $2
        AND expires_at > clock_timestamp() LIMIT 1`, values: [owner, commandId], maxRows: 1 });
  if (!rows[0]) return null;
  if (rows[0].command_kind !== "update-assistant-memory" || rows[0].request_digest !== requestDigest) {
    throw new AssistantMemoryControlError("idempotency_conflict", 409, "commandId was reused");
  }
  return rows[0].result_json as Record<string, unknown>;
}

async function store(tx: DatabaseTransaction, owner: string, commandId: string,
  requestDigest: string, result: Record<string, unknown>, now: string) {
  await tx.query({ name: "assistant_memory_replay_write_v1",
    text: `INSERT INTO control.scoped_control_command_replays
      (scope_kind,scope_id,command_id,command_kind,request_digest,result_json,created_at,expires_at)
      VALUES ('user',$1,$2,'update-assistant-memory',$3,$4::jsonb,$5,$6)`,
    values: [owner, commandId, requestDigest, JSON.stringify(result), now,
      new Date(Date.parse(now) + REPLAY_TTL_MS).toISOString()], maxRows: 0 });
}

export class PostgresAssistantMemoryRepository {
  constructor(private readonly database: AuthorityDatabase) {
    if (database.cacheMode !== "disabled") throw new AssistantMemoryControlError(
      "cached_authority_forbidden", 500, "Assistant Memory authority requires uncached PostgreSQL");
  }

  async update(input: Record<string, unknown>) {
    const commandId = text(input.commandId, "commandId", 200);
    const owner = text(input.ownerUserId, "ownerUserId", 200);
    const update = object(input.update, "update");
    const requestDigest = await digest({ commandId, owner, update });
    const now = new Date().toISOString();
    return this.database.transaction({ requestId: commandId, operation: "assistant-memory.update" },
      async (tx) => {
        const prior = await replay(tx, owner, commandId, requestDigest);
        if (prior) return prior;
        const rows = await tx.query<QueryResultRow>({ name: "assistant_memory_current_lock_v1",
          text: "SELECT snapshot_json,version FROM data.assistant_memory_snapshots WHERE owner_user_id = $1 FOR UPDATE",
          values: [owner], maxRows: 1 });
        const memory = apply(rows[0]?.snapshot_json, update, now);
        await tx.query({ name: "assistant_memory_upsert_v1",
          text: `INSERT INTO data.assistant_memory_snapshots
            (owner_user_id,snapshot_json,version,updated_at) VALUES ($1,$2::jsonb,1,$3)
            ON CONFLICT (owner_user_id) DO UPDATE SET snapshot_json = EXCLUDED.snapshot_json,
              version = data.assistant_memory_snapshots.version + 1,updated_at = EXCLUDED.updated_at`,
          values: [owner, JSON.stringify(memory), now], maxRows: 0 });
        const result = { memory };
        await store(tx, owner, commandId, requestDigest, result, now);
        return result;
      });
  }

  async get(input: { requestId: string; ownerUserId: string }) {
    const requestId = text(input.requestId, "requestId", 200);
    const owner = text(input.ownerUserId, "ownerUserId", 200);
    const now = new Date().toISOString();
    return this.database.transaction({ requestId, operation: "assistant-memory.get" }, async (tx) => {
      const rows = await tx.query<QueryResultRow>({ name: "assistant_memory_get_v1",
        text: "SELECT snapshot_json FROM data.assistant_memory_snapshots WHERE owner_user_id = $1 LIMIT 1",
        values: [owner], maxRows: 1 });
      return { memory: rows[0]?.snapshot_json ?? empty(now) };
    });
  }
}
