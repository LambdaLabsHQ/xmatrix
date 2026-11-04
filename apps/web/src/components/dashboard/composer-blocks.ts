/**
 * Quotes and pictures in the composer are blocks of the draft (Daniel 2026-11-03: 嵌在正文里，有顺序，可以多个，
 * 一行可以多个). The draft stays text: a quote is its head (`> passage`, a blank line, `— [where it came from](link)`,
 * a blank line), a picture a line naming its attachment (inline-attachments.ts), each on the lines where it was
 * put, so a draft sends, saves and restores as the message it becomes, in order among whatever is written around
 * it. The editor draws each quote as one yellow slip and each run of picture lines as one row of pictures in place
 * of their lines; the caret steps over a block, and Backspace or Delete beside it, or its ×, removes a quote whole
 * or the picture next to the caret.
 */
import { discussionHead, discussionHeadsIn, type DiscussionSource } from "@xmatrix/protocol";
import type { Node as DocNode } from "prosemirror-model";
import { Plugin, TextSelection, type EditorState, type Transaction } from "prosemirror-state";
import { Decoration, DecorationSet, type EditorView } from "prosemirror-view";
import { composerTextOf } from "./composer-editor-text";
import { pictureOfLine, putBlockInDraft } from "./inline-attachments";


/** A quote's lines in the document: paragraphs `first` to `last`, from before the first to after the last. */
type QuoteBlock = { kind: "quote"; first: number; last: number; from: number; to: number; quote: string; label: string; href: string };
/** A run of picture lines, one row of pictures; each picture with its line's span. */
type PictureRow = { kind: "pictures"; first: number; last: number; from: number; to: number;
  pictures: { ref: string; name: string; from: number; to: number }[] };
type Block = QuoteBlock | PictureRow;

/** The quotes a draft holds, in order. */
export function quoteBlocksOf(doc: DocNode): QuoteBlock[] {
  const text = composerTextOf(doc);
  const heads = discussionHeadsIn(text);
  if (!heads.length) return [];
  const lineAt = (offset: number) => text.slice(0, offset).split("\n").length - 1;
  const starts: number[] = [];
  let pos = 0;
  doc.forEach((paragraph) => {
    starts.push(pos);
    pos += paragraph.nodeSize;
  });
  starts.push(pos);
  return heads.map((head) => {
    const first = lineAt(head.start);
    // A head ends in the blank line after its source; one at the very end of the draft, in its source line.
    const last = Math.min(lineAt(Math.max(head.start, head.end - 1)), doc.childCount - 1);
    return { kind: "quote" as const, first, last, from: starts[first]!, to: starts[last + 1]!, quote: head.quote,
      label: head.label, href: head.href };
  });
}

/** The draft's quotes and rows of pictures, in order. */
export function blocksOf(doc: DocNode): Block[] {
  const quotes = quoteBlocksOf(doc);
  const rows: PictureRow[] = [];
  let pos = 0;
  doc.forEach((paragraph, _offset, line) => {
    const from = pos;
    pos += paragraph.nodeSize;
    if (quotes.some((quote) => line >= quote.first && line <= quote.last)) return;
    const picture = pictureOfLine(paragraph.textContent);
    if (!picture) return;
    const last = rows.at(-1);
    const entry = { ...picture, from, to: pos };
    if (last && last.last === line - 1) {
      last.last = line;
      last.to = pos;
      last.pictures.push(entry);
    } else rows.push({ kind: "pictures", first: line, last: line, from, to: pos, pictures: [entry] });
  });
  return [...quotes, ...rows].sort((a, b) => a.from - b.from);
}

/** The draft with a quote put as a block on the line after the caret's, where writing goes on after it. */
export function insertQuoteIntoDraft(draft: string, cursor: number, quote: string, source: DiscussionSource):
  { value: string; cursor: number } {
  // The head ends in the line to write on, which the block's placing makes when it is needed.
  return putBlockInDraft(draft, cursor, discussionHead(quote, source).split("\n").slice(0, -1));
}

/** Removes a quote's lines, leaving the caret where they were. */
function removeBlock(state: EditorState, block: { from: number; to: number }): Transaction {
  const end = Math.min(block.to, state.doc.content.size);
  const tr = state.tr.delete(block.from, end);
  // The draft keeps a line to write on.
  if (!tr.doc.childCount || tr.doc.content.size === 0) return tr;
  if (!tr.doc.childCount) return tr;
  const at = Math.min(block.from, tr.doc.content.size);
  return tr.setSelection(TextSelection.near(tr.doc.resolve(Math.max(0, Math.min(at + 1, tr.doc.content.size)))));
}

function removeButton(label: string, onRemove: () => void): HTMLButtonElement {
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "composer-quote-block-remove";
  remove.title = label;
  remove.setAttribute("aria-label", label);
  remove.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>';
  remove.addEventListener("mousedown", (event) => event.preventDefault());
  remove.addEventListener("click", onRemove);
  return remove;
}

/** Where the composer draws a picture of the draft, with everything its attachment offers (composer-editor.tsx). */
export type PictureSlots = { add(element: HTMLElement, ref: string): void; remove(element: HTMLElement): void };

/** A row of the draft's pictures: a place for each, which the composer fills with its attachment's card. */
function pictureRow(row: PictureRow, slots: PictureSlots): HTMLElement {
  const element = document.createElement("div");
  element.className = "composer-picture-row";
  element.contentEditable = "false";
  for (const picture of row.pictures) {
    const slot = document.createElement("span");
    slot.className = "composer-picture";
    slot.dataset.testid = "composer-picture";
    slot.dataset.ref = picture.ref;
    slots.add(slot, picture.ref);
    element.append(slot);
  }
  return element;
}

function slip(view: EditorView, block: QuoteBlock, isHere: (href: string) => boolean,
  getPos: () => number | undefined): HTMLElement {
  const element = document.createElement("div");
  element.className = "message-citation-composer composer-quote-block";
  element.contentEditable = "false";
  element.dataset.testid = "composer-quote";
  const body = document.createElement("div");
  body.className = "composer-quote-block-body";
  const words = document.createElement("div");
  words.className = "composer-quote-block-text";
  words.textContent = block.quote;
  body.append(words);
  // A quote of this conversation is its own reference; one from elsewhere says where it came from.
  if (!isHere(block.href)) {
    const source = document.createElement("div");
    source.className = "message-citation-source";
    source.textContent = block.label;
    body.append(source);
  }
  element.append(body, removeButton("Remove quote", () => {
    // Widgets survive edits before them; their captured block coordinates do
    // not. The editor owns the widget's current position, including duplicates.
    const current = quoteBlocksOf(view.state.doc).find((candidate) => candidate.from === getPos());
    if (current) view.dispatch(removeBlock(view.state, current));
    view.focus();
  }));
  return element;
}

/**
 * Where the caret is: the browser's own when it has just moved it (Home, a click) and the editor has not read it
 * back yet, so a key right after acts where the reader sees the caret.
 */
function caretPos(view: EditorView): number {
  const selection = view.dom.ownerDocument.getSelection();
  if (selection?.isCollapsed && selection.anchorNode && view.dom.contains(selection.anchorNode)) {
    try {
      return view.posAtDOM(selection.anchorNode, selection.anchorOffset);
    } catch {
      return view.state.selection.from;
    }
  }
  return view.state.selection.from;
}

/** The block whose lines hold `pos`, if any. */
function blockAt(blocks: Block[], pos: number): Block | undefined {
  return blocks.find((block) => pos > block.from && pos < block.to);
}

export function composerBlocks(isHere: () => (href: string) => boolean, slots: PictureSlots): Plugin {
  return new Plugin({
    props: {
      decorations(state) {
        const blocks = blocksOf(state.doc);
        if (!blocks.length) return DecorationSet.empty;
        const decorations: Decoration[] = [];
        for (const block of blocks) {
          if (block.kind === "quote") {
            decorations.push(Decoration.widget(block.from, (view, getPos) => slip(view, block, isHere(), getPos), {
              side: -1, ignoreSelection: true, stopEvent: () => true,
              key: `quote\u0000${block.quote}\u0000${block.label}\u0000${block.href}\u0000${isHere()(block.href)}`,
            }));
          } else {
            decorations.push(Decoration.widget(block.from, () => pictureRow(block, slots), {
              side: -1, ignoreSelection: true, stopEvent: () => true,
              key: `pictures\u0000${block.pictures.map((picture) => picture.ref).join("\u0000")}`,
              destroy: (node) => {
                for (const slot of (node as HTMLElement).querySelectorAll<HTMLElement>(".composer-picture")) slots.remove(slot);
              },
            }));
          }
          let pos = block.from;
          for (let line = block.first; line <= block.last; line += 1) {
            const paragraph = state.doc.child(line);
            decorations.push(Decoration.node(pos, pos + paragraph.nodeSize, { class: "composer-quote-line" }));
            pos += paragraph.nodeSize;
          }
        }
        return DecorationSet.create(state.doc, decorations);
      },
      handleKeyDown(view, event) {
        const { state } = view;
        const { selection } = state;
        if (!selection.empty || event.metaKey || event.ctrlKey || event.altKey) return false;
        const blocks = blocksOf(state.doc);
        if (!blocks.length) return false;
        const $pos = state.doc.resolve(caretPos(view));
        const atStart = $pos.parentOffset === 0;
        const atEnd = $pos.parentOffset === $pos.parent.content.size;
        const before = $pos.before();
        const after = $pos.after();
        const above = blocks.find((block) => block.to === before);
        const below = blocks.find((block) => block.from === after);
        // A quote goes whole; of a row of pictures, the one beside the caret.
        if (event.key === "Backspace" && atStart && above) {
          view.dispatch(removeBlock(state, above.kind === "pictures" ? above.pictures.at(-1)! : above).scrollIntoView());
          return true;
        }
        if (event.key === "Delete" && atEnd && below) {
          const gone = below.kind === "pictures" ? below.pictures[0]! : below;
          view.dispatch(state.tr.delete(gone.from, Math.min(gone.to, state.doc.content.size)));
          return true;
        }
        // The caret steps over a quote's lines, as over one block.
        const step = (target: number) => {
          view.dispatch(state.tr.setSelection(TextSelection.near(state.doc.resolve(target))).scrollIntoView());
          return true;
        };
        if ((event.key === "ArrowUp" || (event.key === "ArrowLeft" && atStart)) && above) {
          return above.from > 0 ? step(above.from - 1) : step(above.to + 1);
        }
        if ((event.key === "ArrowDown" || (event.key === "ArrowRight" && atEnd)) && below
          && below.to < state.doc.content.size) {
          return step(below.to + 1);
        }
        return false;
      },
    },
    // A caret that still lands among a quote's lines (a click, the browser's own movement) goes past it, the way
    // it was going.
    appendTransaction(_transactions, oldState, state) {
      const blocks = blocksOf(state.doc);
      const block = blocks.length ? blockAt(blocks, state.selection.head) : undefined;
      if (!block) return null;
      const backwards = oldState.selection.head > state.selection.head && block.from > 0;
      const target = backwards ? block.from - 1 : Math.min(block.to + 1, state.doc.content.size);
      return state.tr.setSelection(TextSelection.near(state.doc.resolve(target), backwards ? -1 : 1));
    },
  });
}
