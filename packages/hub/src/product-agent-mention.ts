import { parseRebornInstanceMentions as parseProductRebornInstanceMentions,
  parseHandoffInstanceMentions as parseProductHandoffInstanceMentions,
  type RebornInstanceMention as ProductRebornInstanceMention,
  type HandoffInstanceMention as ProductHandoffInstanceMention } from "@xmatrix/protocol";
export { parseProductRebornInstanceMentions, parseProductHandoffInstanceMentions };
export type { ProductRebornInstanceMention, ProductHandoffInstanceMention };

/**
 * Product-layer orchestration of the Agent work a message asks for: the
 * `:reborn` / `:handoff` continuations. Every Run it
 * starts is a registration Run, prepared by the registration authority; this
 * module never creates a Run or issues daemon work itself.
 */

import type { HandoffSuccessor } from "./handoff-successor";
import { agentPresetForLauncher, isAutoHandoffSuccessor, sha256Hex,
  type ChannelAttachment } from "@xmatrix/protocol";

export interface ProductRebornTarget {
  instanceId: string;
  instanceStatus: string;
  channelId: string;
  channelInstanceId: number;
  runId: string;
  runStatus: string;
  /** The registration's display name and harness; either addresses the slot. */
  agentName: string;
  harness: string;
  ownerUserId: string;
  workspace?: ProductWorkspaceRef;
  metadata: Record<string, unknown>;
}

export interface ProductWorkspaceRef {
  machineId: string;
  canonicalCwd: string;
}

export interface ProductChannelView {
  id: string;
  spaceId: string;
  mode: "open" | "closed";
  name?: string;
  archivedAt?: string;
  metadata?: Record<string, unknown>;
}

export interface ProductAgentMentionPort {
  getChannel(channelId: string): Promise<ProductChannelView | null>;
  getRebornTarget(input: {
    channelId: string;
    agentName: string;
    channelInstanceId: number;
  }): Promise<ProductRebornTarget | null>;
  /**
   * Reborn in a composite Space: the successor is a registration Run of the
   * predecessor's tuple (durable intent; the reconciler stops, creates and
   * spawns). `legacy` means the Space has not cut over.
   */
  /** Rejects with a coded error when the registration refuses the reborn. */
  prepareRegisteredReborn(input: {
    channelId: string;
    sourceInstanceId: string;
    sourceMessageId: string;
    /** The exact `@<name>:<ordinal>:reborn` text, so the reborn's status binds to it. */
    sourceMention: string;
    prompt: string;
  }): Promise<{ intentId: string; state: string }>;
  /** Stop the source and start its successor through ordinary launch routing,
   * on any machine but the source's own registration. */
  handOff?(input: HandoffSuccessor): Promise<{ agentName: string }>;
  /**
   * Same lookup as reborn, including dead instances, for an existing-to-new
   * handoff. Implementations may reuse the reborn target read.
   */
  getHandoffTarget?(input: {
    channelId: string;
    agentName: string;
    channelInstanceId: number;
  }): Promise<ProductRebornTarget | null>;
  /** Jev's decision on a new conversation's first message that summons
   * nobody: the harness to summon, or none. `window`: its Human author may choose first. */
  decideFirstMessageLaunch(input: { channelId: string; messageId: string; body: string; window: boolean }):
    Promise<{ claimed: boolean; harness?: string }>;
  /** Best-effort product feedback when summon cannot proceed. */
  publishSystemNotice?(channelId: string, body: string): Promise<void>;
  /** Bounded operational diagnostics; must not include message or command payloads. */
  reportDiagnostic?(input: {
    stage: "summon" | "system_notice";
    channelId: string;
    messageId: string;
    machineId?: string;
    hostId?: string;
    error: string;
  }): void;
}

export interface ProductAgentMentionOrchestrationInput {
  channelId: string;
  messageId: string;
  body: string;
  actorUserId: string;
  /** Canonical Channel authority commit timestamp for the trigger message. */
  triggerCommittedAt?: string;
  /** Hub observation time at the beginning of post-commit interpretation. */
  interpretStartedAt?: string;
  attachments?: ChannelAttachment[];
  /** Direct product tasks have no source message to acknowledge or replay. */
  sourceMessageExists?: boolean;
  port: ProductAgentMentionPort;
}

export interface ProductAgentMentionOrchestrationResult {
  considered: number;
  spawned: number;
  notices: string[];
}

function metadataString(metadata: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = metadata?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * The code of a registration refusal, which is a reportable outcome. Anything
 * without one (a lost lease, a transport failure) belongs to the caller's retry.
 */
function registrationRefusalCode(error: unknown): string {
  const code = error && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code : "";
  if (!code) throw error;
  return code;
}

/** Remove only actual invocation ranges; retain literal examples and formatting. */
function promptWithoutMentionRanges(body: string, mentions: readonly { start: number; end: number }[]): string {
  const ordered = [...mentions].sort((left, right) => right.start - left.start);
  let next = body;
  for (const mention of ordered) next = `${next.slice(0, mention.start)}${next.slice(mention.end)}`;
  const content = next.replace(/^(?:[ \t]*\r?\n)+/u, "");
  // Downstream prompt boundaries trim outer whitespace. A leading indented
  // example needs a label so that trim cannot turn it into ordinary instructions.
  return /^(?: {4}|[ \t]*\t)/u.test(content)
    ? `Message:\n\n${content.trimEnd()}` : next.trim();
}

function promptWithoutProductRebornMentions(body: string, mentions: readonly ProductRebornInstanceMention[]): string {
  return promptWithoutMentionRanges(body, mentions);
}

function promptWithoutProductHandoffMentions(body: string, mentions: readonly ProductHandoffInstanceMention[]): string {
  return promptWithoutMentionRanges(body, mentions);
}

/** Host-safe key for `~/.xmatrix-management/<key>/` (daemon key bound: 128). */
/**
 * After an Authority-authoritative message commit, summon each explicit
 * `@agent:new` target through Authority run/instance/daemon product APIs.
 */
/**
 * Continuation lifecycle mentions (`:reborn`, `:handoff`). Starting a new
 * Instance (`@name`, `@name:new`, `@name:once`) is the registration dispatch's
 * alone; this path never creates one from a name.
 */
export async function orchestrateProductAgentMentions(
  input: ProductAgentMentionOrchestrationInput,
): Promise<ProductAgentMentionOrchestrationResult> {
  const rebornMentions = parseProductRebornInstanceMentions(input.body);
  const handoffMentions = parseProductHandoffInstanceMentions(input.body);
  if (rebornMentions.length === 0 && handoffMentions.length === 0) {
    return { considered: 0, spawned: 0, notices: [] };
  }
  const empty: ProductAgentMentionOrchestrationResult = { considered: 0, spawned: 0, notices: [] };
  const [reborn, handoff] = await Promise.all([
    rebornMentions.length > 0
      ? orchestrateProductAgentRebornMentions(input, rebornMentions)
      : Promise.resolve(empty),
    handoffMentions.length > 0
      ? orchestrateProductAgentHandoffMentions(input, handoffMentions)
      : Promise.resolve(empty),
  ]);
  return {
    considered: reborn.considered + handoff.considered,
    spawned: reborn.spawned + handoff.spawned,
    notices: [...reborn.notices, ...handoff.notices],
  };
}

/**
 * A new conversation's first message that summons nobody: Jev reads whether
 * its author wants an Agent to start on it now, and which harness. Only a
 * conversation nobody has named yet (the web's New conversation) is asked;
 * Jev's "no" and every refusal start nothing and say nothing, because the
 * author never asked for an Agent. A Human author sees the harnesses and
 * "none" for a few seconds; a choice there is the decision, and Jev's reading
 * decides only once that window closes. The harness decided here is summoned
 * by the caller with an ordinary `@<harness>` message, never launched here.
 */
export async function orchestrateProductNewConversationStart(input: {
  port: ProductAgentMentionPort; channelId: string; messageId: string; body: string;
  /** A Human's message offers its author a short window to choose first. */
  authorKind?: "user" | "agent";
}): Promise<{ harness?: string }> {
  const channel = await input.port.getChannel(input.channelId);
  if (!channel || channel.archivedAt || channel.metadata?.autoName !== true || !input.body.trim()) return {};
  try {
    const { harness } = await input.port.decideFirstMessageLaunch({ channelId: channel.id, messageId: input.messageId,
      body: input.body, window: input.authorKind === "user" });
    return harness ? { harness } : {};
  } catch (error) {
    input.port.reportDiagnostic?.({ stage: "summon", channelId: channel.id, messageId: input.messageId,
      error: registrationRefusalCode(error) });
    return {};
  }
}

/**
 * Say a refused continuation out loud.
 *
 * `:reborn` and `:handoff:` are off the Launch pipeline, so a target that is
 * missing, deleted, already handed off or bound to a different Profile writes
 * no launch row, no rejection and no chip, and `xmatrix diagnose` cannot see it
 * either. Without this the whole refusal existed only as a notice count in a
 * log line, and the mention looked like nothing had happened at all.
 */
async function publishContinuationNotices(
  input: ProductAgentMentionOrchestrationInput,
  notices: readonly string[],
): Promise<void> {
  if (!input.port.publishSystemNotice) return;
  for (const notice of notices) {
    try {
      await input.port.publishSystemNotice(input.channelId, notice);
    } catch (error) {
      input.port.reportDiagnostic?.({
        stage: "system_notice",
        channelId: input.channelId,
        messageId: input.messageId,
        error: error instanceof Error ? error.message : "system notice publication failed",
      });
      // These are refusal notices, not successful-spawn decoration. A failed
      // publication must remain an error to the caller, never a silent success.
      throw error;
    }
  }
}

async function orchestrateProductAgentRebornMentions(
  input: ProductAgentMentionOrchestrationInput,
  mentions: readonly ProductRebornInstanceMention[],
): Promise<ProductAgentMentionOrchestrationResult> {
  const notices: string[] = [];
  let spawned = 0;
  for (const mention of mentions) {
    const address = `@${mention.agentName}:${mention.channelInstanceId}`;
    let target: ProductRebornTarget | null;
    try {
      target = await input.port.getRebornTarget({ channelId: input.channelId,
        agentName: mention.agentName, channelInstanceId: mention.channelInstanceId });
    } catch (error) {
      input.port.reportDiagnostic?.({ stage: "summon", channelId: input.channelId,
        messageId: input.messageId, error: error instanceof Error ? error.message : "Reborn target lookup failed" });
      notices.push(`Reborn failed [reborn_target_lookup_failed] for ${address}. ` +
        "The original Instance could not be read or access was refused. No recovery was queued. Check the Instance and Channel access before retrying.");
      continue;
    }
    if (!target) {
      notices.push(`xMatrix could not find ${address} to reborn.`);
      continue;
    }
    if (target.channelId !== input.channelId || target.channelInstanceId !== mention.channelInstanceId) {
      notices.push(`xMatrix refused an invalid reborn target for ${address}.`);
      continue;
    }
    try {
      await input.port.prepareRegisteredReborn({ channelId: input.channelId,
        sourceInstanceId: target.instanceId, sourceMessageId: input.messageId,
        sourceMention: input.body.slice(mention.start, mention.end),
        prompt: promptWithoutProductRebornMentions(input.body, mentions) });
      spawned++;
    } catch (error) {
      const code = error && typeof error === "object" && typeof (error as { code?: unknown }).code === "string"
        ? (error as { code: string }).code : "registration_reborn_failed";
      notices.push(`Reborn failed [${code}] for ${address}. ` +
        "No recovery was queued. Check the Agent's registration and Channel access before retrying.");
    }
  }
  await publishContinuationNotices(input, notices);
  return { considered: mentions.length, spawned, notices };
}

async function orchestrateProductAgentHandoffMentions(
  input: ProductAgentMentionOrchestrationInput,
  mentions: readonly ProductHandoffInstanceMention[],
): Promise<ProductAgentMentionOrchestrationResult> {
  const resolveSource = input.port.getHandoffTarget?.bind(input.port) ??
    input.port.getRebornTarget.bind(input.port);
  const notices: string[] = [];
  let spawned = 0;
  for (const mention of mentions) {
    const address = `@${mention.sourceAgentName}:${mention.channelInstanceId}`;
    const target = await resolveSource({ channelId: input.channelId,
      agentName: mention.sourceAgentName, channelInstanceId: mention.channelInstanceId });
    if (!target) {
      notices.push(`xMatrix could not find ${address} to hand off.`);
      continue;
    }
    if (target.channelId !== input.channelId || target.channelInstanceId !== mention.channelInstanceId) {
      notices.push(`xMatrix refused an invalid handoff source for ${address}.`);
      continue;
    }
    // Management and direct-conversation directories belong to their purpose.
    const routedAs = metadataString(target.metadata, "routedAs");
    if (routedAs?.startsWith("management_") || routedAs === "direct_conversation") {
      notices.push(`xMatrix could not hand off ${address} to @${mention.successorName} (handoff_source_not_transferable).`);
      continue;
    }
    const auto = isAutoHandoffSuccessor(mention.successorName);
    const harness = auto ? undefined : agentPresetForLauncher(mention.successorName)?.id;
    if (!input.port.handOff || (!auto && !harness)) {
      notices.push(`xMatrix could not hand off ${address} to @${mention.successorName} (registration_handoff_failed).`);
      continue;
    }
    // A handoff is an ordinary launch: routing weighs every machine, with the
    // source's work site as its only location constraint.
    const repository = metadataString(target.metadata, "remoteRepo");
    const directory = !repository && !metadataString(target.metadata, "managedWorkspaceKey")
      ? target.workspace?.canonicalCwd : undefined;
    try {
      await input.port.handOff({
        commandId: `handoff-elsewhere:${await sha256Hex(`${input.messageId}:${target.instanceId}`)}`.slice(0, 200),
        actorUserId: input.actorUserId, channelId: input.channelId, sourceMessageId: input.messageId,
        sourceRunId: target.runId, sourceInstanceId: target.instanceId, sourceAddress: address,
        ...(repository ? { repository } : directory ? { directory } : {}), ...(harness ? { harness } : {}),
        request: promptWithoutProductHandoffMentions(input.body, mentions),
        sourceMention: input.body.slice(mention.start, mention.end),
      });
      spawned++;
    } catch (error) {
      const code = error && typeof error === "object" && typeof (error as { code?: unknown }).code === "string"
        ? (error as { code: string }).code : "registration_handoff_failed";
      notices.push(`xMatrix could not hand off ${address} to @${mention.successorName} (${code}).`);
    }
  }
  await publishContinuationNotices(input, notices);
  return { considered: mentions.length, spawned, notices };
}
