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
 * A comment as its discussion's first message. An Agent it mentions starts on it at once. One that mentions nobody
 * goes to the Agent at work on the page (`taker`), which `commentCall` tells in its own conversation, where its
 * Instance lives; it answers in the discussion. With none there, xMatrix gives it to one.
 */
export function commentBody<Agent extends CommentTaker>(text: string, agents: readonly string[], taker?: Agent):
  { body: string; taker?: Agent } {
  for (const match of text.matchAll(MENTION)) {
    if (!agents.includes(match[2]!.split(":")[0]!)) continue;
    const end = match.index! + match[0].length;
    return { body: `${text.slice(0, end)} launch:force${text.slice(end)}` };
  }
  return taker ? { body: text, taker } : { body: `@auto ${text}` };
}

/** What calls the taker to the discussion of its comment. */
export function commentCall(taker: Pick<CommentTaker, "name">, discussionId: string): string {
  return `@${taker.name} A comment for you: channel:${discussionId}`;
}
