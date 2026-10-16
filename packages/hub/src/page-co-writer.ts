import {
  PAGE_AGENT_INK_MS, PageCoWriteParser, pageBlocks, pageChangedBlocks, type PageCoWriteAction, type PageCoWriteEvent,
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
/**
 * What the Agent writes reaches the page at most this often while it streams: every write rebuilds the
 * blocks it writes and brings the document to them, and a harness sends its words many times a second.
 */
export const CO_WRITER_WRITE_EVERY_MS = 80;
/**
 * A turn that has said nothing for this long is given up: the Agent is asked afresh at the next pause
 * instead of the page waiting on an answer that will not come. While a turn is open this timer also
 * keeps the session awake, so an answer is never lost to hibernation between its words.
 */
export const CO_WRITER_TURN_MS = 120_000;
/** After this many turns of changes alone, the Agent reads the whole page again. */
const FULL_PAGE_EVERY = 8;
/** More changed sections than this, and the Agent reads the whole page. */
const FULL_PAGE_CHANGES = 3;
const QUOTE_CONTEXT = 80;
/** The most changes an Agent's presence names as just written. */
const WROTE_KEPT = 8;

export type PageCoWriterActivity = "watching" | "thinking" | "writing" | "waiting";

/** Where the Agent wrote, and when: its presence names these, so the page marks them in its colour. */
export interface PageCoWriterWrote { from: Y.RelativePosition; to: Y.RelativePosition; at: number }

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
  /** The Agent's presence on the page: what it is doing, its caret, and whether its last change can be taken back. */
  present(state: { activity: PageCoWriterActivity; cursor?: Y.RelativePosition | null; say?: string | null;
    undoable: boolean; wrote: PageCoWriterWrote[] }): void;
  /** The people on the page now. */
  people(): PageCoWriterPerson[];
  /** The pace its words reach the page at, while someone reads it; null: as they come. */
  pace(): PageReaderPace | null;
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
  /** What its blocks were before it wrote them: the paragraph `replace` rewrites, nothing for `after`. */
  replaced: DocNode[];
}

/** Where the Agent wrote, what it wrote there, and what was there before. */
type Written = Pick<Action, "before" | "written" | "replaced">;

interface Turn {
  id: number;
  parser: PageCoWriteParser;
  action: Action | null;
  /** Someone edited what it was writing, so the rest of its answer is not written. */
  stopped: boolean;
  /** What the Agent sent that the page has not taken yet: given out at a reader's pace. */
  queue: PageCoWriteEvent[];
  /** The runtime has sent all of the turn, and how it ended. */
  sent: { failed: boolean; reason?: string } | null;
  /** Written as it comes, whoever reads the page: a message's write, which its sender waits on. */
  atOnce: boolean;
}

function newTurn(id: number, atOnce = false): Turn {
  return { id, parser: new PageCoWriteParser(), action: null, stopped: false, queue: [], sent: null, atOnce };
}

/** How fast an Agent's words reach a page someone is reading: about as a quick writer types, a breath after each sentence. */
export interface PageReaderPace { charsPerSecond: number; sentencePauseMs: number }

const SENTENCE_END = /[.!?。！？；;]\s*$/u;

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

export interface PageCoWriterOptions {
  /**
   * The Agent writes from a conversation (`⟦write page:<id>⟧ … ⟦/write⟧` in its reply): its runtime opens
   * each turn itself, as it writes, and the session never asks it, on joining or when people pause.
   */
  streams?: boolean;
}

export class PageCoWriter {
  /** Turn numbers start from the clock, so one asked after the session woke is never taken for one before. */
  private turns = Date.now();
  private active: Turn | null = null;
  private turnTimer: ReturnType<typeof setTimeout> | null = null;
  /** The page as the Agent last read it. */
  private seen = "";
  private readCount = 0;
  /** Others changed the page since the Agent last read it. */
  private changed = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** What became of its last answer, said in its next turn. */
  private outcome: string[] = [];
  /** What of the turn it opened itself did not reach the page, and why: its outcome, when it ends. */
  private problems: string[] = [];
  /** Its last note, shown beside its caret until it writes or notes again. */
  private note: string | null = null;
  /** Its last finished change, which a person may take back until it writes again. */
  private last: Written | null = null;
  private ended = false;
  private writable = false;
  /** What it wrote lately, change by change, for the page to mark in its colour while it is fresh. */
  private wrote: Array<PageCoWriterWrote & { change: Written }> = [];
  /** When the Agent's words last reached the page, and the write that waits to bring the rest. */
  private lastWrite = 0;
  private writeTimer: ReturnType<typeof setTimeout> | null = null;
  /** The next step giving the open turn's words to the page, at a reader's pace. */
  private releaseTimer: ReturnType<typeof setTimeout> | null = null;
  /** Turns the runtime opened while the last was still reaching the page, in order. */
  private waiting: Turn[] = [];

  constructor(private readonly host: PageCoWriterHost, private readonly options: PageCoWriterOptions = {}) {}

  /** The Agent joins: it is shown on the page, and reads it unless it already had (a session that woke). */
  start(writable: boolean, resumed = false): void {
    this.writable = writable;
    this.show({ activity: writable ? "watching" : "waiting" });
    if (!writable || this.options.streams) return;
    if (resumed) {
      this.seen = this.host.markdown();
      this.readCount = 1;
      return;
    }
    this.ask();
  }

  /** The session's current write policy applies to the whole turn, including work already queued. */
  setWritable(writable: boolean): void {
    if (this.ended || this.writable === writable) return;
    this.writable = writable;
    if (writable) {
      if (!this.options.streams) this.ask();
    } else {
      if (this.timer) clearTimeout(this.timer);
      this.timer = null;
      for (const turn of this.waiting.splice(0)) this.refuse(turn.id, false);
      this.yieldTurn("live write permission was withdrawn");
      this.show({ activity: "waiting" });
    }
  }

  stop(): void {
    this.ended = true;
    this.waiting = [];
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.close();
  }

  /** The open turn ends: nothing more of it is waited on. */
  private close(): void {
    if (this.turnTimer) clearTimeout(this.turnTimer);
    this.turnTimer = null;
    if (this.writeTimer) clearTimeout(this.writeTimer);
    this.writeTimer = null;
    if (this.releaseTimer) clearTimeout(this.releaseTimer);
    this.releaseTimer = null;
    this.active = null;
  }

  /** People's changes are heard when they pause, unless the Agent only writes what it opens itself. */
  private askLater(): void {
    if (!this.options.streams && this.changed && !this.timer) this.ask();
  }

  /** Waits on the open turn's next words, for so long. */
  private awaitTurn(turn: Turn): void {
    if (this.turnTimer) clearTimeout(this.turnTimer);
    this.turnTimer = setTimeout(() => {
      this.turnTimer = null;
      if (this.active !== turn || this.ended) return;
      this.told(this.options.streams ? "Nothing more came for two minutes, so what you were writing ended there."
        : "Your last answer went quiet and was given up.", true);
      this.host.send({ type: "interrupt", turn: turn.id });
      this.finished(turn);
      this.close();
      this.show({ activity: "watching" });
      this.askLater();
    }, CO_WRITER_TURN_MS);
    // In Node (tests, local runs) a waiting turn does not keep the process alive; Workers have no unref.
    (this.turnTimer as { unref?: () => void }).unref?.();
  }

  /** Someone else changed the page. If it touched what the Agent is writing, the Agent stops there. */
  othersEdited(): void {
    if (this.ended || !this.writable) return;
    this.changed = true;
    if (this.active?.action && !this.active.action.skipped && !this.intact(this.active.action)) {
      this.yieldTurn("someone edited what you were writing");
    }
    if (this.options.streams) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.paused(), CO_WRITER_PAUSE_MS);
  }

  /** Someone's caret moved: into what the Agent is writing, and it stops there. */
  othersMoved(): void {
    const action = this.active?.action;
    if (this.ended || !this.writable || !action || action.skipped || this.active?.stopped) return;
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
    if (reply.type === "write") {
      this.own(reply.turn, reply.atOnce === true);
      return;
    }
    const turn = this.active?.id === reply.turn ? this.active : this.waiting.find((item) => item.id === reply.turn);
    if (this.ended || !this.writable || !turn || turn.stopped || turn.sent) return;
    if (reply.type === "delta") {
      if (turn === this.active) this.awaitTurn(turn);
      turn.queue.push(...turn.parser.push(reply.text));
    } else {
      turn.queue.push(...turn.parser.finish());
      turn.sent = { failed: reply.type === "failed", ...(reply.type === "failed" && reply.reason ? { reason: reply.reason } : {}) };
      // No more of it is waited on; what it sent goes on reaching the page.
      if (turn === this.active && this.turnTimer) {
        clearTimeout(this.turnTimer);
        this.turnTimer = null;
      }
    }
    if (turn === this.active && !this.releaseTimer) this.step(turn);
  }

  /**
   * Gives what the Agent sent to the page: all of it at once when nobody reads the page, otherwise a few
   * characters a step, a breath after each sentence, so a reader sees it written as a quick writer writes.
   */
  private step(turn: Turn): void {
    this.releaseTimer = null;
    if (this.active !== turn || turn.stopped) return;
    const pace = turn.atOnce ? null : this.host.pace();
    let budget = pace ? Math.max(1, Math.round(pace.charsPerSecond * CO_WRITER_WRITE_EVERY_MS / 1000)) : Infinity;
    let rest = 0;
    while (turn.queue.length && budget > 0 && this.active === turn && !turn.stopped) {
      const event = turn.queue.shift()!;
      if (event.type !== "text" || !pace) {
        this.apply(turn, event);
        continue;
      }
      const chars = Array.from(event.text);
      const given = chars.slice(0, budget).join("");
      if (chars.length > budget) turn.queue.unshift({ type: "text", text: chars.slice(budget).join("") });
      budget -= Math.min(budget, chars.length);
      this.apply(turn, { type: "text", text: given });
      if (SENTENCE_END.test(given)) {
        rest = pace.sentencePauseMs;
        break;
      }
    }
    if (this.active !== turn || turn.stopped) return;
    if (turn.queue.length) {
      this.releaseTimer = setTimeout(() => this.step(turn), rest || CO_WRITER_WRITE_EVERY_MS);
      (this.releaseTimer as { unref?: () => void }).unref?.();
    } else if (turn.sent) {
      this.complete(turn);
    }
  }

  /** The Agent's turn has reached the page whole: it ends, and the next one it opened goes on. */
  private complete(turn: Turn): void {
    if (turn.sent?.failed) this.told(`Your last answer failed${turn.sent.reason ? `: ${turn.sent.reason}` : ""}.`);
    this.finished(turn);
    this.close();
    this.show({ activity: "watching" });
    if (this.next()) return;
    // People who changed the page while it answered, and have paused since, are answered now.
    this.askLater();
  }

  /** The next turn the runtime opened while the last was reaching the page is written now. Whether there was one. */
  private next(): boolean {
    const turn = this.waiting.shift();
    if (!turn) return false;
    this.activate(turn);
    this.step(turn);
    return true;
  }

  private activate(turn: Turn): void {
    this.active = turn;
    this.problems = [];
    if (!turn.sent) this.awaitTurn(turn);
    this.show({ activity: "thinking" });
  }

  /** Tells the runtime a turn it opened is not written, and why. */
  private refuse(id: number, stillWriting: boolean): void {
    this.host.send({ type: "interrupt", turn: id });
    if (this.options.streams && !this.ended) this.host.send({ type: "outcome", turn: id, problems: [stillWriting
      ? "You were still writing into the page; write one ⟦write⟧ at a time."
      : "The page does not take your words live now (its Agent edits are suggestions, or you may not edit it); use `xmatrix page edit`."] });
  }

  /**
   * The Agent opens a turn itself: it is writing into the page from its conversation, as its words come.
   * Nobody asked it, so a co-writer that waits on the session's turns, or that may not write, is told no.
   */
  private own(id: number, atOnce = false): void {
    const sending = this.active && !this.active.sent;
    if (this.ended || !this.options.streams || !this.writable || (sending && this.active!.id !== id)) {
      this.refuse(id, this.writable);
      return;
    }
    if (this.active?.id === id || this.waiting.some((item) => item.id === id)) return;
    const turn = newTurn(id, atOnce);
    // A turn opened while the last is still reaching the page goes in after it.
    if (this.active) this.waiting.push(turn);
    else this.activate(turn);
  }

  /**
   * What became of the Agent's words: said in its next turn, or, for a co-writer that streams from a
   * conversation and is never asked, in the outcome of the turn it opened when what went wrong is a problem.
   */
  private told(text: string, problem = false): void {
    if (!this.options.streams) this.outcome.push(text);
    else if (problem) this.problems.push(text);
  }

  /** A turn the runtime opened itself ends: it hears what did not reach the page. */
  private finished(turn: Turn): void {
    if (!this.options.streams) return;
    this.host.send({ type: "outcome", turn: turn.id, problems: this.problems });
    this.problems = [];
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
    const turn = newTurn(++this.turns);
    this.active = turn;
    this.awaitTurn(turn);
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
      if (!action.skipped && action.kind !== "note") this.writeSoon(turn, action);
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
        this.told(`Your note on "${shortened(action.quote)}" was shown to the people.`);
      }
      return;
    }
    this.write(turn, action, true);
    if (turn.stopped) return;
    this.last = action.written.length || action.replaced.length ? action : null;
    this.show({ activity: "writing" });
    this.told(action.kind === "after"
      ? `You added ${action.written.length ? `${action.written.length} block(s)` : "nothing"} after "${shortened(action.quote)}".`
      : `You replaced "${shortened(action.quote)}".`);
  }

  /** Finds where an action writes: the one block holding its words, and not a paragraph someone is typing in. */
  private begin(kind: PageCoWriteAction, quote: string): Action {
    const action: Action = { kind, quote, text: "", skipped: true, before: null, written: [], original: "", replaced: [] };
    const live = initProseMirrorDoc(this.host.fragment, pageSchema);
    const matches: number[] = [];
    let count = 0;
    live.doc.forEach((node, _offset, index) => {
      const found = occurrences(blockMarkdown(node), quote);
      if (found) { matches.push(index); count += found; }
    });
    if (count === 0) {
      this.told(`Your ⟦${kind}⟧ quoted "${shortened(quote)}", which is not on the page; nothing was written there.`, true);
      return action;
    }
    if (count > 1) {
      this.told(`Your ⟦${kind}⟧ quoted "${shortened(quote)}", which appears more than once; quote more words.`, true);
      return action;
    }
    const at = matches[0]!;
    if (kind === "note") return { ...action, skipped: false };
    if (kind === "replace") {
      const typing = this.host.people().find((person) => person.caret && this.blockIndexOf(person.caret, live) === at);
      if (typing) {
        this.told(`${typing.name} is typing in the paragraph holding "${shortened(quote)}"; it was left alone.`, true);
        return action;
      }
    }
    const blocks = this.host.fragment.toArray();
    const before = kind === "after" ? blocks[at] : at > 0 ? blocks[at - 1] : null;
    const written = kind === "after" ? [] : [live.doc.child(at)];
    const original = kind === "replace" ? blockMarkdown(live.doc.child(at)) : "";
    const started: Action = { ...action, skipped: false, before: (before ?? null) as Action["before"], written, original,
      replaced: written };
    // A new change is the one a person can take back, and its first words show at once where it goes.
    this.last = null;
    this.lastWrite = 0;
    // Its caret goes to where it will write, then the words follow it.
    this.note = null;
    this.show({ activity: "writing", cursor: this.caretAfter(live, at) });
    return started;
  }

  /** Where the blocks an action occupies start, or null when the block before them is gone. */
  private region(action: Pick<Action, "before">, doc: DocNode): { from: number } | null {
    if (!action.before) return { from: 0 };
    const index = this.host.fragment.toArray().indexOf(action.before);
    if (index < 0 || index >= doc.childCount) return null;
    return { from: index + 1 };
  }

  /** The action's blocks still read as it wrote them: nobody else edited them. */
  private intact(action: Pick<Action, "before" | "written">, live = initProseMirrorDoc(this.host.fragment, pageSchema)): boolean {
    const region = this.region(action, live.doc);
    if (!region || region.from + action.written.length > live.doc.childCount) return false;
    return action.written.every((node, offset) => live.doc.child(region.from + offset).eq(node));
  }

  /**
   * A person takes back what the Agent last wrote: the blocks return to what they were, unless
   * someone changed them since. What it is writing now counts as its last change, and it stops.
   */
  undo(by: string): "undone" | "changed" | "nothing" {
    const writing = this.active?.action;
    const target: Written | null = writing && !writing.skipped && writing.kind !== "note" && writing.written.length
      ? writing : this.last;
    if (this.ended || !target) return "nothing";
    this.last = null;
    const live = initProseMirrorDoc(this.host.fragment, pageSchema);
    if (!this.intact(target, live)) {
      this.show({ activity: this.active ? "thinking" : "watching" });
      return "changed";
    }
    if (target === writing) this.yieldTurn(`${by} took back what you were writing`);
    const from = this.region(target, live.doc)!.from;
    const children: DocNode[] = [];
    live.doc.forEach((node, _offset, index) => {
      if (index === from) children.push(...target.replaced);
      if (index < from || index >= from + target.written.length) children.push(node);
    });
    if (from >= live.doc.childCount) children.push(...target.replaced);
    if (!children.length) children.push(pageSchema.nodes.paragraph!.create());
    const restored = pageSchema.topNodeType.create(live.doc.attrs, Fragment.fromArray(children));
    this.host.write(() => updateYFragment(this.host.doc, this.host.fragment, restored, live.meta));
    // What was taken back is not its writing any more.
    this.wrote = this.wrote.filter((entry) => entry.change !== target);
    this.told(`${by} took back your last change; leave it out unless they ask again.`);
    this.show({ activity: this.active ? "thinking" : target === writing ? "waiting" : "watching" });
    return "undone";
  }

  /**
   * Brings the action's blocks to what the Agent has written so far, now or as soon as the last write is
   * far enough behind: the words keep coming many times a second, and the page shows them a few times.
   */
  private writeSoon(turn: Turn, action: Action): void {
    const wait = this.lastWrite + CO_WRITER_WRITE_EVERY_MS - Date.now();
    if (wait <= 0) {
      this.write(turn, action, false);
      return;
    }
    if (this.writeTimer) return;
    this.writeTimer = setTimeout(() => {
      this.writeTimer = null;
      if (this.active === turn && turn.action === action && !action.skipped) this.write(turn, action, false);
    }, wait);
    (this.writeTimer as { unref?: () => void }).unref?.();
  }

  /** Brings the action's blocks to what the Agent has written so far, as one change under its caret. */
  private write(turn: Turn, action: Action, final: boolean): void {
    if (this.writeTimer) clearTimeout(this.writeTimer);
    this.writeTimer = null;
    if (turn.stopped) return;
    this.lastWrite = Date.now();
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
    this.remember(action, intended, region.from, end, live.meta.mapping);
    this.show({ activity: "writing", cursor: this.caretAt(intended, end, live.meta.mapping) });
  }

  /** Its change now covers blocks `from` to `to` of `doc`: kept as positions that survive others' edits. */
  private remember(change: Written, doc: DocNode, from: number, to: number, mapping: Live["mapping"]): void {
    const now = Date.now();
    this.wrote = this.wrote.filter((entry) => entry.change !== change && now - entry.at < PAGE_AGENT_INK_MS);
    if (to <= from) return;
    let start = 0;
    for (let child = 0; child < from; child++) start += doc.child(child).nodeSize;
    let finish = start;
    for (let child = from; child < to; child++) finish += doc.child(child).nodeSize;
    const at = (pos: number) => absolutePositionToRelativePosition(pos, this.host.fragment, mapping) as Y.RelativePosition;
    this.wrote = [...this.wrote, { change, from: at(start + 1), to: at(finish - 1), at: now }].slice(-WROTE_KEPT);
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
    const writing = this.active?.action;
    const now = Date.now();
    this.host.present({ ...state, say: this.note,
      undoable: this.last !== null || Boolean(writing && !writing.skipped && writing.kind !== "note" && writing.written.length),
      wrote: this.wrote.filter((entry) => now - entry.at < PAGE_AGENT_INK_MS).map(({ from, to, at }) => ({ from, to, at })) });
  }

  /** Someone edited where the Agent writes: it stops there, as a person would, and hears why when they pause. */
  private yieldTurn(why: string): void {
    const turn = this.active;
    if (!turn || turn.stopped) return;
    turn.stopped = true;
    turn.action = null;
    // Its turn ends here: what it still sends for it is not written, and the next pause asks again.
    this.close();
    this.told(`You were stopped: ${why}.`, true);
    this.host.send({ type: "interrupt", turn: turn.id });
    this.finished(turn);
    this.show({ activity: "waiting" });
    // What it opened after the stopped turn is its own write: it goes on.
    this.next();
  }
}
