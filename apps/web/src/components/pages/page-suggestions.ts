import { mergePageText } from "@xmatrix/protocol";
import {
  markdownToPageDoc, pageDocHunks, pageDocToMarkdown, pageSchema, type PageDocHunk,
} from "@xmatrix/protocol/page-document";
import { DOMSerializer, type Node as DocNode } from "prosemirror-model";
import { Plugin, PluginKey, type Transaction } from "prosemirror-state";
import { Decoration, DecorationSet, type EditorView } from "prosemirror-view";
import { edgeRoom, edgeRoomAt } from "./page-editor-setup";

/**
 * A suggestion waiting on the page (pages-live-document.md §4.2): the whole document an Agent proposed,
 * the text it proposed it against, and who proposed it.
 */
export interface PageSuggestion {
  revision: number; base: string; body: string; author: string; color: string; avatarUrl?: string;
}

/**
 * Where a person is in the suggestions: how many changes are left, which one is in front of them, whose,
 * and the last suggestion those changes were worked out from (0 before they have been).
 */
export interface SuggestionsReport { count: number; current: number; author: string | null; through: number }

interface SuggestionsState {
  suggestions: readonly PageSuggestion[];
  hunks: PageDocHunk[];
  /** The hunks the person left, by what they would change, so they stay left as the page moves. */
  left: ReadonlySet<string>;
  current: number;
  /** The last suggestion the hunks were worked out from. */
  through: number;
  decorations: DecorationSet;
}

type Meta =
  | { suggestions: readonly PageSuggestion[] }
  | { hunks: PageDocHunk[]; through: number }
  | { taken: true }
  | { left: string }
  | { step: -1 | 0 | 1 };

export const suggestionsKey = new PluginKey<SuggestionsState>("page-suggestions");

/** Views whose reader just took, left or stepped: the next change is brought into view. */
const bringIntoView = new WeakSet<EditorView>();

/** What a hunk would change, as text, so leaving it holds while positions move. */
function signature(doc: DocNode, hunk: PageDocHunk): string {
  return `${doc.textBetween(hunk.from, hunk.to, "\n", "\n")}\u0000${JSON.stringify(hunk.content.toJSON())}`;
}

/**
 * The suggestions laid over the page as it is now, one change at a time: each is rebased onto the
 * live text (what was typed meanwhile stays), and what remains different is offered hunk by hunk.
 */
function suggestedHunks(doc: DocNode, suggestions: readonly PageSuggestion[], left: ReadonlySet<string>): PageDocHunk[] {
  if (suggestions.length === 0) return [];
  const live = pageDocToMarkdown(doc);
  let proposal = live;
  for (const suggestion of suggestions) {
    // A suggestion that no longer fits what the page says now is passed over; History keeps it.
    const merged = mergePageText(suggestion.base, proposal, suggestion.body);
    if (merged.ok) proposal = merged.text;
  }
  if (proposal === live) return [];
  return pageDocHunks(doc, markdownToPageDoc(proposal)).filter((hunk) => !left.has(signature(doc, hunk)));
}

const serializer = DOMSerializer.fromSchema(pageSchema);

/** Who is writing the change in front of the reader: their colour, and the face their pen carries. */
interface Writer { color: string; avatarUrl?: string }

/** The words already written out once, so laying the suggestions over the page again does not write them twice. */
const written = new Set<string>();

/** The Agent's pen: its own face, in the line at the height of the words, moving with them as it writes. */
function pen(writer: Writer): HTMLElement {
  const element = document.createElement("span");
  element.className = "page-suggest-pen";
  element.contentEditable = "false";
  element.setAttribute("aria-hidden", "true");
  element.style.setProperty("--page-suggest-color", writer.color);
  if (writer.avatarUrl) {
    const face = document.createElement("img");
    face.className = "page-suggest-pen-face";
    face.src = writer.avatarUrl;
    face.alt = "";
    face.draggable = false;
    element.append(face);
  }
  return element;
}

/** Marks the words of each block in `element` as being written, as a highlighter marks lines of text. */
function inkBlocks(element: HTMLElement): void {
  for (const block of element.querySelectorAll<HTMLElement>("p, h1, h2, h3, h4, h5, h6")) {
    const ink = document.createElement("span");
    ink.className = "page-suggest-ink";
    ink.append(...block.childNodes);
    block.append(ink);
  }
}

/**
 * Writes the words of `element` out as the Agent would type them, its pen just after the last one, so
 * the change reads as being written there and then. Once written, they stand whole with the pen resting
 * at their end.
 */
function writeOut(element: HTMLElement, writer: Writer, key: string): void {
  const nodes: Text[] = [];
  const walk = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  for (let node = walk.nextNode(); node; node = walk.nextNode()) nodes.push(node as Text);
  const caret = pen(writer);
  const rest = () => nodes[nodes.length - 1]!.after(caret);
  const words = nodes.map((node) => node.data);
  const total = words.reduce((sum, text) => sum + text.length, 0);
  if (written.has(key) || total === 0 || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    if (nodes.length) rest(); else element.append(caret);
    written.add(key);
    return;
  }
  for (const node of nodes) node.data = "";
  // About a second and a half for the change, however long: quick enough to wait for, slow enough to watch.
  const perCharacter = Math.max(8, Math.min(32, 1500 / total));
  const started = performance.now();
  let shown = 0;
  const step = (now: number) => {
    if (!element.isConnected) return;
    const target = Math.min(total, Math.floor((now - started) / perCharacter) + 1);
    let left = target;
    for (const [index, node] of nodes.entries()) {
      const text = words[index]!;
      const take = Math.min(text.length, left);
      if (node.data.length !== take) node.data = text.slice(0, take);
      left -= take;
      if (take < text.length || index === nodes.length - 1) {
        if (caret.previousSibling !== node) node.after(caret);
        break;
      }
    }
    shown = target;
    if (shown < total) requestAnimationFrame(step);
    else { written.add(key); rest(); }
  };
  element.append(caret);
  requestAnimationFrame(step);
}

/** New blocks as they would read, ghosted where they would go; the one being written is lit in its Agent's colour. */
function ghostBlocks(hunk: PageDocHunk, current: boolean, writer: Writer, key: string): HTMLElement {
  const element = document.createElement("div");
  element.className = `page-suggest-in is-block${current ? " is-current" : ""}`;
  element.style.setProperty("--page-suggest-color", writer.color);
  element.contentEditable = "false";
  element.append(serializer.serializeFragment(hunk.content));
  if (current) {
    inkBlocks(element);
    element.querySelector("p, h1, h2, h3, h4, h5, h6")?.prepend(edgeRoom("suggestion"));
    writeOut(element, writer, key);
  }
  return element;
}

function putIn(text: string, block: boolean, current: boolean, writer: Writer, key: string): HTMLElement {
  const element = document.createElement(block ? "div" : "span");
  element.className = `page-suggest-in${block ? " is-block" : ""}${current ? " is-current page-suggest-ink" : ""}`;
  element.style.setProperty("--page-suggest-color", writer.color);
  element.contentEditable = "false";
  element.textContent = text;
  if (current) writeOut(element, writer, key);
  return element;
}

function decorate(doc: DocNode, hunks: readonly PageDocHunk[], current: number, writer: Writer): DecorationSet {
  const color = writer.color;
  const decorations: Decoration[] = [];
  hunks.forEach((hunk, index) => {
    const now = index === current;
    const tag = now ? " is-current" : "";
    if (hunk.from === hunk.to) {
      const key = `suggest-blocks:${String(now)}:${color}:${JSON.stringify(hunk.content.toJSON())}`;
      decorations.push(Decoration.widget(hunk.from, () => ghostBlocks(hunk, now, writer, key), {
        side: -1, ignoreSelection: true, key,
      }));
      return;
    }
    // The words of the blocks being written are marked in the colour of the Agent writing them, as a
    // highlighter marks lines, the colour its caret and History have.
    if (now) {
      doc.nodesBetween(hunk.from, hunk.to, (node, pos) => {
        if (node.isTextblock && node.content.size > 0) {
          decorations.push(Decoration.inline(pos + 1, pos + node.nodeSize - 1, { class: "page-suggest-ink",
            style: `--page-suggest-color: ${color}` }));
        }
        return !node.isTextblock;
      });
      // Room beside the change for what to do with it, so neither its words nor the pen run under that.
      decorations.push(...edgeRoomAt(doc, hunk.from, hunk.to, "suggestion"));
    }
    const outs = hunk.changes.filter((change) => change.kind === "added");
    // A hunk that changes only how its blocks are laid out shows the blocks it replaces as taken out.
    if (hunk.changes.length === 0) {
      doc.nodesBetween(hunk.from, hunk.to, (node, pos) => {
        if (pos >= hunk.from && pos + node.nodeSize <= hunk.to) {
          decorations.push(Decoration.node(pos, pos + node.nodeSize, { class: `page-suggest-out is-block${tag}` }));
        }
        return false;
      });
    }
    for (const change of outs) {
      if (change.kind !== "added") continue;
      if (change.block) {
        const node = doc.nodeAt(change.from);
        if (node && !node.isText) {
          decorations.push(Decoration.node(change.from, change.from + node.nodeSize, { class: `page-suggest-out is-block${tag}` }));
        }
      } else {
        decorations.push(Decoration.inline(change.from, change.to, { class: `page-suggest-out${tag}` }));
      }
    }
    for (const change of hunk.changes) {
      if (change.kind !== "removed") continue;
      // What it puts in reads after what it takes out, where both stand at one place.
      const replaced = outs.find((out) => out.kind === "added" && !out.block && out.from === change.at);
      const at = replaced?.kind === "added" ? replaced.to : change.at;
      const key = `suggest-in:${index}:${at}:${String(now)}:${color}:${change.text}`;
      decorations.push(Decoration.widget(at, () => putIn(change.text, change.block, now, writer, key), {
        side: change.block ? -1 : 1, ignoreSelection: true, marks: [], key,
      }));
    }
  });
  return DecorationSet.create(doc, decorations);
}

/** Hunks follow an edit made before they are worked out again. */
function mapHunks(tr: Transaction, hunks: readonly PageDocHunk[]): PageDocHunk[] {
  const out: PageDocHunk[] = [];
  for (const hunk of hunks) {
    const from = tr.mapping.map(hunk.from, 1);
    const to = Math.max(from, tr.mapping.map(hunk.to, -1));
    out.push({ ...hunk, from, to, changes: hunk.changes.map((change) => change.kind === "added"
      ? { ...change, from: tr.mapping.map(change.from, 1), to: tr.mapping.map(change.to, -1) }
      : { ...change, at: tr.mapping.map(change.at) }) });
  }
  return out;
}

/** How long typing waits before the suggestions are laid over the page again. */
const RELAY_MS = 120;

/**
 * Suggestions over the page, as Cursor offers its edits: each change is shown where it would land,
 * and the one in front of the reader is taken with Tab or left with Escape, then the next comes up.
 */
export function pageSuggestions(report: () => ((state: SuggestionsReport) => void) | undefined): Plugin<SuggestionsState> {
  return new Plugin<SuggestionsState>({
    key: suggestionsKey,
    state: {
      init: (_config, state) => ({ suggestions: [], hunks: [], left: new Set(), current: 0, through: 0,
        decorations: DecorationSet.create(state.doc, []) }),
      apply(tr, value, _old, state) {
        const meta = tr.getMeta(suggestionsKey) as Meta | undefined;
        let { suggestions, hunks, left, current, through } = value;
        if (meta && "suggestions" in meta) suggestions = meta.suggestions;
        if (meta && "hunks" in meta) { hunks = meta.hunks; through = meta.through; }
        else if (tr.docChanged) hunks = mapHunks(tr, hunks);
        if (meta && "taken" in meta) hunks = hunks.filter((_hunk, index) => index !== current);
        if (meta && "left" in meta) {
          left = new Set([...left, meta.left]);
          hunks = hunks.filter((_hunk, index) => index !== current);
        }
        if (meta && "step" in meta && hunks.length) current = (current + meta.step + hunks.length) % hunks.length;
        current = hunks.length ? Math.min(current, hunks.length - 1) : 0;
        if (!meta && !tr.docChanged) return value;
        const last = suggestions[suggestions.length - 1];
        const writer = { color: last?.color ?? "", ...(last?.avatarUrl ? { avatarUrl: last.avatarUrl } : {}) };
        return { suggestions, hunks, left, current, through, decorations: decorate(state.doc, hunks, current, writer) };
      },
    },
    props: { decorations: (state) => suggestionsKey.getState(state)?.decorations },
    view: (view) => {
      let timer: number | undefined;
      let reported = "";
      const relay = () => {
        window.clearTimeout(timer);
        timer = window.setTimeout(() => {
          const value = suggestionsKey.getState(view.state);
          if (!value || view.isDestroyed) return;
          const hunks = suggestedHunks(view.state.doc, value.suggestions, value.left);
          const through = value.suggestions.reduce((last, suggestion) => Math.max(last, suggestion.revision), 0);
          view.dispatch(view.state.tr.setMeta(suggestionsKey, { hunks, through } satisfies Meta));
        }, RELAY_MS);
      };
      const tell = () => {
        const value = suggestionsKey.getState(view.state);
        if (!value) return;
        const author = value.suggestions[value.suggestions.length - 1]?.author ?? null;
        const next = `${value.hunks.length}:${value.current}:${author}:${value.through}`;
        if (next === reported) return;
        reported = next;
        report()?.({ count: value.hunks.length, current: value.current, author, through: value.through });
      };
      return {
        update(current, previous) {
          const now = suggestionsKey.getState(current.state);
          const before = suggestionsKey.getState(previous);
          if (now && before && (now.suggestions !== before.suggestions || current.state.doc !== previous.doc)) relay();
          if (bringIntoView.has(current) && now?.hunks.length) {
            bringIntoView.delete(current);
            requestAnimationFrame(() => current.dom.querySelector(".is-current")
              ?.scrollIntoView({ block: "center", behavior: "smooth" }));
          }
          tell();
        },
        destroy: () => window.clearTimeout(timer),
      };
    },
  });
}

/** Lays these suggestions over the page, replacing those it had. */
export function showSuggestions(view: EditorView, suggestions: readonly PageSuggestion[]): void {
  view.dispatch(view.state.tr.setMeta(suggestionsKey, { suggestions } satisfies Meta));
}

/** Acts on the change in front of the reader, and brings the next into view; false when none waits. */
function onCurrent(view: EditorView, act: (hunk: PageDocHunk) => Transaction): boolean {
  const value = suggestionsKey.getState(view.state);
  const hunk = value?.hunks[value.current];
  if (!hunk) return false;
  bringIntoView.add(view);
  view.dispatch(act(hunk));
  return true;
}

/** Takes the change in front of the reader into the page; the next one comes up. */
export function takeSuggestion(view: EditorView): boolean {
  return onCurrent(view, (hunk) => view.state.tr.replaceWith(hunk.from, hunk.to, hunk.content)
    .setMeta(suggestionsKey, { taken: true } satisfies Meta));
}

/** Leaves the change in front of the reader as the page has it; the next one comes up. */
export function leaveSuggestion(view: EditorView): boolean {
  return onCurrent(view, (hunk) => view.state.tr
    .setMeta(suggestionsKey, { left: signature(view.state.doc, hunk) } satisfies Meta));
}

/** Brings the next (or previous) change in front of the reader, or the same one into view. */
export function stepSuggestion(view: EditorView, by: -1 | 0 | 1): void {
  bringIntoView.add(view);
  view.dispatch(view.state.tr.setMeta(suggestionsKey, { step: by } satisfies Meta));
}

/**
 * Where the change in front of the reader starts: the top of the words marked for it, where what to do
 * with it stands, in the room kept for it beside them.
 */
export function currentSuggestionTop(view: EditorView): number | null {
  const value = suggestionsKey.getState(view.state);
  if (!value?.hunks[value.current]) return null;
  return view.dom.querySelector(".page-suggest-ink, .is-current")?.getBoundingClientRect().top ?? null;
}
