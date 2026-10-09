import { authorizeDingTalkEffect, finishDingTalkEffect, type DingTalkEffectAuthority } from "./dingtalk-effect-authority.js";
import { dingtalkDenied } from "./dingtalk-company-values.js";
import { storedIso as iso, storedObject as json } from "./stored-values.js";
import type { QueryResultRow } from "pg";
import { ACTIVE_RUN_STATUS_SQL,
  automationRef,
  canonicalAutomationCommand,
  isAutomationIntervalMinutes,
  isTerminalRunStatus,
  legacyAutomationCommandKind,
  legacyAutomationCommandView,
  TERMINAL_RUN_STATUS_SQL } from "@xmatrix/protocol";
import { commandDigest as digest } from "./command-digest.js";
import { cancelRunExecution } from "./runtime-control.js";

import type { AuthorityDatabase, DatabaseTransaction } from "./contracts.js";
import {
  channelCapabilityPredicate,
  requireChannelCapability,
  type ChannelCapability,
  type ChannelCapabilityFailure,
  type ChannelPrincipal,
} from "./channel-capability-policy.js";
import { PostgresEntitySpaceDirectory } from "./entity-directory.js";
import { PostgresUserSpaceMembershipDirectory } from "./membership-directory.js";
import {
  PostgresChannelSpaceDirectory,
  PostgresSpacePlacementDirectory,
  type SpacePlacement,
} from "./placement.js";
import { reserveNaturalKey } from "./natural-keys.js";
import { pageAccess, pageAccessMap } from "./page-control.js";
import { AutomationControlError, automationName, commitAutomationChange as commit } from "./automation-commit.js";

export { automationName };
import { commandFields } from "./command-fields.js";

export { AutomationControlError };

const OCCURRENCE_BATCH_SIZE = 4;
const OCCURRENCE_LEASE_MS = 60_000;
const OCCURRENCE_MAX_ATTEMPTS = 8;
const OCCURRENCE_RETENTION_MS = 30 * 24 * 60 * 60_000;
const OCCURRENCE_MAX_ROWS = 100_000;
const LINEAGE_OCCURRENCE_BUDGET = 4_096;
/** While an occurrence runs, an Automation an event fired checks back this often to take it. */
const TRIGGER_FOLLOW_UP_MS = 60_000;
/**
 * Events run an Automation at most this often: those that arrive sooner wait
 * for one occurrence that takes them all. It bounds the loop an Automation
 * would otherwise start by triggering on the changes its own runs make.
 */
const EVENT_SPACING_MINUTES = 60;

const { text, integer, object } = commandFields((field) =>
  new AutomationControlError("invalid_automation_request", 400, `${field} is invalid`));

function humanPrincipal(input: Record<string, unknown>): string {
  const principal = object(input.principal, "principal");
  if (principal.kind !== "user") throw new AutomationControlError(
    "forbidden", 403, "Agent Automation reads are not yet admitted by PostgreSQL");
  return text(principal.id, "principal.id", 300);
}

function timestamp(value: unknown, field: string): string {
  const result = text(value, field, 100);
  if (!Number.isFinite(Date.parse(result))) {
    throw new AutomationControlError("invalid_automation_request", 400, `${field} is invalid`);
  }
  return result;
}


function publicExecutionCancellation(value: unknown) {
  const cancellation = json(value);
  const cleanup = json(cancellation.processCleanup);
  return { reason: cancellation.reason, requestedAt: cancellation.requestedAt,
    processCleanup: { status: cleanup.status, attempts: cleanup.attempts,
      ...(cleanup.nextAttemptAt ? { nextAttemptAt: cleanup.nextAttemptAt } : {}),
      ...(cleanup.confirmedAt ? { confirmedAt: cleanup.confirmedAt } : {}),
      ...(cleanup.errorCode ? { errorCode: cleanup.errorCode } : {}) } };
}


function nextRunAt(scheduledFor: unknown, intervalMinutes: number, nowMs: number): string {
  const scheduledMs = Date.parse(iso(scheduledFor));
  const intervalMs = Math.floor(intervalMinutes) * 60_000;
  if (!Number.isFinite(scheduledMs) || !Number.isSafeInteger(intervalMs) || intervalMs <= 0) {
    throw new AutomationControlError(
      "invalid_automation_cadence", 409, "Automation cadence is invalid");
  }
  const steps = Math.floor(Math.max(0, nowMs - scheduledMs) / intervalMs) + 1;
  return new Date(scheduledMs + steps * intervalMs).toISOString();
}

function retryBackoff(attempts: number): number {
  return Math.min(15 * 60_000, 5_000 * 2 ** Math.min(Math.max(0, attempts - 1), 8));
}

// The Hub shares one occurrence lifecycle with the retiring Durable Object
// authority, whose SQLite row still says task_id/task_version; this maps the
// PostgreSQL columns onto that in-memory row shape.
function occurrence(row: QueryResultRow): Record<string, unknown> {
  return { id: String(row.occurrence_id), task_id: String(row.automation_id),
    task_version: Number(row.automation_version), owner_user_id: String(row.owner_user_id),
    scheduled_for: iso(row.scheduled_for), status: String(row.status),
    lease_owner: row.lease_owner ? String(row.lease_owner) : null,
    lease_until: row.lease_until ? iso(row.lease_until) : null, attempts: Number(row.attempts),
    next_attempt_at: iso(row.next_attempt_at), run_id: String(row.run_id),
    instance_id: String(row.instance_id), control_id: String(row.control_id),
    delivery_kind: String(row.delivery_kind), message_id: row.message_id ? String(row.message_id) : null,
    error_code: row.error_code ? String(row.error_code) : null,
    error_message: row.error_message ? String(row.error_message) : null,
    execution_timeout_ms: Number(row.execution_timeout_ms),
    execution_deadline_at: row.execution_deadline_at ? iso(row.execution_deadline_at) : null,
    created_at: iso(row.created_at), updated_at: iso(row.updated_at),
    finished_at: row.finished_at ? iso(row.finished_at) : null,
    trigger_events: Array.isArray(row.trigger_events) ? row.trigger_events : [] };
}

function executionIds(occurrenceId: string) {
  const stableId = occurrenceId.replace(/[^A-Za-z0-9:._-]/gu, "-").slice(0, 150);
  return { controlId: `scheduled:${stableId}:spawn`.slice(0, 200),
    runId: `run:scheduled:${stableId}`.slice(0, 200),
    instanceId: `instance:scheduled:${stableId}`.slice(0, 200) };
}

/** The principal an Automation acts as: the Agent that created it, or its Human
 * owner. Authorization reads this; the public record exposes only `owner.id`. */
function automationOwner(row: QueryResultRow): { kind: "user" | "agent"; id: string } {
  const payload = json(row.payload_json);
  const input = json(payload.input);
  const env = json(input.envRef);
  const actor = json(env.actor);
  return payload.payloadVersion === 3 && actor.kind === "agent" && typeof actor.id === "string" && actor.id
    ? { kind: "agent", id: actor.id }
    : { kind: "user", id: String(row.owner_user_id) };
}

type AgentAuthority = {
  principalId: string;
  ownerUserId: string;
  channelId: string;
  spaceId: string;
};

function validateAutomationPayload(payload: Record<string, unknown>, channelId: string,
  authorityRootUserId: string, actorId?: string) {
  const input = json(payload.input);
  const datum = json(input.datum);
  const env = json(input.envRef);
  const root = json(env.root);
  const actor = json(env.actor);
  const resume = json(input.resume);
  const lineage = json(input.lineage);
  const interval = Number(payload.intervalMinutes);
  if (payload.payloadVersion !== 3 || datum.kind !== "text" ||
      datum.language !== "natural-language" || typeof datum.text !== "string" ||
      typeof datum.ref !== "string" || root.kind !== "channel" || root.id !== channelId ||
      resume.kind !== "interval" || Number(resume.intervalMinutes) !== interval ||
      !isAutomationIntervalMinutes(interval) ||
      typeof lineage.rootMessageId !== "string" || !lineage.rootMessageId ||
      !Number.isSafeInteger(Number(lineage.depth)) || Number(lineage.depth) < 0 ||
      Number(lineage.depth) > 16 || !Number.isSafeInteger(Number(lineage.budget)) ||
      Number(lineage.budget) < 1 || Number(lineage.budget) > 128 ||
      env.authorityRootUserId !== authorityRootUserId || actor.kind !== (actorId ? "agent" : "user") ||
      actor.id !== (actorId ?? authorityRootUserId)) throw new AutomationControlError(
    "invalid_automation_request", 400, "Automation requires a valid evaluator input");
}

/** An Agent's binding to its birth Channel: a registered Run's Instance is
 * bound to the Channel it was started in for its lifetime, and may also hold a
 * Channel grant. */
function agentBirthBindingSql(channelSql: string, principalSql: string): string {
  return `(EXISTS (SELECT 1 FROM data.channel_access binding_grant
      WHERE binding_grant.channel_id=${channelSql} AND binding_grant.subject_kind='agent'
        AND binding_grant.subject_id=${principalSql})
    OR EXISTS (SELECT 1 FROM data.instances binding_instance
      JOIN data.run_agent_registrations binding_registration
        ON binding_registration.run_id=binding_instance.run_id
      WHERE binding_instance.instance_id=${principalSql}
        AND binding_instance.channel_id=${channelSql}))`;
}

async function agentReadsBirthChannel(tx: DatabaseTransaction,
  authority: AgentAuthority): Promise<boolean> {
  const rows = await tx.query({ name: "automation_agent_birth_binding_v1",
    text: `SELECT 1 AS present WHERE ${agentBirthBindingSql("$1", "$2")}`,
    values: [authority.channelId, authority.principalId], maxRows: 1 });
  return rows.length > 0;
}

async function agentAuthority(tx: DatabaseTransaction, input: Record<string, unknown>,
  actorUserId: string, principalId: string): Promise<AgentAuthority> {
  const context = object(input.automationAgent, "automationAgent");
  const ownerUserId = text(context.ownerUserId, "automationAgent.ownerUserId", 300);
  if (ownerUserId !== actorUserId) throw new AutomationControlError(
    "forbidden", 403, "Automation Agent owner mismatch");
  const runId = text(context.runId, "automationAgent.runId", 300);
  const channelId = text(context.channelId, "automationAgent.channelId", 300);
  // The Agent is the Instance of a registered Run in the Channel's Space.
  const rows = await tx.query<QueryResultRow>({ name: "automation_agent_authority_v4", text: `SELECT
    r.channel_id,c.space_id,r.metadata_json,i.instance_id
    FROM data.runs r JOIN data.channels c ON c.channel_id=r.channel_id
    JOIN data.run_agent_registrations b ON b.run_id=r.run_id
      AND b.space_id=c.space_id AND b.owner_user_id=r.owner_user_id
    JOIN data.instances i ON i.run_id=r.run_id
    WHERE r.run_id=$1 AND i.instance_id=$2 AND r.owner_user_id=$3
      AND r.channel_id=$4 AND r.status IN ('starting','running') LIMIT 1`,
  values: [runId, principalId, ownerUserId, channelId], maxRows: 1 });
  text(context.executionKey, "automationAgent.executionKey", 300);
  text(context.machineId, "automationAgent.machineId", 300);
  const row = rows[0];
  const metadata = json(row?.metadata_json);
  if (!row || metadata.executionKey !== context.executionKey ||
      metadata.machineId !== context.machineId ||
      context.instanceId !== undefined && row.instance_id !== context.instanceId) {
    throw new AutomationControlError("forbidden", 403, "Automation Agent Run is no longer live");
  }
  return { principalId, ownerUserId, channelId, spaceId: String(row.space_id) };
}

/** An Agent changes only its own Automations, in its birth Channel. */
async function authorizeAgentAutomation(tx: DatabaseTransaction, authority: AgentAuthority,
  automation: QueryResultRow): Promise<void> {
  const owner = automationOwner(automation);
  await automationChannel(tx, String(automation.channel_id),
    { kind: "agent", id: authority.principalId }, "automation_history_read");
  if (owner.kind === "agent" && owner.id === authority.principalId &&
      automation.channel_id === authority.channelId) return;
  throw new AutomationControlError("forbidden", 403,
    owner.kind === "user" ? "A person's Automation is changed by people"
      : "Agent cannot manage this Automation");
}

function authorityRoot(row: QueryResultRow): string {
  const payload = json(row.payload_json);
  const root = json(json(payload.input).envRef).authorityRootUserId;
  return typeof root === "string" && root ? root : String(row.owner_user_id);
}

/** `reasonRequired` is always false: no Automation change needs a stated
 * reason. It stays on the wire for CLIs that still require the field. */
function capabilities(row: QueryResultRow) {
  if (row.page_id) {
    // A page's Automation is managed through its page, by whoever can edit it;
    // a detached one resumes only when its reference is back.
    const canManage = row.can_manage === true;
    const enabled = row.enabled === true;
    return { update: canManage, pause: canManage && enabled, requestPause: false,
      resume: canManage && !enabled && !row.detached_at, run: canManage && enabled, delete: canManage,
      reasonRequired: false };
  }
  if (row.agent_principal_id) {
    const owner = automationOwner(row);
    const own = owner.kind === "agent" && owner.id === row.agent_principal_id;
    return { update: own, pause: own && row.enabled === true, requestPause: false,
      resume: own && row.enabled !== true, run: false, delete: own, reasonRequired: false };
  }
  const canManage = row.can_manage === true;
  const enabled = row.enabled === true;
  // Only a page's Automation runs now: the page route is the one that does it.
  return { update: canManage, pause: canManage && enabled, requestPause: false,
    resume: canManage && !enabled, run: false, delete: canManage, reasonRequired: false };
}

/**
 * A page's Automation is read through its page, whatever conversation it runs
 * in: rows anchored to a page the Human cannot read are dropped, and the rest
 * are theirs to manage exactly when they can edit the page.
 */
async function withPageAccess(tx: DatabaseTransaction, userId: string,
  rows: readonly QueryResultRow[]): Promise<QueryResultRow[]> {
  const spaces = new Map<string, Map<string, { canEdit: boolean }>>();
  const visible: QueryResultRow[] = [];
  for (const row of rows) {
    if (!row.page_id) {
      visible.push(row);
      continue;
    }
    const spaceId = String(row.channel_space_id);
    let pages = spaces.get(spaceId);
    if (!pages) {
      pages = await pageAccessMap(tx, spaceId, { kind: "user", id: userId });
      spaces.set(spaceId, pages);
    }
    const access = pages.get(String(row.page_id));
    if (access) visible.push({ ...row, can_manage: access.canEdit });
  }
  return visible;
}

/** The Human read predicate: a page's Automation passes here and is checked against its page afterwards. */
function humanReadable(userSql: string): string {
  return `(t.page_id IS NOT NULL OR ${channelCapabilityPredicate({ capability: "automation_history_read",
    channelAlias: "c", principalKindSql: "'user'", principalIdSql: userSql })})`;
}

function automationFromRow(row: QueryResultRow): Record<string, unknown> {
  const stored = { ...json(row.payload_json) };
  const storedInput = stored.input;
  delete stored.input;
  const input = json(storedInput);
  const hasInput = Object.keys(input).length > 0;
  const datum = json(input.datum);
  const messageValue = json(stored.message);
  const message = stored.payloadVersion === 3 && datum.kind === "text" &&
      datum.language === "natural-language" && typeof datum.text === "string"
    ? { body: datum.text.trim(), ...(Array.isArray(datum.appMentions) ? { appMentions: datum.appMentions } : {}) }
    : { body: typeof messageValue.body === "string" ? messageValue.body : "",
      ...(Array.isArray(messageValue.appMentions) ? { appMentions: messageValue.appMentions } : {}) };
  const expression = stored.payloadVersion === 3 && Object.keys(datum).length > 0 ? datum : {
    kind: "text", ref: automationRef(String(row.automation_id)), language: "natural-language",
    text: message.body, ...(message.appMentions ? { appMentions: message.appMentions } : {}),
  };
  const taskCapabilities = capabilities(row);
  const canManage = Object.values(taskCapabilities).some((value) => value === true);
  const latest = row.execution_status ? {
    status: String(row.execution_status), attempts: Number(row.execution_attempts) || 0,
    scheduledFor: iso(row.execution_scheduled_for), nextAttemptAt: iso(row.execution_next_attempt_at),
    updatedAt: iso(row.execution_updated_at),
    ...(row.execution_finished_at ? { finishedAt: iso(row.execution_finished_at) } : {}),
    ...(row.execution_error_code ? { errorCode: String(row.execution_error_code) } : {}),
    ...(row.execution_error_message ? { errorMessage: String(row.execution_error_message) } : {}),
  } : undefined;
  const runCount = Number(row.run_count) || 0;
  // Preserve the public message-Automation projection without confusing a dispatched
  // Agent Run with the canonical message that triggered it.
  const messageAutomation = stored.payloadVersion === 2 || stored.payloadVersion === 3;
  const lastMessageId = messageAutomation && typeof row.last_run_id === "string" &&
      row.last_run_id.startsWith("scheduled-message:") ? row.last_run_id : undefined;
  // Every Automation has a name on the wire. Rows written before names were
  // required (moved Channel schedules) are named from what they do.
  const name = automationName(stored.name, message.body);
  const payload = { ...stored, name, ...(hasInput ? { input } : {}), expression, message,
    nextRunAt: iso(row.next_run_at),
    enabled: row.enabled === true, runCount,
    ...(row.last_run_at ? { lastRunAt: iso(row.last_run_at) } : {}),
    ...(row.last_run_id ? { lastRunId: String(row.last_run_id) } : {}),
    ...(row.last_run_status ? { lastRunStatus: String(row.last_run_status) } : {}),
    ...(row.last_run_finished_at ? { lastRunFinishedAt: iso(row.last_run_finished_at) } : {}),
    ...(row.execution_cancellation ? { executionCancellation: publicExecutionCancellation(row.execution_cancellation) } : {}),
    ...(row.last_error ? { lastError: String(row.last_error) } : {}),
    ...(latest ? { latestExecution: latest } : {}) };
  return { ...payload, id: String(row.automation_id), ownerUserId: String(row.owner_user_id),
    authorityRootUserId: authorityRoot(row), channelId: String(row.channel_id),
    ...(row.page_id ? { pageId: String(row.page_id) } : {}),
    ...(row.page_id && row.channel_space_id ? { spaceId: String(row.channel_space_id) } : {}),
    ...(row.detached_at ? { detachedAt: iso(row.detached_at) } : {}),
    ...(Array.isArray(row.trigger_events) && row.trigger_events.length ? { triggerEvents: row.trigger_events } : {}),
    canManage, capabilities: taskCapabilities, expression, message,
    ...(lastMessageId ? { lastMessageId } : {}),
    ...(lastMessageId && row.last_channel_id ? { lastChannelId: String(row.last_channel_id) } : {}),
    version: Number(row.version), deliveryCount: runCount, payload,
    createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) };
}

/** A command's digest, and the digest a pre-rename Hub's body for it had. */
interface RequestDigests { current: string; legacy: string }

async function requestDigests(input: Record<string, unknown>): Promise<RequestDigests> {
  return { current: await digest({ ...input, at: undefined }),
    legacy: await digest({ ...legacyAutomationCommandView(input), at: undefined }) };
}

async function replay(tx: DatabaseTransaction, spaceId: string, commandId: string,
  kind: string, digests: RequestDigests): Promise<Record<string, unknown> | null> {
  const rows = await tx.query<QueryResultRow>({ name: "automation_replay_read_v1", text: `SELECT
    command_kind,request_digest,result_json FROM control.scoped_control_command_replays
    WHERE scope_kind='space' AND scope_id=$1 AND command_id=$2 AND expires_at>clock_timestamp() LIMIT 1`,
  values: [spaceId, commandId], maxRows: 1 });
  if (!rows[0]) return null;
  // Rows written before the command rename store the digest of the legacy body
  // (their kind was already stored in the automation spelling since C1).
  const kinds = [kind, legacyAutomationCommandKind(kind)];
  if (!kinds.includes(String(rows[0].command_kind)) ||
      rows[0].request_digest !== digests.current && rows[0].request_digest !== digests.legacy) {
    throw new AutomationControlError("idempotency_mismatch", 409, "command id was reused");
  }
  return { ...(rows[0].result_json as Record<string, unknown>), reused: true };
}

function channelCapabilityError(failure: ChannelCapabilityFailure): AutomationControlError {
  return new AutomationControlError(failure.code, failure.status, failure.message);
}

/** Row predicate of requireManager for a listing Human bound as $1 over `t`, `c` and `sm`. */
const HUMAN_AUTOMATION_MANAGE_SQL = `(t.owner_user_id=$1 OR sm.role NOT IN ('viewer','participant'))`;

/** Only message payloads are Automations; a retired Focus Auto row is never read. */
const MESSAGE_AUTOMATION_SQL = `t.payload_json->>'payloadVersion' IN ('2','3')`;

type AutomationChannelCapability = Extract<ChannelCapability,
  "automation_history_read" | "automation_new_work" | "automation_terminalize">;

async function automationChannel(tx: DatabaseTransaction, channelId: string,
  principal: ChannelPrincipal, capability: AutomationChannelCapability) {
  const grant = await requireChannelCapability(tx, {
    channelId, principal, capability, error: channelCapabilityError,
  });
  return { channel_id: grant.channelId, space_id: grant.spaceId, mode: grant.mode,
    metadata_json: grant.metadata, version: grant.version };
}

/**
 * The conversation a page's Automation runs in, when the Human may edit its
 * page. The conversation's own access does not decide who manages it.
 */
async function pageAutomationChannel(tx: DatabaseTransaction, channelId: string, pageId: string,
  userId: string) {
  const rows = await tx.query<QueryResultRow>({ name: "page_automation_channel_v1",
    text: "SELECT channel_id,space_id,mode,metadata_json,version FROM data.channels WHERE channel_id=$1 LIMIT 1",
    values: [channelId], maxRows: 1 });
  const channel = rows[0];
  if (!channel) throw new AutomationControlError("not_found", 404, "channel not found");
  const access = await pageAccess(tx, String(channel.space_id), { kind: "user", id: userId }, pageId, true);
  if (!access.canRead) throw new AutomationControlError("page_not_found", 404, "page not found");
  if (!access.canEdit) throw new AutomationControlError("page_edit_forbidden", 403,
    "Only someone who can edit the page changes its Automations");
  return channel;
}

/**
 * Humans manage Automations like Channel members: anyone who may start new work
 * in the Channel may pause, resume, remove or rewrite any evaluation there. The
 * evaluation still runs as its author, so the Hub replaces rather than rewrites
 * an input authored by someone else.
 */
async function requireManager(tx: DatabaseTransaction, automation: QueryResultRow, actorUserId: string,
  capability: Exclude<AutomationChannelCapability, "automation_history_read">) {
  await automationChannel(tx, String(automation.channel_id), { kind: "user", id: actorUserId }, capability);
}

/**
 * A Channel's earliest Automation wake ($1 = channel id), as one scalar query:
 * cadence, retry, lease, execution deadline, cleanup and orphan convergence.
 * The Channel coordinator reads it in the same statement as its other due
 * times, so a pass pays one round trip for all of them.
 */
export const CHANNEL_AUTOMATION_WAKE_SQL = `SELECT MIN(wake_at) AS wake_at FROM (
          SELECT t.next_run_at AS wake_at,c.space_id,t.channel_id
            FROM data.automations t JOIN data.channels c ON c.channel_id=t.channel_id
            WHERE t.channel_id=$1 AND t.enabled=true
          UNION ALL
          SELECT o.next_attempt_at,c.space_id,t.channel_id
            FROM data.automation_occurrences o
            JOIN data.automations t ON t.automation_id=o.automation_id
            JOIN data.channels c ON c.channel_id=t.channel_id
            WHERE t.channel_id=$1 AND o.status='pending'
          UNION ALL
          SELECT o.lease_until,c.space_id,t.channel_id
            FROM data.automation_occurrences o
            JOIN data.automations t ON t.automation_id=o.automation_id
            JOIN data.channels c ON c.channel_id=t.channel_id
            WHERE t.channel_id=$1 AND o.status IN ('leased','prepared') AND o.lease_until IS NOT NULL
          UNION ALL
          SELECT o.execution_deadline_at,c.space_id,t.channel_id
            FROM data.automation_occurrences o JOIN data.automations t ON t.automation_id=o.automation_id
            JOIN data.channels c ON c.channel_id=t.channel_id
            WHERE t.channel_id=$1 AND o.status='dispatched' AND o.finished_at IS NULL
          UNION ALL
          SELECT (r.metadata_json#>>'{executionCancellation,processCleanup,nextAttemptAt}')::timestamptz,
            c.space_id,t.channel_id FROM data.runs r
            JOIN data.automation_occurrences o ON o.run_id=r.run_id AND o.owner_user_id=r.owner_user_id
            JOIN data.automations t ON t.automation_id=o.automation_id
            JOIN data.channels c ON c.channel_id=t.channel_id
            WHERE t.channel_id=$1 AND o.status='cancelled'
              AND r.metadata_json#>>'{executionCancellation,processCleanup,status}'='pending'
          UNION ALL
          SELECT o.updated_at + INTERVAL '2 minutes',c.space_id,t.channel_id
            FROM data.automation_occurrences o
            LEFT JOIN data.runs r ON r.run_id=o.run_id AND r.owner_user_id=o.owner_user_id
            JOIN data.automations t ON t.automation_id=o.automation_id
            JOIN data.channels c ON c.channel_id=t.channel_id
            WHERE t.channel_id=$1 AND o.status='dispatched' AND o.finished_at IS NULL
              AND (r.run_id IS NULL OR r.status NOT IN (${ACTIVE_RUN_STATUS_SQL}))
        ) automation_wakes WHERE wake_at IS NOT NULL`;

export class PostgresAutomationRepository {
  private readonly channelDirectory: PostgresChannelSpaceDirectory;
  private readonly entityDirectory: PostgresEntitySpaceDirectory;
  private readonly membershipDirectory: PostgresUserSpaceMembershipDirectory;
  private readonly placements: PostgresSpacePlacementDirectory;

  constructor(private readonly database: AuthorityDatabase) {
    if (database.cacheMode !== "disabled") throw new AutomationControlError(
      "cached_authority_forbidden", 500, "Automation authority requires uncached PostgreSQL");
    this.channelDirectory = new PostgresChannelSpaceDirectory(database);
    this.entityDirectory = new PostgresEntitySpaceDirectory(database);
    this.membershipDirectory = new PostgresUserSpaceMembershipDirectory(database);
    this.placements = new PostgresSpacePlacementDirectory(database);
  }

  private async placement(requestId: string, operation: string, spaceId: string): Promise<SpacePlacement> {
    const placement = await this.placements.find({ requestId, operation }, spaceId);
    if (!placement) throw new AutomationControlError("space_not_found", 404, "Space not found");
    if (placement.state !== "active" || placement.targetShardId !== null) {
      throw new AutomationControlError(
        "space_placement_unavailable", 503, "Space placement is unavailable", true);
    }
    return placement;
  }

  private async opaquePlacement(
    requestId: string, kind: "automation", entityId: string,
  ): Promise<SpacePlacement> {
    const route = await this.entityDirectory.resolve(
      { requestId, operation: `automation.${kind}.locate` }, kind, entityId,
    );
    let spaceId = route?.spaceId ?? null;
    if (!spaceId) {
      const rows = await this.database.transaction(
        { requestId, operation: `automation.${kind}.locate-legacy` },
        (tx) => tx.query<QueryResultRow>({ name: "automation_entity_space_legacy_v1",
          text: `SELECT channel.space_id FROM data.automations automation
                 JOIN data.channels channel ON channel.channel_id=automation.channel_id
                 WHERE automation.automation_id=$1 LIMIT 1`,
          values: [entityId], maxRows: 1 }),
      );
      spaceId = rows[0] ? String(rows[0].space_id) : null;
    }
    if (!spaceId) throw new AutomationControlError("not_found", 404, "Automation not found");
    return this.placement(requestId, `automation.${kind}.placement`, spaceId);
  }

  private async mutationPlacement(
    requestId: string, kind: string, input: Record<string, unknown>,
  ): Promise<SpacePlacement> {
    if (kind === "automation_put" && integer(input.expectedVersion, "expectedVersion") > 0) {
      return this.opaquePlacement(requestId, "automation", text(input.automationId, "automationId", 300));
    }
    if (kind === "automation_put") {
      const channelId = text(input.channelId, "channelId", 300);
      const route = await this.channelDirectory.resolve(
        { requestId, operation: "automation.channel.locate" }, channelId,
      );
      let spaceId = route?.spaceId ?? null;
      if (!spaceId) {
        const rows = await this.database.transaction(
          { requestId, operation: "automation.channel.locate-legacy" },
          (tx) => tx.query<QueryResultRow>({ name: "automation_channel_space_legacy_v1",
            text: "SELECT space_id FROM data.channels WHERE channel_id=$1 LIMIT 1",
            values: [channelId], maxRows: 1 }),
        );
        spaceId = rows[0] ? String(rows[0].space_id) : null;
      }
      if (!spaceId) throw new AutomationControlError("not_found", 404, "channel not found");
      return this.placement(requestId, "automation.channel.placement", spaceId);
    }
    return this.opaquePlacement(requestId, "automation", text(input.automationId, "automationId", 300));
  }

  private async publishEntityRoute(
    requestId: string, placement: SpacePlacement, kind: "automation",
    entityId: string, entityVersion: number, state: "active" | "deleted" = "active",
  ): Promise<void> {
    const rows = await this.database.transaction({ requestId,
      operation: `automation.${kind}.directory-source`, placement: {
        spaceId: placement.spaceId, shardId: placement.shardId,
        placementEpoch: placement.placementEpoch,
      } }, (tx) => tx.query<QueryResultRow>({ name: "automation_route_source_v1",
        text: "SELECT commit_sequence AS route_version,updated_at FROM data.space_control_heads WHERE space_id=$1",
        values: [placement.spaceId], maxRows: 1 }));
    if (!rows[0]) throw new AutomationControlError(
      "entity_directory_source_incomplete", 503, "Automation directory source is incomplete", true);
    await this.entityDirectory.publish({ requestId,
      operation: `automation.${kind}.directory-publish` }, {
      kind, entityId, spaceId: placement.spaceId, shardId: placement.shardId,
      placementEpoch: placement.placementEpoch, entityVersion,
      routeVersion: Number(rows[0].route_version), state, updatedAt: iso(rows[0].updated_at),
    });
  }

  async mutate(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    // Canonicalize before anything reads or digests the body: a Hub from before
    // the command rename may still retry in the old spelling.
    const input = canonicalAutomationCommand(body);
    const kind = text(input.kind, "kind", 80);
    if (!["automation_put", "automation_remove", "scheduled_execution_cancel"].includes(kind)) {
      throw new AutomationControlError(
        "invalid_automation_request", 400, "Automation command is invalid");
    }
    const commandId = text(input.commandId, "commandId", 200);
    const actorUserId = text(input.actorUserId, "actorUserId", 300);
    const at = timestamp(input.at, "at");
    const placement = await this.mutationPlacement(commandId, kind, input);
    if (kind === "scheduled_execution_cancel") {
      if (humanPrincipal(input) !== actorUserId) throw new AutomationControlError(
        "forbidden", 403, "Execution cancellation requires its Human owner");
      return this.cancelExecution(input, commandId, actorUserId, at, placement);
    }
    const automationId = text(input.automationId, "automationId", 300);
    const expectedVersion = integer(input.expectedVersion, "expectedVersion");
    const principal = input.principal === undefined
      ? { kind: "user", id: actorUserId } : object(input.principal, "principal");
    if (principal.kind !== "user" && principal.kind !== "agent" ||
        typeof principal.id !== "string" || !principal.id ||
        principal.kind === "user" && principal.id !== actorUserId) throw new AutomationControlError(
      "forbidden", 403, "Automation principal is invalid");
    const replaces = kind === "automation_put" && input.replacesAutomation !== undefined
      ? object(input.replacesAutomation, "replacesAutomation") : undefined;
    const replacedId = replaces ? text(replaces.automationId, "replacesAutomation.automationId", 300) : undefined;
    if (replaces && (principal.kind !== "user" || expectedVersion !== 0 || replacedId === automationId)) {
      throw new AutomationControlError("forbidden", 403,
        "Only a Human may replace an Automation, and only with a new one");
    }
    const requestedPageId = kind === "automation_put" && input.pageId !== undefined
      ? text(input.pageId, "pageId", 300) : undefined;
    let replacedVersion = 0;
    const digests = await requestDigests(input);
    const value = await this.database.transaction({ requestId: commandId, operation: `automation.${kind}`,
      placement: { spaceId: placement.spaceId, shardId: placement.shardId,
        placementEpoch: placement.placementEpoch } }, async (tx) => {
      let current: QueryResultRow | undefined;
      if (kind === "automation_put") {
        const rows = await tx.query<QueryResultRow>({ name: "automation_current_lock_v1", text: `SELECT *
          FROM data.automations WHERE automation_id=$1 FOR UPDATE`, values: [automationId], maxRows: 1 });
        current = rows[0];
      } else {
        const rows = await tx.query<QueryResultRow>({ name: "automation_current_lock_v1", text: `SELECT *
          FROM data.automations WHERE automation_id=$1 FOR UPDATE`, values: [automationId], maxRows: 1 });
        current = rows[0];
        if (!current) throw new AutomationControlError("not_found", 404, "Automation not found");
      }
      const prior = await replay(tx, placement.spaceId, commandId, kind, digests);
      if (prior) return prior;
      // A page's Automation belongs to its page (docs/design/pages-live-document.md §6):
      // whoever can edit the page manages it, as a Human; an Agent does so as its owner.
      const pageId = current?.page_id ? String(current.page_id) : requestedPageId;
      if (current && requestedPageId !== undefined && requestedPageId !== current.page_id) {
        throw new AutomationControlError("forbidden", 403, "An Automation stays on its page");
      }
      if (pageId && principal.kind !== "user") throw new AutomationControlError("forbidden", 403,
        "A page's Automation is changed through its page, as the Agent's owner");
      const agent = principal.kind === "agent"
        ? await agentAuthority(tx, input, actorUserId, text(principal.id, "principal.id", 300))
        : undefined;
      const capability: Exclude<AutomationChannelCapability, "automation_history_read"> =
        kind === "automation_remove" ? "automation_terminalize" : "automation_new_work";
      const channelId = kind === "automation_put"
        ? text(input.channelId, "channelId", 300) : String(current!.channel_id);
      const channelPrincipal: ChannelPrincipal =
        { kind: principal.kind as "user" | "agent", id: String(principal.id) };
      const channelRow = pageId
        ? await pageAutomationChannel(tx, channelId, pageId, actorUserId)
        : await automationChannel(tx, channelId, channelPrincipal, capability);
      const spaceId = String(channelRow.space_id);
      if (spaceId !== placement.spaceId) throw new AutomationControlError(
        "conflict", 409, "Automation Space placement changed");
      const currentVersion = Number(current?.version ?? 0);
      if (currentVersion !== expectedVersion) throw new AutomationControlError(
        "conflict", 409, current ? "Automation version changed" : "Automation does not exist");
      if (current) {
        if (agent) await authorizeAgentAutomation(tx, agent, current);
        else if (!pageId) await requireManager(tx, current, actorUserId, capability);
      }
      const next = currentVersion + 1;
      if (kind === "automation_put") {
        const storedOwner = current ? automationOwner(current) : undefined;
        const payload = object(input.payload, "payload");
        validateAutomationPayload(payload, String(channelRow.channel_id),
          current ? authorityRoot(current) : actorUserId,
          storedOwner?.kind === "agent" ? storedOwner.id : agent?.principalId);
        const nextRunAt = timestamp(input.nextRunAt, "nextRunAt");
        if (typeof input.enabled !== "boolean") throw new AutomationControlError(
          "invalid_automation_request", 400, "enabled is invalid");
        // Only a page's Automation has triggers; the page routes resolve them.
        if (payload.triggers !== undefined && (!pageId || !Array.isArray(payload.triggers) ||
            payload.triggers.length > 8 || payload.triggers.some((trigger) =>
              !["merged", "ci-failed", "owed", "event"].includes(String(json(trigger).kind))))) {
          throw new AutomationControlError("invalid_automation_request", 400, "triggers are invalid");
        }
        // Created detached, it starts running once the page references it.
        const detached = current ? Boolean(current.detached_at) : Boolean(pageId) && input.detached === true;
        if (detached && input.enabled) throw new AutomationControlError("automation_detached", 409,
          "Its reference is not on the page; put the reference back to resume it");
        if (current && current.channel_id !== channelRow.channel_id) {
          const previousChannel = await automationChannel(tx, String(current.channel_id),
            channelPrincipal, "automation_new_work");
          if (previousChannel.space_id !== channelRow.space_id) throw new AutomationControlError(
            "forbidden", 403, "Automation cannot move between Spaces");
        }
        const replaced = replaces ? await this.lockReplacedAutomation(tx, replacedId!,
          integer(replaces.expectedVersion, "replacesAutomation.expectedVersion"),
          String(channelRow.channel_id), actorUserId, pageId) : undefined;
        if (!current) {
          const policy = await tx.query<QueryResultRow>({ name: "automation_creation_policy_v1", text: `SELECT
            COALESCE((SELECT automation_creation_policy FROM data.space_member_creation_policies WHERE space_id=$1),'members') AS policy,
            (SELECT role FROM data.space_members WHERE space_id=$1 AND user_id=$2) AS role`,
          values: [spaceId, actorUserId], maxRows: 1 });
          if (policy[0]?.policy === "admins" &&
              (agent || input.viaAgentRun === true || !["owner", "admin"].includes(String(policy[0]?.role)))) {
            throw new AutomationControlError("space_member_automation_creation_disabled", 403,
              "Space administrators disabled Automation creation for members");
          }
          if (replaced) {
            // The replaced input's pending work was scheduled under its author.
            await tx.query({ name: "automation_cancel_replaced_occurrences_v1", text: `UPDATE
              data.automation_occurrences SET status='cancelled',lease_owner=NULL,lease_until=NULL,
              error_code='automation_replaced',error_message='Automation replaced before dispatch',
              updated_at=$1,finished_at=$1 WHERE automation_id=$2 AND status IN ('pending','leased')`,
            values: [at, replacedId], maxRows: 0 });
            const removed = await tx.query<QueryResultRow>({ name: "automation_remove_replaced_v1",
              text: "DELETE FROM data.automations WHERE automation_id=$1 AND version=$2 RETURNING automation_id",
              values: [replacedId, replaced.version], maxRows: 1 });
            if (removed.length !== 1) throw new AutomationControlError(
              "conflict", 409, "Replaced Automation changed");
            replacedVersion = Number(replaced.version) + 1;
          }
          await tx.query({ name: "automation_insert_v2", text: `INSERT INTO data.automations
            (automation_id,owner_user_id,channel_id,next_run_at,enabled,version,payload_json,created_at,updated_at,
             page_id,detached_at)
            VALUES ($1,$2,$3,$4,$5,1,$6::jsonb,$7,$7,$8,$9)`, values: [automationId, actorUserId,
            channelRow.channel_id, nextRunAt, input.enabled, JSON.stringify(payload), at, pageId ?? null,
            detached ? at : null], maxRows: 0 });
        } else {
          await tx.query({ name: "automation_cancel_changed_occurrences_v1", text: `UPDATE
            data.automation_occurrences SET status='cancelled',lease_owner=NULL,lease_until=NULL,
            error_code='automation_changed',error_message='Automation changed before dispatch',
            updated_at=$1,finished_at=$1 WHERE automation_id=$2 AND status IN ('pending','leased')`,
          values: [at, automationId], maxRows: 0 });
          await tx.query({ name: "automation_update_v1", text: `UPDATE data.automations SET
            channel_id=$1,next_run_at=$2,enabled=$3,version=$4,payload_json=$5::jsonb,updated_at=$6
            WHERE automation_id=$7 AND version=$8`, values: [channelRow.channel_id, nextRunAt, input.enabled, next,
            JSON.stringify(payload), at, automationId, currentVersion], maxRows: 0 });
        }
      } else {
        const currentPayload = json(current!.payload_json);
        const currentLineage = json(json(currentPayload.input).lineage);
        const rootMessageId = currentPayload.payloadVersion === 3 &&
            typeof currentLineage.rootMessageId === "string" && currentLineage.rootMessageId
          ? currentLineage.rootMessageId : null;
        const lineageRows = rootMessageId ? await tx.query<QueryResultRow>({
          name: "automation_lineage_lock_v1", text: `SELECT automation_id FROM data.automations
            WHERE channel_id=$1 AND payload_json->>'payloadVersion'='3'
              AND payload_json#>>'{input,lineage,rootMessageId}'=$2 ORDER BY automation_id FOR UPDATE`,
          values: [current!.channel_id, rootMessageId], maxRows: 128,
        }) : [{ automation_id: automationId }];
        const lineageAutomationIds = lineageRows.map((row) => String(row.automation_id));
        if (!lineageAutomationIds.includes(automationId)) throw new AutomationControlError(
          "conflict", 409, "evaluator lineage changed before revocation");
        await tx.query({ name: "automation_cancel_removed_occurrences_v1", text: `UPDATE
          data.automation_occurrences SET status='cancelled',lease_owner=NULL,lease_until=NULL,
          error_code='lineage_revoked',error_message='Automation revoked before dispatch',
          updated_at=$1,finished_at=$1 WHERE automation_id=ANY($2::text[]) AND status IN ('pending','leased')`,
        values: [at, lineageAutomationIds], maxRows: 0 });
        const removed = await tx.query<QueryResultRow>({ name: "automation_remove_v1",
          text: "DELETE FROM data.automations WHERE automation_id=ANY($1::text[]) RETURNING automation_id",
          values: [lineageAutomationIds], maxRows: 128 });
        if (removed.length !== lineageAutomationIds.length) throw new AutomationControlError(
          "conflict", 409, "evaluator lineage changed during revocation");
      }
      const value = { commandId, kind, entityId: automationId, channelId,
        entityVersion: next, reused: false,
        projectionMutations: [], recipientChanges: [] };
      await commit(tx, spaceId, commandId, kind, digests.current, value, at);
      return value;
    });
    await this.publishEntityRoute(commandId, placement, "automation", automationId,
      Number(value.entityVersion), kind === "automation_remove" ? "deleted" : "active");
    if (replacedId && replacedVersion > 0) await this.publishEntityRoute(commandId, placement,
      "automation", replacedId, replacedVersion, "deleted");
    return value;
  }

  /**
   * A Human rewriting someone else's evaluation replaces it with their own: the
   * evaluation runs with its author's Machines, Agents and name, so another
   * member's text must never run under it. Only a single-input lineage can be
   * replaced; evaluator children stay with the author who spawned them.
   */
  private async lockReplacedAutomation(tx: DatabaseTransaction, automationId: string,
    expectedVersion: number, channelId: string, actorUserId: string, pageId: string | undefined):
    Promise<QueryResultRow> {
    const rows = await tx.query<QueryResultRow>({ name: "automation_replaced_lock_v1", text: `SELECT *
      FROM data.automations WHERE automation_id=$1 FOR UPDATE`, values: [automationId], maxRows: 1 });
    const replaced = rows[0];
    if (!replaced) throw new AutomationControlError("not_found", 404, "Replaced Automation not found");
    if (Number(replaced.version) !== expectedVersion) throw new AutomationControlError(
      "conflict", 409, "Replaced Automation version changed");
    const payload = json(replaced.payload_json);
    if (replaced.channel_id !== channelId || payload.payloadVersion !== 3) throw new AutomationControlError(
      "forbidden", 403, "Only an evaluation in the same Channel can be replaced");
    if (authorityRoot(replaced) === actorUserId) throw new AutomationControlError(
      "forbidden", 403, "An Automation's author updates it in place");
    if ((replaced.page_id ?? undefined) !== pageId) throw new AutomationControlError(
      "forbidden", 403, "A page's Automation is replaced on its page");
    // On a page, being able to edit the page is what lets the editor replace it.
    if (!pageId) await requireManager(tx, replaced, actorUserId, "automation_new_work");
    const rootMessageId = json(json(payload.input).lineage).rootMessageId;
    const lineage = await tx.query<QueryResultRow>({ name: "automation_replaced_lineage_v1", text: `SELECT
      automation_id FROM data.automations WHERE channel_id=$1 AND automation_id<>$2
        AND payload_json->>'payloadVersion'='3' AND payload_json#>>'{input,lineage,rootMessageId}'=$3 LIMIT 1`,
    values: [channelId, automationId, String(rootMessageId ?? "")], maxRows: 1 });
    if (lineage.length > 0) throw new AutomationControlError("conflict", 409,
      "Only its author can rewrite an evaluation with evaluator children");
    return replaced;
  }

  async list(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const requestId = text(input.requestId, "requestId", 200);
    const principal = object(input.principal, "principal");
    const limit = Math.min(integer(input.limit ?? 50, "limit", 1), 200);
    const cursor = typeof input.cursor === "string" ? input.cursor : "";
    const spaceId = typeof input.spaceId === "string" && input.spaceId ? input.spaceId : null;
    const channelId = typeof input.channelId === "string" && input.channelId ? input.channelId : null;
    if (!spaceId && !channelId && principal.kind === "user") return this.listAcrossActivePlacements({
      requestId, userId: text(principal.id, "principal.id", 300), cursor, limit,
    });
    const channelRoute = channelId ? await this.channelDirectory.resolve(
      { requestId, operation: "automation.list.channel-locate" }, channelId,
    ) : null;
    const routedSpaceId = spaceId ?? channelRoute?.spaceId ?? null;
    if (spaceId && channelRoute && channelRoute.spaceId !== spaceId) throw new AutomationControlError(
      "conflict", 409, "Automation list scope is inconsistent");
    const placement = routedSpaceId
      ? await this.placement(requestId, "automation.list.placement", routedSpaceId) : null;
    return this.database.transaction(placement ? { requestId, operation: "automation.list",
      placement: { spaceId: placement.spaceId, shardId: placement.shardId,
        placementEpoch: placement.placementEpoch } } : {
      requestId, operation: "automation.list-unscoped-legacy",
    }, async (tx) => {
      if (principal.kind === "agent") {
        const authority = await agentAuthority(tx, input,
          text(object(input.automationAgent, "automationAgent").ownerUserId,
            "automationAgent.ownerUserId", 300), text(principal.id, "principal.id", 300));
        if (channelId !== authority.channelId || spaceId !== null) throw new AutomationControlError(
          "forbidden", 403, "Agent Automation reads are limited to its birth Channel");
        if (!(await agentReadsBirthChannel(tx, authority))) {
          throw new AutomationControlError("forbidden", 403, "Agent cannot read this Channel");
        }
        const rows = await tx.query<QueryResultRow>({ name: "automation_agent_list_v5", text: `SELECT
          t.*,r.status AS last_run_status,r.metadata_json->'executionCancellation' AS execution_cancellation,r.finished_at AS last_run_finished_at,false AS can_manage,
          $1::text AS agent_principal_id,
          o.status AS execution_status,o.attempts AS execution_attempts,o.scheduled_for AS execution_scheduled_for,
          o.next_attempt_at AS execution_next_attempt_at,o.updated_at AS execution_updated_at,
          o.finished_at AS execution_finished_at,o.error_code AS execution_error_code,
          o.error_message AS execution_error_message
          FROM data.automations t JOIN data.channels c ON c.channel_id=t.channel_id
          LEFT JOIN data.runs r ON r.run_id=t.last_run_id AND r.owner_user_id=t.owner_user_id
          LEFT JOIN LATERAL (SELECT * FROM data.automation_occurrences x WHERE x.automation_id=t.automation_id
            ORDER BY x.scheduled_for DESC,x.occurrence_id DESC LIMIT 1) o ON true
          WHERE t.channel_id=$2
            AND ${channelCapabilityPredicate({ capability: "automation_history_read", channelAlias: "c",
              principalKindSql: "'agent'", principalIdSql: "$1" })}
            AND ${MESSAGE_AUTOMATION_SQL} AND t.automation_id>$3 ORDER BY t.automation_id LIMIT $4`,
        values: [authority.principalId, authority.channelId, cursor, limit + 1], maxRows: limit + 1 });
        const page = rows.slice(0, limit);
        return { tasks: page.map(automationFromRow), cursor: rows.length > limit
          ? String(page.at(-1)?.automation_id ?? "") : null,
          executionEnabled: true, agentManagementEnabled: true };
      }
      const userId = humanPrincipal(input);
      const rows = await tx.query<QueryResultRow>({ name: "automation_list_v5", text: `SELECT
        t.*,c.space_id AS channel_space_id,r.status AS last_run_status,r.metadata_json->'executionCancellation' AS execution_cancellation,r.finished_at AS last_run_finished_at,
        ${HUMAN_AUTOMATION_MANAGE_SQL} AS can_manage,
        o.status AS execution_status,o.attempts AS execution_attempts,o.scheduled_for AS execution_scheduled_for,
        o.next_attempt_at AS execution_next_attempt_at,o.updated_at AS execution_updated_at,
        o.finished_at AS execution_finished_at,o.error_code AS execution_error_code,
        o.error_message AS execution_error_message
        FROM data.automations t JOIN data.channels c ON c.channel_id=t.channel_id
        JOIN data.space_members sm ON sm.space_id=c.space_id AND sm.user_id=$1
        LEFT JOIN data.channel_access ca ON ca.channel_id=c.channel_id AND ca.subject_kind='user' AND ca.subject_id=$1
        LEFT JOIN data.runs r ON r.run_id=t.last_run_id AND r.owner_user_id=t.owner_user_id
        LEFT JOIN LATERAL (SELECT * FROM data.automation_occurrences x WHERE x.automation_id=t.automation_id
          ORDER BY x.scheduled_for DESC,x.occurrence_id DESC LIMIT 1) o ON true
        WHERE ${humanReadable("$1")}
          AND ($2::text IS NULL OR c.space_id=$2) AND ($3::text IS NULL OR c.channel_id=$3)
          AND ${MESSAGE_AUTOMATION_SQL} AND t.automation_id>$4 ORDER BY t.automation_id LIMIT $5`,
      values: [userId, spaceId, channelId, cursor, limit + 1], maxRows: limit + 1 });
      const page = await withPageAccess(tx, userId, rows.slice(0, limit));
      return { tasks: page.map(automationFromRow), cursor: rows.length > limit
        ? String(rows[limit - 1]?.automation_id ?? "") : null, executionEnabled: true, agentManagementEnabled: true };
    });
  }

  /** A page's Automations, in the order they were made, for a Human who can read the page. */
  async listPage(input: { requestId: string; spaceId: string; pageId: string; userId: string }):
    Promise<{ tasks: Record<string, unknown>[] }> {
    const requestId = text(input.requestId, "requestId", 200);
    const spaceId = text(input.spaceId, "spaceId", 300);
    const placement = await this.placement(requestId, "automation.page.placement", spaceId);
    return this.database.transaction({ requestId, operation: "automation.page.list", placement: {
      spaceId: placement.spaceId, shardId: placement.shardId, placementEpoch: placement.placementEpoch,
    } }, async (tx) => {
      const rows = await tx.query<QueryResultRow>({ name: "automation_page_list_v1", text: `SELECT
        t.*,c.space_id AS channel_space_id,r.status AS last_run_status,
        r.metadata_json->'executionCancellation' AS execution_cancellation,r.finished_at AS last_run_finished_at,
        o.status AS execution_status,o.attempts AS execution_attempts,o.scheduled_for AS execution_scheduled_for,
        o.next_attempt_at AS execution_next_attempt_at,o.updated_at AS execution_updated_at,
        o.finished_at AS execution_finished_at,o.error_code AS execution_error_code,
        o.error_message AS execution_error_message
        FROM data.automations t JOIN data.channels c ON c.channel_id=t.channel_id
        LEFT JOIN data.runs r ON r.run_id=t.last_run_id AND r.owner_user_id=t.owner_user_id
        LEFT JOIN LATERAL (SELECT * FROM data.automation_occurrences x WHERE x.automation_id=t.automation_id
          ORDER BY x.scheduled_for DESC,x.occurrence_id DESC LIMIT 1) o ON true
        WHERE t.page_id=$1 AND c.space_id=$2 ORDER BY t.created_at,t.automation_id LIMIT 200`,
      values: [text(input.pageId, "pageId", 300), spaceId], maxRows: 200 });
      const visible = await withPageAccess(tx, text(input.userId, "userId", 300), rows);
      return { tasks: visible.map(automationFromRow) };
    });
  }

  private async listAcrossActivePlacements(input: {
    requestId: string; userId: string; cursor: string; limit: number;
  }): Promise<Record<string, unknown>> {
    const routes = await this.membershipDirectory.list({
      requestId: input.requestId, operation: "automation.list-directory",
    }, input.userId, "", 201);
    if (routes.length > 200) throw new AutomationControlError(
      "automation_catalog_too_broad", 409,
      "Automation catalog requires a Space or Channel filter");
    const byShard = new Map<string, typeof routes>();
    for (const route of routes) {
      const current = byShard.get(route.shardId) ?? [];
      byShard.set(route.shardId, [...current, route]);
    }
    const pages = await Promise.all([...byShard.values()].map(async (group) => {
      const anchor = group[0]!;
      return this.database.transaction({ requestId: input.requestId,
        operation: "automation.list-shard", placement: {
          spaceId: anchor.spaceId, shardId: anchor.shardId,
          placementEpoch: anchor.placementEpoch,
        } }, async (tx) => withPageAccess(tx, input.userId,
          await tx.query<QueryResultRow>({ name: "automation_list_shard_v5", text: `SELECT
          t.*,c.space_id AS channel_space_id,r.status AS last_run_status,r.metadata_json->'executionCancellation' AS execution_cancellation,r.finished_at AS last_run_finished_at,
          ${HUMAN_AUTOMATION_MANAGE_SQL} AS can_manage,
          o.status AS execution_status,o.attempts AS execution_attempts,
          o.scheduled_for AS execution_scheduled_for,o.next_attempt_at AS execution_next_attempt_at,
          o.updated_at AS execution_updated_at,o.finished_at AS execution_finished_at,
          o.error_code AS execution_error_code,o.error_message AS execution_error_message
          FROM data.automations t JOIN data.channels c ON c.channel_id=t.channel_id
          JOIN data.space_members sm ON sm.space_id=c.space_id AND sm.user_id=$1
          LEFT JOIN data.channel_access ca ON ca.channel_id=c.channel_id
            AND ca.subject_kind='user' AND ca.subject_id=$1
          LEFT JOIN data.runs r ON r.run_id=t.last_run_id AND r.owner_user_id=t.owner_user_id
          LEFT JOIN LATERAL (SELECT * FROM data.automation_occurrences x
            WHERE x.automation_id=t.automation_id ORDER BY x.scheduled_for DESC,x.occurrence_id DESC LIMIT 1) o ON true
          WHERE c.space_id=ANY($2::text[]) AND ${humanReadable("$1")}
            AND ${MESSAGE_AUTOMATION_SQL} AND t.automation_id>$3 ORDER BY t.automation_id LIMIT $4`,
        values: [input.userId, group.map((route) => route.spaceId), input.cursor, input.limit + 1],
        maxRows: input.limit + 1 })));
    }));
    const merged = pages.flat().sort((left, right) =>
      String(left.automation_id).localeCompare(String(right.automation_id)));
    const page = merged.slice(0, input.limit);
    return { tasks: page.map(automationFromRow), cursor: merged.length > input.limit
      ? String(page.at(-1)?.automation_id ?? "") : null,
    executionEnabled: true, agentManagementEnabled: true };
  }

  async get(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const requestId = text(input.requestId, "requestId", 200);
    const principal = object(input.principal, "principal");
    const automationId = text(input.automationId ?? input.taskId, "automationId", 300);
    const placement = await this.opaquePlacement(requestId, "automation", automationId);
    return this.database.transaction({ requestId, operation: "automation.get",
      placement: { spaceId: placement.spaceId, shardId: placement.shardId,
        placementEpoch: placement.placementEpoch } }, async (tx) => {
      if (principal.kind === "agent") {
        const context = object(input.automationAgent, "automationAgent");
        const authority = await agentAuthority(tx, input,
          text(context.ownerUserId, "automationAgent.ownerUserId", 300),
          text(principal.id, "principal.id", 300));
        const rows = await tx.query<QueryResultRow>({ name: "automation_agent_get_v5", text: `SELECT
          t.*,r.status AS last_run_status,r.metadata_json->'executionCancellation' AS execution_cancellation,r.finished_at AS last_run_finished_at,false AS can_manage,
          $1::text AS agent_principal_id,
          o.status AS execution_status,o.attempts AS execution_attempts,o.scheduled_for AS execution_scheduled_for,
          o.next_attempt_at AS execution_next_attempt_at,o.updated_at AS execution_updated_at,
          o.finished_at AS execution_finished_at,o.error_code AS execution_error_code,
          o.error_message AS execution_error_message
          FROM data.automations t JOIN data.channels c ON c.channel_id=t.channel_id
          LEFT JOIN data.runs r ON r.run_id=t.last_run_id AND r.owner_user_id=t.owner_user_id
          LEFT JOIN LATERAL (SELECT * FROM data.automation_occurrences x WHERE x.automation_id=t.automation_id
            ORDER BY x.scheduled_for DESC,x.occurrence_id DESC LIMIT 1) o ON true
          WHERE t.automation_id=$2 AND t.channel_id=$3 AND ${agentBirthBindingSql("t.channel_id", "$1")}
            AND ${channelCapabilityPredicate({ capability: "automation_history_read", channelAlias: "c",
              principalKindSql: "'agent'", principalIdSql: "$1" })} AND ${MESSAGE_AUTOMATION_SQL} LIMIT 1`,
        values: [authority.principalId, automationId, authority.channelId], maxRows: 1 });
        if (!rows[0]) throw new AutomationControlError("automation_not_found", 404, "Automation not found");
        return { task: automationFromRow(rows[0]) };
      }
      const userId = humanPrincipal(input);
      const rows = await withPageAccess(tx, userId, await tx.query<QueryResultRow>({ name: "automation_get_v5", text: `SELECT
        t.*,c.space_id AS channel_space_id,r.status AS last_run_status,r.metadata_json->'executionCancellation' AS execution_cancellation,r.finished_at AS last_run_finished_at,
        ${HUMAN_AUTOMATION_MANAGE_SQL} AS can_manage,
        o.status AS execution_status,o.attempts AS execution_attempts,o.scheduled_for AS execution_scheduled_for,
        o.next_attempt_at AS execution_next_attempt_at,o.updated_at AS execution_updated_at,
        o.finished_at AS execution_finished_at,o.error_code AS execution_error_code,
        o.error_message AS execution_error_message
        FROM data.automations t JOIN data.channels c ON c.channel_id=t.channel_id
        JOIN data.space_members sm ON sm.space_id=c.space_id AND sm.user_id=$1
        LEFT JOIN data.channel_access ca ON ca.channel_id=c.channel_id AND ca.subject_kind='user' AND ca.subject_id=$1
        LEFT JOIN data.runs r ON r.run_id=t.last_run_id AND r.owner_user_id=t.owner_user_id
        LEFT JOIN LATERAL (SELECT * FROM data.automation_occurrences x WHERE x.automation_id=t.automation_id
          ORDER BY x.scheduled_for DESC,x.occurrence_id DESC LIMIT 1) o ON true
        WHERE t.automation_id=$2 AND ${humanReadable("$1")} AND ${MESSAGE_AUTOMATION_SQL} LIMIT 1`,
      values: [userId, automationId], maxRows: 1 }));
      if (!rows[0]) throw new AutomationControlError(
        "automation_not_found", 404, "Automation not found");
      return { task: automationFromRow(rows[0]) };
    });
  }

  async maintain(input: { requestId: string; now: string; runTimeoutMs: number; spaceId?: string }): Promise<void> {
    const spaceId = input.spaceId === undefined ? null : text(input.spaceId, "spaceId", 300);
    const requestId = text(input.requestId, "requestId", 200);
    const now = timestamp(input.now, "now");
    const nowMs = Date.parse(now);
    const runTimeoutMs = integer(input.runTimeoutMs, "runTimeoutMs", 1_000);
    if (runTimeoutMs > 86_400_000) throw new AutomationControlError(
      "invalid_automation_request", 400, "runTimeoutMs is invalid");
    await this.database.transaction({ requestId, operation: "automation.maintain" }, async (tx) => {
      const expired = await tx.query<QueryResultRow>({ name: "scheduled_occurrence_expired_v2", text: `SELECT
        occurrence_id,attempts FROM data.automation_occurrences
        WHERE status IN ('leased','prepared') AND lease_until<=$1
        ORDER BY lease_until,occurrence_id LIMIT $2 FOR UPDATE SKIP LOCKED`,
      values: [now, OCCURRENCE_BATCH_SIZE], maxRows: OCCURRENCE_BATCH_SIZE });
      for (const row of expired) {
        await tx.query({ name: "scheduled_occurrence_release_v2", text: `UPDATE
          data.automation_occurrences SET status='pending',lease_owner=NULL,lease_until=NULL,
          next_attempt_at=$1,updated_at=$2 WHERE occurrence_id=$3
            AND status IN ('leased','prepared') AND attempts=$4`, values: [
          new Date(nowMs + retryBackoff(Number(row.attempts))).toISOString(), now,
          row.occurrence_id, row.attempts], maxRows: 0 });
      }
      await tx.query({ name: "scheduled_occurrence_prune_v2", text: `DELETE FROM
        data.automation_occurrences WHERE occurrence_id IN (SELECT occurrence_id FROM
          data.automation_occurrences WHERE status IN ('dispatched','failed','cancelled')
          AND finished_at<=$1 ORDER BY finished_at,occurrence_id LIMIT 100 FOR UPDATE SKIP LOCKED)`,
      values: [new Date(nowMs - OCCURRENCE_RETENTION_MS).toISOString()], maxRows: 0 });
      const counts = await tx.query<QueryResultRow>({ name: "scheduled_occurrence_count_v2",
        text: "SELECT COUNT(*)::bigint AS count FROM data.automation_occurrences",
        maxRows: 1 });
      let occurrenceCount = Number(counts[0]?.count ?? 0);
      // Due Automations create new occurrences.
      const due = await tx.query<QueryResultRow>({ name: "automation_due_lock_v2", text: `SELECT *
        FROM data.automations WHERE enabled=true AND next_run_at<=$1
          AND EXISTS (SELECT 1 FROM data.channels c
            WHERE c.channel_id=automations.channel_id
              AND ($3::text IS NULL OR c.space_id=$3))
        ORDER BY next_run_at,automation_id LIMIT $2 FOR UPDATE SKIP LOCKED`,
      values: [now, OCCURRENCE_BATCH_SIZE, spaceId], maxRows: OCCURRENCE_BATCH_SIZE });
      for (const current of due) {
        const payload = json(current.payload_json);
        const lineageRoot = json(json(payload.input).lineage).rootMessageId;
        if (typeof lineageRoot === "string" && lineageRoot) {
          const lineageCounts = await tx.query<QueryResultRow>({ name: "scheduled_lineage_occurrence_count_v2",
            text: `SELECT COUNT(*)::bigint AS count FROM data.automation_occurrences o
              JOIN data.automations t ON t.automation_id=o.automation_id
              WHERE t.payload_json->>'payloadVersion'='3'
                AND t.payload_json#>>'{input,lineage,rootMessageId}'=$1`,
            values: [lineageRoot], maxRows: 1 });
          if (Number(lineageCounts[0]?.count ?? 0) >= LINEAGE_OCCURRENCE_BUDGET) {
            await tx.query({ name: "scheduled_lineage_disable_v2", text: `UPDATE data.automations
              SET enabled=false,version=version+1,
                last_error='Evaluator lineage occurrence budget is exhausted',updated_at=$1
              WHERE enabled=true AND payload_json->>'payloadVersion'='3'
                AND payload_json#>>'{input,lineage,rootMessageId}'=$2`,
            values: [now, lineageRoot], maxRows: 0 });
            continue;
          }
        }
        const intervalMinutes = Number(payload.intervalMinutes);
        if (!isAutomationIntervalMinutes(intervalMinutes)) {
          await this.disableAutomation(tx, current, now, "Automation interval is invalid");
          continue;
        }
        const cadence = nextRunAt(current.next_run_at, intervalMinutes, nowMs);
        if (occurrenceCount >= OCCURRENCE_MAX_ROWS) {
          await tx.query({ name: "automation_capacity_defer_v1", text: `UPDATE data.automations
            SET next_run_at=$1,version=version+1,
              last_error='Evaluator occurrence capacity is temporarily exhausted',updated_at=$2
            WHERE automation_id=$3 AND version=$4 AND enabled=true`,
          values: [cadence, now, current.automation_id, current.version], maxRows: 0 });
          continue;
        }
        const inputValue = json(payload.input);
        const datum = json(inputValue.datum);
        const message = json(payload.message);
        const deliveryText = typeof datum.text === "string" ? datum.text
          : typeof message.body === "string" ? message.body : "";
        const deliveryKind = deliveryText.trim() ? "message" : "agent_run";
        const configuredTimeout = payload.executionTimeoutMinutes;
        const executionTimeoutMs = deliveryKind === "message" || configuredTimeout === undefined
          ? runTimeoutMs : Number(configuredTimeout) * 60_000;
        if (!Number.isSafeInteger(executionTimeoutMs) || executionTimeoutMs < 1_000 ||
            executionTimeoutMs > 86_400_000) {
          await this.disableAutomation(tx, current, now, "Automation maximum runtime is invalid");
          continue;
        }
        const nextVersion = Number(current.version) + 1;
        const active = await tx.query<QueryResultRow>({ name: "scheduled_occurrence_active_v2", text: `SELECT
          occurrence_id,status,automation_version FROM data.automation_occurrences WHERE automation_id=$1 AND
          (status IN ('pending','leased','prepared') OR (status='dispatched' AND finished_at IS NULL))
          ORDER BY created_at,occurrence_id LIMIT 1 FOR UPDATE`, values: [current.automation_id], maxRows: 1 });
        if (active[0]) {
          if (["pending", "leased", "prepared"].includes(String(active[0].status))) {
            await tx.query({ name: "scheduled_occurrence_coalesce_v2", text: `UPDATE
              data.automation_occurrences SET automation_version=$1,updated_at=$2
              WHERE occurrence_id=$3 AND automation_version=$4 AND status IN ('pending','leased','prepared')`,
            values: [nextVersion, now, active[0].occurrence_id, current.version], maxRows: 0 });
          }
          // Events that arrive while it runs leave one follow-up: it stays due
          // shortly, until the running occurrence ends and a new one takes them.
          const lastRunMs = current.last_run_at ? Date.parse(iso(current.last_run_at)) : Number.NaN;
          const followUp = Array.isArray(current.trigger_events) && current.trigger_events.length > 0
            ? new Date(Math.min(Date.parse(cadence), Math.max(nowMs + TRIGGER_FOLLOW_UP_MS,
              Number.isFinite(lastRunMs) ? lastRunMs + EVENT_SPACING_MINUTES * 60_000 : 0))).toISOString()
            : cadence;
          await this.advanceAutomation(tx, current, followUp, nextVersion, now);
          continue;
        }
        const existing = await tx.query<QueryResultRow>({ name: "scheduled_occurrence_slot_v2", text: `SELECT
          occurrence_id FROM data.automation_occurrences WHERE automation_id=$1 AND scheduled_for=$2 LIMIT 1`,
        values: [current.automation_id, current.next_run_at], maxRows: 1 });
        if (existing[0]) {
          await this.advanceAutomation(tx, current, cadence, nextVersion, now);
          continue;
        }
        const occurrenceId = `scheduled-occurrence:${crypto.randomUUID()}`;
        // The occurrence records its reserved natural key; the dispatch that
        // later starts it must use exactly these ids.
        const legacyIds = executionIds(occurrenceId);
        const reserved = await reserveNaturalKey(tx, { creationKey: legacyIds.runId,
          channelId: String(current.channel_id), scope: "instance", at: now });
        const ids = { ...legacyIds, runId: reserved.runId, instanceId: reserved.instanceId! };
        const messageId = deliveryKind === "message"
          ? `scheduled-message:${occurrenceId.slice("scheduled-occurrence:".length)}`.slice(0, 200) : null;
        // The occurrence takes the events that made it due, to name them.
        await tx.query({ name: "scheduled_occurrence_insert_v3", text: `INSERT INTO
          data.automation_occurrences (occurrence_id,automation_id,automation_version,owner_user_id,
          scheduled_for,status,lease_owner,lease_until,attempts,next_attempt_at,run_id,instance_id,
          control_id,delivery_kind,message_id,error_code,error_message,execution_timeout_ms,
          execution_deadline_at,created_at,updated_at,finished_at,trigger_events)
          VALUES ($1,$2,$3,$4,$5,'pending',NULL,NULL,0,$6,$7,$8,$9,$10,$11,NULL,NULL,$12,NULL,$6,$6,NULL,$13::jsonb)`,
        values: [occurrenceId, current.automation_id, nextVersion, current.owner_user_id,
          current.next_run_at, now, ids.runId, ids.instanceId, ids.controlId,
          deliveryKind, messageId, executionTimeoutMs,
          Array.isArray(current.trigger_events) && current.trigger_events.length
            ? JSON.stringify(current.trigger_events) : null], maxRows: 0 });
        await this.advanceAutomation(tx, current, cadence, nextVersion, now, true);
        occurrenceCount += 1;
      }
    });
  }

  async claim(input: { requestId: string; now: string; leaseOwner: string; spaceId?: string }) {
    const requestId = text(input.requestId, "requestId", 200);
    const now = timestamp(input.now, "now");
    const leaseOwner = text(input.leaseOwner, "leaseOwner", 300);
    const spaceId = input.spaceId ? text(input.spaceId, "spaceId", 300) : null;
    return this.database.transaction({ requestId, operation: "automation.claim" }, async (tx) => {
      const rows = await tx.query<QueryResultRow>({ name: "scheduled_occurrence_claim_v3", text: `WITH candidate AS (
        SELECT o.occurrence_id FROM data.automation_occurrences o
        JOIN data.automations t ON t.automation_id=o.automation_id
        JOIN data.channels c ON c.channel_id=t.channel_id
        WHERE o.status='pending' AND o.next_attempt_at<=$1
          AND ($2::text IS NULL OR c.space_id=$2)
        ORDER BY o.next_attempt_at,o.scheduled_for,o.occurrence_id LIMIT 1 FOR UPDATE OF o SKIP LOCKED)
        UPDATE data.automation_occurrences o SET status='leased',lease_owner=$3,
          lease_until=$4,attempts=o.attempts+1,updated_at=$1 FROM candidate
        WHERE o.occurrence_id=candidate.occurrence_id RETURNING o.*`, values: [now, spaceId, leaseOwner,
        new Date(Date.parse(now) + OCCURRENCE_LEASE_MS).toISOString()], maxRows: 1 });
      return rows[0] ? occurrence(rows[0]) : undefined;
    });
  }

  async cancel(input: { requestId: string; occurrenceId: string; leaseOwner: string;
    now: string; code: string; message: string }): Promise<void> {
    const requestId = text(input.requestId, "requestId", 200);
    const now = timestamp(input.now, "now");
    await this.database.transaction({ requestId, operation: "automation.cancel" }, async (tx) => {
      await tx.query({ name: "scheduled_occurrence_cancel_v2", text: `UPDATE
        data.automation_occurrences SET status='cancelled',lease_owner=NULL,lease_until=NULL,
        error_code=$1,error_message=$2,updated_at=$3,finished_at=$3
        WHERE occurrence_id=$4 AND status IN ('leased','prepared') AND lease_owner=$5`,
      values: [text(input.code, "code", 100), String(input.message).slice(0, 1_000), now,
        text(input.occurrenceId, "occurrenceId", 300), text(input.leaseOwner, "leaseOwner", 300)],
      maxRows: 0 });
    });
  }

  async fail(input: { requestId: string; occurrenceId: string; taskId: string;
    taskVersion: number; attempts: number; leaseOwner: string; now: string;
    message: string; permanent: boolean }): Promise<void> {
    const requestId = text(input.requestId, "requestId", 200);
    const now = timestamp(input.now, "now");
    const attempts = integer(input.attempts, "attempts");
    await this.database.transaction({ requestId, operation: "automation.fail" }, async (tx) => {
      const values = [String(input.message).slice(0, 1_000), now,
        text(input.occurrenceId, "occurrenceId", 300), text(input.leaseOwner, "leaseOwner", 300)];
      if (!input.permanent && attempts < OCCURRENCE_MAX_ATTEMPTS) {
        await tx.query({ name: "scheduled_occurrence_retry_v2", text: `UPDATE
          data.automation_occurrences SET status='pending',lease_owner=NULL,lease_until=NULL,
          next_attempt_at=$1,error_code='dispatch_retry',error_message=$2,updated_at=$3
          WHERE occurrence_id=$4 AND status IN ('leased','prepared') AND lease_owner=$5`,
        values: [new Date(Date.parse(now) + retryBackoff(attempts)).toISOString(), ...values], maxRows: 0 });
        return;
      }
      await tx.query({ name: "scheduled_occurrence_fail_v2", text: `UPDATE
        data.automation_occurrences SET status='failed',lease_owner=NULL,lease_until=NULL,
        error_code='dispatch_failed',error_message=$1,updated_at=$2,finished_at=$2
        WHERE occurrence_id=$3 AND status IN ('leased','prepared') AND lease_owner=$4`,
      values, maxRows: 0 });
      await tx.query({ name: "automation_disable_failed_v1", text: `UPDATE data.automations
        SET enabled=false,version=version+1,last_error=$1,updated_at=$2
        WHERE automation_id=$3 AND version=$4`, values: [values[0], now,
        text(input.taskId, "taskId", 300), integer(input.taskVersion, "taskVersion", 1)], maxRows: 0 });
    });
  }

  async getExecutionAutomation(input: { requestId: string; taskId: string }) {
    return this.database.transaction({ requestId: text(input.requestId, "requestId", 200),
      operation: "automation.execution.get" }, async (tx) => {
      const rows = await tx.query<QueryResultRow>({ name: "automation_execution_get_v2",
        text: `SELECT t.* FROM data.automations t JOIN data.channels c ON c.channel_id=t.channel_id
          WHERE t.automation_id=$1 LIMIT 1`,
        values: [text(input.taskId, "taskId", 300)], maxRows: 1 });
      const row = rows[0];
      return row ? { ...row, id: String(row.automation_id), payload_json: JSON.stringify(row.payload_json),
        enabled: row.enabled === true ? 1 : 0, next_run_at: iso(row.next_run_at),
        created_at: iso(row.created_at), updated_at: iso(row.updated_at) } : undefined;
    });
  }

  async markDispatched(input: { requestId: string; occurrenceId: string; leaseOwner: string;
    taskId: string; runId: string; executionTimeoutMs: number; now: string }): Promise<void> {
    const requestId = text(input.requestId, "requestId", 200);
    const now = timestamp(input.now, "now");
    await this.database.transaction({ requestId, operation: "automation.dispatched" }, async (tx) => {
      const active = await tx.query<QueryResultRow>({ name: "scheduled_occurrence_dispatch_lock_v3",
        text: `SELECT o.status,o.lease_owner,o.error_message,o.finished_at
          FROM data.automation_occurrences o JOIN data.automations t ON t.automation_id=o.automation_id
          JOIN data.channels c ON c.channel_id=t.channel_id
          WHERE o.occurrence_id=$1 FOR UPDATE OF o`,
      values: [input.occurrenceId], maxRows: 1 });
      if (active[0]?.status !== "prepared" || active[0].lease_owner !== input.leaseOwner) {
        throw new AutomationControlError(
          "scheduled_occurrence_lease_lost", 409, "Automation occurrence lost its prepared dispatch lease");
      }
      const deadline = new Date(Date.parse(now) + integer(
        input.executionTimeoutMs, "executionTimeoutMs", 1_000)).toISOString();
      await tx.query({ name: "scheduled_occurrence_dispatched_v2", text: active[0].finished_at
        ? `UPDATE data.automation_occurrences SET status='dispatched',lease_owner=NULL,
            lease_until=NULL,updated_at=$1 WHERE occurrence_id=$2 AND status='prepared' AND lease_owner=$3`
        : `UPDATE data.automation_occurrences SET status='dispatched',lease_owner=NULL,
            lease_until=NULL,error_code=NULL,error_message=NULL,next_attempt_at=$4,
            execution_deadline_at=$4,updated_at=$1,finished_at=NULL
            WHERE occurrence_id=$2 AND status='prepared' AND lease_owner=$3`,
      values: active[0].finished_at ? [now, input.occurrenceId, input.leaseOwner]
        : [now, input.occurrenceId, input.leaseOwner, deadline], maxRows: 0 });
      await tx.query({ name: "automation_mark_dispatched_v1", text: `UPDATE data.automations
        SET run_count=run_count+1,last_run_at=$1,last_run_id=$2,last_error=$3,
          version=version+1,updated_at=$1 WHERE automation_id=$4`, values: [now,
        text(input.runId, "runId", 300), active[0].error_message ?? null,
        text(input.taskId, "taskId", 300)], maxRows: 0 });
    });
  }

  async markPrepared(input: { requestId: string; occurrenceId: string; leaseOwner: string;
    now: string; errorMessage?: string | null; deliveryKind?: "agent_run" | "message";
    messageId?: string; runId?: string; instanceId?: string }): Promise<void> {
    const now = timestamp(input.now, "now");
    await this.database.transaction({ requestId: text(input.requestId, "requestId", 200),
      operation: "automation.prepared" }, async (tx) => {
      const rows = await tx.query<QueryResultRow>({ name: "scheduled_occurrence_prepared_v3", text: `UPDATE
        data.automation_occurrences SET status='prepared',error_message=$1,updated_at=$2
        WHERE occurrence_id=$3 AND status='leased' AND lease_owner=$4
          AND ($5::text IS NULL OR delivery_kind=$5) AND ($6::text IS NULL OR message_id=$6)
          AND ($7::text IS NULL OR run_id=$7) AND ($8::text IS NULL OR instance_id=$8)
          AND EXISTS (SELECT 1 FROM data.automations t
            JOIN data.channels c ON c.channel_id=t.channel_id
            WHERE t.automation_id=automation_occurrences.automation_id)
        RETURNING occurrence_id`, values: [
        input.errorMessage ?? null, now, text(input.occurrenceId, "occurrenceId", 300),
        text(input.leaseOwner, "leaseOwner", 300), input.deliveryKind ?? null,
        input.messageId ?? null, input.runId ?? null, input.instanceId ?? null], maxRows: 1 });
      if (!rows[0]) throw new AutomationControlError(
        "scheduled_occurrence_lease_lost", 409, "Automation occurrence lost its dispatch lease");
    });
  }

  async finishMessage(input: { requestId: string; occurrenceId: string; leaseOwner: string;
    taskId: string; messageId: string; channelId: string; now: string }): Promise<void> {
    const now = timestamp(input.now, "now");
    await this.database.transaction({ requestId: text(input.requestId, "requestId", 200),
      operation: "automation.message.dispatched" }, async (tx) => {
      const rows = await tx.query<QueryResultRow>({ name: "scheduled_message_dispatched_v2", text: `UPDATE
        data.automation_occurrences SET status='dispatched',lease_owner=NULL,lease_until=NULL,
        error_code=NULL,error_message=NULL,updated_at=$1,finished_at=$1
        WHERE occurrence_id=$2 AND status='prepared' AND lease_owner=$3
          AND delivery_kind='message' AND message_id=$4 RETURNING occurrence_id`, values: [now,
        text(input.occurrenceId, "occurrenceId", 300), text(input.leaseOwner, "leaseOwner", 300),
        text(input.messageId, "messageId", 300)], maxRows: 1 });
      if (!rows[0]) throw new AutomationControlError(
        "scheduled_occurrence_lease_lost", 409, "Scheduled message occurrence lost its dispatch lease");
      await tx.query({ name: "scheduled_message_task_finish_v3", text: `UPDATE data.automations
        SET run_count=run_count+1,last_run_at=$1,last_run_id=$2,last_channel_id=$4,last_error=NULL,
          version=version+1,updated_at=$1 WHERE automation_id=$3`, values: [now, input.messageId,
        text(input.taskId, "taskId", 300), text(input.channelId, "channelId", 300)], maxRows: 0 });
    });
  }

  async assertPrepared(input: { requestId: string; occurrenceId: string; taskId: string;
    leaseOwner: string; controlId: string; runId: string }): Promise<void> {
    await this.database.transaction({ requestId: text(input.requestId, "requestId", 200),
      operation: "automation.prepared.assert" }, async (tx) => {
      const rows = await tx.query<QueryResultRow>({ name: "scheduled_occurrence_prepared_assert_v3",
        text: `SELECT 1 AS present FROM data.automation_occurrences o
          JOIN data.automations t ON t.automation_id=o.automation_id
          JOIN data.channels c ON c.channel_id=t.channel_id WHERE o.occurrence_id=$1
          AND o.automation_id=$2 AND o.status='prepared' AND o.lease_owner=$3
          AND o.control_id=$4 AND o.run_id=$5 LIMIT 1`,
        values: [input.occurrenceId, input.taskId, input.leaseOwner, input.controlId, input.runId], maxRows: 1 });
      if (!rows[0]) throw new AutomationControlError(
        "automation_stale_lease", 409, "Automation daemon issue lost its exact occurrence lease");
    });
  }

  async requireEvaluationAuthority(input: { requestId: string; channelId: string;
    authorityRootUserId: string }): Promise<void> {
    await this.database.transaction({ requestId: text(input.requestId, "requestId", 200),
      operation: "automation.evaluation.authorize" }, async (tx) => {
      await automationChannel(tx, text(input.channelId, "channelId", 300),
        { kind: "user", id: text(input.authorityRootUserId, "authorityRootUserId", 300) },
        "automation_new_work");
    });
  }

  private async executionPlacement(requestId: string, spaceId?: string) {
    if (!spaceId) throw new AutomationControlError(
      "invalid_automation_request", 400, "Execution cancellation requires a scoped Space");
    return this.placement(requestId, "automation.execution.placement", spaceId);
  }

  private async finishCancellation(tx: DatabaseTransaction, row: QueryResultRow,
    now: string, reason: "timeout" | "owner"): Promise<void> {
    await cancelRunExecution(tx, { runId: String(row.run_id), ownerUserId: String(row.owner_user_id),
      channelId: String(row.channel_id), at: now, reason });
    const changed = await tx.query({ name: "scheduled_execution_cancel_occurrence_v2", text: `UPDATE
      data.automation_occurrences SET status='cancelled',finished_at=$2,updated_at=$2,
      lease_owner=NULL,lease_until=NULL,error_code=$3,error_message=$4
      WHERE occurrence_id=$1 AND status='dispatched' AND finished_at IS NULL RETURNING occurrence_id`,
      values: [row.occurrence_id, now, reason === "timeout" ? "scheduled_run_timed_out" : "scheduled_run_cancelled",
        reason === "timeout" ? "Execution deadline exceeded; execution cancelled" : "Execution cancelled by its owner"],
      maxRows: 1 });
    if (!changed[0]) return;
    await tx.query({ name: "scheduled_execution_cancel_task_v2", text: `UPDATE data.automations
      SET last_error=$2,version=version+1,updated_at=$3 WHERE automation_id=$1 AND last_run_id=$4`,
      values: [row.automation_id, reason === "timeout" ? "Execution deadline exceeded; execution cancelled"
        : "Execution cancelled by its owner", now, row.run_id], maxRows: 0 });
  }

  private async cancelExecution(input: Record<string, unknown>, commandId: string,
    ownerUserId: string, at: string, placement: SpacePlacement): Promise<Record<string, unknown>> {
    const automationId = text(input.automationId, "automationId", 300);
    const runId = text(input.runId, "runId", 300);
    const digests = await requestDigests(input);
    return this.database.transaction({ requestId: commandId, operation: "automation.execution.cancel",
      placement: { spaceId: placement.spaceId, shardId: placement.shardId,
        placementEpoch: placement.placementEpoch } }, async (tx) => {
      // Match the exact historical execution, never the Automation's mutable latest pointer.
      // Lock Run before occurrence and Automation, matching authenticated lifecycle reports.
      const rows = await tx.query<QueryResultRow>({ name: "scheduled_execution_cancel_owner_v2",
        text: `SELECT o.*,t.channel_id,r.metadata_json,r.status AS run_status FROM data.runs r
          JOIN data.automation_occurrences o ON o.run_id=r.run_id AND o.owner_user_id=r.owner_user_id
          JOIN data.automations t ON t.automation_id=o.automation_id AND t.owner_user_id=o.owner_user_id
          JOIN data.channels c ON c.channel_id=t.channel_id
          WHERE o.automation_id=$1 AND o.run_id=$2 AND o.owner_user_id=$3 AND c.space_id=$4
          FOR UPDATE OF r`, values: [automationId, runId, ownerUserId, placement.spaceId], maxRows: 1 });
      const row = rows[0];
      if (!row) throw new AutomationControlError("not_found", 404, "Owned scheduled execution not found");
      const prior = await replay(tx, placement.spaceId, commandId, "scheduled_execution_cancel", digests);
      if (prior) return prior;
      await automationChannel(tx, String(row.channel_id), { kind: "user", id: ownerUserId },
        "automation_terminalize");
      if (row.status !== "cancelled" || !json(row.metadata_json).executionCancellation ||
          !isTerminalRunStatus(row.run_status)) {
        if (row.status !== "dispatched" || row.finished_at) throw new AutomationControlError(
          "conflict", 409, "Scheduled execution is already finished or has not been dispatched");
        await this.finishCancellation(tx, row, at, "owner");
      }
      const automations = await tx.query<QueryResultRow>({ name: "scheduled_execution_cancel_version_v2",
        text: "SELECT version FROM data.automations WHERE automation_id=$1", values: [automationId], maxRows: 1 });
      const value = { commandId, kind: "scheduled_execution_cancel", automationId, runId,
        channelId: String(row.channel_id),
        status: "cancelled", processCleanup: json(row.metadata_json).executionCancellation
          ? publicExecutionCancellation(json(row.metadata_json).executionCancellation).processCleanup
          : { status: "pending", attempts: 0, nextAttemptAt: at },
        entityId: automationId, entityVersion: Number(automations[0]?.version), reused: row.status === "cancelled" };
      await commit(tx, placement.spaceId, commandId, "scheduled_execution_cancel", digests.current, value, at);
      return value;
    });
  }

  async cancelExpiredExecutions(input: { requestId: string; now: string; spaceId?: string }): Promise<void> {
    const now = timestamp(input.now, "now");
    await this.database.transaction({ requestId: text(input.requestId, "requestId", 200),
      operation: "automation.execution.expire",
      placement: await this.executionPlacement(input.requestId, input.spaceId) }, async (tx) => {
      const rows = await tx.query<QueryResultRow>({ name: "scheduled_execution_expired_v2", text: `SELECT
        o.*,t.channel_id FROM data.runs r JOIN data.automation_occurrences o
          ON o.run_id=r.run_id AND o.owner_user_id=r.owner_user_id
        JOIN data.automations t ON t.automation_id=o.automation_id AND t.owner_user_id=o.owner_user_id
        JOIN data.channels c ON c.channel_id=t.channel_id
        WHERE o.status='dispatched' AND o.finished_at IS NULL
          AND o.execution_deadline_at<=$1 AND r.status IN (${ACTIVE_RUN_STATUS_SQL})
          AND ($2::text IS NULL OR c.space_id=$2)
        ORDER BY o.execution_deadline_at,o.occurrence_id LIMIT $3 FOR UPDATE OF r SKIP LOCKED`,
        values: [now, input.spaceId ?? null, OCCURRENCE_BATCH_SIZE], maxRows: OCCURRENCE_BATCH_SIZE });
      for (const row of rows) await this.finishCancellation(tx, row, now, "timeout");
    });
  }

  async claimTimeoutStops(input: { requestId: string; now: string; spaceId?: string }) {
    const now = timestamp(input.now, "now");
    const spaceId = input.spaceId ? text(input.spaceId, "spaceId", 300) : null;
    return this.database.transaction({ requestId: text(input.requestId, "requestId", 200),
      operation: "automation.timeout.claim",
      placement: await this.executionPlacement(input.requestId, input.spaceId) }, async (tx) => {
      const rows = await tx.query<QueryResultRow>({ name: "scheduled_cancel_cleanup_claim_v3", text: `WITH
        candidate AS MATERIALIZED (SELECT r.run_id,o.occurrence_id,
          (r.metadata_json#>>'{executionCancellation,processCleanup,attempts}')::integer AS cleanup_attempts
          FROM data.runs r JOIN data.automation_occurrences o ON o.run_id=r.run_id
            AND o.owner_user_id=r.owner_user_id
          JOIN data.automations t ON t.automation_id=o.automation_id
          JOIN data.channels c ON c.channel_id=t.channel_id
          WHERE o.status='cancelled' AND r.status IN (${TERMINAL_RUN_STATUS_SQL})
            AND r.metadata_json#>>'{executionCancellation,processCleanup,status}'='pending'
            AND (r.metadata_json#>>'{executionCancellation,processCleanup,nextAttemptAt}')::timestamptz<=$1
            AND ($2::text IS NULL OR c.space_id=$2)
          ORDER BY o.finished_at,o.occurrence_id LIMIT $3 FOR UPDATE OF r SKIP LOCKED), claimed AS (
          UPDATE data.runs r SET metadata_json=jsonb_set(r.metadata_json,
            '{executionCancellation,processCleanup}',jsonb_build_object(
              'status',CASE WHEN candidate.cleanup_attempts >= $4 THEN 'unconfirmed' ELSE 'pending' END,
              'attempts',LEAST(candidate.cleanup_attempts+1,$4),
              'nextAttemptAt',$1::timestamptz + make_interval(secs =>
                LEAST(900,5*power(2,LEAST(candidate.cleanup_attempts,8)))::double precision))),
            version=r.version+1,updated_at=$1 FROM candidate WHERE r.run_id=candidate.run_id
          RETURNING r.run_id,r.metadata_json AS run_metadata_json,
            candidate.cleanup_attempts+1 AS cleanup_attempts
        ) SELECT o.*,claimed.run_metadata_json,claimed.cleanup_attempts
          FROM claimed JOIN data.automation_occurrences o ON o.run_id=claimed.run_id
          WHERE claimed.cleanup_attempts<=$4`,
        values: [now, spaceId, OCCURRENCE_BATCH_SIZE, OCCURRENCE_MAX_ATTEMPTS], maxRows: OCCURRENCE_BATCH_SIZE });
      return rows.map((row) => ({ ...occurrence(row), attempts: Number(row.cleanup_attempts),
        run_metadata_json: json(row.run_metadata_json) }));
    });
  }

  async recordTimeout(input: { requestId: string; occurrenceId: string; taskId: string;
    runId: string; now: string; expectedAttempts: number; code: "scheduled_run_timeout_unroutable" |
      "scheduled_run_timeout_retry"; message: string;
    nextAttemptAt?: string }): Promise<void> {
    const now = timestamp(input.now, "now");
    const nextAttemptAt = input.nextAttemptAt ? timestamp(input.nextAttemptAt, "nextAttemptAt") : null;
    const expectedAttempts = integer(input.expectedAttempts, "expectedAttempts", 1);
    await this.database.transaction({ requestId: text(input.requestId, "requestId", 200),
      operation: "automation.timeout.record", placement: await this.opaquePlacement(
        input.requestId, "automation", input.taskId) }, async (tx) => {
      await tx.query({ name: "scheduled_cancel_cleanup_record_v2", text: `UPDATE data.runs r
        SET metadata_json=jsonb_set(r.metadata_json,'{executionCancellation,processCleanup}',
          (r.metadata_json#>'{executionCancellation,processCleanup}') || $1::jsonb),
          version=version+1,updated_at=$2
        FROM data.automation_occurrences o WHERE o.run_id=r.run_id AND o.owner_user_id=r.owner_user_id
          AND o.occurrence_id=$3 AND o.automation_id=$4 AND r.run_id=$5 AND o.status='cancelled'
          AND r.metadata_json#>>'{executionCancellation,processCleanup,status}'='pending'
          AND (r.metadata_json#>>'{executionCancellation,processCleanup,attempts}')::integer=$6`,
        values: [JSON.stringify({ ...(input.code === "scheduled_run_timeout_unroutable"
          ? { status: "unroutable" } : {}), errorCode: input.code,
          ...(nextAttemptAt ? { nextAttemptAt } : {}) }), now, input.occurrenceId, input.taskId,
          input.runId, expectedAttempts], maxRows: 0 });
    });
  }

  async finalizeOrphanedRuns(input: { requestId: string; now: string; cutoff: string;
    spaceId?: string }): Promise<void> {
    const now = timestamp(input.now, "now");
    const cutoff = timestamp(input.cutoff, "cutoff");
    const spaceId = input.spaceId ? text(input.spaceId, "spaceId", 300) : null;
    await this.database.transaction({ requestId: text(input.requestId, "requestId", 200),
      operation: "automation.timeout.finalize-orphans",
      ...(input.spaceId ? { placement: await this.executionPlacement(input.requestId, input.spaceId) } : {}) }, async (tx) => {
      const rows = await tx.query<QueryResultRow>({ name: "scheduled_orphaned_runs_v2", text: `SELECT
        o.occurrence_id,o.automation_id,o.run_id,r.status AS run_status,
          r.metadata_json->>'terminalError' AS run_terminal_error
        FROM data.automation_occurrences o LEFT JOIN data.runs r
          ON r.run_id=o.run_id AND r.owner_user_id=o.owner_user_id
        JOIN data.automations t ON t.automation_id=o.automation_id
        JOIN data.channels c ON c.channel_id=t.channel_id
        WHERE o.status='dispatched' AND o.finished_at IS NULL AND o.updated_at<=$1
          AND ($2::text IS NULL OR c.space_id=$2)
          AND (r.run_id IS NULL OR r.status NOT IN (${ACTIVE_RUN_STATUS_SQL}))
        ORDER BY o.updated_at,o.occurrence_id LIMIT $3 FOR UPDATE OF o SKIP LOCKED`,
      values: [cutoff, spaceId, OCCURRENCE_BATCH_SIZE], maxRows: OCCURRENCE_BATCH_SIZE });
      for (const row of rows) {
        const detail = (row.run_status == null
          ? "Scheduled run record no longer exists and never reported an exit"
          : `Scheduled run ended as '${String(row.run_status)}' without reporting an exit${
            row.run_terminal_error ? `: ${String(row.run_terminal_error)}` : ""}`).slice(0, 1_000);
        await tx.query({ name: "scheduled_orphaned_occurrence_finish_v2", text: `UPDATE
          data.automation_occurrences SET status='failed',lease_owner=NULL,lease_until=NULL,
            error_code='run_terminal_without_exit_report',error_message=$1,updated_at=$2,finished_at=$2
          WHERE occurrence_id=$3 AND status='dispatched' AND finished_at IS NULL`,
        values: [detail, now, row.occurrence_id], maxRows: 0 });
        await tx.query({ name: "scheduled_orphaned_task_finish_v2", text: `UPDATE data.automations
          SET last_error=$1,version=version+1,updated_at=$2 WHERE automation_id=$3 AND last_run_id=$4`,
        values: [detail, now, row.automation_id, row.run_id], maxRows: 0 });
      }
    });
  }

  /** One Channel's earliest Automation wake: cadence, retry, lease, deadline, cleanup and
   *  orphan convergence. The Channel's coordinator alarm follows it. */
  async nextChannelAutomationWakeAt(input: { requestId: string; channelId: string }): Promise<string | null> {
    const channelId = text(input.channelId, "channelId", 300);
    return this.database.transaction({ requestId: text(input.requestId, "requestId", 200),
      operation: "automation.next-channel-automation-wake" }, async (tx) => {
      const rows = await tx.query<QueryResultRow>({ name: "automation_next_channel_wake_v1",
        text: CHANNEL_AUTOMATION_WAKE_SQL,
        values: [channelId], maxRows: 1 });
      return rows[0]?.wake_at ? iso(rows[0].wake_at) : null;
    });
  }

  /** One page of Channels that have Automation work (an enabled Automation or an unfinished
   *  occurrence), ordered by id: the cutover wakes each Channel's coordinator once. */
  async channelsWithAutomationWork(input: { requestId: string; afterChannelId?: string;
    limit: number }): Promise<string[]> {
    const limit = integer(input.limit, "limit");
    if (limit < 1 || limit > 1_000) throw new AutomationControlError(
      "invalid_automation_request", 400, "limit is invalid");
    const after = input.afterChannelId === undefined ? "" : text(input.afterChannelId, "afterChannelId", 300);
    return this.database.transaction({ requestId: text(input.requestId, "requestId", 200),
      operation: "automation.channels-with-work" }, async (tx) => {
      const rows = await tx.query<QueryResultRow>({ name: "automation_channels_with_work_v1",
        text: `SELECT DISTINCT t.channel_id FROM data.automations t
          WHERE t.channel_id > $1 AND (t.enabled=true OR EXISTS (
            SELECT 1 FROM data.automation_occurrences o
            WHERE o.automation_id=t.automation_id AND o.finished_at IS NULL))
          ORDER BY t.channel_id LIMIT $2`,
        values: [after, limit], maxRows: limit });
      return rows.map((row) => String(row.channel_id));
    });
  }

  private async disableAutomation(tx: DatabaseTransaction, row: QueryResultRow,
    now: string, message: string) {
    await tx.query({ name: "automation_disable_invalid_v1", text: `UPDATE data.automations
      SET enabled=false,version=version+1,last_error=$1,updated_at=$2
      WHERE automation_id=$3 AND version=$4 AND enabled=true`,
    values: [message, now, row.automation_id, row.version], maxRows: 0 });
  }

  private async advanceAutomation(tx: DatabaseTransaction, row: QueryResultRow,
    cadence: string, nextVersion: number, now: string, eventsTaken = false) {
    await tx.query({ name: "automation_advance_v2", text: `UPDATE data.automations
      SET next_run_at=$1,version=$2,updated_at=$3,
        trigger_events=CASE WHEN $6::boolean THEN NULL ELSE trigger_events END
      WHERE automation_id=$4 AND version=$5 AND enabled=true`,
    values: [cadence, nextVersion, now, row.automation_id, row.version, eventsTaken], maxRows: 0 });
  }

  /**
   * The page Automations an event may concern, on this shard: enabled ones
   * whose triggers contain the given one (docs/design/pages-live-document.md
   * §6.2). The caller decides which of them the event really fires.
   */
  async triggeredBy(input: { requestId: string; trigger: Record<string, unknown>; spaceId?: string;
    pageId?: string }): Promise<Array<{ automationId: string; channelId: string; spaceId: string; pageId: string;
      authorityRootUserId: string; triggers: unknown[] }>> {
    const requestId = text(input.requestId, "requestId", 200);
    return this.database.transaction({ requestId, operation: "automation.triggered-by" }, async (tx) => {
      const rows = await tx.query<QueryResultRow>({ name: "automation_triggered_by_v1", text: `SELECT
          a.automation_id,a.channel_id,a.page_id,a.owner_user_id,a.payload_json,c.space_id
        FROM data.automations a JOIN data.channels c ON c.channel_id=a.channel_id
        WHERE a.page_id IS NOT NULL AND a.enabled=true AND (a.payload_json->'triggers') @> $1::jsonb
          AND ($2::text IS NULL OR c.space_id=$2) AND ($3::text IS NULL OR a.page_id=$3)
        ORDER BY a.automation_id LIMIT 200`,
      values: [JSON.stringify([input.trigger]), input.spaceId ?? null, input.pageId ?? null], maxRows: 200 });
      return rows.map((row) => ({ automationId: String(row.automation_id), channelId: String(row.channel_id),
        spaceId: String(row.space_id), pageId: String(row.page_id), authorityRootUserId: authorityRoot(row),
        triggers: Array.isArray(json(row.payload_json).triggers) ? json(row.payload_json).triggers as unknown[] : [] }));
    });
  }

  /**
   * An event fires an Automation: it becomes due now, and the event is kept
   * (the last ten) for the occurrence that takes it. Idempotent per event id.
   * Returns the conversation to tell, or null when nothing changed.
   */
  async fireTrigger(input: { requestId: string; automationId: string; eventId: string;
    event: Record<string, unknown>; at: string }, dingtalkEffect?: DingTalkEffectAuthority): Promise<string | null> {
    const requestId = text(input.requestId, "requestId", 200);
    const at = timestamp(input.at, "at");
    const placement=dingtalkEffect ? await this.placement(requestId,"automation.dingtalk-effect.placement",dingtalkEffect.spaceId) : undefined;
    return this.database.transaction({ requestId, operation: "automation.trigger",
      ...(placement ? { placement: { spaceId: placement.spaceId,shardId: placement.shardId,placementEpoch: placement.placementEpoch } } : {}) }, async (tx) => {
      const source=dingtalkEffect && placement ? await authorizeDingTalkEffect(tx,dingtalkEffect,{
        kind: "automation",id: input.automationId,channelId: dingtalkEffect.destination.channelId,
        spaceId: placement.spaceId,shardId: placement.shardId,effectId: input.eventId,
        authorityRootUserId: dingtalkEffect.destination.authorityRootUserId }) : undefined;
      if (dingtalkEffect) {
        // Lock first; a new statement below reads enabled/owner/trigger state
        // after a concurrent manager's transaction has committed.
        await tx.query({ name: "dingtalk_effect_automation_lock_v1",text: `SELECT 1 FROM data.automations
          WHERE automation_id=$1 FOR UPDATE`,values: [input.automationId],maxRows: 1 });
      }
      const rows = await tx.query<QueryResultRow>({ name: "automation_trigger_lock_v1", text: `SELECT
          a.automation_id,a.channel_id,a.version,a.trigger_events,c.space_id,a.owner_user_id,a.payload_json,
          (extract(epoch from a.created_at)*1000000)::bigint::text AS birth
        FROM data.automations a JOIN data.channels c ON c.channel_id=a.channel_id
        WHERE a.automation_id=$1 AND a.enabled=true AND a.page_id IS NOT NULL FOR UPDATE OF a`,
      values: [text(input.automationId, "automationId", 300)], maxRows: 1 });
      const row = rows[0];
      if (!row) { if (dingtalkEffect) dingtalkDenied(); return null; }
      if (dingtalkEffect && source) {
        const destination=dingtalkEffect.destination;
        const triggers=json(row.payload_json).triggers;
        const matching=Array.isArray(triggers) && triggers.some(value => {
          const trigger=json(value);
          return trigger.kind==="event" && trigger.provider==="dingtalk" &&
            (trigger.source==="*" || trigger.source===source.sourceRef.slice("dingtalk:".length)) &&
            (!trigger.feature || trigger.feature==="message.received");
        });
        if (row.channel_id!==destination.channelId || row.space_id!==dingtalkEffect.spaceId ||
          Number(row.version)!==destination.version || row.birth!==destination.birth ||
          row.owner_user_id!==destination.ownerUserId || authorityRoot(row)!==destination.authorityRootUserId || !matching) dingtalkDenied();
      }
      const eventId = text(input.eventId, "eventId", 200);
      const commandId = dingtalkEffect ? `automation-trigger:${dingtalkEffect.effectId}`
        : `automation-trigger:${String(row.automation_id)}:${eventId}`.slice(0, 200);
      // A redelivered event, even one an occurrence already took, fires nothing more.
      if ((await tx.query({ name: "automation_trigger_seen_v1", text: `SELECT 1 FROM
        control.scoped_control_command_replays WHERE scope_kind='space' AND scope_id=$1 AND command_id=$2`,
      values: [String(row.space_id), commandId], maxRows: 1 })).length) {
        if (dingtalkEffect) await finishDingTalkEffect(tx,dingtalkEffect);
        return null;
      }
      const events = Array.isArray(row.trigger_events) ? row.trigger_events as Array<Record<string, unknown>> : [];
      const event=source ? { kind: "event",provider: "dingtalk",feature: "message.received",
        sourceRef: source.sourceRef,summary: source.candidate.text } : input.event;
      const next = [...events, { ...event, id: eventId, at }].slice(-10);
      const version = Number(row.version) + 1;
      await tx.query({ name: "automation_trigger_fire_v1", text: `UPDATE data.automations SET
          trigger_events=$1::jsonb,next_run_at=LEAST(next_run_at,GREATEST($2::timestamptz,
            COALESCE(last_run_at+make_interval(mins=>$5),$2::timestamptz))),version=$3,updated_at=$2
        WHERE automation_id=$4`, values: [JSON.stringify(next), at, version, row.automation_id, EVENT_SPACING_MINUTES],
        maxRows: 0 });
      await commit(tx, String(row.space_id), commandId, "automation_put", await digest(commandId), {
        commandId, kind: "automation_put", entityId: String(row.automation_id), channelId: String(row.channel_id),
        entityVersion: version, reused: false, projectionMutations: [], recipientChanges: [] }, at);
      if (dingtalkEffect) await finishDingTalkEffect(tx,dingtalkEffect);
      return String(row.channel_id);
    });
  }
}
