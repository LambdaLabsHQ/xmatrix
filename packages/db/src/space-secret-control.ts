import { ControlError } from "./control-error.js";
import type { QueryResultRow } from "pg";
import {
  isLiveAgentStatus, isSpaceSecretAccess, SECRET_ENV_NAME_PATTERN, utf8ByteLength,
  type SpaceSecretAccess, type SpaceSecretEntry,
} from "@xmatrix/protocol";

import type { AuthorityDatabase, DatabaseTransaction } from "./contracts.js";
import { requireRunRegistrationAccess } from "./agent-registration-run.js";
import { requireChannelCapability } from "./channel-capability-policy.js";
import { inActiveSpace } from "./page-control.js";
import { PostgresChannelSpaceDirectory } from "./placement.js";
import { decryptSpaceSecretValue, encryptSpaceSecretValue, secretHmac } from "./secret-value-control.js";

const MAX_SPACE_SECRETS = 128;
const MAX_VALUE_BYTES = 64 * 1024;
const SECRET_REF = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/u;

export class SpaceSecretError extends ControlError {
  override name = "SpaceSecretError";
  constructor(code: string, status: number, message: string = code, retryable = false) {
    super(code, status, message, retryable);
  }
}

/** The live Agent Run asking, as its token proves it; `spaceId` is its token's Space. */
export interface RunSecretCaller {
  runId: string; ownerUserId: string; spaceId: string; channelId: string; instanceId: string; executionKey: string;
}

/** A secret as a Run sees it: whether it may read it now, never the value. */
export interface RunSecretView { secretRef: string; envName: string; access: SpaceSecretAccess; readable: boolean }

export interface SpaceSecretChange {
  secretRef: string; value?: string; envName?: string; description?: string | null; access?: SpaceSecretAccess;
}

export function secretRefOf(value: unknown): string {
  const ref = typeof value === "string" ? value.trim() : "";
  if (!SECRET_REF.test(ref)) throw new SpaceSecretError("invalid_request", 400, "secretRef is invalid");
  return ref;
}

/** The environment name a secret is given when nobody named one. */
export function defaultSecretEnvName(ref: string): string {
  const derived = ref.toUpperCase().replace(/[^A-Z0-9_]/gu, "_");
  return (/^[A-Z_]/u.test(derived) ? derived : `_${derived}`).slice(0, 120);
}

function envNameOf(value: unknown): string {
  const name = typeof value === "string" ? value.trim() : "";
  if (!SECRET_ENV_NAME_PATTERN.test(name)) throw new SpaceSecretError("invalid_request", 400, "envName is invalid");
  return name;
}

function descriptionOf(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string" || utf8ByteLength(value.trim()) > 600) {
    throw new SpaceSecretError("invalid_request", 400, "description is invalid");
  }
  return value.trim() || null;
}

function entry(row: QueryResultRow): SpaceSecretEntry {
  return { secretRef: String(row.secret_ref), envName: String(row.env_name),
    ...(row.description ? { description: String(row.description) } : {}),
    access: String(row.access) as SpaceSecretAccess, createdByUserId: String(row.created_by_user_id),
    createdAt: new Date(row.created_at as string).toISOString(),
    updatedAt: new Date(row.updated_at as string).toISOString() };
}

async function role(tx: DatabaseTransaction, spaceId: string, userId: string): Promise<string | null> {
  const rows = await tx.query({ name: "space_secret_member_role_v1", text: `SELECT role FROM data.space_members
    WHERE space_id=$1 AND user_id=$2 LIMIT 1`, values: [spaceId, userId], maxRows: 1 });
  return rows[0] ? String(rows[0].role) : null;
}

const SECRET_READERS = ["owner", "admin", "member", "viewer"];
const SECRET_ADMINS = ["owner", "admin"];

async function requireRole(tx: DatabaseTransaction, spaceId: string, userId: string, roles: string[], action: string) {
  if (!roles.includes((await role(tx, spaceId, userId)) ?? "")) {
    throw new SpaceSecretError("forbidden", 403, `Only a Space ${roles === SECRET_ADMINS ? "admin" : "member"} ${action}`);
  }
}

/**
 * The Space a live Run reads secrets in. Its registration must still authorize
 * it, and its owner must still be a member who could use them by hand.
 *
 * Only saving a secret (`write`) holds the Channel, Run, Instance and
 * registration rows until commit. A read is checked at its own moment and
 * takes no row lock, so it does not wait out a launch or append that holds the
 * Channel row: behind one stalled for 3 s it hit `lock_timeout` (XMATRIX-HUB-6B).
 */
async function liveRunSpace(tx: DatabaseTransaction, run: RunSecretCaller, use: "read" | "write"): Promise<string> {
  await requireChannelCapability(tx, { channelId: run.channelId, principal: { kind: "user", id: run.ownerUserId },
    capability: use === "write" ? "secret_new_work" : "secret_run_read",
    error: (failure) => new SpaceSecretError(failure.code, failure.status, failure.message) });
  const rows = await tx.query({ name: `space_secret_live_run_${use}_v2`, text: `SELECT r.owner_user_id,r.channel_id,
    r.status AS run_status,r.metadata_json->>'executionKey' AS execution_key,i.channel_id AS instance_channel_id,
    i.status AS instance_status FROM data.runs r JOIN data.instances i ON i.run_id=r.run_id
    WHERE r.run_id=$1 AND i.instance_id=$2 LIMIT 1${use === "write" ? " FOR SHARE OF r,i" : ""}`,
  values: [run.runId, run.instanceId], maxRows: 1 });
  const live = rows[0];
  if (!live || live.owner_user_id !== run.ownerUserId || live.channel_id !== run.channelId ||
      live.instance_channel_id !== run.channelId || !["starting", "running"].includes(String(live.run_status)) ||
      !isLiveAgentStatus(live.instance_status) || live.execution_key !== run.executionKey) {
    throw new SpaceSecretError("request_context_unavailable", 409, "Secrets are read by the matching live Agent Instance");
  }
  const admission = await requireRunRegistrationAccess(tx, { runId: run.runId, channelId: run.channelId,
    phase: live.run_status === "starting" ? "admission" : "continuation", lock: use === "write" ? "hold" : "none",
    error: (code, status) => new SpaceSecretError(code, status, "Registration no longer authorizes this Run") });
  if (admission.key.spaceId !== run.spaceId) {
    throw new SpaceSecretError("request_context_mismatch", 409, "The Run's token names another Space");
  }
  await requireRole(tx, run.spaceId, run.ownerUserId, ["owner", "admin", "member"], "may use its secrets");
  return run.spaceId;
}

async function runViews(tx: DatabaseTransaction, spaceId: string, runId: string, refs?: string[]) {
  const rows = await tx.query({ name: "space_secret_run_views_v1", text: `SELECT s.*,
    (s.access='auto' OR a.run_id IS NOT NULL) AS readable FROM data.space_secrets s
    LEFT JOIN data.run_secret_approvals a ON a.run_id=$2 AND a.secret_ref=s.secret_ref AND a.space_id=s.space_id
    WHERE s.space_id=$1 AND ($3::text[] IS NULL OR s.secret_ref=ANY($3::text[])) ORDER BY s.secret_ref`,
  values: [spaceId, runId, refs ?? null], maxRows: MAX_SPACE_SECRETS });
  return rows;
}

export class PostgresSpaceSecretRepository {
  constructor(private readonly database: AuthorityDatabase, private readonly material: string) {
    if (database.cacheMode !== "disabled") throw new SpaceSecretError(
      "cached_authority_forbidden", 500, "Space secrets require uncached PostgreSQL");
    if (!material.trim()) throw new SpaceSecretError(
      "secret_authority_unavailable", 503, "Secret encryption is not configured");
  }

  /** A Space's secrets, for its members; values are never listed. */
  async list(input: { spaceId: string; userId: string }) {
    return this.inSpace(input.spaceId, "space-secret.list", async (tx) => {
      const memberRole = await role(tx, input.spaceId, input.userId);
      if (!memberRole || !SECRET_READERS.includes(memberRole)) {
        throw new SpaceSecretError("forbidden", 403, "Only a Space member sees its secrets");
      }
      const rows = await tx.query({ name: "space_secret_list_v1", text: `SELECT * FROM data.space_secrets
        WHERE space_id=$1 ORDER BY secret_ref`, values: [input.spaceId], maxRows: MAX_SPACE_SECRETS });
      return { secrets: rows.map(entry), canManage: SECRET_ADMINS.includes(memberRole) };
    });
  }

  /** A Space admin saves a secret: a new one needs its value; leaving the value
   * out keeps it. */
  async put(input: SpaceSecretChange & { spaceId: string; userId: string }) {
    return this.inSpace(input.spaceId, "space-secret.put", async (tx) => {
      await requireRole(tx, input.spaceId, input.userId, SECRET_ADMINS, "saves its secrets");
      return { secret: await this.write(tx, input.spaceId, input.userId, input, "upsert") };
    });
  }

  async remove(input: { spaceId: string; userId: string; secretRef: string }) {
    const ref = secretRefOf(input.secretRef);
    return this.inSpace(input.spaceId, "space-secret.delete", async (tx) => {
      await requireRole(tx, input.spaceId, input.userId, SECRET_ADMINS, "deletes its secrets");
      await tx.query({ name: "space_secret_delete_approvals_v1", text: `DELETE FROM data.run_secret_approvals
        WHERE space_id=$1 AND secret_ref=$2`, values: [input.spaceId, ref], maxRows: 0 });
      const deleted = await tx.query({ name: "space_secret_delete_v1", text: `DELETE FROM data.space_secrets
        WHERE space_id=$1 AND secret_ref=$2 RETURNING secret_ref`, values: [input.spaceId, ref], maxRows: 1 });
      return { deleted: deleted.length === 1, secretRef: ref };
    });
  }

  /** The Space's secrets as this Run sees them: which it may read now. */
  async runList(run: RunSecretCaller): Promise<{ spaceId: string; secrets: RunSecretView[] }> {
    return this.inSpace(run.spaceId, "space-secret.run-list", async (tx) => {
      const spaceId = await liveRunSpace(tx, run, "read");
      return { spaceId, secrets: (await runViews(tx, spaceId, run.runId)).map((row) => ({
        secretRef: String(row.secret_ref), envName: String(row.env_name),
        access: String(row.access) as SpaceSecretAccess, readable: row.readable === true })) };
    });
  }

  /**
   * The values a Run reads at the moment it needs them, each read audited. A
   * named secret must exist (`secret_not_found`) and be `auto` or approved
   * for this Run (`secret_approval_required`); naming none reads every one it
   * may read now.
   */
  async runRead(run: RunSecretCaller, secretRefs?: unknown) {
    const refs = secretRefs === undefined ? undefined : Array.isArray(secretRefs) && secretRefs.length <= 32
      ? [...new Set(secretRefs.map(secretRefOf))] : null;
    if (refs === null) throw new SpaceSecretError("invalid_request", 400, "secretRefs is invalid");
    return this.inSpace(run.spaceId, "space-secret.run-read", async (tx) => {
      const spaceId = await liveRunSpace(tx, run, "read");
      const rows = await runViews(tx, spaceId, run.runId, refs);
      for (const ref of refs ?? []) {
        const row = rows.find((candidate) => candidate.secret_ref === ref);
        // CLIs keep waiting on a request card while the refusal says "is not
        // saved" or "not configured for this Agent"; older ones match only these.
        if (!row) throw new SpaceSecretError("secret_not_found", 404, `Secret ${ref} is not saved in this Space`);
        if (row.readable !== true) throw new SpaceSecretError("secret_approval_required", 403,
          `Secret ${ref} is not configured for this Agent yet: a Space admin approves it on a card`);
      }
      const readable = rows.filter((row) => row.readable === true);
      const secrets = [];
      for (const row of readable) secrets.push({ secretRef: String(row.secret_ref), envName: String(row.env_name),
        value: await decryptSpaceSecretValue(this.material, row) });
      if (secrets.length) await tx.query({ name: "space_secret_run_read_audit_v2", text: `INSERT INTO
        data.secret_grant_audit (command_id,grant_id,owner_user_id,action,machine_id,space_id,secret_refs_json,created_at)
        VALUES ($1,$2,$3,'space_read',NULL,$4,$5::jsonb,clock_timestamp())`, values: [crypto.randomUUID(),
        `run:${run.runId}`.slice(0, 300), run.ownerUserId, spaceId,
        JSON.stringify(secrets.map((secret) => secret.secretRef))], maxRows: 0 });
      return { secrets };
    });
  }

  /** An Agent saves a credential it already holds into its Space. It cannot
   * replace one, and only this Run may read it until an admin opens it up. */
  async runCreate(run: RunSecretCaller, input: SpaceSecretChange) {
    return this.inSpace(run.spaceId, "space-secret.run-create", async (tx) => {
      const spaceId = await liveRunSpace(tx, run, "write");
      const secret = await this.write(tx, spaceId, run.ownerUserId, { ...input, access: "ask" }, "create");
      await approveRun(tx, spaceId, run.runId, secret.secretRef, run.ownerUserId);
      return { secret };
    });
  }

  /**
   * A Space admin answers a Run's request card: saves the value when the
   * Space has no such secret yet (or a new one is typed), and lets that Run
   * read it. Repeating it is harmless.
   */
  async approve(input: SpaceSecretChange & { userId: string; runId: string; channelId: string }) {
    const ref = secretRefOf(input.secretRef);
    return this.inChannelSpace(input.channelId, "space-secret.approve", async (tx, spaceId) => {
      await requireRunInChannel(tx, input.runId, input.channelId);
      await requireRole(tx, spaceId, input.userId, SECRET_ADMINS, "approves its secrets");
      if (input.value !== undefined) await this.write(tx, spaceId, input.userId, { ...input, secretRef: ref }, "upsert");
      const saved = await tx.query({ name: "space_secret_approve_read_v1", text: `SELECT 1 FROM data.space_secrets
        WHERE space_id=$1 AND secret_ref=$2`, values: [spaceId, ref], maxRows: 1 });
      if (!saved[0]) throw new SpaceSecretError("secret_value_required", 400, "Type the value: this Space has no such secret yet");
      await approveRun(tx, spaceId, input.runId, ref, input.userId);
      return requestStatus(tx, spaceId, input.runId, ref, input.userId);
    });
  }

  /** Whether a request card is answered, for whoever views it. */
  async requestStatus(input: { userId: string; runId: string; channelId: string; secretRef: string }) {
    const ref = secretRefOf(input.secretRef);
    return this.inChannelSpace(input.channelId, "space-secret.request-status", async (tx, spaceId) => {
      await requireRunInChannel(tx, input.runId, input.channelId);
      await requireRole(tx, spaceId, input.userId, SECRET_READERS, "sees its secret requests");
      return requestStatus(tx, spaceId, input.runId, ref, input.userId);
    });
  }

  /** A transaction on the Space's own shard; Space secrets live with the Space. */
  private inSpace<T>(spaceId: string, operation: string, callback: (tx: DatabaseTransaction) => Promise<T>) {
    return inActiveSpace(this.database, { requestId: crypto.randomUUID(), operation, spaceId }, SpaceSecretError, callback);
  }

  /** A transaction on the shard of the Space a Channel belongs to. */
  private async inChannelSpace<T>(channelId: string, operation: string,
    callback: (tx: DatabaseTransaction, spaceId: string) => Promise<T>) {
    const route = await new PostgresChannelSpaceDirectory(this.database)
      .resolve({ requestId: crypto.randomUUID(), operation }, channelId);
    if (!route) throw new SpaceSecretError("run_not_found", 404, "That Agent Run is not in this Channel");
    return this.inSpace(route.spaceId, operation, (tx) => callback(tx, route.spaceId));
  }

  private async write(tx: DatabaseTransaction, spaceId: string, userId: string, input: SpaceSecretChange,
    mode: "create" | "upsert"): Promise<SpaceSecretEntry> {
    const ref = secretRefOf(input.secretRef);
    const value = input.value;
    if (value !== undefined && (typeof value !== "string" || !value.trim() || utf8ByteLength(value) > MAX_VALUE_BYTES)) {
      throw new SpaceSecretError("invalid_request", typeof value === "string" && value.trim() ? 413 : 400,
        typeof value === "string" && value.trim() ? "A secret value is at most 64 KiB" : "A secret value cannot be empty");
    }
    if (input.access !== undefined && !isSpaceSecretAccess(input.access)) {
      throw new SpaceSecretError("invalid_request", 400, "access must be auto or ask");
    }
    // One writer per alias, so the version a value is bound to is the one stored.
    await tx.query({ name: "space_secret_write_lock_v1", text: "SELECT pg_advisory_xact_lock(hashtextextended('space-secret:'||$1||':'||$2,0))",
      values: [spaceId, ref], maxRows: 1 });
    const current = (await tx.query({ name: "space_secret_write_read_v1", text: `SELECT * FROM data.space_secrets
      WHERE space_id=$1 AND secret_ref=$2`, values: [spaceId, ref], maxRows: 1 }))[0];
    if (current && mode === "create") throw new SpaceSecretError("secret_already_exists", 409,
      "This Space already has a secret with this alias");
    if (!current && value === undefined) throw new SpaceSecretError("secret_value_required", 400, "A new secret needs its value");
    if (!current) {
      const count = await tx.query({ name: "space_secret_write_count_v1", text: `SELECT count(*)::int AS count
        FROM data.space_secrets WHERE space_id=$1`, values: [spaceId], maxRows: 1 });
      if (Number(count[0]?.count ?? 0) >= MAX_SPACE_SECRETS) throw new SpaceSecretError("secret_limit_reached", 409,
        `A Space holds at most ${MAX_SPACE_SECRETS} secrets`);
    }
    const envName = input.envName !== undefined ? envNameOf(input.envName) : current ? String(current.env_name) : defaultSecretEnvName(ref);
    const description = input.description !== undefined ? descriptionOf(input.description) : current?.description ?? null;
    const access = input.access ?? (current ? String(current.access) : "ask");
    const valueVersion = Number(current?.value_version ?? 0) + (value === undefined ? 0 : 1);
    const sealed = value === undefined ? null : {
      envelope: JSON.stringify(await encryptSpaceSecretValue(this.material, spaceId, ref, valueVersion, value)),
      digest: await secretHmac(this.material, `space-secret-value-v1\0${spaceId}\0${ref}\0${value}`),
    };
    const rows = current ? await tx.query({ name: "space_secret_update_v1", text: `UPDATE data.space_secrets
      SET env_name=$3,description=$4,access=$5,encrypted_value_json=COALESCE($6::jsonb,encrypted_value_json),
        value_version=$7,value_digest=COALESCE($8,value_digest),updated_by_user_id=$9,version=version+1,
        updated_at=GREATEST(clock_timestamp(),created_at) WHERE space_id=$1 AND secret_ref=$2 RETURNING *`,
    values: [spaceId, ref, envName, description, access, sealed?.envelope ?? null, valueVersion,
      sealed?.digest ?? null, userId], maxRows: 1 }) : await tx.query({ name: "space_secret_insert_v1", text: `INSERT INTO
      data.space_secrets (space_id,secret_ref,env_name,description,access,encrypted_value_json,value_version,
        value_digest,created_by_user_id,updated_by_user_id,version,created_at,updated_at)
      VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$9,1,clock_timestamp(),clock_timestamp()) RETURNING *`,
    values: [spaceId, ref, envName, description, access, sealed!.envelope, valueVersion, sealed!.digest, userId],
    maxRows: 1 });
    return entry(rows[0]!);
  }
}

/** The card names a Run and its Channel; they must agree. */
async function requireRunInChannel(tx: DatabaseTransaction, runId: string, channelId: string) {
  const rows = await tx.query({ name: "space_secret_run_channel_v1", text: `SELECT 1 FROM data.runs
    WHERE run_id=$1 AND channel_id=$2 LIMIT 1`, values: [runId, channelId], maxRows: 1 });
  if (!rows[0]) throw new SpaceSecretError("run_not_found", 404, "That Agent Run is not in this Channel");
}

async function approveRun(tx: DatabaseTransaction, spaceId: string, runId: string, ref: string, userId: string) {
  await tx.query({ name: "space_secret_approve_run_v1", text: `INSERT INTO data.run_secret_approvals
    (run_id,secret_ref,space_id,approved_by_user_id,approved_at) VALUES ($1,$2,$3,$4,clock_timestamp())
    ON CONFLICT (run_id,secret_ref) DO NOTHING`, values: [runId, ref, spaceId, userId], maxRows: 0 });
}

async function requestStatus(tx: DatabaseTransaction, spaceId: string, runId: string, ref: string, userId: string) {
  const row = (await runViews(tx, spaceId, runId, [ref]))[0];
  return { saved: !!row, readable: row?.readable === true, ...(row ? { secret: entry(row) } : {}),
    canApprove: SECRET_ADMINS.includes((await role(tx, spaceId, userId)) ?? "") };
}
