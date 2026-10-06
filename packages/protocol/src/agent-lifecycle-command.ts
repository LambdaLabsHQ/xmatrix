import { matchInteractionGrammar } from "./message-interaction-grammar.js";
import { parseHandoffInstanceTarget } from "./agent-mention.js";
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
  end: number;
}

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
  return filterOperationalMentions(body, matchInteractionGrammar("lifecycle.handoff.v1", body))
    .flatMap(match => {
      const parsed = parseHandoffInstanceTarget(body.slice(match.start + 1, match.end));
      return parsed ? [{ ...parsed, start: match.start, end: match.end }] : [];
    });
}
