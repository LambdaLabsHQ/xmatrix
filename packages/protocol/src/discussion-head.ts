/**
 * A conversation started from a passage, of a page or of a message
 * (docs/design/pages-and-conversations.md §3.2), opens with what it discusses:
 * its first message is the passage quoted line by line, then
 * "— [where it came from](link)", then what was written. Agents read that head
 * as the conversation's context; a client that already shows the passage
 * elsewhere folds it away, and a preview shows what was written.
 */

/** Where a discussed passage came from: a page section or a message, by name and link. */
export interface DiscussionSource {
  label: string;
  href: string;
}

/** A discussion's first message, taken apart. */
export interface DiscussionHead extends DiscussionSource {
  /** The passage, as it was quoted. */
  quote: string;
  /** What was written after the head. */
  rest: string;
}

const HEAD = /^((?:>[^\n]*\n)*>[^\n]*)\n\n— \[((?:[^\]\\\n]|\\.)*)\]\((<[^<>\n]*>|[^\s()<>]+)\)(?:\n\n|\n?$)/u;

/** A link destination Markdown keeps whole: one with spaces or parentheses goes in angle brackets. */
function linkDestination(href: string): string {
  return /[\s()<>]/u.test(href) ? `<${href.replace(/[<>\n]/gu, encodeURIComponent)}>` : href;
}

/** The head a discussion's first message opens with, ending in the blank line before what is written. */
export function discussionHead(quote: string, source: DiscussionSource): string {
  const quoted = quote.split(/\r?\n/u).map((line) => (line.trim() ? `> ${line.trimEnd()}` : ">")).join("\n");
  const label = source.label.trim().replace(/\s+/gu, " ").replace(/[[\]\\]/gu, "\\$&") || "source";
  return `${quoted}\n\n— [${label}](${linkDestination(source.href)})\n\n`;
}

/** A discussion's first message split into its head and what was written; null for any other message. */
export function splitDiscussionHead(body: string): DiscussionHead | null {
  const match = HEAD.exec(body);
  if (!match) return null;
  const [head, quoted, label, destination] = match as unknown as [string, string, string, string];
  return {
    quote: quoted.split("\n").map((line) => line.replace(/^> ?/u, "")).join("\n"),
    label: label.replace(/\\([[\]\\])/gu, "$1"),
    href: destination.startsWith("<") ? destination.slice(1, -1) : destination,
    rest: body.slice(head.length),
  };
}
