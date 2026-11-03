/**
 * Quotes in the composer are blocks of the draft (Daniel 2026-11-03: 引用嵌在正文里，有顺序，可以多个). The draft
 * stays text: a quote is its head (`> passage`, a blank line, `— [where it came from](link)`, a blank line) on the
 * lines where it was put, so it sends, saves and restores as the message it becomes, in order among whatever is
 * written around it. The editor draws each head as one yellow slip in place of its lines, which the caret steps
 * over and Backspace, Delete or its × remove whole.
 */
import { discussionHead, discussionHeadsIn, type DiscussionSource } from "@xmatrix/protocol";
import type { Node as DocNode } from "prosemirror-model";
import { Plugin, TextSelection, type EditorState, type Transaction } from "prosemirror-state";
import { Decoration, DecorationSet, type EditorView } from "prosemirror-view";
import { composerTextOf } from "./composer-editor-text";

/** A quote's lines in the document: paragraphs `first` to `last`, from before the first to after the last. */
type QuoteBlock = { first: number; last: number; from: number; to: number; quote: string; label: string; href: string };

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
    return { first, last, from: starts[first]!, to: starts[last + 1]!, quote: head.quote, label: head.label, href: head.href };
  });
}

/**
 * The draft with a quote put on the line after the caret's, or in place of the caret's line when that is empty,
 * and the caret on the line after it, where writing goes on.
 */
export function insertQuoteIntoDraft(draft: string, cursor: number, quote: string, source: DiscussionSource):
  { value: string; cursor: number } {
  const lines = draft.split("\n");
  const at = Math.max(0, draft.slice(0, Math.max(0, Math.min(cursor, draft.length))).split("\n").length - 1);
  const head = discussionHead(quote, source).split("\n");
  const blank = !lines[at];
  const index = blank ? at : at + 1;
  // The head ends in a line to write on; one already there after it takes its place.
  const block = !blank && index < lines.length ? head.slice(0, -1) : head;
  lines.splice(index, blank ? 1 : 0, ...block);
  const value = lines.join("\n");
  const caretLine = index + block.length - (block === head ? 1 : 0);
  const offset = lines.slice(0, caretLine).reduce((sum, line) => sum + line.length + 1, 0);
  return { value, cursor: Math.min(offset, value.length) };
}

/** Removes a quote's lines, leaving the caret where they were. */
function removeBlock(state: EditorState, block: QuoteBlock): Transaction {
  const end = Math.min(block.to, state.doc.content.size);
  const tr = state.tr.delete(block.from, end);
  if (!tr.doc.childCount) return tr;
  const at = Math.min(block.from, tr.doc.content.size);
  return tr.setSelection(TextSelection.near(tr.doc.resolve(Math.max(0, Math.min(at + 1, tr.doc.content.size)))));
}

function slip(view: EditorView, block: QuoteBlock, isHere: (href: string) => boolean): HTMLElement {
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
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "composer-quote-block-remove";
  remove.title = "Remove quote";
  remove.setAttribute("aria-label", "Remove quote");
  remove.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>';
  remove.addEventListener("mousedown", (event) => event.preventDefault());
  remove.addEventListener("click", () => {
    const current = quoteBlocksOf(view.state.doc).find((candidate) => candidate.from === block.from);
    if (current) view.dispatch(removeBlock(view.state, current));
    view.focus();
  });
  element.append(body, remove);
  return element;
}

/** The block whose lines hold `pos`, if any. */
function blockAt(blocks: QuoteBlock[], pos: number): QuoteBlock | undefined {
  return blocks.find((block) => pos > block.from && pos < block.to);
}

export function composerQuoteBlocks(isHere: () => (href: string) => boolean): Plugin {
  return new Plugin({
    props: {
      decorations(state) {
        const blocks = quoteBlocksOf(state.doc);
        if (!blocks.length) return DecorationSet.empty;
        const decorations: Decoration[] = [];
        for (const block of blocks) {
          decorations.push(Decoration.widget(block.from, (view) => slip(view, block, isHere()), {
            side: -1, ignoreSelection: true, stopEvent: () => true,
            key: `quote\u0000${block.quote}\u0000${block.label}\u0000${block.href}\u0000${isHere()(block.href)}`,
          }));
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
        const blocks = quoteBlocksOf(state.doc);
        if (!blocks.length) return false;
        const $pos = selection.$from;
        const atStart = $pos.parentOffset === 0;
        const atEnd = $pos.parentOffset === $pos.parent.content.size;
        const before = $pos.before();
        const after = $pos.after();
        const above = blocks.find((block) => block.to === before);
        const below = blocks.find((block) => block.from === after);
        if (event.key === "Backspace" && atStart && above) {
          view.dispatch(removeBlock(state, above).scrollIntoView());
          return true;
        }
        if (event.key === "Delete" && atEnd && below) {
          view.dispatch(state.tr.delete(below.from, Math.min(below.to, state.doc.content.size)));
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
      const blocks = quoteBlocksOf(state.doc);
      const block = blocks.length ? blockAt(blocks, state.selection.head) : undefined;
      if (!block) return null;
      const backwards = oldState.selection.head > state.selection.head && block.from > 0;
      const target = backwards ? block.from - 1 : Math.min(block.to + 1, state.doc.content.size);
      return state.tr.setSelection(TextSelection.near(state.doc.resolve(target), backwards ? -1 : 1));
    },
  });
}
