/*
 * The Hub publishes a connector result as `<summary> — <url>` (connector-commands.ts, index-routes-connector-call.ts).
 * When the summary ends in a fenced block, that link lands on the closing fence, which then no longer closes it, and
 * the whole result reads as one run of code. The Web takes the trailing link off and draws it as its own action.
 */

export interface ConnectorResultLink { href: string; host: string }

const TRAILING_LINK = /[ \t]+—[ \t]+(https:\/\/[^\s<>]+)[ \t]*$/u;

export function splitConnectorResult(detail: string): { body: string; link?: ConnectorResultLink } {
  const match = TRAILING_LINK.exec(detail);
  if (!match) return { body: detail };
  let host: string;
  try { host = new URL(match[1]!).host; } catch { return { body: detail }; }
  return { body: detail.slice(0, match.index).trimEnd(), link: { href: match[1]!, host } };
}
