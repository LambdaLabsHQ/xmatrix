import { splitDiscussionHead } from "./discussion-head.js";

/**
 * A conversation's name until xMatrix names it from what it is about: the
 * first line of what its first message says, without addresses or markup. A
 * discussion's first message says what was written after the passage it
 * quotes, so the passage never names it.
 */
export function automaticConversationName(body: string): string {
  const head = splitDiscussionHead(body);
  const said = head?.rest.trim() ? head.rest : body;
  const line = said.split("\n").map((value) => value
    .replace(/[@＠][^\s]+/gu, "")
    .replace(/[`*_#>[\]()]/gu, "")
    .replace(/\s+/gu, " ")
    .trim()).find(Boolean) ?? "";
  if (line.length <= 60) return line || "New conversation";
  const cut = line.slice(0, 60);
  const space = cut.lastIndexOf(" ");
  return `${space > 30 ? cut.slice(0, space) : cut}…`;
}
