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
 * in a new discussion.
 */
export function commentBody<Agent extends CommentTaker>(text: string, agents: readonly string[], taker?: Agent,
  live: readonly Agent[] = [], conversationId?: string): { body: string; taker?: Agent; conversationId?: string } {
  for (const match of text.matchAll(MENTION)) {
    const name = match[2]!.toLowerCase();
    const matches = (agent: Agent) => agent.name.toLowerCase() === name
      || (!name.includes(":") && agent.name.split(":")[0]!.toLowerCase() === name);
    const named = taker && matches(taker) ? taker : live.find(matches);
    if (named) {
      const start = match.index! + match[1]!.length;
      return { body: `${text.slice(0, start)}@${named.name}${text.slice(match.index! + match[0].length)}`, taker: named };
    }
    if (!agents.some((agent) => agent.toLowerCase() === name.split(":")[0])) continue;
    const end = match.index! + match[0].length;
    return { body: `${text.slice(0, end)} launch:force${text.slice(end)}` };
  }
  return taker ? { body: `@${taker.name} ${text}`, taker }
    : conversationId ? { body: text, conversationId } : { body: `@auto ${text}` };
}
