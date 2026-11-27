import { ControlError } from "./control-error.js";
import type { QueryResultRow } from "pg";
import {
  isLiveAgentStatus, isSpaceSecretAccess, SECRET_ENV_NAME_PATTERN, utf8ByteLength,
  type SpaceSecretAccess, type SpaceSecretEntry,
} from "@xmatrix/protocol";

import type { AuthorityDatabase, DatabaseQuery, DatabaseTransaction } from "./contracts.js";
import { requireRunRegistrationAccess } from "./agent-registration-run.js";
import { requireChannelCapability } from "./channel-capability-policy.js";
import { inActiveSpace } from "./page-control.js";
import { PostgresChannelSpaceDirectory } from "./placement.js";
import { decryptSpaceSecretValue, encryptSpaceSecretValue, secretHmac } from "./secret-value-control.js";

const SECRET_READ_PAGE_ROWS = 128;
const MAX_CATALOG_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_SECRET_READ_BYTES = 8 * 1024 * 1024;
const MAX_VALUE_BYTES = 64 * 1024;
const SECRET_REF = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/u;
const SECRET_METADATA_COLUMNS = `s.space_id,s.secret_ref,s.env_name,s.description,s.access,
  s.created_by_user_id,s.created_at,s.updated_at`;

/** The kind of thing an admission policy is asked about here: a Run asks to use a secret that asks first. */
export const SECRET_USE_ADMISSION = "secret.use";
const MAX_ADMISSION_POLICY_BYTES = 16 * 1024;
const ADMISSION_LIBRARY_NAME = /^[A-Z][A-Za-z0-9_]{0,39}$/u;

/** The policy a Space adopted, as its admins read it (docs/design/admission-policy.md). */
export interface SpaceAdmissionPolicy {
  pageId: string; libraryName: string; sourceText: string; sourceSha256: string; adoptedByUserId: string; adoptedAt: string;
}
/** The Page program whose open request a Run is working on: `<page id>/<block name>` and the digest of its text. */
export interface AdmissionWork { program: string; digest: string }

function admissionPolicy(row: QueryResultRow): SpaceAdmissionPolicy {
  return { pageId: String(row.page_id), libraryName: String(row.library_name), sourceText: String(row.source_text),
    sourceSha256: String(row.source_sha256), adoptedByUserId: String(row.adopted_by_user_id),
    adoptedAt: new Date(row.adopted_at as string).toISOString() };
}

/**
 * The adopted policy while whoever adopted it is still an owner or admin of
 * the Space: authority is current, so a policy a former admin adopted is none.
 */
const ADMISSION_POLICY_IN_FORCE_SQL = `SELECT p.page_id,p.library_name,p.source_text,p.source_sha256,p.adopted_by_user_id,p.adopted_at
  FROM data.space_admission_policies p JOIN data.space_members m ON m.space_id=p.space_id AND m.user_id=p.adopted_by_user_id
  WHERE p.space_id=$1 AND m.role IN ('owner','admin')`;

/**
 * The Page programs whose open request this Run is working on now. Attributed
 * by Run, never by Instance: the Run has an execution of the request's
 * delivery message that is accepted or running. A Run that has reported no
 * execution yet is taken by what triggered its launch; the trigger alone
 * stays true for the Run's whole life, so it counts only until then. A
 * delegated request, a request the Instance itself asked, and a stopped or
 * ad-hoc program never count.
 */
const ADMISSION_WORK_SQL = `SELECT DISTINCT p.page_id,p.page_name,encode(sha256(convert_to(p.source,'UTF8')),'hex') AS digest
  FROM data.norn_requests r JOIN data.norn_programs p ON p.space_id=r.space_id AND p.program_id=r.program_id
  WHERE r.space_id=$1 AND r.channel_id=$2 AND r.settled_at IS NULL AND r.delegator_user_id IS NULL
    AND p.state='running' AND p.stop_reason IS NULL AND p.page_id IS NOT NULL AND p.page_name IS NOT NULL
    AND (EXISTS (SELECT 1 FROM data.agent_message_executions working WHERE working.run_id=$3
        AND working.channel_id=r.channel_id AND working.source_message_id=r.delivery_message_id
        AND working.state IN ('accepted','running'))
      OR (NOT EXISTS (SELECT 1 FROM data.agent_message_executions any_execution WHERE any_execution.run_id=$3)
        AND EXISTS (SELECT 1 FROM data.agent_launches launch WHERE launch.run_id=$3
          AND launch.channel_id=r.channel_id AND launch.trigger_id=r.delivery_message_id)))
  LIMIT 2`;

async function admissionWork(tx: DatabaseTransaction, spaceId: string, run: RunSecretCaller): Promise<AdmissionWork | undefined> {
  const rows = await tx.query({ name: "space_secret_admission_work_v1", text: ADMISSION_WORK_SQL,
    values: [spaceId, run.channelId, run.runId], maxRows: 2 });
  // Work for two programs at once names neither.
  return rows.length === 1 ? { program: `${String(rows[0]!.page_id)}/${String(rows[0]!.page_name)}`, digest: String(rows[0]!.digest) }
    : undefined;
}

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

/** Read the complete catalog without turning a query's row budget into a Space
 * quota. Each keyset page has its own SQL bound; the transaction deadline and
 * response byte budget bound the complete operation. */
async function secretRows(tx: DatabaseTransaction, query: (after: string | null) => DatabaseQuery,
  maxBytes: number): Promise<QueryResultRow[]> {
  const rows: QueryResultRow[] = [];
  let bytes = 0;
  let after: string | null = null;
  for (;;) {
    const page: readonly QueryResultRow[] = await tx.query(query(after));
    for (const row of page) {
      bytes += utf8ByteLength(JSON.stringify(row));
      if (bytes > maxBytes) throw new SpaceSecretError("secret_response_too_large", 413,
        "Secret response exceeds the request byte budget");
      rows.push(row);
    }
    if (page.length < SECRET_READ_PAGE_ROWS) return rows;
    after = String(page[page.length - 1]!.secret_ref);
  }
}

async function runViews(tx: DatabaseTransaction, spaceId: string, runId: string, refs?: string[], values = false) {
  return secretRows(tx, (after) => ({ name: values ? "space_secret_run_values_v2" : "space_secret_run_views_v2",
    text: `SELECT ${SECRET_METADATA_COLUMNS}${values ? `,s.value_version,
    CASE WHEN s.access='auto' OR a.run_id IS NOT NULL THEN s.encrypted_value_json END AS encrypted_value_json` : ""},
    (s.access='auto' OR a.run_id IS NOT NULL) AS readable FROM data.space_secrets s
    LEFT JOIN data.run_secret_approvals a ON a.run_id=$2 AND a.secret_ref=s.secret_ref AND a.space_id=s.space_id
    WHERE s.space_id=$1 AND ($3::text[] IS NULL OR s.secret_ref=ANY($3::text[]))
      AND ($4::text IS NULL OR s.secret_ref>$4) ORDER BY s.secret_ref LIMIT $5`,
    values: [spaceId, runId, refs ?? null, after, SECRET_READ_PAGE_ROWS], maxRows: SECRET_READ_PAGE_ROWS }),
  values ? MAX_SECRET_READ_BYTES : MAX_CATALOG_RESPONSE_BYTES);
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
      const rows = await secretRows(tx, (after) => ({ name: "space_secret_list_v2",
        text: `SELECT ${SECRET_METADATA_COLUMNS} FROM data.space_secrets s
          WHERE s.space_id=$1 AND ($2::text IS NULL OR s.secret_ref>$2) ORDER BY s.secret_ref LIMIT $3`,
        values: [input.spaceId, after, SECRET_READ_PAGE_ROWS], maxRows: SECRET_READ_PAGE_ROWS }),
      MAX_CATALOG_RESPONSE_BYTES);
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

  /**
   * A Space admin fills an app connection's credentials from secrets the
   * Space already holds. The values go straight to the connection's encrypted
   * credential store, never back to the person, and each read is audited
   * under the connection. Whether an Agent may read a secret plays no part.
   */
  async adminReadForConnection(input: { spaceId: string; userId: string; providerId: string; secretRefs: readonly unknown[] }):
    Promise<Map<string, string>> {
    if (input.secretRefs.length < 1 || input.secretRefs.length > 16) {
      throw new SpaceSecretError("invalid_request", 400, "Name between 1 and 16 secrets");
    }
    const refs = [...new Set(input.secretRefs.map(secretRefOf))];
    const providerId = String(input.providerId).slice(0, 80);
    return this.inSpace(input.spaceId, "space-secret.connection-fill", async (tx) => {
      await requireRole(tx, input.spaceId, input.userId, SECRET_ADMINS, "fills app credentials from its secrets");
      const rows = await secretRows(tx, (after) => ({ name: "space_secret_connection_values_v1",
        text: `SELECT ${SECRET_METADATA_COLUMNS},s.value_version,s.encrypted_value_json FROM data.space_secrets s
          WHERE s.space_id=$1 AND s.secret_ref=ANY($2::text[]) AND ($3::text IS NULL OR s.secret_ref>$3)
          ORDER BY s.secret_ref LIMIT $4`,
        values: [input.spaceId, refs, after, SECRET_READ_PAGE_ROWS], maxRows: SECRET_READ_PAGE_ROWS }), MAX_SECRET_READ_BYTES);
      const values = new Map<string, string>();
      for (const ref of refs) {
        const row = rows.find((candidate) => candidate.secret_ref === ref);
        if (!row) throw new SpaceSecretError("secret_not_found", 404, `Secret ${ref} is not saved in this Space`);
        values.set(ref, await decryptSpaceSecretValue(this.material, row));
      }
      await tx.query({ name: "space_secret_connection_fill_audit_v1", text: `INSERT INTO
        data.secret_grant_audit (command_id,grant_id,owner_user_id,action,machine_id,space_id,secret_refs_json,created_at)
        VALUES ($1,$2,$3,'connection_fill',NULL,$4,$5::jsonb,clock_timestamp())`, values: [crypto.randomUUID(),
        `connection:${input.spaceId}:${providerId}`.slice(0, 300), input.userId, input.spaceId, JSON.stringify(refs)], maxRows: 0 });
      return values;
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
      const rows = await runViews(tx, spaceId, run.runId, refs, true);
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
   * A Run whose owner is a Space admin makes a held secret `ask`: fewer Runs
   * read it, which its owner may do by hand, and it is audited. Opening one
   * up to `auto`, or changing its value, stays with a person.
   */
  async runAsk(run: RunSecretCaller, secretRef: string) {
    const ref = secretRefOf(secretRef);
    return this.inSpace(run.spaceId, "space-secret.run-ask", async (tx) => {
      const spaceId = await liveRunSpace(tx, run, "write");
      await requireRole(tx, spaceId, run.ownerUserId, SECRET_ADMINS, "changes how its secrets are read");
      const rows = await tx.query({ name: "space_secret_run_ask_v1", text: `UPDATE data.space_secrets
        SET access='ask',updated_by_user_id=$3,version=version+(access<>'ask')::int,
          updated_at=CASE WHEN access<>'ask' THEN GREATEST(clock_timestamp(),created_at) ELSE updated_at END
        WHERE space_id=$1 AND secret_ref=$2 RETURNING *`, values: [spaceId, ref, run.ownerUserId], maxRows: 1 });
      if (!rows[0]) throw new SpaceSecretError("secret_not_found", 404, `Secret ${ref} is not saved in this Space`);
      await tx.query({ name: "space_secret_run_ask_audit_v1", text: `INSERT INTO
        data.secret_grant_audit (command_id,grant_id,owner_user_id,action,machine_id,space_id,secret_refs_json,created_at)
        VALUES ($1,$2,$3,'space_ask',NULL,$4,$5::jsonb,clock_timestamp())`, values: [crypto.randomUUID(),
        `run:${run.runId}`.slice(0, 300), run.ownerUserId, spaceId, JSON.stringify([ref])], maxRows: 0 });
      return { secret: entry(rows[0]) };
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

  /**
   * A Space admin answers a Run's card asking that secrets be read without
   * asking: each one the admin chose becomes `auto`. Repeating it is harmless.
   */
  async makeAutomatic(input: { userId: string; runId: string; channelId: string; secretRefs: readonly string[] }) {
    const refs = [...new Set(input.secretRefs.map(secretRefOf))];
    return this.inChannelSpace(input.channelId, "space-secret.make-automatic", async (tx, spaceId) => {
      await requireRunInChannel(tx, input.runId, input.channelId);
      await requireRole(tx, spaceId, input.userId, SECRET_ADMINS, "changes how its secrets are read");
      await tx.query({ name: "space_secret_make_automatic_v1", text: `UPDATE data.space_secrets
        SET access='auto', updated_at=clock_timestamp()
        WHERE space_id=$1 AND secret_ref=ANY($2::text[]) AND access<>'auto'`, values: [spaceId, refs], maxRows: 0 });
      return accessStatus(tx, spaceId, refs, input.userId);
    });
  }

  /** How each secret a secret access card names is read now, for whoever views it. */
  async accessStatus(input: { userId: string; runId: string; channelId: string; secretRefs: readonly string[] }) {
    const refs = [...new Set(input.secretRefs.map(secretRefOf))];
    return this.inChannelSpace(input.channelId, "space-secret.access-status", async (tx, spaceId) => {
      await requireRunInChannel(tx, input.runId, input.channelId);
      await requireRole(tx, spaceId, input.userId, SECRET_READERS, "sees its secret requests");
      return accessStatus(tx, spaceId, refs, input.userId);
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

  /** The Space's adopted admission policy, for a member; its text only for one who may adopt. */
  async admissionPolicy(input: { spaceId: string; userId: string }): Promise<{ policy?: SpaceAdmissionPolicy; canAdopt: boolean }> {
    return this.inSpace(input.spaceId, "space-secret.admission-policy", async (tx) => {
      const memberRole = await role(tx, input.spaceId, input.userId);
      if (!memberRole || !SECRET_READERS.includes(memberRole)) {
        throw new SpaceSecretError("forbidden", 403, "Only a Space member sees its admission policy");
      }
      const canAdopt = SECRET_ADMINS.includes(memberRole);
      const rows = await tx.query({ name: "space_secret_admission_policy_read_v1", text: `SELECT page_id,library_name,
        source_text,source_sha256,adopted_by_user_id,adopted_at FROM data.space_admission_policies WHERE space_id=$1`,
      values: [input.spaceId], maxRows: 1 });
      if (!rows[0]) return { canAdopt };
      const policy = admissionPolicy(rows[0]);
      return { policy: canAdopt ? policy : { ...policy, sourceText: "" }, canAdopt };
    });
  }

  /**
   * A Space admin adopts, in person, the text of one library on one of the
   * Space's Pages as its admission policy. The caller read that text from the
   * Page and checked it; this stores what was adopted, from where and by whom.
   */
  async adoptAdmissionPolicy(input: { spaceId: string; userId: string; pageId: string; libraryName: string;
    sourceText: string; sourceSha256: string }): Promise<{ policy: SpaceAdmissionPolicy }> {
    if (!ADMISSION_LIBRARY_NAME.test(input.libraryName) || !/^[0-9a-f]{64}$/u.test(input.sourceSha256) || !input.sourceText.trim() ||
        !input.pageId || input.pageId.length > 300) {
      throw new SpaceSecretError("invalid_request", 400, "An admission policy is a library on a Page, with its text and digest");
    }
    if (utf8ByteLength(input.sourceText) > MAX_ADMISSION_POLICY_BYTES) {
      throw new SpaceSecretError("invalid_request", 413, "An admission policy is at most 16 KiB");
    }
    return this.inSpace(input.spaceId, "space-secret.admission-policy-adopt", async (tx) => {
      await requireRole(tx, input.spaceId, input.userId, SECRET_ADMINS, "adopts its admission policy");
      const page = await tx.query({ name: "space_secret_admission_page_v1", text: `SELECT 1 FROM data.pages
        WHERE space_id=$1 AND page_id=$2 LIMIT 1`, values: [input.spaceId, input.pageId], maxRows: 1 });
      if (!page[0]) throw new SpaceSecretError("page_not_found", 404, "That Page is not in this Space");
      const rows = await tx.query({ name: "space_secret_admission_policy_adopt_v1", text: `INSERT INTO
        data.space_admission_policies (space_id,page_id,library_name,source_text,source_sha256,adopted_by_user_id,adopted_at)
        VALUES ($1,$2,$3,$4,$5,$6,clock_timestamp())
        ON CONFLICT (space_id) DO UPDATE SET page_id=EXCLUDED.page_id,library_name=EXCLUDED.library_name,
          source_text=EXCLUDED.source_text,source_sha256=EXCLUDED.source_sha256,
          adopted_by_user_id=EXCLUDED.adopted_by_user_id,adopted_at=EXCLUDED.adopted_at
        RETURNING page_id,library_name,source_text,source_sha256,adopted_by_user_id,adopted_at`,
      values: [input.spaceId, input.pageId, input.libraryName, input.sourceText, input.sourceSha256, input.userId], maxRows: 1 });
      await admissionAudit(tx, input.spaceId, input.userId, "policy_adopt", `policy:${input.sourceSha256}`);
      return { policy: admissionPolicy(rows[0]!) };
    });
  }

  /** A Space admin withdraws the Space's admission policy: every request goes to its card again. */
  async withdrawAdmissionPolicy(input: { spaceId: string; userId: string }): Promise<{ withdrawn: boolean }> {
    return this.inSpace(input.spaceId, "space-secret.admission-policy-withdraw", async (tx) => {
      await requireRole(tx, input.spaceId, input.userId, SECRET_ADMINS, "withdraws its admission policy");
      const rows = await tx.query({ name: "space_secret_admission_policy_withdraw_v1", text: `DELETE FROM
        data.space_admission_policies WHERE space_id=$1 RETURNING source_sha256`, values: [input.spaceId], maxRows: 1 });
      if (rows[0]) await admissionAudit(tx, input.spaceId, input.userId, "policy_withdraw", `policy:${String(rows[0].source_sha256)}`);
      return { withdrawn: Boolean(rows[0]) };
    });
  }

  /**
   * What the Hub needs to put a Run's request for a secret to the Space's
   * policy: the policy in force, and the Page program this Run is working for.
   * Read in one uncached transaction with the Run's own liveness.
   */
  async runAdmission(run: RunSecretCaller): Promise<{ policy?: SpaceAdmissionPolicy; work?: AdmissionWork }> {
    return this.inSpace(run.spaceId, "space-secret.run-admission", async (tx) => {
      const spaceId = await liveRunSpace(tx, run, "read");
      const rows = await tx.query({ name: "space_secret_admission_policy_in_force_v1", text: ADMISSION_POLICY_IN_FORCE_SQL,
        values: [spaceId], maxRows: 1 });
      if (!rows[0]) return {};
      const work = await admissionWork(tx, spaceId, run);
      return { policy: admissionPolicy(rows[0]), ...(work ? { work } : {}) };
    });
  }

  /**
   * The policy answered `Allow`: this Run may read the secret, approved by
   * whoever adopted the policy, as on a card, and audited as the policy's
   * answer. Everything the answer rested on is read again here: the policy's
   * digest, its adopter's role, the Run's liveness and the work it named. If
   * any moved, nothing is approved and the caller posts the card.
   */
  async runAdmit(run: RunSecretCaller, input: { secretRef: string; sourceSha256: string; work?: AdmissionWork }) {
    const ref = secretRefOf(input.secretRef);
    return this.inSpace(run.spaceId, "space-secret.run-admit", async (tx) => {
      const spaceId = await liveRunSpace(tx, run, "read");
      const rows = await tx.query({ name: "space_secret_admission_policy_in_force_v1", text: ADMISSION_POLICY_IN_FORCE_SQL,
        values: [spaceId], maxRows: 1 });
      const policy = rows[0] ? admissionPolicy(rows[0]) : undefined;
      const work = await admissionWork(tx, spaceId, run);
      if (!policy || policy.sourceSha256 !== input.sourceSha256 || work?.program !== input.work?.program ||
          work?.digest !== input.work?.digest) return { readable: false };
      const saved = await tx.query({ name: "space_secret_approve_read_v1", text: `SELECT 1 FROM data.space_secrets
        WHERE space_id=$1 AND secret_ref=$2`, values: [spaceId, ref], maxRows: 1 });
      if (!saved[0]) throw new SpaceSecretError("secret_not_found", 404, `Secret ${ref} is not saved in this Space`);
      await approveRun(tx, spaceId, run.runId, ref, policy.adoptedByUserId);
      await tx.query({ name: "space_secret_admission_approve_audit_v1", text: `INSERT INTO
        data.secret_grant_audit (command_id,grant_id,owner_user_id,action,machine_id,space_id,secret_refs_json,created_at)
        VALUES ($1,$2,$3,'policy_approve',NULL,$4,$5::jsonb,clock_timestamp())`, values: [crypto.randomUUID(),
        `run:${run.runId}`.slice(0, 300), policy.adoptedByUserId, spaceId, JSON.stringify([ref])], maxRows: 0 });
      return { readable: true };
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
      "This Space already has a secret with this alias: an Agent Run makes it ask first with `--access ask` alone; a Space admin changes its value or opens it up");
    if (!current && value === undefined) throw new SpaceSecretError("secret_value_required", 400, "A new secret needs its value");
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

async function admissionAudit(tx: DatabaseTransaction, spaceId: string, userId: string, action: string, grantId: string) {
  await tx.query({ name: "space_secret_admission_audit_v1", text: `INSERT INTO
    data.secret_grant_audit (command_id,grant_id,owner_user_id,action,machine_id,space_id,secret_refs_json,created_at)
    VALUES ($1,$2,$3,$4,NULL,$5,'[]'::jsonb,clock_timestamp())`, values: [crypto.randomUUID(), grantId, userId, action, spaceId],
  maxRows: 0 });
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

/** The named secrets the Space holds, each with how it is read; one it does not hold is left out. */
async function accessStatus(tx: DatabaseTransaction, spaceId: string, refs: string[], userId: string) {
  const rows = await tx.query({ name: "space_secret_access_status_v2", text: `SELECT secret_ref,env_name,access
    FROM data.space_secrets WHERE space_id=$1 AND secret_ref=ANY($2::text[]) ORDER BY secret_ref LIMIT $3`,
  values: [spaceId, refs, refs.length], maxRows: refs.length });
  return { secrets: rows.map((row) => ({ secretRef: String(row.secret_ref), envName: String(row.env_name),
    access: String(row.access) as SpaceSecretAccess })),
    canApprove: SECRET_ADMINS.includes((await role(tx, spaceId, userId)) ?? "") };
}

async function requestStatus(tx: DatabaseTransaction, spaceId: string, runId: string, ref: string, userId: string) {
  const row = (await runViews(tx, spaceId, runId, [ref]))[0];
  return { saved: !!row, readable: row?.readable === true, ...(row ? { secret: entry(row) } : {}),
    canApprove: SECRET_ADMINS.includes((await role(tx, spaceId, userId)) ?? "") };
}
