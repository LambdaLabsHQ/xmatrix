import { isAutoLaunchSummonText, type AgentInvocationSelection } from "@xmatrix/protocol";

const MENTION = /(^|\s)[@＠]([\p{L}\p{N}_.:-]+)/gu;

/** An Agent live on the page, as the page's Agent listing gives it. */
export interface CommentTaker { name: string; conversationId: string; blockId: string }

/**
 * Who takes a comment that names nobody: the Agent already at work on the page, nearest the passage first. It is
 * that very Instance, addressed in its own conversation, so only one the reader can write in is offered.
 */
export function commentTaker<Agent extends CommentTaker>(onPage: readonly Agent[], blockId: string,
  reachable: (conversationId: string) => boolean): Agent | undefined {
  return onPage.filter((agent) => reachable(agent.conversationId))
    .sort((a, b) => Number(b.blockId === blockId) - Number(a.blockId === blockId))[0];
}

/**
 * Address the existing Instance in its own conversation. Without one, continue the section's editing
 * conversation when known. Only an explicit new Agent, or a comment with neither destination, starts work
 * in a new discussion. An Agent picked from the box's `@` list (`selections`, measured against `text`), and an
 * `@auto` or condition summon, ask for a new one: such a comment goes as written, with its picks.
 */
export function commentBody<Agent extends CommentTaker>(text: string, agents: readonly string[], taker?: Agent,
  live: readonly Agent[] = [], conversationId?: string, selections: readonly AgentInvocationSelection[] = []):
  { body: string; selections?: AgentInvocationSelection[]; taker?: Agent; conversationId?: string } {
  if (selections.length) return { body: text, selections: [...selections] };
  for (const match of text.matchAll(MENTION)) {
    const name = match[2]!.toLowerCase();
    const start = match.index! + match[1]!.length;
    if (isAutoLaunchSummonText(text.slice(start))) return { body: text };
    const matches = (agent: Agent) => agent.name.toLowerCase() === name
      || (!name.includes(":") && agent.name.split(":")[0]!.toLowerCase() === name);
    const named = taker && matches(taker) ? taker : live.find(matches);
    if (named) {
      return { body: `${text.slice(0, start)}@${named.name}${text.slice(match.index! + match[0].length)}`, taker: named };
    }
    if (agents.some((agent) => agent.toLowerCase() === name.split(":")[0])) return { body: text };
  }
  return taker ? { body: `@${taker.name} ${text}`, taker }
    : conversationId ? { body: text, conversationId } : { body: `@auto ${text}` };
}
