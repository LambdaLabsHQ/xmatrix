import * as Y from "yjs";

/**
 * Sessions kept by an earlier version could hold a committed Agent edit whose words were still being
 * typed into the live text. Committed edits now reach the live text whole (pages-live-document.md §2);
 * a session restored with such leftovers puts the rest of those words in at once, around people's
 * uncommitted edits, so what was not typed yet is never read as a person's deletion.
 */

/** The blocks whose text an Agent's words go into. */
const TEXT_BLOCKS = new Set(["paragraph", "heading", "code_block", "table_cell", "table_header"]);

interface StoredWord { text: string; attrs: Record<string, unknown> }

/** The typing an earlier session stored: each run's place and the words it still had to type there. */
export interface PageStoredTypingState { runs: Array<{ at: unknown; words: StoredWord[] }> }

/** Whether `type` is still in the document: neither it nor anything holding it was removed. */
function inDocument(type: Y.AbstractType<unknown>): boolean {
  for (let item = type._item; item; item = item.parent instanceof Y.AbstractType ? item.parent._item : null) {
    if (item.deleted) return false;
  }
  return true;
}

/** The text a run's next word goes into, and where in it: the block's own text, made when it has none. */
function place(doc: Y.Doc, at: Y.RelativePosition): { text: Y.XmlText; index: number } | null {
  const position = Y.createAbsolutePositionFromRelativePosition(at, doc);
  if (!position || !inDocument(position.type)) return null;
  const { type, index } = position;
  if (type instanceof Y.XmlText) return { text: type, index };
  if (!(type instanceof Y.XmlElement) || !TEXT_BLOCKS.has(type.nodeName)) return null;
  const before = index > 0 ? type.get(index - 1) : null;
  if (before instanceof Y.XmlText) return { text: before, index: before.length };
  const after = index < type.length ? type.get(index) : null;
  if (after instanceof Y.XmlText) return { text: after, index: 0 };
  const text = new Y.XmlText();
  type.insert(index, [text]);
  return { text, index: 0 };
}

/** Puts every word a stored typing still held into `doc`, in one transaction. A run whose place is gone is given up. */
export function finishStoredTyping(doc: Y.Doc, state: PageStoredTypingState, origin: unknown): void {
  doc.transact(() => {
    for (const run of state.runs) {
      if (!run.words.length) continue;
      const at = place(doc, Y.createRelativePositionFromJSON(run.at));
      if (!at) continue;
      let index = at.index;
      // Each word with exactly its own marks; a fresh attribute object, so Yjs clears what it does not carry.
      for (const word of run.words) {
        at.text.insert(index, word.text, { ...word.attrs });
        index += word.text.length;
      }
    }
  }, origin);
}
