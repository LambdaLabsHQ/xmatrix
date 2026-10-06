import { agentPresetForLauncher, createInstanceMentions, deriveHarnessInvocationSelections, digestCanonicalCloneCborV1,
  parseAgentInvocationSelections, type AgentInvocationSelections, type AgentInvocationTarget } from "@xmatrix/protocol";
import type { DatabaseTransaction } from "./contracts.js";
import { requireChannelCapability } from "./channel-capability-policy.js";
import { MessageAuthorityError } from "./message-authority-error.js";

/** The append/edit transaction supplies its authenticated actor and canonical
 * body. A picker reference is intent, never a grant or an execution receipt. */
export async function authorizeMessageInvocationSelections(tx: DatabaseTransaction, input: {
  spaceId: string; channelId: string; principal: { kind: "user" | "agent"; id: string };
  body: string; bodyHash: string; revision: number; selections: unknown;
}): Promise<AgentInvocationSelections> {
  if (input.principal.kind !== "user") throw new MessageAuthorityError(
    "invocation_selection_forbidden", 403, "Agent invocation selections require a Human caller");
  let parsed: AgentInvocationSelections;
  try {
    if (await digestCanonicalCloneCborV1(input.body) !== input.bodyHash) throw new Error("Body hash mismatch");
    parsed = parseAgentInvocationSelections(input.selections, input);
  } catch {
    throw new MessageAuthorityError("invocation_selection_stale", 409,
      "Agent selection no longer matches this message; select the target again");
  }
  await requireChannelCapability(tx, { spaceId: input.spaceId, channelId: input.channelId,
    principal: input.principal, capability: "runtime_new_work",
    error: failure => new MessageAuthorityError(failure.code, failure.status, failure.message) });
  // Take the same membership/access row locks used by admission. This is an
  // initial eligibility check only: dispatch must recheck resources and fences.
  for (const selection of parsed.selections) {
    if (selection.target.kind === "auto") throw new MessageAuthorityError("invocation_selection_stale", 409,
      "Agent selection no longer matches this message; select the target again");
    const key = selection.target.kind === "registration" ? selection.target.key : undefined;
    const rows = await tx.query({ name: "message_invocation_selection_authorize_v1", text: `SELECT a.harness
      FROM data.space_agent_registration_access a
      JOIN data.space_agent_registrations r USING (space_id,owner_user_id,machine_id,harness)
      JOIN data.space_members m ON m.space_id=a.space_id AND m.user_id=a.owner_user_id
      WHERE a.space_id=$1 AND a.harness=$2 AND ($3::text IS NULL OR a.owner_user_id=$3)
        AND ($4::text IS NULL OR a.machine_id=$4) AND a.grant_state='active' AND a.policy_state='enabled'
      ORDER BY a.owner_user_id,a.machine_id LIMIT 1 FOR SHARE OF a,r,m`,
    values: [input.spaceId, key?.harness ?? (selection.target.kind === "capability" ? selection.target.harness : ""),
      key?.ownerUserId ?? null, key?.machineId ?? null], maxRows: 1 });
    if (!rows[0]) throw new MessageAuthorityError("invocation_target_unavailable", 409,
      "The selected Agent capability is no longer available in this Space");
  }
  return parsed;
}

/** Preserve offsets and newlines while keeping explicitly bound invocations out
 * of the legacy name scanner. Ordinary mentions outside these spans still work. */
export function bodyWithoutInvocationSelections(body: string, selections: AgentInvocationSelections): string {
  let result = body;
  for (const selection of [...selections.selections].reverse()) {
    // Spaces would turn a leading invocation into Markdown indentation and
    // incorrectly suppress a following ordinary mention as a code block.
    result = result.slice(0, selection.start) + selection.text.replace(/[^\r\n]/gu, character => "x".repeat(character.length)) +
      result.slice(selection.end);
  }
  return result;
}

/** xMatrix's own `@<harness>` reply summoning the harness decided for a new
 * conversation's first message. Only the Hub writes `system:xmatrix` messages. */
export const XMATRIX_SYSTEM_AUTHOR_ID = "xmatrix";
export const firstMessageSummonId = (firstMessageId: string) => `xmatrix-summon:${firstMessageId}`;

/**
 * Whether the actor may invoke through a message it authored: its own Human
 * message, one an Agent Instance running under the actor's registration
 * posted, or xMatrix's summon for the first message whose decision the actor
 * owns. The launch reader and the staged-launch recheck share this rule.
 */
export async function messageAuthoredForActor(tx: DatabaseTransaction, input: {
  spaceId: string; channelId: string; messageId: string; authorKind: unknown; authorId: unknown; actorUserId: string;
}): Promise<boolean> {
  if (input.authorKind === "user") return input.authorId === input.actorUserId;
  if (input.authorKind === "system") {
    return input.authorId === XMATRIX_SYSTEM_AUTHOR_ID && await firstMessageSummonOfActor(tx, input);
  }
  return input.authorKind === "agent" && await agentOfActor(tx, input.spaceId, String(input.authorId), input.actorUserId);
}

/** The first message this summon answers was decided to start a harness, and is the actor's. */
async function firstMessageSummonOfActor(tx: DatabaseTransaction, input: {
  spaceId: string; channelId: string; messageId: string; actorUserId: string }): Promise<boolean> {
  const rows = await tx.query({ name: "message_invocation_first_message_summon_v1", text: `SELECT 1 AS present
    FROM data.first_message_launch_choices
    WHERE space_id=$1 AND channel_id=$2 AND $3='xmatrix-summon:'||message_id AND author_user_id=$4 AND choice='start'`,
  values: [input.spaceId, input.channelId, input.messageId, input.actorUserId], maxRows: 1 });
  return Boolean(rows[0]);
}

/** An Agent's message launches as its owner: the Instance of one of the
 * owner's registered Runs in this Space. */
async function agentOfActor(tx: DatabaseTransaction, spaceId: string, authorId: string,
  actorUserId: string): Promise<boolean> {
  const rows = await tx.query({ name: "message_invocation_agent_author_v2", text: `SELECT 1 AS present
    FROM data.instances i JOIN data.run_agent_registrations b ON b.run_id=i.run_id
    WHERE i.instance_id=$1 AND b.space_id=$2 AND b.owner_user_id=$3 LIMIT 1`,
  values: [authorId, spaceId, actorUserId], maxRows: 1 });
  return Boolean(rows[0]);
}

/**
 * What each `@name:new` / `@name:once` in the body addresses in this Space: the
 * one registration with that display name, or -- when the name is a harness
 * or names several registrations of one harness -- that harness capability.
 * Anything else stays text.
 */
async function createMentionTargets(tx: DatabaseTransaction, spaceId: string,
  body: string): Promise<Map<string, AgentInvocationTarget>> {
  const names = [...new Set(createInstanceMentions(body).map(mention => mention.name.toLowerCase()))].slice(0, 32);
  const targets = new Map<string, AgentInvocationTarget>();
  if (!names.length) return targets;
  const rows = await tx.query({ name: "message_invocation_create_targets_v1", text: `SELECT lower(display_name) AS name,
      owner_user_id,machine_id,harness FROM data.space_agent_registrations
    WHERE space_id=$1 AND lower(display_name)=ANY($2::text[]) ORDER BY owner_user_id,machine_id,harness LIMIT 1001`,
  values: [spaceId, names], maxRows: 1001 });
  for (const name of names) {
    const matches = rows.filter(row => row.name === name);
    const harness = agentPresetForLauncher(name)?.id;
    if (matches.length === 1 && !(harness && matches[0]!.harness !== harness)) {
      targets.set(name, { kind: "registration", key: { spaceId, ownerUserId: String(matches[0]!.owner_user_id),
        machineId: String(matches[0]!.machine_id), harness: String(matches[0]!.harness) } });
    } else if (harness && matches.every(row => row.harness === harness)) {
      targets.set(name, { kind: "capability", harness });
    } else if (!harness && matches.length > 1 && matches.every(row => row.harness === matches[0]!.harness)) {
      targets.set(name, { kind: "capability", harness: String(matches[0]!.harness) });
    }
  }
  return targets;
}

/** Called by the invocation authority after authorizing the source Channel.
 * Keep the source locked until the attempt is committed so an edit cannot race
 * task admission. Reactions change entity_version but not invocation_input_version. */
export async function readMessageInvocationSelections(tx: DatabaseTransaction, input: {
  spaceId: string; channelId: string; messageId: string; actorUserId: string; body: string;
  /** The Space is composite: derive capability selections from harness shouts. */
  deriveFromText?: boolean;
}): Promise<(AgentInvocationSelections & { sourceSequence: number; authorKind: "user" | "agent" }) | null> {
  await requireChannelCapability(tx, { spaceId: input.spaceId, channelId: input.channelId,
    principal: { kind: "user", id: input.actorUserId }, capability: "runtime_new_work",
    error: failure => new MessageAuthorityError(failure.code, failure.status, failure.message) });
  const rows = await tx.query({ name: "message_invocation_selections_source_v1", text: `SELECT author_kind,author_id,
      timeline_sequence,body_hash,COALESCE(invocation_input_version,entity_version) AS input_version,agent_invocation_targets_json
    FROM data.messages WHERE space_id=$1 AND channel_id=$2 AND message_id=$3
      AND deleted_at IS NULL AND recalled_at IS NULL FOR SHARE`,
  values: [input.spaceId, input.channelId, input.messageId], maxRows: 1 });
  const row = rows[0];
  if (!row || !await messageAuthoredForActor(tx, { spaceId: input.spaceId, channelId: input.channelId,
      messageId: input.messageId, authorKind: row.author_kind,
      authorId: row.author_id, actorUserId: input.actorUserId })) {
    throw new MessageAuthorityError("invocation_source_unavailable", 409, "Invocation source is unavailable");
  }
  const envelope = row.agent_invocation_targets_json?.selections;
  // Only a composer can bind a specific registration; text reaches the same
  // launch path through its harness shouts, derived from the stored body.
  if (envelope === undefined && !input.deriveFromText) return null;
  try {
    if (await digestCanonicalCloneCborV1(input.body) !== row.body_hash) throw new Error("Body hash mismatch");
    const sourceSequence = Number(row.timeline_sequence);
    if (!Number.isSafeInteger(sourceSequence) || sourceSequence < 1) throw new Error("Invalid source sequence");
    const source = { spaceId: input.spaceId, body: input.body,
      bodyHash: String(row.body_hash), revision: Number(row.input_version) };
    return { ...(envelope === undefined
      ? deriveHarnessInvocationSelections(source, await createMentionTargets(tx, input.spaceId, input.body))
      : parseAgentInvocationSelections(envelope, source)), sourceSequence,
      authorKind: row.author_kind === "agent" ? "agent" as const : "user" as const };
  } catch {
    throw new MessageAuthorityError("invocation_selection_stale", 409, "Invocation source has changed");
  }
}
