export type MessageDisplaySenderKind = "agent" | "system" | "user" | string | undefined;

const ESCAPED_NEWLINE_SEQUENCE = /\\r\\n|\\n|\\r/g;
const ESCAPED_PARAGRAPH_BREAK = /(?:\\r\\n|\\n|\\r){2,}/;

export function normalizeMessageBodyForDisplay(
  body: string,
  senderKind?: MessageDisplaySenderKind
): string {
  if (!body || (senderKind !== "agent" && senderKind !== "system")) return body;
  if (!shouldDecodeEscapedNewlines(body)) return body;
  return body.replace(ESCAPED_NEWLINE_SEQUENCE, "\n");
}

function shouldDecodeEscapedNewlines(body: string): boolean {
  if (body.includes("\n") || body.includes("\r")) return false;
  if (ESCAPED_PARAGRAPH_BREAK.test(body)) return true;
  const escapedLineBreaks = body.match(ESCAPED_NEWLINE_SEQUENCE);
  return Boolean(escapedLineBreaks && escapedLineBreaks.length >= 2);
}
