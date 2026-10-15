import {
  PageCoWriteParser, pageBlocks, pageChangedBlocks, type PageCoWriteAction, type PageCoWriteEvent,
  type PageCoWriteReply, type PageCoWriteRequest,
} from "@xmatrix/protocol";
import { markdownToPageDoc, pageDocToMarkdown, pageSchema } from "@xmatrix/protocol/page-document";
import { Fragment, type Node as DocNode } from "prosemirror-model";
import { Selection } from "prosemirror-state";
import {
  absolutePositionToRelativePosition, initProseMirrorDoc, relativePositionToAbsolutePosition, updateYFragment,
} from "y-prosemirror";
import * as Y from "yjs";

/**
 * An Agent co-writing a page live (docs/design/pages-live-document.md §4.2),
 * as a person beside you in a shared document: present with a caret, it reads
 * the page as people write and, when they pause, answers in the page itself.
 * Its words go into the document as they come from its harness, through the
 * same CRDT as everyone's typing, under its own caret and colour.
 *
 * The session asks with a turn (what changed, who is typing where) and the
 * Agent's runtime streams its answer back; only the marked actions of
 * page-co-writing.ts reach the page. The Agent keeps out of the paragraph a
 * person is typing in, and stops the moment someone edits what it is writing.
 */

/** People pause this long before the Agent hears what changed. */
export const CO_WRITER_PAUSE_MS = 1_500;
/** After this many turns of changes alone, the Agent reads the whole page again. */
const FULL_PAGE_EVERY = 8;
/** More changed sections than this, and the Agent reads the whole page. */
const FULL_PAGE_CHANGES = 3;
const QUOTE_CONTEXT = 80;

export type PageCoWriterActivity = "watching" | "thinking" | "writing" | "waiting";

export interface PageCoWriterPerson {
  name: string;
  /** Where their caret is, when their editor shares one. */
  caret: Y.RelativePosition | null;
}

export interface PageCoWriterHost {
  readonly doc: Y.Doc;
  readonly fragment: Y.XmlFragment;
  /** The live document as markdown. */
  markdown(): string;
  /** Applies `change` as the Agent: the text it adds carries the Agent's id, and the edit is the Agent's. */
  write(change: () => void): void;
  /** The Agent's presence on the page: what it is doing, and its caret. */
  present(state: { activity: PageCoWriterActivity; cursor?: Y.RelativePosition | null; say?: string | null }): void;
  /** The people on the page now. */
  people(): PageCoWriterPerson[];
  /** To the Agent's runtime. */
  send(request: PageCoWriteRequest): void;
}

/** The live document as ProseMirror reads it, with the mapping between its nodes and the CRDT's. */
type Live = ReturnType<typeof initProseMirrorDoc>;

interface Action {
  kind: PageCoWriteAction;
  quote: string;
  /** What the Agent has written for it so far. */
  text: string;
  /** Set when the action cannot be carried out; its text is read and dropped. */
  skipped: boolean;
  /** The block just before what it writes, or null at the top of the page. */
  before: Y.XmlElement | Y.XmlText | null;
  /** The blocks it occupies now, as it last wrote them. */
  written: DocNode[];
  /** The paragraph `replace` rewrites, as it read when the action started. */
  original: string;
}

interface Turn {
  id: number;
  parser: PageCoWriteParser;
  action: Action | null;
  /** Someone edited what it was writing, so the rest of its answer is not written. */
  stopped: boolean;
}

/** A block of the page as markdown, as the Agent reads it. */
function blockMarkdown(node: DocNode): string {
  return pageDocToMarkdown(pageSchema.topNodeType.create(null, node)).replace(/\n+$/u, "");
}

/** The blocks some markdown describes; none for none. */
function blocksOf(markdown: string): DocNode[] {
  if (!markdown.trim()) return [];
  const doc = markdownToPageDoc(markdown);
  const nodes: DocNode[] = [];
  doc.forEach((node) => nodes.push(node));
  return nodes;
}

function shortened(text: string): string {
  const line = text.replace(/\s+/gu, " ").trim();
  return line.length > QUOTE_CONTEXT ? `${line.slice(0, QUOTE_CONTEXT)}…` : line;
}

function occurrences(text: string, part: string): number {
  let count = 0;
  for (let at = text.indexOf(part); at >= 0; at = text.indexOf(part, at + part.length)) count++;
  return count;
}

const INSTRUCTIONS = [
  "You are co-writing this page live with the people on it, as a co-author in the document, like a colleague in a",
  "shared Google Doc. Everyone sees your caret and your words appear as you write them.",
  "",
  "Only what you write inside these markers reaches the page; anything else you say is seen by nobody:",
  "⟦after \"words on the page\"⟧ then markdown to add right after the paragraph, heading, list or table holding those words.",
  "⟦replace \"words on the page\"⟧ then the new wording of exactly those words, within one paragraph.",
  "⟦note \"words on the page\"⟧ then a short remark to the people about those words.",
  "⟦pass⟧ when there is nothing to add now.",
  "Quote a few words that appear once on the page, copied exactly as the page below shows them. An answer may hold",
  "several markers.",
  "",
  "How to work:",
  "- Most of the time, ⟦pass⟧. Write when there is a clear opening: a heading or list left empty, a TODO, a section",
  "  that is plainly unfinished, something asked of you on the page, a gap the page's purpose calls for.",
  "- Never write in the paragraph someone is typing in (\"Typing now\" says where).",
  "- Your own additions go straight in. Do not reword what others wrote: fix only plain typos, and say anything else",
  "  with ⟦note⟧.",
  "- The page's first line, its top-level heading, is the page's name.",
  "- Write in the page's language and style, briefly, as a good colleague would add to it.",
  "- If someone edits what you are writing, you are stopped there; you hear what changed when they pause.",
  "You may use your tools to check facts first. A message like this one comes whenever people change the page and pause.",
].join("\n");

export class PageCoWriter {
  private turns = 0;
  private active: Turn | null = null;
  /** The page as the Agent last read it. */
  private seen = "";
  private readCount = 0;
  /** Others changed the page since the Agent last read it. */
  private changed = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** What became of its last answer, said in its next turn. */
  private outcome: string[] = [];
  /** Its last note, shown beside its caret until it writes or notes again. */
  private note: string | null = null;
  private ended = false;

  constructor(private readonly host: PageCoWriterHost) {}

  /** The Agent joins: it is shown on the page, and reads it unless it already had (a session that woke). */
  start(resumed = false): void {
    this.show({ activity: "watching" });
    if (resumed) {
      this.seen = this.host.markdown();
      this.readCount = 1;
      return;
    }
    this.ask();
  }

  stop(): void {
    this.ended = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.active = null;
  }

  /** Someone else changed the page. If it touched what the Agent is writing, the Agent stops there. */
  othersEdited(): void {
    if (this.ended) return;
    this.changed = true;
    if (this.active?.action && !this.active.action.skipped && !this.intact(this.active.action)) {
      this.yieldTurn("someone edited what you were writing");
    }
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.paused(), CO_WRITER_PAUSE_MS);
  }

  /** Someone's caret moved: into what the Agent is writing, and it stops there. */
  othersMoved(): void {
    const action = this.active?.action;
    if (this.ended || !action || action.skipped || this.active?.stopped) return;
    const live = initProseMirrorDoc(this.host.fragment, pageSchema);
    const region = this.region(action, live.doc);
    if (!region) return;
    for (const person of this.host.people()) {
      const at = person.caret ? this.blockIndexOf(person.caret, live) : null;
      if (at !== null && at >= region.from && at < region.from + action.written.length) {
        this.yieldTurn(`${person.name} moved into what you were writing`);
        return;
      }
    }
  }

  /** The runtime answers a turn: the Agent's words as they come, then the end of its turn. */
  receive(reply: PageCoWriteReply): void {
    const turn = this.active;
    if (this.ended || !turn || reply.turn !== turn.id) return;
    if (reply.type === "delta") {
      if (!turn.stopped) for (const event of turn.parser.push(reply.text)) this.apply(turn, event);
      return;
    }
    if (!turn.stopped) for (const event of turn.parser.finish()) this.apply(turn, event);
    if (reply.type === "failed") this.outcome.push(`Your last answer failed${reply.reason ? `: ${reply.reason}` : ""}.`);
    this.active = null;
    this.show({ activity: "watching" });
    // People who changed the page while it answered, and have paused since, are answered now.
    if (this.changed && !this.timer) this.ask();
  }

  private paused(): void {
    this.timer = null;
    if (this.ended || this.active || !this.changed) return;
    this.ask();
  }

  /** Sends the Agent what it needs to answer now. */
  private ask(): void {
    const now = this.host.markdown();
    const first = this.readCount === 0;
    const changedIds = first ? [] : pageChangedBlocks(this.seen, now);
    const full = first || this.readCount % FULL_PAGE_EVERY === 0 || changedIds.length > FULL_PAGE_CHANGES;
    const lines: string[] = [];
    lines.push(first ? "[Live co-writing] You joined this page." : "[Live co-writing] People paused.");
    if (first) lines.push("", INSTRUCTIONS);
    if (full) {
      lines.push("", "The page now:", "<<<PAGE", now.replace(/\n+$/u, ""), "PAGE>>>");
    } else if (changedIds.length) {
      const sections = new Map(pageBlocks(now).map((block) => [block.id, now.slice(block.start, block.end)]));
      const titles = new Map(pageBlocks(this.seen).map((block) => [block.id, block.title]));
      lines.push("", "Changed since you last read the page:");
      for (const id of changedIds) {
        const section = sections.get(id);
        if (section === undefined) lines.push(`- Removed: the section "${titles.get(id) ?? id}".`);
        else lines.push(`<<<SECTION${id ? "" : " (top of the page)"}`, section.replace(/\n+$/u, ""), "SECTION>>>");
      }
    } else {
      lines.push("", "Nothing changed in the text since you last read it.");
    }
    if (this.outcome.length) lines.push("", ...this.outcome);
    const typing = this.typingNow();
    lines.push("", typing.length ? `Typing now: ${typing.join("; ")}.` : "Nobody is typing now.");
    lines.push("Answer with ⟦…⟧ markers, or ⟦pass⟧.");
    this.outcome = [];
    this.seen = now;
    this.readCount++;
    this.changed = false;
    const turn: Turn = { id: ++this.turns, parser: new PageCoWriteParser(), action: null, stopped: false };
    this.active = turn;
    this.show({ activity: "thinking" });
    this.host.send({ type: "turn", turn: turn.id, text: lines.join("\n") });
  }

  /** Where people's carets are, by the paragraph they are in. */
  private typingNow(): string[] {
    const people = this.host.people().filter((person) => person.caret);
    if (!people.length) return [];
    const live = initProseMirrorDoc(this.host.fragment, pageSchema);
    const out: string[] = [];
    for (const person of people) {
      const at = this.blockIndexOf(person.caret!, live);
      if (at === null) continue;
      out.push(`${person.name} in "${shortened(blockMarkdown(live.doc.child(at)))}"`);
    }
    return out;
  }

  private blockIndexOf(caret: Y.RelativePosition, live: Live): number | null {
    const pos = relativePositionToAbsolutePosition(this.host.doc, this.host.fragment, caret, live.mapping);
    if (pos === null || live.doc.childCount === 0) return null;
    return live.doc.resolve(Math.min(Math.max(pos, 0), live.doc.content.size)).index(0);
  }

  private apply(turn: Turn, event: PageCoWriteEvent): void {
    if (turn.stopped || event.type === "pass") return;
    if (event.type === "start") {
      turn.action = this.begin(event.action, event.quote);
      return;
    }
    const action = turn.action;
    if (!action) return;
    if (event.type === "text") {
      action.text += event.text;
      if (!action.skipped && action.kind !== "note") this.write(turn, action, false);
      return;
    }
    // The action ends.
    turn.action = null;
    if (action.skipped) return;
    if (action.kind === "note") {
      const note = action.text.trim();
      if (note) {
        this.note = note;
        this.show({ activity: "writing" });
        this.outcome.push(`Your note on "${shortened(action.quote)}" was shown to the people.`);
      }
      return;
    }
    this.write(turn, action, true);
    if (turn.stopped) return;
    this.outcome.push(action.kind === "after"
      ? `You added ${action.written.length ? `${action.written.length} block(s)` : "nothing"} after "${shortened(action.quote)}".`
      : `You replaced "${shortened(action.quote)}".`);
  }

  /** Finds where an action writes: the one block holding its words, and not a paragraph someone is typing in. */
  private begin(kind: PageCoWriteAction, quote: string): Action {
    const action: Action = { kind, quote, text: "", skipped: true, before: null, written: [], original: "" };
    const live = initProseMirrorDoc(this.host.fragment, pageSchema);
    const matches: number[] = [];
    let count = 0;
    live.doc.forEach((node, _offset, index) => {
      const found = occurrences(blockMarkdown(node), quote);
      if (found) { matches.push(index); count += found; }
    });
    if (count === 0) {
      this.outcome.push(`Your ⟦${kind}⟧ quoted "${shortened(quote)}", which is not on the page; nothing was written there.`);
      return action;
    }
    if (count > 1) {
      this.outcome.push(`Your ⟦${kind}⟧ quoted "${shortened(quote)}", which appears more than once; quote more words.`);
      return action;
    }
    const at = matches[0]!;
    if (kind === "note") return { ...action, skipped: false };
    if (kind === "replace") {
      const typing = this.host.people().find((person) => person.caret && this.blockIndexOf(person.caret, live) === at);
      if (typing) {
        this.outcome.push(`${typing.name} is typing in the paragraph holding "${shortened(quote)}"; it was left alone.`);
        return action;
      }
    }
    const blocks = this.host.fragment.toArray();
    const before = kind === "after" ? blocks[at] : at > 0 ? blocks[at - 1] : null;
    const written = kind === "after" ? [] : [live.doc.child(at)];
    const original = kind === "replace" ? blockMarkdown(live.doc.child(at)) : "";
    const started: Action = { ...action, skipped: false, before: (before ?? null) as Action["before"], written, original };
    // Its caret goes to where it will write, then the words follow it.
    this.note = null;
    this.show({ activity: "writing", cursor: this.caretAfter(live, at) });
    return started;
  }

  /** Where the blocks an action occupies start, or null when the block before them is gone. */
  private region(action: Action, doc: DocNode): { from: number } | null {
    if (!action.before) return { from: 0 };
    const index = this.host.fragment.toArray().indexOf(action.before);
    if (index < 0 || index >= doc.childCount) return null;
    return { from: index + 1 };
  }

  /** The action's blocks still read as it wrote them: nobody else edited them. */
  private intact(action: Action): boolean {
    const live = initProseMirrorDoc(this.host.fragment, pageSchema);
    const region = this.region(action, live.doc);
    if (!region || region.from + action.written.length > live.doc.childCount) return false;
    return action.written.every((node, offset) => live.doc.child(region.from + offset).eq(node));
  }

  /** Brings the action's blocks to what the Agent has written so far, as one change under its caret. */
  private write(turn: Turn, action: Action, final: boolean): void {
    if (turn.stopped) return;
    const live = initProseMirrorDoc(this.host.fragment, pageSchema);
    const region = this.region(action, live.doc);
    if (!region || !action.written.every((node, offset) =>
      region.from + offset < live.doc.childCount && live.doc.child(region.from + offset).eq(node))) {
      this.yieldTurn("someone edited what you were writing");
      return;
    }
    const text = final ? action.text.replace(/\s+$/u, "") : action.text;
    const nodes = action.kind === "after"
      // A new line appears for its caret before its first words do.
      ? (text.trim() ? blocksOf(text) : final ? [] : [pageSchema.nodes.paragraph!.create()])
      : blocksOf(action.original.replace(action.quote, () => text.replace(/^\s+/u, "")));
    const children: DocNode[] = [];
    live.doc.forEach((node, _offset, index) => {
      if (index === region.from) children.push(...nodes);
      if (index < region.from || index >= region.from + action.written.length) children.push(node);
    });
    if (region.from >= live.doc.childCount) children.push(...nodes);
    if (!children.length) children.push(pageSchema.nodes.paragraph!.create());
    const intended = pageSchema.topNodeType.create(live.doc.attrs, Fragment.fromArray(children));
    this.host.write(() => updateYFragment(this.host.doc, this.host.fragment, intended, live.meta));
    action.written = nodes;
    const end = region.from + nodes.length;
    this.show({ activity: "writing", cursor: this.caretAt(intended, end, live.meta.mapping) });
  }

  /** The caret at the end of the block before `index`, as a position that survives others' edits. */
  private caretAt(doc: DocNode, index: number, mapping: Live["mapping"]): Y.RelativePosition | null {
    if (index <= 0 || doc.childCount === 0) return null;
    let pos = 0;
    for (let child = 0; child < Math.min(index, doc.childCount); child++) pos += doc.child(child).nodeSize;
    const $end = Selection.near(doc.resolve(Math.max(pos - 1, 0)), -1).$head;
    return absolutePositionToRelativePosition($end.pos, this.host.fragment, mapping) as Y.RelativePosition;
  }

  private caretAfter(live: Live, index: number): Y.RelativePosition | null {
    return this.caretAt(live.doc, index + 1, live.mapping);
  }

  private show(state: { activity: PageCoWriterActivity; cursor?: Y.RelativePosition | null }): void {
    this.host.present({ ...state, say: this.note });
  }

  /** Someone edited where the Agent writes: it stops there, as a person would, and hears why when they pause. */
  private yieldTurn(why: string): void {
    const turn = this.active;
    if (!turn || turn.stopped) return;
    turn.stopped = true;
    turn.action = null;
    // Its turn ends here: what it still sends for it is not written, and the next pause asks again.
    this.active = null;
    this.outcome.push(`You were stopped: ${why}.`);
    this.host.send({ type: "interrupt", turn: turn.id });
    this.show({ activity: "waiting" });
  }
}
