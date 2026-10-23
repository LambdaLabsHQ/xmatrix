import {
  AGENT_PRESETS, agentFaceUrl, faceInitials, mentionAddressTokens, messageReferenceSpans, scanMentionAddresses,
  type MessageReferenceSpan,
} from "@xmatrix/protocol";
import { pageSchema } from "@xmatrix/protocol/page-document";
import type { Node as DocNode } from "prosemirror-model";
import { type EditorState, Plugin, PluginKey } from "prosemirror-state";
import { Decoration, DecorationSet } from "prosemirror-view";
import { mentionChipLabel } from "@/components/dashboard/mention-read-state";

/**
 * `page:<id>` and `channel:<id>` in a page's text
 * (docs/design/pages-and-conversations.md §4.3) read as they do in a message:
 * a chip with the target's current name that opens it. The id stays the text
 * of the document, so a rename never breaks it; the reference the caret
 * touches shows as typed, like the markdown markers do. An `@` naming an
 * Agent or a member of the Space reads as a message's mention chip does: its
 * face and name.
 */
export interface PageReferenceTargets {
  /** The title of a page this reader can see. */
  pageTitle: (pageId: string) => string | null;
  /** The name of a channel this reader can see. */
  channelName: (channelId: string) => string | null;
  openPage: (pageId: string, blockId: string | null) => void;
  openChannel: (channelId: string) => void;
  /** Whom an `@` in the text can name. */
  mentions?: PageMentions;
}

/** Someone an `@` names: the name and picture its chip shows. */
export interface PageMention { label: string; imageUrl: string | undefined }

/** Token → whom it names, tokens longest first as the shared grammar wants them. */
export interface PageMentions { tokens: readonly string[]; byToken: ReadonlyMap<string, PageMention> }

/** A member of the Space as an `@` names them: their name, their handle, and where their picture is read. */
export interface PageMentionMember { name?: string; handle?: string; imageUrl?: string }

/**
 * Whom a page's `@` can name: every Agent runtime by its harness, with its vendor face, and the Space's
 * members by their name and handle. A token two members share names no one.
 */
export function pageMentions(members: readonly PageMentionMember[], harnesses: readonly string[]): PageMentions {
  const byToken = new Map<string, PageMention>();
  const agents = [...AGENT_PRESETS.filter((preset) => preset.id !== "custom").map((preset) => preset.id), ...harnesses];
  for (const harness of agents) {
    for (const token of mentionAddressTokens([harness])) byToken.set(token, { label: harness, imageUrl: agentFaceUrl(harness) });
  }
  const shared = new Set<string>();
  for (const member of members) {
    const label = member.name?.trim() || member.handle;
    if (!label) continue;
    const mention = { label, imageUrl: member.imageUrl };
    for (const token of mentionAddressTokens([label, member.handle ?? ""])) {
      if (shared.has(token)) continue;
      const prior = byToken.get(token);
      if (prior && prior !== mention) {
        byToken.delete(token);
        shared.add(token);
      } else byToken.set(token, mention);
    }
  }
  return { tokens: mentionAddressTokens(byToken.keys()), byToken };
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
function referenceChip(span: MessageReferenceSpan, label: string, targets: PageReferenceTargets): HTMLSpanElement {
  // A span, not a <button>: a button is always an atomic inline box, so a label that wraps
  // (a narrow table column) became one tall pill instead of a capsule per line.
  const chip = document.createElement("span");
  chip.setAttribute("role", "button");
  chip.tabIndex = 0;
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
  const open = (event: Event) => {
    event.preventDefault();
    event.stopPropagation();
    if (span.kind === "page") targets.openPage(span.pageId, span.blockId);
    else targets.openChannel(span.channelId);
  };
  chip.addEventListener("click", open);
  chip.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") open(event);
  });
  return chip;
}

/** The message mention chip's markup (mention-read-chip.tsx), built for a place React does not draw. */
function mentionChip(text: string, mention: PageMention, token: string): HTMLSpanElement {
  const label = mentionChipLabel(text, mention.label, token);
  const chip = document.createElement("span");
  chip.className = "app-mention-chip";
  chip.contentEditable = "false";
  chip.dataset.testid = "page-mention-chip";
  chip.title = `@${label}`;
  const avatar = document.createElement("span");
  avatar.className = "app-mention-chip-avatar";
  const face = document.createElement("span");
  face.className = "app-mention-chip-avatar-face";
  face.setAttribute("aria-hidden", "true");
  const letter = () => {
    const initial = document.createElement("span");
    initial.className = "app-mention-chip-initial";
    initial.textContent = Array.from(faceInitials(mention.label))[0] ?? "@";
    return initial;
  };
  if (mention.imageUrl) {
    const image = document.createElement("img");
    image.src = mention.imageUrl;
    image.alt = "";
    image.draggable = false;
    image.referrerPolicy = "no-referrer";
    image.addEventListener("error", () => image.replaceWith(letter()), { once: true });
    face.append(image);
  } else face.append(letter());
  avatar.append(face);
  const name = document.createElement("span");
  name.className = "app-mention-chip-label";
  name.textContent = `@${label}`;
  chip.append(avatar, name);
  return chip;
}

/** A reference or a mention in a run of text, and the chip it reads as; null where it stays as typed. */
interface TextChip { start: number; end: number; key: string; draw: () => HTMLElement }

function textChips(value: string, targets: PageReferenceTargets): TextChip[] {
  const chips: TextChip[] = [];
  for (const span of messageReferenceSpans(value)) {
    const label = referenceLabel(span, targets);
    if (label !== null) {
      chips.push({ start: span.start, end: span.end, key: `reference:${span.text}:${label}`,
        draw: () => referenceChip(span, label, targets) });
    }
  }
  const mentions = targets.mentions;
  if (mentions && /[@＠]/u.test(value)) {
    for (const match of scanMentionAddresses(value, mentions.tokens)) {
      const mention = mentions.byToken.get(match.token);
      if (!mention) continue;
      const text = value.slice(match.start, match.end);
      chips.push({ start: match.start, end: match.end, key: `mention:${text}:${mention.label}:${mention.imageUrl ?? ""}`,
        draw: () => mentionChip(text, mention, match.token) });
    }
  }
  return chips.sort((a, b) => a.start - b.start);
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
    for (const chip of textChips(value, targets)) {
      pieces.push(value.slice(cursor, chip.start), chip.draw());
      cursor = chip.end;
    }
    if (cursor) text.replaceWith(...pieces, value.slice(cursor));
  }
}

interface DocReference { chip: TextChip; from: number; to: number }

function docReferences(doc: DocNode, targets: PageReferenceTargets): DocReference[] {
  const found: DocReference[] = [];
  doc.descendants((node, pos, parent) => {
    if (!node.isText || parent?.type.spec.code || pageSchema.marks.code.isInSet(node.marks)) return;
    for (const chip of textChips(node.text ?? "", targets)) {
      found.push({ chip, from: pos + chip.start, to: pos + chip.end });
    }
  });
  return found;
}

export const referencesKey = new PluginKey("page-references");

/** `targets` is read on every draw; a transaction carrying `referencesKey` draws again when the names changed. */
export function referenceChips(targets: () => PageReferenceTargets | undefined): Plugin {
  let editable = () => false;
  let references: { doc: DocNode; names: number; found: DocReference[] } | null = null;
  let drawn: { doc: DocNode; key: string; set: DecorationSet } | null = null;
  let names = 0;
  const decorations = (state: EditorState): DecorationSet => {
    const current = targets();
    if (!current) return DecorationSet.empty;
    if (references?.doc !== state.doc || references.names !== names) {
      references = { doc: state.doc, names, found: docReferences(state.doc, current) };
    }
    const { from, to } = state.selection;
    const shown = references.found.filter((reference) =>
      !(editable() && from <= reference.to && to >= reference.from));
    const key = `${names}:${shown.map((reference) => reference.from).join(",")}`;
    if (drawn?.doc === state.doc && drawn.key === key) return drawn.set;
    const set: Decoration[] = [];
    for (const { chip, from: start, to: end } of shown) {
      set.push(Decoration.inline(start, end, { class: "page-reference-source" }));
      set.push(Decoration.widget(start, chip.draw, { side: -1, ignoreSelection: true, marks: [], key: chip.key }));
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
