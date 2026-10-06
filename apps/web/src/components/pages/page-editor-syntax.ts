import { pageSchema } from "@xmatrix/protocol/page-document";
import { setBlockType, lift } from "prosemirror-commands";
import { InputRule, inputRules, textblockTypeInputRule, wrappingInputRule } from "prosemirror-inputrules";
import { keymap } from "prosemirror-keymap";
import type { MarkType, Node as DocNode } from "prosemirror-model";
import { type Command, type EditorState, Plugin, type Transaction } from "prosemirror-state";
import { findWrapping } from "prosemirror-transform";
import { Decoration, DecorationSet } from "prosemirror-view";

/**
 * Typing on a page (docs/design/pages-live-document.md §4.2). People format
 * by writing markdown, the way Typora does. The markers are decorations on
 * the caret's block and on the marks it sits in: they are not in the
 * document, so everyone else still sees rendered text and carets.
 */
const { nodes, marks } = pageSchema;

type SyntaxKind = "link" | "strong" | "em" | "strike" | "code";

interface SyntaxSpan {
  kind: SyntaxKind;
  from: number;
  to: number;
  href: string | null;
}

const INNER_FIRST: SyntaxKind[] = ["code", "strike", "em", "strong", "link"];

function delimiter(kind: SyntaxKind, edge: "open" | "close", href: string | null): string {
  switch (kind) {
    case "strong": return "**";
    case "em": return "*";
    case "strike": return "~~";
    case "code": return "`";
    case "link": return edge === "open" ? "[" : `](${href ?? ""})`;
  }
}

/** Contiguous runs of one mark in the caret's textblock. A run is included when the caret touches it. */
function syntaxSpans(doc: DocNode, pos: number): SyntaxSpan[] {
  const $pos = doc.resolve(pos);
  const parent = $pos.parent;
  if (!parent.isTextblock || parent.type.spec.code) return [];
  const found: SyntaxSpan[] = [];
  for (const kind of INNER_FIRST) {
    const type = marks[kind];
    let runFrom: number | null = null;
    let runHref: string | null = null;
    let cursor = $pos.start();
    const close = (runTo: number) => {
      // A link is exclusive at its end: the caret there is outside, so its markers stay hidden.
      const inside = runFrom !== null && runTo > runFrom && pos >= runFrom && (kind === "link" ? pos < runTo : pos <= runTo);
      if (inside && runFrom !== null) found.push({ kind, from: runFrom, to: runTo, href: runHref });
      runFrom = null;
      runHref = null;
    };
    parent.forEach((node) => {
      const start = cursor;
      cursor += node.nodeSize;
      const mark = node.isText ? type.isInSet(node.marks) : null;
      const href = mark && kind === "link" ? String(mark.attrs.href ?? "") : null;
      if (!mark || (runFrom !== null && href !== runHref)) close(start);
      if (!mark) return;
      if (runFrom === null) {
        runFrom = start;
        runHref = href;
      }
    });
    close(cursor);
  }
  return found;
}

function syntaxToken(text: string, href?: string): HTMLElement {
  const span = document.createElement("span");
  span.className = "page-md-syntax";
  span.textContent = text;
  span.contentEditable = "false";
  span.setAttribute("aria-hidden", "true");
  if (href !== undefined) {
    span.dataset.editLink = href;
    span.title = "Edit link";
  }
  return span;
}

/**
 * Markers for the caret's block and the marks around the caret. Widgets, not
 * CSS generated text: the editor can still map a click onto the real text.
 * @testonly
 */
export function syntaxDecorations(state: EditorState): DecorationSet {
  const $pos = state.selection.$head;
  const parent = $pos.parent;
  if (!parent.isTextblock) return DecorationSet.empty;
  const drawn: Decoration[] = [];
  if (parent.type === nodes.code_block) {
    drawn.push(Decoration.node($pos.before(), $pos.after(), { class: "page-md-open" }, { fence: true }));
    return DecorationSet.create(state.doc, drawn);
  }
  if (parent.type.spec.code) return DecorationSet.empty;
  let quotes = 0;
  for (let depth = $pos.depth; depth > 0; depth--) if ($pos.node(depth).type === nodes.blockquote) quotes += 1;
  let marker = quotes ? `${">".repeat(quotes)} ` : "";
  if (parent.type === nodes.heading) {
    const level = Math.min(6, Math.max(1, Number(parent.attrs.level) || 1));
    marker += `${"#".repeat(level)} `;
  }
  if (marker) {
    drawn.push(Decoration.widget($pos.start(), () => syntaxToken(marker), {
      side: -20, ignoreSelection: true, marks: [], key: "md-block", syntax: marker,
    }));
  }
  for (const span of syntaxSpans(state.doc, $pos.pos)) {
    const open = delimiter(span.kind, "open", span.href);
    const close = delimiter(span.kind, "close", span.href);
    drawn.push(Decoration.widget(span.from, () => syntaxToken(open), {
      side: -1, ignoreSelection: true, marks: [], key: `md-open-${span.kind}-${span.from}`, syntax: open,
    }));
    drawn.push(Decoration.widget(span.to, () => syntaxToken(close, span.kind === "link" ? span.href ?? "" : undefined), {
      side: 1, ignoreSelection: true, marks: [], key: `md-close-${span.kind}-${span.to}`, syntax: close,
    }));
  }
  return drawn.length ? DecorationSet.create(state.doc, drawn) : DecorationSet.empty;
}

/** A second click on the link the caret is already in edits its address. */
export function syntaxPlugin(): Plugin {
  return new Plugin({
    props: {
      decorations: syntaxDecorations,
      handleDOMEvents: {
        mousedown(view, event) {
          if (!view.editable) return false;
          const target = event.target;
          const element = target instanceof Element ? target : target instanceof Node ? target.parentElement : null;
          const token = element?.closest<HTMLElement>("[data-edit-link]");
          if (token) {
            event.preventDefault();
            view.dom.dispatchEvent(new CustomEvent("xmatrix-edit-link", {
              bubbles: true, detail: { href: token.dataset.editLink ?? "" },
            }));
            return true;
          }
          return false;
        },
      },
    },
  });
}

function edgeSpan(state: EditorState, edge: "from" | "to"): SyntaxSpan | null {
  const pos = state.selection.from;
  const spans = syntaxSpans(state.doc, pos).filter((span) => span[edge] === pos);
  if (!spans.length) return null;
  return INNER_FIRST.map((kind) => spans.find((span) => span.kind === kind)).find(Boolean) ?? null;
}

function removeSpan(state: EditorState, dispatch: ((tr: Transaction) => void) | undefined, span: SyntaxSpan): boolean {
  dispatch?.(state.tr.removeMark(span.from, span.to, marks[span.kind]));
  return true;
}

/**
 * Backspace on the marker nearest the caret: a mark, then one heading level, then a quote, then an empty fence.
 * @testonly
 */
export const typoraBackspace: Command = (state, dispatch) => {
  const { $from, empty } = state.selection;
  if (!empty || !$from.parent.isTextblock) return false;
  const parent = $from.parent;
  if (parent.type === nodes.code_block && parent.content.size === 0 && $from.parentOffset === 0) {
    return setBlockType(nodes.paragraph)(state, dispatch);
  }
  if (parent.type.spec.code) return false;
  const opening = edgeSpan(state, "from");
  if (opening) return removeSpan(state, dispatch, opening);
  if ($from.parentOffset !== 0) return false;
  if (parent.type === nodes.heading) {
    const level = Number(parent.attrs.level);
    if (level > 1) {
      dispatch?.(state.tr.setNodeMarkup($from.before(), undefined, { ...parent.attrs, level: level - 1 }));
      return true;
    }
    return setBlockType(nodes.paragraph)(state, dispatch);
  }
  if ($from.depth >= 2 && $from.node($from.depth - 1).type === nodes.blockquote) return lift(state, dispatch);
  return false;
};

/**
 * Delete on a closing marker drops that mark.
 * @testonly
 */
export const typoraDelete: Command = (state, dispatch) => {
  const { $from, empty } = state.selection;
  if (!empty || !$from.parent.isTextblock || $from.parent.type.spec.code) return false;
  const closing = edgeSpan(state, "to");
  if (!closing) return false;
  return removeSpan(state, dispatch, closing);
};

export function typoraKeymap(): Plugin {
  return keymap({ Backspace: typoraBackspace, Delete: typoraDelete });
}

function markRule(pattern: RegExp, type: MarkType | MarkType[]): InputRule {
  return new InputRule(pattern, (state, match, start, end) => {
    const text = match[1];
    if (!text) return null;
    const types = Array.isArray(type) ? type : [type];
    const tr = state.tr.replaceWith(start, end, state.schema.text(text, types.map((item) => item.create())));
    for (const item of types) tr.removeStoredMark(item);
    return tr;
  });
}

/** A URL typed and followed by a space becomes a link, as in Google Docs. */
const autolink = new InputRule(/(?:^|\s)(https?:\/\/[^\s]+[^\s.,;:!?)\]])\s$/u, (state, match, _start, end) => {
  const url = match[1]!;
  const from = end - url.length - 1 + 1;
  const $from = state.doc.resolve(from);
  if ($from.parent.type.spec.code || marks.link.isInSet($from.marks())) return null;
  return state.tr.addMark(from, from + url.length, marks.link.create({ href: url })).insertText(" ", end);
});

/** The characters someone types, turned into structure. Block rules win over marks. */
export function markdownShortcuts(): Plugin {
  return inputRules({ rules: [
    textblockTypeInputRule(/^(#{1,6})\s$/u, nodes.heading, (match) => ({ level: match[1]!.length })),
    wrappingInputRule(/^\s*>\s$/u, nodes.blockquote),
    new InputRule(/^\s*\[( |x)\]\s$/u, (state, match, start, end) => {
      const tr = state.tr.delete(start, end);
      const range = tr.doc.resolve(start).blockRange();
      const wrapping = range && findWrapping(range, nodes.bullet_list);
      if (!range || !wrapping) return null;
      tr.wrap(range, wrapping);
      const $item = tr.doc.resolve(tr.mapping.map(start));
      for (let depth = $item.depth; depth > 0; depth--) {
        if ($item.node(depth).type === nodes.list_item) {
          tr.setNodeMarkup($item.before(depth), undefined, { checked: match[1] === "x" });
          break;
        }
      }
      return tr;
    }),
    wrappingInputRule(/^\s*([-+*])\s$/u, nodes.bullet_list),
    wrappingInputRule(/^(\d+)\.\s$/u, nodes.ordered_list, (match) => ({ order: Number(match[1]) }),
      (match, node) => node.childCount + (node.attrs.order as number) === Number(match[1])),
    textblockTypeInputRule(/^```([\w-]*)\s$/u, nodes.code_block, (match) => ({ language: match[1] ?? "" })),
    // Three dashes become a divider. Three stars stay text so bold italic can close.
    new InputRule(/^---$/u, (state, _match, start, end) => {
      const $start = state.doc.resolve(start);
      if ($start.parent.type !== nodes.paragraph || $start.depth !== 1) return null;
      return state.tr.replaceWith($start.before(), $start.after(), [nodes.horizontal_rule.create(), nodes.paragraph.create()])
        .delete(end, end);
    }),
    new InputRule(/!\[([^\]]*)\]\(([^)\s]+)\)/u, (state, match, start, end) => {
      if (state.doc.resolve(start).parent.type.spec.code) return null;
      return state.tr.replaceWith(start, end, nodes.image.create({ src: match[2], alt: match[1] ?? "" }));
    }),
    new InputRule(/\[([^\]]+)\]\(([^)\s]+)\)/u, (state, match, start, end) => {
      const label = match[1];
      const href = match[2];
      if (!label || !href) return null;
      const $start = state.doc.resolve(start);
      if ($start.parent.type.spec.code || marks.code.isInSet($start.marks())) return null;
      const tr = state.tr.replaceWith(start, end, state.schema.text(label, [marks.link.create({ href })]));
      return tr.removeStoredMark(marks.link);
    }),
    markRule(/\*\*\*([^*]+)\*\*\*$/u, [marks.strong, marks.em]),
    markRule(/(?<!\*)\*\*([^*]+)\*\*$/u, marks.strong),
    markRule(/__([^_\n]+?)__$/u, marks.strong),
    markRule(/(?<![*\w])\*([^*\s][^*]*)\*$/u, marks.em),
    markRule(/(?<![_\w])_([^_\s][^_]*)_$/u, marks.em),
    markRule(/~~([^~]+)~~$/u, marks.strike),
    markRule(/`([^`]+)`$/u, marks.code),
    autolink,
  ] });
}
