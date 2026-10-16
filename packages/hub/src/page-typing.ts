import { pageDocBlockAt, type PageWritingRun } from "@xmatrix/protocol/page-document";
import type { Mark, Node as DocNode } from "prosemirror-model";
import { absolutePositionToRelativePosition, updateYFragment } from "y-prosemirror";
import * as Y from "yjs";

/**
 * An Agent typing its committed edit into the live page (pages-live-document.md §2), as a person
 * types: the edit's structure goes in first, whole (`pageWritingPlan`), and its words are then typed
 * into the document's text where they belong, a few at a time. Each step is a small CRDT insertion
 * anchored to the text around it, so people typing anywhere meanwhile, and other Agents typing their
 * own edits, merge with it as two people's keystrokes do; no step reads or rewrites the whole page.
 */

/** The blocks whose text an Agent's words go into. */
const TEXT_BLOCKS = new Set(["paragraph", "heading", "code_block", "table_cell", "table_header"]);

interface TypedWord { text: string; attrs: Record<string, unknown> }
/** `from` is where the run's first word went: with `at`, the stretch it has typed so far. */
interface TypedRun { from: Y.RelativePosition; at: Y.RelativePosition; words: TypedWord[]; block: string; typed: boolean }

/** A typing as a session persists it, so a restart finishes it instead of leaving it half there. */
export interface PageTypingState { runs: Array<{ from?: unknown; at: unknown; words: TypedWord[]; block: string; typed?: boolean }> }

/** A mark as y-prosemirror keeps it on text: the page's marks each exclude themselves, so the name is the key. */
function markAttributes(marks: readonly Mark[]): Record<string, unknown> {
  return Object.fromEntries(marks.map((mark) => [mark.type.name, mark.attrs]));
}

/** Whether `type` is still in the document: neither it nor anything holding it was removed. */
function inDocument(type: Y.AbstractType<unknown>): boolean {
  for (let item = type._item; item; item = item.parent instanceof Y.AbstractType ? item.parent._item : null) {
    if (item.deleted) return false;
  }
  return true;
}

export class PageTyping {
  /** Every run, kept after it is typed out, for where the words went. */
  private readonly all: TypedRun[];

  private constructor(private readonly runs: TypedRun[]) {
    this.all = [...runs];
  }

  /**
   * Brings the live fragment to `start` with the smallest structural update, under `origin`, and
   * anchors each run's place in it, so the words still find their place whatever is typed around them.
   */
  static begin(fragment: Y.XmlFragment, start: DocNode, runs: readonly PageWritingRun[], origin: unknown): PageTyping {
    const doc = fragment.doc!;
    const meta = { mapping: new Map(), isOMark: new Map() };
    doc.transact(() => updateYFragment(doc, fragment, start, meta), origin);
    return new PageTyping(runs.map((run) => {
      const at = absolutePositionToRelativePosition(run.pos, fragment, meta.mapping);
      return { from: at, at, words: run.words.map((word) => ({ text: word.text, attrs: markAttributes(word.marks) })),
        block: pageDocBlockAt(start, run.pos), typed: false };
    }));
  }

  static restore(state: PageTypingState): PageTyping {
    return new PageTyping(state.runs.map((run) => {
      const at = Y.createRelativePositionFromJSON(run.at);
      return { from: run.from ? Y.createRelativePositionFromJSON(run.from) : at, at,
        words: run.words.map((word) => ({ ...word })), block: run.block, typed: run.typed === true };
    }));
  }

  toJSON(): PageTypingState {
    // A copy of the words: the state is kept while this typing goes on taking them.
    return { runs: this.runs.map((run) => ({ from: Y.relativePositionToJSON(run.from), at: Y.relativePositionToJSON(run.at),
      words: run.words.map((word) => ({ ...word })), block: run.block, typed: run.typed })) };
  }

  /** The same words still to type, apart from this one's, as a commit types them into a copy of the page. */
  copy(): PageTyping {
    return new PageTyping(this.runs.map((run) => ({ ...run, words: [...run.words] })));
  }

  /** Where it has typed so far, run by run: what the page marks as this Agent's while it is fresh. */
  wrote(): Array<{ from: Y.RelativePosition; to: Y.RelativePosition }> {
    return this.all.filter((run) => run.typed).map((run) => ({ from: run.from, to: run.at }));
  }

  /** How many words are still to type. */
  get remaining(): number {
    return this.runs.reduce((count, run) => count + run.words.length, 0);
  }

  /** Where the next word goes, and the section it is in: the Agent's caret while it types. */
  get caret(): { at: Y.RelativePosition; block: string; typed?: string } | null {
    const run = this.runs[0];
    return run ? { at: run.at, block: run.block } : null;
  }

  /**
   * Types the next `count` words into `doc` in one transaction, each right after the one before it in its
   * run, with exactly its own marks, and never stops right after a space while its run goes on: a line
   * ending in a space does not read back from Markdown as itself, and a session that rewrites the page
   * from Markdown (another Agent's edit) would take the space out. A run whose place someone removed
   * meanwhile is given up: its words have nowhere to go. Answers where the last word typed ends, and what
   * was typed.
   */
  type(doc: Y.Doc, count: number, origin: unknown): { at: Y.RelativePosition; block: string; typed: string } | null {
    let end: { at: Y.RelativePosition; block: string; typed: string } | null = null;
    let typed = "";
    doc.transact(() => {
      let spaced = false;
      while ((count > 0 || spaced) && this.runs.length) {
        const run = this.runs[0]!;
        const word = run.words[0];
        const place = word ? this.place(doc, run.at) : null;
        if (!word || !place) {
          this.runs.shift();
          spaced = false;
          continue;
        }
        run.words.shift();
        run.typed = true;
        // A fresh attribute object every time: Yjs completes it with the marks to clear, so none is inherited.
        place.text.insert(place.index, word.text, { ...word.attrs });
        // The next word sticks to this one, whatever anyone types right after it.
        run.at = Y.createRelativePositionFromTypeIndex(place.text, place.index + word.text.length, -1);
        typed += word.text;
        end = { at: run.at, block: run.block, typed };
        count--;
        spaced = !word.text.trim() && run.words.length > 0;
        if (!run.words.length) this.runs.shift();
      }
    }, origin);
    return end;
  }

  /** The text a run's next word goes into, and where in it: the block's own text, made when it has none. */
  private place(doc: Y.Doc, at: Y.RelativePosition): { text: Y.XmlText; index: number } | null {
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
}
