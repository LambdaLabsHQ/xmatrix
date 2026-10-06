import type { ConnectorActionStatement } from "../provider";

/* Shared validation for action statements: bounded targets and text. */

export const MAX_ACTION_TEXT = 4_000;

export function requireText(statement: ConnectorActionStatement): string | undefined {
  const value = statement.text.trim();
  return value && value.length <= MAX_ACTION_TEXT ? value : undefined;
}


/** The first line as a title and the rest as a body. */
export function titleAndBody(value: string): { title: string; body: string } {
  const [title = "", ...rest] = value.split(/\r?\n/u);
  return { title: title.trim().slice(0, 250), body: rest.join("\n").trim() };
}

/** Jira and Linear normalize a validated issue key before posting a comment. */
export function parseIssueComment(statement: ConnectorActionStatement, issue: RegExp, example: string) {
  if (!issue.test(statement.target)) return `name an issue: ${example}`;
  const text = requireText(statement);
  return text ? { issue: statement.target.toUpperCase(), text } : "write the comment after the issue";
}

/** Fence retrieved content so it cannot inject receipt formatting. */
export function quoteRetrievedText(value: string): string {
  const longest = (character: "`" | "~") => Math.max(0, ...Array.from(value.matchAll(
    character === "`" ? /`+/gu : /~+/gu), match => match[0].length));
  const backticks = longest("`");
  const tildes = longest("~");
  const fence = (backticks <= tildes ? "`" : "~").repeat(Math.max(3, Math.min(backticks, tildes) + 1));
  return `${fence}\n${value}\n${fence}`;
}
