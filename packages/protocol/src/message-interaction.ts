import type { AutoLaunchMention } from "./agent-auto-mention.js";
import type { SerializedFirstMessageLaunchChoice } from "./agent-launch.js";
import { agentAvatarUrlFromMetadata } from "./authority-foundation.js";
import { parseAutoLaunchMentions, hasRetiredAgentLaunchMention } from "./agent-auto-mention.js";
import { parseAgentControlCommands, type AgentControlCommand } from "./agent-control-command.js";
import { parseRebornInstanceMentions, parseHandoffInstanceMentions,
  type RebornInstanceMention, type HandoffInstanceMention } from "./agent-lifecycle-command.js";
import { parseAgentStopCommand, type AgentStopCommand } from "./agent-stop-command.js";
import { mentionAddressTokens, scanMentionAddresses } from "./mention-address.js";
import { filterOperationalMentions } from "./operational-mention-context.js";
import { MESSAGE_INTERACTION_LIMITS } from "./message-interaction-grammar.js";
export type InteractionTargetKind = "human" | "broadcast" | "agent" | "instance" | "router" | "connector" | "service";
export type InteractionExecutionContract = "attention.v1" | "registration-launch.v1" | "runtime-control.v1" |
  "runtime-lifecycle.v1" | "connector-command.v1";
export type InteractionPresentationRef = "mention.v1" | "launch.v1" | "handoff.v1" | "reborn.v1" |
  "stop.v1" | "runtime-control.v1" | "connector.v1" | "launch-choice.v1";

export interface InteractionOperationDescriptor {
  id: string;
  syntaxRefs: readonly string[];
  inputSchemaRef: string;
  executionContract: InteractionExecutionContract;
  presentationRef: InteractionPresentationRef;
}

/** A projection of domain identities and capabilities, never an access grant. */
export interface InteractionTargetDescriptor {
  schemaVersion: 1;
  descriptorRevision: string;
  targetId: string;
  kind: InteractionTargetKind;
  aliases: readonly string[];
  operations: readonly InteractionOperationDescriptor[];
}

export interface InteractionLaunchOption {
  optionId: string;
  targetId: string;
  descriptorRevision: string;
  operationId: "launch";
  harness: string;
  /** What the option shows: its name and the icon that names its harness. */
  displayName: string;
  iconRef?: string;
  /** Explicit to prevent a new catalog entry from enabling paid consumption. */
  funding: { kind: "owner-subscription" } | { kind: "service"; serviceId: string; catalogRevision: string };
}

export interface InteractionDecisionWindow {
  schemaVersion: 1;
  choiceId: string;
  messageId: string;
  deadlineAt: string;
  /** The Hub's own clock says the author may still choose. */
  open?: boolean;
  presentationRef: "launch-choice.v1";
  options: readonly InteractionLaunchOption[];
  recommendation?: string | null;
  decision?: { optionId: string | null; by: "author" | "jev"; at: string };
  /** Jev could not read the message, so nothing was decided. */
  failureCode?: string;
}

/** A launch option for a harness the reader may start in this Space; its icon is the harness preset's. */
export function harnessLaunchOption(harness: string, displayName = harness): InteractionLaunchOption {
  const iconRef = agentAvatarUrlFromMetadata({ presetId: harness }, harness);
  return { optionId: harness, targetId: `harness:${harness}`, descriptorRevision: "registration-catalog",
    operationId: "launch", harness, displayName, ...(iconRef ? { iconRef } : {}), funding: { kind: "owner-subscription" } };
}

/**
 * A first message's launch choice as the decision window it presents
 * (`launch-choice.v1`). `options` are what the reader may start; a recommended
 * or decided harness outside them is added, so the window always shows what
 * Jev or the author picked.
 */
export function firstMessageDecisionWindow(choice: SerializedFirstMessageLaunchChoice,
  options: readonly InteractionLaunchOption[]): InteractionDecisionWindow {
  const known = new Map(options.map(option => [option.harness, option]));
  const add = (harness: string) => { if (!known.has(harness)) known.set(harness, harnessLaunchOption(harness)); };
  if (choice.recommendation?.start) add(choice.recommendation.harness);
  if (choice.choice?.start) add(choice.choice.harness);
  const listed = [...known.values()];
  const recommended = choice.recommendation?.start ? known.get(choice.recommendation.harness)?.optionId : undefined;
  const decided = choice.choice;
  return {
    schemaVersion: 1, choiceId: `${choice.channelId}:${choice.messageId}`, messageId: choice.messageId,
    deadlineAt: choice.deadlineAt, ...(choice.open !== undefined ? { open: choice.open } : {}),
    presentationRef: "launch-choice.v1", options: listed,
    ...(choice.recommendation ? { recommendation: recommended ?? null } : {}),
    ...(decided ? { decision: { optionId: decided.start ? known.get(decided.harness)!.optionId : null,
      by: decided.by, at: decided.at } } : {}),
    ...(choice.failureCode ? { failureCode: choice.failureCode } : {}),
  };
}

export interface ParsedMessageInteraction {
  schemaVersion: 1;
  refused?: "message_too_long" | "retired_launch_syntax";
  stop?: AgentStopCommand;
  controls: AgentControlCommand[];
  reborn: RebornInstanceMention[];
  handoff: HandoffInstanceMention[];
  launches: AutoLaunchMention[];
  mentions: Array<{ start: number; end: number; token: string }>;
}

/** One interpretation plan for all message entry points. A handoff consumes
 * its successor; whole-message controls never become an additional launch.
 * Domain adapters retain their existing idempotency keys and authorization. */
export function parseMessageInteraction(body: string, aliases: readonly string[] = []): ParsedMessageInteraction {
  const empty: ParsedMessageInteraction = { schemaVersion: 1, controls: [], reborn: [], handoff: [], launches: [], mentions: [] };
  if (body.length > MESSAGE_INTERACTION_LIMITS.bodyLength) return { ...empty, refused: "message_too_long" };
  if (hasRetiredAgentLaunchMention(body)) return { ...empty, refused: "retired_launch_syntax" };
  const stop = parseAgentStopCommand(body);
  if (stop) return { ...empty, stop };
  const controls = parseAgentControlCommands(body);
  if (controls.length) return { ...empty, controls };
  const handoff = parseHandoffInstanceMentions(body);
  const reborn = parseRebornInstanceMentions(body);
  const owned = [...handoff, ...reborn];
  const outside = (span: { start: number; end: number }) => !owned.some(other => span.start >= other.start && span.start < other.end);
  return { ...empty, handoff, reborn,
    launches: parseAutoLaunchMentions(body).filter(outside),
    mentions: filterOperationalMentions(body, scanMentionAddresses(body, mentionAddressTokens(aliases))).filter(outside) };
}
