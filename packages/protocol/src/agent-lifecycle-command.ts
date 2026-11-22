import { INTERACTION_CONDITION_FIELDS_SOURCE, MESSAGE_INTERACTION_LIMITS, matchInteractionGrammar } from "./message-interaction-grammar.js";
import { AGENT_NAME_PATTERN, AGENT_NAME_SOURCE, isAutoHandoffSuccessor, parseHandoffInstanceTarget } from "./agent-mention.js";
import { isConditionSummonText, parseConditionSummon, parseLaunchConditions,
  type AutoLaunchCondition, type AutoLaunchTags } from "./agent-auto-mention.js";
import { agentPresetForLauncher } from "./agent-presets.js";
import { filterOperationalMentions } from "./operational-mention-context.js";

export interface RebornInstanceMention {
  /** Original `@`-less target text including `:<ordinal>:reborn`. */
  target: string;
  agentName: string;
  channelInstanceId: number;
  start: number;
  end: number;
}

export interface HandoffInstanceMention {
  /** Original `@`-less target text including `:<ordinal>:handoff:@<successor>`. */
  target: string;
  sourceAgentName: string;
  channelInstanceId: number;
  successorName: string;
  start: number;
  /** End of the whole handoff mention, including any trailing launch conditions. */
  end: number;
  /** Offset of the successor `@` immediately after `:handoff:`. */
  successorStart: number;
  /** End of the `:handoff:@<successor>` head before trailing space-separated conditions. */
  headEnd: number;
  /** True when the successor opens with a condition (`:handoff:@machine:Laptop`). */
  conditionFirst: boolean;
  /** Parsed launch conditions (both condition-first and trailing `key:value` words). */
  tags: AutoLaunchTags;
  /** Where each `key:value` condition sits in the body (UTF-16 offsets). */
  conditions: AutoLaunchCondition[];
  /** Present when launch conditions are malformed or conflict with the successor harness. */
  error?: string;
}

const CONDITION_HANDOFF_PREFIX = new RegExp(
  `(?:^|[\\s([{])([@＠](${AGENT_NAME_SOURCE}):([1-9]\\d{0,15}):handoff:)(?=[@＠](?:${INTERACTION_CONDITION_FIELDS_SOURCE}):)`,
  "giu",
);

/** Lifecycle syntax is read from the same data table as runtime commands. */
export function parseRebornInstanceMentions(body: string): RebornInstanceMention[] {
  return filterOperationalMentions(body, matchInteractionGrammar("lifecycle.reborn.v1", body))
    .flatMap(match => {
      const channelInstanceId = Number(match.arguments.ordinal);
      return Number.isSafeInteger(channelInstanceId) ? [{ target: body.slice(match.start + 1, match.end),
        agentName: match.arguments.agent!, channelInstanceId, start: match.start, end: match.end }] : [];
    });
}

export function parseHandoffInstanceMentions(body: string): HandoffInstanceMention[] {
  if (body.length > MESSAGE_INTERACTION_LIMITS.bodyLength) return [];
  type Candidate = { start: number; sourceAgentName: string; channelInstanceId: number; successorStart: number; headEnd?: number };
  const byStart = new Map<number, Candidate>();
  for (const match of matchInteractionGrammar("lifecycle.handoff.v1", body)) {
    const channelInstanceId = Number(match.arguments.ordinal);
    const sourceAgentName = match.arguments.agent!;
    const successor = match.arguments.successor!;
    if (!Number.isSafeInteger(channelInstanceId)) continue;
    byStart.set(match.start, { start: match.start, sourceAgentName, channelInstanceId,
      successorStart: match.end - successor.length - 1, headEnd: match.end });
  }
  for (const match of body.matchAll(CONDITION_HANDOFF_PREFIX)) {
    const start = match.index! + match[0].length - match[1]!.length;
    if (byStart.has(start)) continue;
    const channelInstanceId = Number(match[3]);
    if (!Number.isSafeInteger(channelInstanceId)) continue;
    byStart.set(start, { start, sourceAgentName: match[2]!, channelInstanceId, successorStart: match.index! + match[0].length });
  }
  const mentions: HandoffInstanceMention[] = [];
  let consumedUntil = 0;
  for (const candidate of [...byStart.values()].sort((left, right) => left.start - right.start)) {
    if (candidate.start < consumedUntil) continue;
    if (!AGENT_NAME_PATTERN.test(candidate.sourceAgentName) || candidate.sourceAgentName.toLowerCase() === "xmatrix") continue;
    if (isConditionSummonText(body.slice(candidate.successorStart))) {
      const parsed = parseConditionSummon(body, candidate.successorStart);
      if (!parsed) continue;
      const headEnd = parsed.conditions[0]!.end;
      mentions.push({ target: body.slice(candidate.start + 1, headEnd), sourceAgentName: candidate.sourceAgentName,
        channelInstanceId: candidate.channelInstanceId, successorName: parsed.tags.harness ?? "auto",
        start: candidate.start, end: parsed.end, successorStart: candidate.successorStart, headEnd,
        conditionFirst: true, tags: parsed.tags, conditions: parsed.conditions,
        ...(parsed.error ? { error: parsed.error } : {}) });
      consumedUntil = parsed.end;
      continue;
    }
    if (candidate.headEnd === undefined) continue;
    const target = parseHandoffInstanceTarget(body.slice(candidate.start + 1, candidate.headEnd));
    if (!target) continue;
    const parsed = parseLaunchConditions(body, candidate.headEnd);
    const auto = isAutoHandoffSuccessor(target.successorName);
    const harness = auto ? undefined : agentPresetForLauncher(target.successorName)?.id;
    const error = parsed.error ?? (harness && parsed.tags.harness && parsed.tags.harness !== harness
      ? "The harness condition conflicts with the addressed Agent." : undefined);
    mentions.push({ ...target, start: candidate.start, end: parsed.end,
      successorStart: candidate.successorStart, headEnd: candidate.headEnd,
      conditionFirst: false, tags: parsed.tags, conditions: parsed.conditions,
      ...(error ? { error } : {}) });
    consumedUntil = parsed.end;
  }
  return filterOperationalMentions(body, mentions);
}
