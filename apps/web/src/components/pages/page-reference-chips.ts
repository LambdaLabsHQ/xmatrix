import { messageReferenceSpans, type MessageReferenceSpan } from "@xmatrix/protocol";
import { pageSchema } from "@xmatrix/protocol/page-document";
import type { Node as DocNode } from "prosemirror-model";
import { type EditorState, Plugin, PluginKey } from "prosemirror-state";
import { Decoration, DecorationSet } from "prosemirror-view";

/**
 * `page:<id>` and `channel:<id>` in a page's text
 * (docs/design/pages-and-conversations.md §4.3) read as they do in a message:
 * a chip with the target's current name that opens it. The id stays the text
 * of the document, so a rename never breaks it; the reference the caret
 * touches shows as typed, like the markdown markers do.
 */
export interface PageReferenceTargets {
  /** The title of a page this reader can see. */
  pageTitle: (pageId: string) => string | null;
  /** The name of a channel this reader can see. */
  channelName: (channelId: string) => string | null;
  openPage: (pageId: string, blockId: string | null) => void;
  openChannel: (channelId: string) => void;
}

const ICONS = {
  page: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/>'
    + '<path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/>',
  channel: '<line x1="4" x2="20" y1="9" y2="9"/><line x1="4" x2="20" y1="15" y2="15"/>'
    + '<line x1="10" x2="8" y1="3" y2="21"/><line x1="16" x2="14" y1="3" y2="21"/>',
} as const;

/** What the chip says: null for a target this reader cannot see, which stays as typed. */
function referenceLabel(span: MessageReferenceSpan, targets: PageReferenceTargets): string | null {
  if (span.kind === "channel") return targets.channelName(span.channelId);
  const title = targets.pageTitle(span.pageId);
  if (title === null) return null;
  const heading = span.blockId ? `${title} › ${span.blockId}` : title;
  return span.revision === null ? heading : `${heading} · r${span.revision}`;
}

/** The message chip's markup (page-reference-chip.tsx), built for a place React does not draw. */
function referenceChip(span: MessageReferenceSpan, label: string, targets: PageReferenceTargets): HTMLButtonElement {
  const chip = document.createElement("button");
  chip.type = "button";
  chip.className = "app-page-reference-chip";
  chip.contentEditable = "false";
  chip.dataset.testid = `${span.kind}-reference-chip`;
  if (span.kind === "page") chip.dataset.pageId = span.pageId;
  else chip.dataset.channelId = span.channelId;
  chip.setAttribute("aria-label", `Open ${span.kind} ${label}`);
  chip.innerHTML = '<span class="app-page-reference-chip-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" '
    + `stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[span.kind]}</svg></span>`;
  const text = document.createElement("span");
  text.className = "app-page-reference-chip-label";
  text.textContent = label;
  chip.append(text);
  // The click opens the target and leaves the editor's selection where it was.
  chip.addEventListener("mousedown", (event) => event.preventDefault());
  chip.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (span.kind === "page") targets.openPage(span.pageId, span.blockId);
    else targets.openChannel(span.channelId);
  });
  return chip;
}

/** The references in a rendered page (its preview, before the editor has synced), drawn as chips. */
export function drawPageReferences(target: HTMLElement, targets: PageReferenceTargets): void {
  const walker = target.ownerDocument.createTreeWalker(target, NodeFilter.SHOW_TEXT);
  const texts: Text[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!node.parentElement?.closest("code, pre")) texts.push(node as Text);
  }
  for (const text of texts) {
    const value = text.data;
    const pieces: (string | Node)[] = [];
    let cursor = 0;
    for (const span of messageReferenceSpans(value)) {
      const label = referenceLabel(span, targets);
      if (label === null) continue;
      pieces.push(value.slice(cursor, span.start), referenceChip(span, label, targets));
      cursor = span.end;
    }
    if (cursor) text.replaceWith(...pieces, value.slice(cursor));
  }
}

interface DocReference { span: MessageReferenceSpan; from: number; to: number }

function docReferences(doc: DocNode): DocReference[] {
  const found: DocReference[] = [];
  doc.descendants((node, pos, parent) => {
    if (!node.isText || parent?.type.spec.code || pageSchema.marks.code.isInSet(node.marks)) return;
    for (const span of messageReferenceSpans(node.text ?? "")) {
      found.push({ span, from: pos + span.start, to: pos + span.end });
    }
  });
  return found;
}

export const referencesKey = new PluginKey("page-references");

/** `targets` is read on every draw; a transaction carrying `referencesKey` draws again when the names changed. */
export function referenceChips(targets: () => PageReferenceTargets | undefined): Plugin {
  let editable = () => false;
  let references: { doc: DocNode; found: DocReference[] } | null = null;
  let drawn: { doc: DocNode; key: string; set: DecorationSet } | null = null;
  let names = 0;
  const decorations = (state: EditorState): DecorationSet => {
    const current = targets();
    if (!current) return DecorationSet.empty;
    if (references?.doc !== state.doc) references = { doc: state.doc, found: docReferences(state.doc) };
    const { from, to } = state.selection;
    const shown = references.found.filter((reference) =>
      !(editable() && from <= reference.to && to >= reference.from));
    const key = `${names}:${shown.map((reference) => reference.from).join(",")}`;
    if (drawn?.doc === state.doc && drawn.key === key) return drawn.set;
    const set: Decoration[] = [];
    for (const { span, from: start, to: end } of shown) {
      const label = referenceLabel(span, current);
      if (label === null) continue;
      set.push(Decoration.inline(start, end, { class: "page-reference-source" }));
      set.push(Decoration.widget(start, () => referenceChip(span, label, current), {
        side: -1, ignoreSelection: true, marks: [], key: `reference:${span.text}:${label}`,
      }));
    }
    drawn = { doc: state.doc, key, set: DecorationSet.create(state.doc, set) };
    return drawn.set;
  };
  return new Plugin({
    key: referencesKey,
    state: {
      init: () => 0,
      apply(tr, value) {
        if (tr.getMeta(referencesKey) === undefined) return value;
        names += 1;
        return names;
      },
    },
    view(editor) {
      editable = () => editor.editable;
      return {};
    },
    props: { decorations },
  });
}
