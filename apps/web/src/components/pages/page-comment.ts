const MENTION = /(^|\s)[@＠]([\p{L}\p{N}_.:-]+)/gu;

/**
 * A comment as its discussion's first message. An Agent it mentions starts on it at once. One that mentions nobody
 * goes to the kind of Agent already at work on the page (`onPage`, by name, nearest first), which knows it; with
 * none there, to xMatrix to give to one.
 */
export function commentBody(text: string, agents: readonly string[], onPage: readonly string[] = []): string {
  for (const match of text.matchAll(MENTION)) {
    if (!agents.includes(match[2]!.split(":")[0]!)) continue;
    const end = match.index! + match[0].length;
    return `${text.slice(0, end)} launch:force${text.slice(end)}`;
  }
  const working = onPage.map((name) => name.split(":")[0]!.trim().toLowerCase()).find((name) => agents.includes(name));
  return working ? `@${working} launch:force ${text}` : `@auto ${text}`;
}
