import type { QueryResultRow } from "pg";

import type { DatabaseTransaction } from "./contracts.js";

export type ChannelPrincipal = { kind: "user" | "agent"; id: string };

type HumanRoles = "all" | "non_viewer" | "owner_admin";
type LifecycleLock = "none" | "share" | "no_key_update" | "update";

interface ChannelCapabilityPolicy {
  principals: readonly ChannelPrincipal["kind"][];
  humanRoles: HumanRoles;
  lock: LifecycleLock;
}

export const CHANNEL_CAPABILITY_POLICIES = Object.freeze({
  message_content_read: policy("all", "none"),
  message_viewer_state_update: policy("all", "none"),
  message_active_command_preflight: policy("non_viewer", "none"),
  message_active_command: policy("non_viewer", "share"),
  // An append later advances the Channel's activity_at in the same transaction.
  // Taking that row lock up front, rather than a share lock it would upgrade,
  // keeps two concurrent appends (or an append and an access change) from each
  // holding a share the other must wait out: PostgreSQL resolves that as a
  // deadlock and the message is refused.
  message_append: policy("non_viewer", "no_key_update"),
  message_maintenance_repair: policy("non_viewer", "share"),
  runtime_history_read: userPolicy("all", "none"),
  runtime_new_work: userPolicy("non_viewer", "update"),
  runtime_continue: userPolicy("non_viewer", "share"),
  runtime_terminalize: userPolicy("non_viewer", "share"),
  // A live Run's registration rechecked by a caller that starts nothing.
  runtime_check: userPolicy("non_viewer", "none"),
  secret_pending_read: userPolicy("all", "none"),
  // A Run reading secrets creates nothing that a Channel change must order
  // behind, so it waits on no launch or append holding the Channel row.
  secret_run_read: userPolicy("non_viewer", "none"),
  secret_new_work: userPolicy("non_viewer", "share"),
  secret_terminalize: userPolicy("non_viewer", "share"),
  app_history_read: policy("all", "none"),
  app_new_work: policy("non_viewer", "share"),
  app_terminalize: policy("non_viewer", "share"),
  scheduler_history_read: policy("all", "none"),
  scheduler_new_work: policy("non_viewer", "share"),
  scheduler_terminalize: policy("non_viewer", "share"),
  automation_history_read: policy("all", "none"),
  automation_new_work: policy("non_viewer", "share"),
  automation_terminalize: policy("non_viewer", "share"),
  trace_history_read: userPolicy("all", "none"),
  trace_new_grant: userPolicy("all", "share"),
  content_history_read: policy("all", "none"),
  content_new_work: policy("all", "share"),
  content_terminalize: policy("all", "share"),
  machine_new_work: userPolicy("non_viewer", "share"),
  catalog_read: policy("all", "none"),
  space_transfer_propose: agentPolicy("share"),
  preference_update: userPolicy("all", "share"),
} satisfies Record<string, ChannelCapabilityPolicy>);

export type ChannelCapability = keyof typeof CHANNEL_CAPABILITY_POLICIES;

export interface ChannelCapabilityFailure {
  code: "channel_not_found";
  status: 404;
  message: string;
}

export type ChannelCapabilityErrorAdapter = (failure: ChannelCapabilityFailure) => Error;

export interface ChannelCapabilityScope {
  channelId: string;
  principal: ChannelPrincipal;
  spaceId?: string;
}

interface AuthorizedChannelRow extends QueryResultRow {
  channel_id: string;
  space_id: string;
  mode: string;
  metadata_json: Record<string, unknown> | null;
  version: string | number;
}

export interface ChannelCapabilityGrant {
  channelId: string;
  spaceId: string;
  mode: string;
  metadata: Record<string, unknown> | null;
  version: number;
}

function policy(humanRoles: HumanRoles, lock: LifecycleLock): ChannelCapabilityPolicy {
  return { principals: ["user", "agent"], humanRoles, lock };
}

function userPolicy(humanRoles: HumanRoles, lock: LifecycleLock): ChannelCapabilityPolicy {
  return { principals: ["user"], humanRoles, lock };
}

function agentPolicy(lock: LifecycleLock): ChannelCapabilityPolicy {
  return { principals: ["agent"], humanRoles: "all", lock };
}

function humanRoleClause(policy: ChannelCapabilityPolicy, memberAlias: string, channelAlias: string,
  userIdSql: string): string {
  if (policy.humanRoles === "all") return "TRUE";
  // A viewer only reads; a participant acts only in the intake conversations
  // they started (docs/design/open-project-governance.md §2).
  if (policy.humanRoles === "non_viewer") {
    return `(${memberAlias}.role NOT IN ('viewer','participant') OR (${memberAlias}.role='participant'
      AND ${channelAlias}.metadata_json->>'intakeOf'=${userIdSql}))`;
  }
  return `${memberAlias}.role IN ('owner','admin')`;
}

export function channelCapabilityPredicate(input: {
  capability: ChannelCapability;
  channelAlias: string;
  principalKindSql: string;
  principalIdSql: string;
  /** Also admit a live Channel About session reading its own Channel's content. */
  channelAboutSessionRead?: boolean;
}): string {
  const capability = CHANNEL_CAPABILITY_POLICIES[input.capability];
  const c = input.channelAlias;
  const kind = input.principalKindSql;
  const id = input.principalIdSql;
  const user = capability.principals.includes("user") ? `(${kind}='user' AND EXISTS (
    SELECT 1 FROM data.space_members channel_member
    WHERE channel_member.space_id=${c}.space_id AND channel_member.user_id=${id}
      AND ${humanRoleClause(capability, "channel_member", c, id)}
      AND (${c}.mode<>'closed' OR EXISTS (
        SELECT 1 FROM data.channel_access channel_grant
        WHERE channel_grant.space_id=${c}.space_id AND channel_grant.channel_id=${c}.channel_id
          AND channel_grant.subject_kind='user' AND channel_grant.subject_id=${id})
        OR channel_member.role IN ('owner','admin'))))` : "FALSE";
  const agentGrant = `EXISTS (
      SELECT 1 FROM data.channel_access channel_grant
      WHERE channel_grant.space_id=${c}.space_id AND channel_grant.channel_id=${c}.channel_id
        AND channel_grant.subject_kind='agent' AND channel_grant.subject_id=${id})`;
  const openChannel = `${c}.mode<>'closed'`;
  // An Agent is the Instance of a registered Run in this Space; it may always
  // use the Channel it was started in, open Channels, and Channels granted to it.
  const agent = capability.principals.includes("agent") ? `(${kind}='agent' AND EXISTS (
    SELECT 1 FROM data.instances channel_instance
    JOIN data.run_agent_registrations channel_registration ON channel_registration.run_id=channel_instance.run_id
    WHERE channel_instance.instance_id=${id} AND channel_registration.space_id=${c}.space_id
      AND (${openChannel} OR channel_instance.channel_id=${c}.channel_id OR ${agentGrant})))` : "FALSE";
  // A Channel About session has no Instance: its session id is its live Run's
  // id. Where a reader opts in, it reads the content of the one Channel it summarizes.
  const aboutSession = input.channelAboutSessionRead && input.capability === "message_content_read" ? `(${kind}='agent' AND EXISTS (
    SELECT 1 FROM data.runs about_run
    JOIN data.run_agent_registrations about_registration ON about_registration.run_id=about_run.run_id
    WHERE about_run.run_id=${id} AND about_run.channel_id=${c}.channel_id
      AND about_registration.space_id=${c}.space_id AND about_run.status IN ('starting','running')
      AND about_run.metadata_json->>'routedAs'='management_channel_about'
      AND about_run.metadata_json->>'runtimeSessionId'=${id}))` : "FALSE";
  return aboutSession === "FALSE" ? `((${user}) OR (${agent}))` : `((${user}) OR (${agent}) OR (${aboutSession}))`;
}

function lockClause(lock: LifecycleLock): string {
  if (lock === "share") return " FOR SHARE OF c";
  if (lock === "no_key_update") return " FOR NO KEY UPDATE OF c";
  if (lock === "update") return " FOR UPDATE OF c";
  return "";
}

function notFound(error: ChannelCapabilityErrorAdapter): Error {
  return error({ code: "channel_not_found", status: 404, message: "Channel not found" });
}

export async function requireChannelCapability(
  transaction: DatabaseTransaction,
  input: ChannelCapabilityScope & {
    capability: ChannelCapability;
    error: ChannelCapabilityErrorAdapter;
  },
): Promise<ChannelCapabilityGrant> {
  const policy = CHANNEL_CAPABILITY_POLICIES[input.capability];
  const rows = await transaction.query<AuthorizedChannelRow>({
    name: `channel_capability_${input.capability}_v3`,
    text: `SELECT c.channel_id,c.space_id,c.mode,c.metadata_json,c.version
      FROM data.channels c
      WHERE c.channel_id=$1 AND ($2::text IS NULL OR c.space_id=$2)
        AND ${channelCapabilityPredicate({ capability: input.capability, channelAlias: "c",
          principalKindSql: "$3", principalIdSql: "$4" })}
      LIMIT 1${lockClause(policy.lock)}`,
    values: [input.channelId, input.spaceId ?? null, input.principal.kind, input.principal.id],
    maxRows: 1,
  });
  const row = rows[0];
  if (!row) throw notFound(input.error);
  return { channelId: row.channel_id, spaceId: row.space_id, mode: row.mode,
    metadata: row.metadata_json, version: Number(row.version) };
}

/**
 * Take the Channel lock a capability's check takes, without authorizing any
 * principal. For a coordinator that must order its own row locks behind the
 * Channel exactly as the authorized paths do (see the staged-launch recheck).
 */
export async function lockChannelLifecycle(
  transaction: DatabaseTransaction,
  input: { channelId: string; capability: ChannelCapability },
): Promise<void> {
  const lock = lockClause(CHANNEL_CAPABILITY_POLICIES[input.capability].lock);
  if (!lock) throw new Error(`Channel capability ${input.capability} takes no Channel lock`);
  await transaction.query({ name: `channel_lifecycle_lock_${input.capability}_v1`,
    text: `SELECT 1 FROM data.channels c WHERE c.channel_id=$1${lock}`,
    values: [input.channelId], maxRows: 1 });
}

export function channelCapabilityCte(input: {
  capability: ChannelCapability;
  inputCte: string;
  cteName?: string;
  channelAboutSessionRead?: boolean;
}): string {
  const policy = CHANNEL_CAPABILITY_POLICIES[input.capability];
  const cteName = input.cteName ?? "authorized_channel";
  return `${cteName} AS MATERIALIZED (
    SELECT c.channel_id,c.space_id,c.mode,c.metadata_json,c.version,TRUE AS authorized
    FROM data.channels c CROSS JOIN ${input.inputCte} input
    WHERE c.space_id=input.space_id AND c.channel_id=input.channel_id
      AND ${channelCapabilityPredicate({ capability: input.capability, channelAlias: "c",
        principalKindSql: "input.principal_kind", principalIdSql: "input.principal_id",
        ...(input.channelAboutSessionRead ? { channelAboutSessionRead: true } : {}) })}
    LIMIT 1${lockClause(policy.lock)}
  )`;
}

/** An authorized-channel CTE yields no row for a Channel the principal may not use. */
export function requireAuthorizedChannel(
  authorized: boolean | null | undefined,
  error: ChannelCapabilityErrorAdapter,
): void {
  if (!authorized) throw notFound(error);
}
