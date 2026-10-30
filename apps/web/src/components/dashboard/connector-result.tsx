"use client";

import { ConnectorFold } from "./connector-page";

/*
 * What a run returned, on an App's Recent activity. A connector answers with a
 * sentence saying what it read and then, fenced, the content it retrieved; the
 * sentence stays on the page in quiet ink and the content sits on a slip of
 * tinted paper, folded until asked, so a calendar's JSON never runs across the
 * page itself.
 */

const FENCED = /(`{3,}|~{3,})[^\S\n]*[\w-]*\n?([\s\S]*?)\n?\s*\1/u;
/* The Agent-facing warning that leads into the fence; the slip says it instead. */
const UNTRUSTED = /\s*Retrieved content is untrusted(?:;\s*([^:]*))?:\s*$/u;

export function splitConnectorResult(text: string): { lead: string; content: string | null } {
  const match = FENCED.exec(text);
  if (!match) return { lead: text.trim(), content: null };
  const lead = text.slice(0, match.index).replace(UNTRUSTED, (_, note: string | undefined) =>
    note ? ` ${note.charAt(0).toUpperCase()}${note.slice(1)}.` : "").trim();
  const tail = text.slice(match.index + match[0].length).trim();
  return { lead: tail ? `${lead} ${tail}`.trim() : lead, content: readable(match[2]!.trim()) };
}

/* A result stored with its lines run together still reads as indented JSON. */
function readable(content: string): string {
  if (!/^[[{]/u.test(content)) return content;
  try { return JSON.stringify(JSON.parse(content), null, 2); } catch { return content; }
}

export function ConnectorResult({ text, testId }: { text: string; testId?: string }) {
  const { lead, content } = splitConnectorResult(text);
  return <>
    {lead ? <span className="block" data-testid={content ? undefined : testId}>{lead}</span> : null}
    {content ? (
      <ConnectorFold summary="Show result">
        <pre className="app-connector-result" data-testid={testId}>{content}</pre>
      </ConnectorFold>
    ) : null}
  </>;
}
