import type { PageMessageEdit } from "@xmatrix/protocol";

/**
 * What a new read of the page edits shows while it runs: the last read's edits for the messages still asked
 * about. The messages asked about change as the reader scrolls or a message arrives; without this every card
 * on screen would vanish until the new read answers, and come back when it does.
 */
export function heldPageMessageEdits(previous: { edits?: PageMessageEdit[] } | undefined,
  messageIds: readonly string[]): { edits: PageMessageEdit[] } | undefined {
  if (!previous?.edits?.length) return undefined;
  const asked = new Set(messageIds);
  const edits = previous.edits.filter((edit) => asked.has(edit.messageId));
  return edits.length ? { edits } : undefined;
}
