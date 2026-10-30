import { pageSchema } from "@xmatrix/protocol/page-document";
import type { Node as DocNode } from "prosemirror-model";
import { Plugin, PluginKey } from "prosemirror-state";
import { Decoration, DecorationSet } from "prosemirror-view";
import {
  highlightCode,
  highlightRuns,
  loadedHighlighter,
  loadHighlighter,
  type CodeInkRun,
} from "../dashboard/code-highlight";

/**
 * A page's code blocks take the same syntax inks as a code block in a conversation (code-highlight.ts): the
 * editor draws them as decorations over the text, and the static page paints its drawn code once.
 */

/** A fence's info string is its language and then any meta; the language is its first word. */
function fenceLanguage(info: unknown): string {
  return String(info ?? "").trim().split(/\s+/)[0] ?? "";
}

function hasCode(doc: DocNode): boolean {
  let found = false;
  doc.descendants((node) => {
    if (found || node.type === pageSchema.nodes.code_block) found = true;
    return !found && !node.isTextblock;
  });
  return found;
}

const key = new PluginKey<DecorationSet>("page-code-highlight");
// Nodes are immutable and shared between versions of the page, so a block that did not change keeps its runs.
const runsOf = new WeakMap<DocNode, CodeInkRun[] | null>();

function drawCode(doc: DocNode): DecorationSet {
  const hljs = loadedHighlighter();
  if (!hljs) return DecorationSet.empty;
  const drawn: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (node.type !== pageSchema.nodes.code_block) return !node.isTextblock;
    let runs = runsOf.get(node);
    if (runs === undefined) {
      runs = highlightRuns(hljs, node.textContent, fenceLanguage(node.attrs.language));
      runsOf.set(node, runs);
    }
    for (const run of runs ?? []) drawn.push(Decoration.inline(pos + 1 + run.from, pos + 1 + run.to, { class: run.className }));
    return false;
  });
  return DecorationSet.create(doc, drawn);
}

export function codeHighlight(): Plugin {
  return new Plugin<DecorationSet>({
    key,
    state: {
      init: (_config, state) => drawCode(state.doc),
      apply: (tr, set, _previous, state) => (tr.docChanged || tr.getMeta(key) ? drawCode(state.doc) : set),
    },
    props: { decorations: (state) => key.getState(state) },
    // highlight.js loads the first time the page holds a code block, then the blocks take their inks.
    view: (view) => {
      let live = true;
      const load = () => {
        if (loadedHighlighter() || !hasCode(view.state.doc)) return;
        void loadHighlighter().then(() => {
          if (live) view.dispatch(view.state.tr.setMeta(key, true));
        });
      };
      load();
      return { update: load, destroy: () => { live = false; } };
    },
  });
}

/** Paints the code blocks a static page drew (page-document-render.ts). */
export function highlightDrawnCode(root: HTMLElement): void {
  const blocks = [...root.querySelectorAll<HTMLElement>("pre > code")];
  if (!blocks.length) return;
  const paint = () => {
    const hljs = loadedHighlighter();
    if (!hljs) return;
    for (const code of blocks) {
      const html = highlightCode(hljs, code.textContent ?? "", fenceLanguage(code.parentElement?.dataset.language));
      if (html !== null) code.innerHTML = html;
    }
  };
  if (loadedHighlighter()) paint();
  else void loadHighlighter().then(paint);
}
