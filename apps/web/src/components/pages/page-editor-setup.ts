import {
  markdownToPageDoc, pageDocBlockAt, pageDocBlocks, pageDocChanges, pageSchema,
} from "@xmatrix/protocol/page-document";
import { baseKeymap, chainCommands, exitCode, lift, setBlockType, toggleMark, wrapIn } from "prosemirror-commands";
import { dropCursor } from "prosemirror-dropcursor";
import { gapCursor } from "prosemirror-gapcursor";
import { keymap } from "prosemirror-keymap";
import type { Node as DocNode } from "prosemirror-model";
import { liftListItem, sinkListItem, splitListItem, wrapInList } from "prosemirror-schema-list";
import { type Command, type EditorState, Plugin, PluginKey, TextSelection, type Transaction } from "prosemirror-state";
import {
  addColumnAfter, addRowAfter, deleteColumn, deleteRow, deleteTable, goToNextCell, isInTable, tableEditing,
} from "prosemirror-tables";

export { addColumnAfter, addRowAfter, deleteColumn, deleteRow, deleteTable, isInTable };
import { Decoration, DecorationSet, type EditorView, type NodeView } from "prosemirror-view";
import {
  absolutePositionToRelativePosition, redo, relativePositionToAbsolutePosition, undo, yCursorPlugin, ySyncPlugin,
  ySyncPluginKey, yUndoPlugin,
} from "y-prosemirror";
import type { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";
import { automationChips } from "./page-automation-chips";
import { markdownShortcuts, syntaxPlugin, typoraKeymap } from "./page-editor-syntax";
import { mountSectionAgents, type SectionAgent } from "./page-section-agents";

/**
 * The page editor's behaviour (docs/design/pages-live-document.md §4): one
 * shared document, named cursors, and markdown typed the way Typora does.
 * Nothing here writes markdown; the page session derives it from the document.
 */
const { nodes, marks } = pageSchema;

export type BlockKind = "paragraph" | "h1" | "h2" | "h3" | "bullet" | "ordered" | "task" | "quote" | "code";

function listItemDepth(state: EditorState): number | null {
  const { $from } = state.selection;
  for (let depth = $from.depth; depth > 0; depth--) if ($from.node(depth).type === nodes.list_item) return depth;
  return null;
}

/** What the block the selection starts in is. */
export function blockKind(state: EditorState): BlockKind {
  const { $from } = state.selection;
  const item = listItemDepth(state);
  if (item !== null) {
    const list = $from.node(item - 1);
    if ($from.node(item).attrs.checked !== null) return "task";
    return list.type === nodes.ordered_list ? "ordered" : "bullet";
  }
  for (let depth = $from.depth; depth > 0; depth--) if ($from.node(depth).type === nodes.blockquote) return "quote";
  const parent = $from.parent;
  if (parent.type === nodes.heading) return parent.attrs.level === 1 ? "h1" : parent.attrs.level === 2 ? "h2" : "h3";
  if (parent.type === nodes.code_block) return "code";
  return "paragraph";
}

/** Marks every list item in the selection as a task (or back to a plain item). */
function setTask(checked: boolean | null): Command {
  return (state, dispatch) => {
    const { from, to } = state.selection;
    const tr = state.tr;
    state.doc.nodesBetween(from, to, (node, pos) => {
      if (node.type === nodes.list_item) tr.setNodeMarkup(pos, undefined, { ...node.attrs, checked });
    });
    if (!tr.docChanged) return false;
    dispatch?.(tr);
    return true;
  };
}

/** Makes the list items around the selection tasks, in the same transaction that created them. */
function markTasks(tr: Transaction): Transaction {
  const { from, to } = tr.selection;
  tr.doc.nodesBetween(Math.max(0, from - 2), Math.min(tr.doc.content.size, to), (node, pos) => {
    if (node.type === nodes.list_item && node.attrs.checked === null) {
      tr.setNodeMarkup(pos, undefined, { ...node.attrs, checked: false });
    }
  });
  return tr;
}

/** Turns the selection's blocks into `kind`, or back to paragraphs when they already are. */
export function setBlockKind(kind: BlockKind): Command {
  return (state, dispatch, view) => {
    const current = blockKind(state);
    const inList = current === "bullet" || current === "ordered" || current === "task";
    if (kind === current && kind !== "paragraph") {
      if (inList) return liftListItem(nodes.list_item)(state, dispatch, view);
      if (kind === "quote") return lift(state, dispatch);
      return setBlockType(nodes.paragraph)(state, dispatch, view);
    }
    switch (kind) {
      case "paragraph": return inList ? liftListItem(nodes.list_item)(state, dispatch, view)
        : setBlockType(nodes.paragraph)(state, dispatch, view);
      case "h1": case "h2": case "h3":
        return setBlockType(nodes.heading, { level: Number(kind[1]) })(state, dispatch, view);
      case "code": return setBlockType(nodes.code_block)(state, dispatch, view);
      case "quote": return wrapIn(nodes.blockquote)(state, dispatch, view);
      case "task":
        if (inList) return setTask(false)(state, dispatch, view);
        return wrapInList(nodes.bullet_list)(state, dispatch && ((tr) => dispatch(markTasks(tr))), view);
      case "bullet": case "ordered": {
        const type = kind === "bullet" ? nodes.bullet_list : nodes.ordered_list;
        if (inList) {
          // Switch the enclosing list's type, and drop task boxes when leaving a task list.
          const depth = listItemDepth(state)! - 1;
          const { $from } = state.selection;
          const tr = state.tr.setNodeMarkup($from.before(depth), type, type === nodes.ordered_list
            ? { order: 1, tight: $from.node(depth).attrs.tight } : { tight: $from.node(depth).attrs.tight });
          $from.node(depth).forEach((item, offset) => {
            if (item.attrs.checked !== null) {
              tr.setNodeMarkup($from.start(depth) + offset, undefined, { ...item.attrs, checked: null });
            }
          });
          dispatch?.(tr);
          return true;
        }
        return wrapInList(type)(state, dispatch, view);
      }
    }
  };
}

export const insertRule: Command = (state, dispatch) => {
  dispatch?.(state.tr.replaceSelectionWith(nodes.horizontal_rule.create()).scrollIntoView());
  return true;
};

export const insertTable: Command = (state, dispatch) => {
  const cell = (header: boolean) => (header ? nodes.table_header : nodes.table_cell).create();
  const row = (header: boolean) => nodes.table_row.create(null, [cell(header), cell(header), cell(header)]);
  const table = nodes.table.create(null, [row(true), row(false), row(false)]);
  if (!dispatch) return true;
  const tr = state.tr.replaceSelectionWith(table);
  const inserted = tr.mapping.map(state.selection.from, -1);
  dispatch(tr.setSelection(TextSelection.near(tr.doc.resolve(inserted + 3))).scrollIntoView());
  return true;
};

/** Sets or clears the link on the selection; an empty href removes it. */
export function setLink(href: string): Command {
  return (state, dispatch) => {
    const { from, to, empty } = state.selection;
    if (!dispatch) return true;
    const trimmed = href.trim();
    if (empty) {
      if (!trimmed) return false;
      const text = state.schema.text(trimmed, [marks.link.create({ href: trimmed })]);
      dispatch(state.tr.replaceSelectionWith(text, false));
      return true;
    }
    const tr = state.tr.removeMark(from, to, marks.link);
    if (trimmed) tr.addMark(from, to, marks.link.create({ href: trimmed }));
    dispatch(tr);
    return true;
  };
}

export function linkAt(state: EditorState): string | null {
  const { $from, from, to, empty } = state.selection;
  const found = empty ? marks.link.isInSet($from.marks()) : null;
  if (found) return found.attrs.href as string;
  let href: string | null = null;
  state.doc.nodesBetween(from, to, (node) => {
    const mark = marks.link.isInSet(node.marks);
    if (mark) href = mark.attrs.href as string;
  });
  return href;
}

/** Pasting a URL over selected text links the text instead of replacing it. */
const pasteLink = new Plugin({
  props: {
    handlePaste(view, event) {
      const text = event.clipboardData?.getData("text/plain")?.trim() ?? "";
      const { empty, from, to } = view.state.selection;
      if (empty || !/^https?:\/\/\S+$/u.test(text) || view.state.selection.$from.parent.type.spec.code) return false;
      view.dispatch(view.state.tr.addMark(from, to, marks.link.create({ href: text })));
      return true;
    },
  },
});

/** A `- [ ] ` typed at the start of an item makes the item a task. */
const taskShortcut = new Plugin({
  appendTransaction(transactions, _old, state) {
    if (!transactions.some((tr) => tr.docChanged)) return null;
    const { $from } = state.selection;
    const item = $from.depth >= 2 ? $from.node($from.depth - 1) : null;
    if (item?.type !== nodes.list_item || item.attrs.checked !== null) return null;
    const match = /^\[( |x)\] $/u.exec($from.parent.textContent);
    if (!match || $from.parentOffset !== match[0].length) return null;
    return state.tr.delete($from.start(), $from.pos)
      .setNodeMarkup($from.before($from.depth - 1), undefined, { ...item.attrs, checked: match[1] === "x" });
  },
});

function editorKeymap(): Plugin {
  const hardBreak: Command = chainCommands(exitCode, (state, dispatch) => {
    dispatch?.(state.tr.replaceSelectionWith(nodes.hard_break.create()).scrollIntoView());
    return true;
  });
  return keymap({
    "Mod-z": undo, "Shift-Mod-z": redo, "Mod-y": redo,
    "Mod-b": toggleMark(marks.strong), "Mod-i": toggleMark(marks.em), "Mod-e": toggleMark(marks.code),
    "Shift-Mod-x": toggleMark(marks.strike),
    "Mod-Alt-0": setBlockKind("paragraph"), "Mod-Alt-1": setBlockKind("h1"), "Mod-Alt-2": setBlockKind("h2"),
    "Mod-Alt-3": setBlockKind("h3"),
    "Shift-Mod-7": setBlockKind("ordered"), "Shift-Mod-8": setBlockKind("bullet"), "Shift-Mod-9": setBlockKind("task"),
    "Shift-Enter": hardBreak, "Mod-Enter": hardBreak,
    Enter: splitListItem(nodes.list_item),
    Tab: chainCommands(goToNextCell(1), sinkListItem(nodes.list_item)),
    "Shift-Tab": chainCommands(goToNextCell(-1), liftListItem(nodes.list_item)),
  });
}

/** A task item draws a checkbox that anyone who can edit may tick. */
class ListItemView implements NodeView {
  dom: HTMLLIElement;
  contentDOM: HTMLElement;
  private box: HTMLInputElement | null = null;

  constructor(private node: DocNode, private view: EditorView, private getPos: () => number | undefined) {
    this.dom = document.createElement("li");
    this.contentDOM = document.createElement("div");
    this.render();
  }

  private render() {
    this.dom.replaceChildren();
    const task = this.node.attrs.checked !== null;
    this.dom.className = task ? "page-task" : "";
    this.dom.dataset.checked = task ? String(this.node.attrs.checked) : "";
    this.box = null;
    if (task) {
      const box = document.createElement("input");
      box.type = "checkbox";
      box.contentEditable = "false";
      box.checked = this.node.attrs.checked === true;
      box.addEventListener("mousedown", (event) => event.preventDefault());
      box.addEventListener("click", (event) => {
        event.preventDefault();
        const pos = this.getPos();
        if (pos === undefined || !this.view.editable) return;
        this.view.dispatch(this.view.state.tr.setNodeMarkup(pos, undefined,
          { ...this.node.attrs, checked: !this.node.attrs.checked }));
      });
      this.box = box;
      this.dom.append(box);
    }
    this.dom.append(this.contentDOM);
  }

  update(node: DocNode) {
    if (node.type !== this.node.type) return false;
    const wasTask = this.node.attrs.checked !== null;
    this.node = node;
    if (wasTask !== (node.attrs.checked !== null)) this.render();
    else if (this.box) this.box.checked = node.attrs.checked === true;
    this.dom.dataset.checked = node.attrs.checked === null ? "" : String(node.attrs.checked);
    return true;
  }

  ignoreMutation(mutation: { type: string; target: Node }) {
    return mutation.type === "attributes" || mutation.target === this.box;
  }
}

function placeholder(text: string): Plugin {
  return new Plugin({
    props: {
      decorations(state) {
        const doc = state.doc;
        if (doc.childCount !== 1 || doc.firstChild!.type !== nodes.paragraph || doc.firstChild!.content.size) return null;
        return DecorationSet.create(doc, [Decoration.node(0, doc.firstChild!.nodeSize,
          { class: "page-placeholder", "data-placeholder": text })]);
      },
    },
  });
}

/** How long a page sits in a hidden tab before its reader shows as idle. */
export const IDLE_AFTER_MS = 10 * 60_000;

/**
 * Tells everyone on the page which section this person is in, and whether
 * they are reading or writing it (§3 presence).
 */
function presence(awareness: Awareness, onBlockChange?: (blockId: string) => void): Plugin {
  let lastBlock: string | null = null;
  let lastActivity: string | null = null;
  return new Plugin({
    view: () => {
      // Ten minutes in a hidden tab makes this person idle, as Google Docs dims them; back on the tab, they are not.
      let away: number | undefined;
      const visibility = () => {
        window.clearTimeout(away);
        if (document.visibilityState === "hidden") {
          away = window.setTimeout(() => awareness.setLocalStateField("idle", true), IDLE_AFTER_MS);
        } else if (awareness.getLocalState()?.idle) {
          awareness.setLocalStateField("idle", false);
        }
      };
      document.addEventListener("visibilitychange", visibility);
      return {
        destroy: () => { document.removeEventListener("visibilitychange", visibility); window.clearTimeout(away); },
        update(view, previous) {
          const changed = !view.state.doc.eq(previous.doc);
          if (!changed && view.state.selection.eq(previous.selection)) return;
          const block = pageDocBlockAt(view.state.doc, view.state.selection.head);
          const activity = changed ? "editing" : "viewing";
          if (block === lastBlock && activity === lastActivity) return;
          lastBlock = block;
          lastActivity = activity;
          awareness.setLocalStateField("block", block);
          awareness.setLocalStateField("activity", activity);
          onBlockChange?.(block);
        },
      };
    },
  });
}

/**
 * What the page shows beside a section's heading (§3.2): who is on it, who has
 * taken it and what it owes. As in Google Docs the text itself carries nothing
 * else; who changed it and when is in History.
 */
export interface SectionNote {
  /** Claimed work ended after the section last changed and nobody wrote it back (§5). */
  owed?: { text: string; conversation: { id: string; name: string } | null };
  /** Agents live in a conversation linked to the section, whether or not they have the page open. */
  working?: SectionAgent[];
  /** Who has taken the section. */
  claim?: { label: string; pullRequestUrl: string | null; claimId: string; mine: boolean } | null;
  /** Conversations about the section, the quiet ones too (§4.4). */
  conversations?: { total: number; quiet: number };
}

/** What a heading offers when it is hovered or holds the cursor (§3.2). */
export interface HeadingActions {
  canEdit: boolean;
  discuss?: (blockId: string) => void;
  copyLink?: (blockId: string) => void;
  claim?: (blockId: string) => void;
  release?: (claimId: string) => void;
  attach?: (blockId: string) => void;
  /** Lists the section's conversations, the quiet ones too. */
  showConversations?: (blockId: string) => void;
}

export const sectionsKey = new PluginKey<{ notes: Map<string, SectionNote>; decorations: DecorationSet }>("page-sections");

// Lucide's icons, drawn here because widgets are plain DOM.
const ICONS = {
  discuss: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/><path d="M12 7v6"/><path d="M9 10h6"/>',
  link: '<path d="M9 17H7A5 5 0 0 1 7 7h2"/><path d="M15 7h2a5 5 0 1 1 0 10h-2"/><line x1="8" x2="16" y1="12" y2="12"/>',
  flag: '<path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" x2="4" y1="22" y2="15"/>',
  schedule: '<path d="M16 14v2.2l1.6 1"/><path d="M16 2v4"/><path d="M21 7.5V6a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h3.5"/>'
    + '<path d="M3 10h5"/><path d="M8 2v4"/><circle cx="16" cy="16" r="6"/>',
  talk: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
} as const;

function icon(name: keyof typeof ICONS, size = 14): string {
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2" `
    + `stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;
}

/** A control in a widget: it acts without moving the editor's selection. */
function control(className: string, label: string, run: () => void, content: string, text?: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = className;
  button.title = label;
  button.setAttribute("aria-label", label);
  button.innerHTML = content;
  if (text) button.append(text);
  button.addEventListener("mousedown", (event) => event.preventDefault());
  button.addEventListener("click", (event) => { event.preventDefault(); run(); });
  return button;
}

/** Takes down the React stack in a heading's widget when the editor drops the widget. */
const unmountAgents = new WeakMap<Element, () => void>();

function sectionDecorations(doc: DocNode, notes: Map<string, SectionNote>,
  openConversation: (conversationId: string) => void, actions: () => HeadingActions): DecorationSet {
  const blocks = pageDocBlocks(doc);
  const decorations: Decoration[] = [];
  blocks.forEach((block) => {
    const heading = doc.nodeAt(block.pos)!;
    const end = block.pos + heading.nodeSize - 1;
    const note = notes.get(block.id) ?? {};
    const working = note.working ?? [];
    const claim = note.claim ?? null;
    const owed = note.owed ?? null;
    const total = note.conversations?.total ?? 0;
    decorations.push(Decoration.widget(end, () => {
      const holder = document.createElement("span");
      holder.className = "page-section-present";
      holder.contentEditable = "false";
      if (claim) {
        const flag = document.createElement(claim.pullRequestUrl ? "a" : "span");
        flag.className = "page-section-claim";
        flag.dataset.testid = "page-claim";
        flag.title = `${claim.label} is on this`;
        flag.innerHTML = icon("flag", 12);
        flag.append(claim.label);
        if (flag instanceof HTMLAnchorElement) {
          flag.href = claim.pullRequestUrl!;
          flag.target = "_blank";
          flag.rel = "noreferrer";
        }
        holder.append(flag);
      }
      // Where the claim was, once its work ended and nobody wrote it back; it opens the conversation that did it.
      if (owed && !claim) {
        const conversation = owed.conversation;
        const flag = control("page-section-owed", conversation ? `${owed.text} · open ${conversation.name}` : owed.text,
          () => { if (conversation) openConversation(conversation.id); }, icon("flag", 12), "Update owed");
        flag.dataset.testid = "page-owed";
        holder.append(flag);
      }
      if (working.length > 0) {
        const agents = document.createElement("span");
        agents.className = "page-section-agents";
        // Opening a conversation from here leaves the editor's selection where it was.
        agents.addEventListener("mousedown", (event) => event.preventDefault());
        unmountAgents.set(agents, mountSectionAgents(agents, working, openConversation));
        holder.append(agents);
      }
      if (total) {
        holder.append(control("page-section-talk", `${total} ${total === 1 ? "conversation" : "conversations"} about this section`,
          () => actions().showConversations?.(block.id), icon("talk", 12), String(total)));
      }
      return holder;
    }, { side: 1, ignoreSelection: true, key: `present:${block.id}:${JSON.stringify([working, claim, owed, total])}`,
      destroy: (node) => {
        const agents = (node as HTMLElement).querySelector(".page-section-agents");
        if (agents) unmountAgents.get(agents)?.();
      } }));
    decorations.push(Decoration.widget(end, () => {
      const current = actions();
      const tools = document.createElement("span");
      tools.className = "page-heading-tools";
      tools.contentEditable = "false";
      if (current.discuss) tools.append(control("", "Discuss this section", () => current.discuss!(block.id), icon("discuss")));
      if (current.copyLink) tools.append(control("", "Copy a link to this section", () => current.copyLink!(block.id), icon("link")));
      if (current.canEdit && claim?.mine && current.release) {
        tools.append(control("", "Release your claim", () => current.release!(claim.claimId), icon("flag"), "Release"));
      } else if (current.canEdit && !claim && current.claim) {
        tools.append(control("", "Claim: tell everyone you are working on this section", () => current.claim!(block.id),
          icon("flag")));
      }
      if (current.canEdit && current.attach) {
        tools.append(control("", "Attach a schedule or a repository to this section", () => current.attach!(block.id),
          icon("schedule")));
      }
      return tools;
    }, { side: 2, ignoreSelection: true,
      key: `tools:${block.id}:${claim?.claimId ?? ""}:${String(claim?.mine)}:${String(actions().canEdit)}` }));
  });
  return DecorationSet.create(doc, decorations);
}

function sectionOverlay(openConversation: (conversationId: string) => void, actions: () => HeadingActions): Plugin {
  return new Plugin({
    key: sectionsKey,
    state: {
      init: (_config, state) => ({ notes: new Map<string, SectionNote>(), decorations: DecorationSet.create(state.doc, []) }),
      apply(tr, value, _old, state) {
        const notes = (tr.getMeta(sectionsKey) as Map<string, SectionNote> | undefined) ?? value.notes;
        if (notes === value.notes && !tr.docChanged) return value;
        return { notes, decorations: sectionDecorations(state.doc, notes, openConversation, actions) };
      },
    },
    props: { decorations: (state) => sectionsKey.getState(state)?.decorations },
  });
}

/** Marks the heading of the section the cursor is in, so its tools show without hovering (on a phone too). */
function currentHeading(): Plugin {
  return new Plugin({
    props: {
      decorations(state) {
        const blockId = pageDocBlockAt(state.doc, state.selection.head);
        const block = blockId ? pageDocBlocks(state.doc).find((entry) => entry.id === blockId) : undefined;
        if (!block) return null;
        const heading = state.doc.nodeAt(block.pos);
        return heading ? DecorationSet.create(state.doc, [Decoration.node(block.pos, block.pos + heading.nodeSize,
          { class: "page-heading-current" })]) : null;
      },
    },
  });
}

/**
 * Discussions anchored in the text (§4.3): the passage is highlighted, and
 * a bubble beside it opens the conversation where the margin does not show
 * it. Anchors are Yjs relative positions, so they follow edits; one whose
 * text is gone is not drawn.
 */
export interface Discussion { linkId: string; conversationId: string; name: string; from: unknown; to: unknown }

export const discussionsKey = new PluginKey<{ discussions: Discussion[]; focused: string | null;
  decorations: DecorationSet }>("page-discussions");

function yMapping(state: EditorState): Map<unknown, unknown> | null {
  const sync = ySyncPluginKey.getState(state) as { binding?: { mapping: Map<unknown, unknown> } } | undefined;
  return sync?.binding?.mapping ?? null;
}

function anchorPosition(state: EditorState, fragment: Y.XmlFragment, position: unknown): number | null {
  const mapping = yMapping(state);
  if (!mapping || !fragment.doc) return null;
  try {
    const at = relativePositionToAbsolutePosition(fragment.doc, fragment, Y.createRelativePositionFromJSON(position),
      mapping as never);
    return at === null || at > state.doc.content.size ? null : at;
  } catch {
    return null;
  }
}

function discussionDecorations(state: EditorState, fragment: Y.XmlFragment, discussions: Discussion[],
  focused: string | null, openConversation: (conversationId: string) => void): DecorationSet {
  const decorations: Decoration[] = [];
  for (const discussion of discussions) {
    const from = anchorPosition(state, fragment, discussion.from);
    const to = anchorPosition(state, fragment, discussion.to);
    if (from === null || to === null || to <= from) continue;
    decorations.push(Decoration.inline(from, to, {
      class: discussion.conversationId === focused ? "page-discussion page-discussion-focus" : "page-discussion",
      "data-link": discussion.linkId, "data-conversation": discussion.conversationId,
    }));
    decorations.push(Decoration.widget(to, () => {
      const bubble = control("page-discussion-bubble", `Open the discussion ${discussion.name}`,
        () => openConversation(discussion.conversationId), icon("talk"));
      bubble.contentEditable = "false";
      bubble.dataset.link = discussion.linkId;
      return bubble;
    }, { side: 1, ignoreSelection: true, key: `discussion:${discussion.linkId}:${discussion.name}` }));
  }
  return DecorationSet.create(state.doc, decorations);
}

function discussionOverlay(fragment: Y.XmlFragment, openConversation: (conversationId: string) => void,
  focusConversation: (conversationId: string) => void): Plugin {
  return new Plugin({
    key: discussionsKey,
    state: {
      init: (_config, state) => ({ discussions: [] as Discussion[], focused: null as string | null,
        decorations: DecorationSet.create(state.doc, []) }),
      apply(tr, value, _old, state) {
        const meta = tr.getMeta(discussionsKey) as { discussions?: Discussion[]; focused?: string | null } | undefined;
        const discussions = meta?.discussions ?? value.discussions;
        const focused = meta && "focused" in meta ? meta.focused ?? null : value.focused;
        if (discussions === value.discussions && focused === value.focused && !tr.docChanged) return value;
        return { discussions, focused,
          decorations: discussionDecorations(state, fragment, discussions, focused, openConversation) };
      },
    },
    props: {
      decorations: (state) => discussionsKey.getState(state)?.decorations,
      // Clicking a highlighted passage brings its conversation forward in the margin; the caret goes there as usual.
      handleClick: (_view, _pos, event) => {
        const passage = (event.target as HTMLElement | null)?.closest<HTMLElement>(".page-discussion");
        if (passage?.dataset.conversation) focusConversation(passage.dataset.conversation);
        return false;
      },
    },
  });
}

/**
 * Where each anchor the margin places a conversation by is (§4.4), as an
 * offset from the top of `frame`: discussions by their passage, sections by
 * their heading, the whole page by the start of the document. Everyone else
 * with a caret on the page is placed by it, as `client:<awareness id>`.
 */
export function anchorOffsets(view: EditorView, fragment: Y.XmlFragment, frame: HTMLElement,
  discussions: readonly Discussion[], awareness: Awareness): Map<string, number> {
  const origin = frame.getBoundingClientRect().top;
  const out = new Map<string, number>([["page", view.dom.getBoundingClientRect().top - origin]]);
  for (const block of pageDocBlocks(view.state.doc)) {
    const dom = view.nodeDOM(block.pos);
    if (dom instanceof HTMLElement) out.set(`block:${block.id}`, dom.getBoundingClientRect().top - origin);
  }
  for (const discussion of discussions) {
    const from = anchorPosition(view.state, fragment, discussion.from);
    if (from === null) continue;
    try {
      out.set(`text:${discussion.linkId}`, view.coordsAtPos(from).top - origin);
    } catch {
      // A position the view cannot draw (mid-update) is measured on the next frame.
    }
  }
  for (const [clientId, state] of awareness.getStates()) {
    const head = (state as { cursor?: { head?: unknown } | null }).cursor?.head;
    if (clientId === awareness.clientID || !head) continue;
    const at = anchorPosition(view.state, fragment, head);
    if (at === null) continue;
    try {
      out.set(`client:${clientId}`, view.coordsAtPos(at).top - origin);
    } catch {
      // As above.
    }
  }
  return out;
}

/** The selection as a discussion anchor: its text, and where it is in the live document. */
export function selectionAnchor(state: EditorState, fragment: Y.XmlFragment):
  { quote: string; from: unknown; to: unknown } | null {
  const { from, to, empty } = state.selection;
  const mapping = yMapping(state);
  if (empty || !mapping) return null;
  const quote = state.doc.textBetween(from, to, " ", " ").trim();
  if (!quote) return null;
  return {
    quote: quote.slice(0, 1000),
    from: Y.relativePositionToJSON(absolutePositionToRelativePosition(from, fragment, mapping as never)),
    to: Y.relativePositionToJSON(absolutePositionToRelativePosition(to, fragment, mapping as never)),
  };
}

/** Scrolls a section into view, for following someone on the page. */
export function scrollToSection(view: EditorView, blockId: string): void {
  const block = pageDocBlocks(view.state.doc).find((entry) => entry.id === blockId);
  const dom = view.nodeDOM(block?.pos ?? 0);
  if (dom instanceof HTMLElement) dom.scrollIntoView({ block: "center", behavior: "smooth" });
}

/**
 * How someone else's caret shows, from their awareness: hidden, or shown and
 * whether they are idle. An Agent's caret rests at its last edit only while
 * its Run is live; a person's is idle while their page sits in a hidden tab.
 */
export type CursorPresence = (state: object) => "active" | "idle" | null;

/**
 * Someone else's caret with their name on it, as in Google Docs: the name
 * shows while they move or type and fades a few seconds later, leaving the
 * caret with a square at its top; hovering the caret shows the name again.
 */
function namedCursor(user: { name?: string; color?: string; kind?: string; conversationId?: string | null },
  clientId: number, idle: boolean): HTMLElement {
  const cursor = document.createElement("span");
  cursor.className = `ProseMirror-yjs-cursor is-active${idle ? " is-idle" : ""}`;
  cursor.dataset.client = String(clientId);
  cursor.style.borderColor = user.color ?? "#888";
  cursor.style.color = user.color ?? "#888";
  const label = document.createElement("div");
  label.style.backgroundColor = user.color ?? "#888";
  label.textContent = user.name ?? "Someone";
  // An Agent's caret names the conversation it works from; its label opens it beside the page.
  if (user.kind === "agent" && user.conversationId) {
    label.dataset.conversation = user.conversationId;
    label.title = "Open its conversation";
  }
  cursor.append("\u2060", label, "\u2060");
  return cursor;
}

/**
 * Dims a caret while its owner is idle. The cursor plugin keeps a caret's
 * element for as long as it shows, so its state is set on the element.
 */
function cursorIdle(presenceOf: (clientId: number) => "active" | "idle" | null): Plugin {
  return new Plugin({
    view: () => ({
      update: (view) => {
        for (const cursor of view.dom.querySelectorAll<HTMLElement>(".ProseMirror-yjs-cursor[data-client]")) {
          cursor.classList.toggle("is-idle", presenceOf(Number(cursor.dataset.client)) === "idle");
        }
      },
    }),
  });
}

/** Opens the conversation an Agent's caret label names. */
function cursorConversations(openConversation: (conversationId: string) => void): Plugin {
  return new Plugin({
    props: {
      handleDOMEvents: {
        mousedown: (_view, event) => {
          const label = (event.target as HTMLElement | null)?.closest<HTMLElement>(".ProseMirror-yjs-cursor > [data-conversation]");
          if (!label?.dataset.conversation) return false;
          event.preventDefault();
          openConversation(label.dataset.conversation);
          return true;
        },
      },
    },
  });
}

/** Shows a person's cursor name again whenever their awareness changes (they moved or typed). */
function cursorActivity(awareness: Awareness): Plugin {
  return new Plugin({
    view: (view) => {
      const changed = ({ updated, added }: { updated: number[]; added: number[] }) => {
        for (const clientId of [...added, ...updated]) {
          for (const cursor of view.dom.querySelectorAll<HTMLElement>(`.ProseMirror-yjs-cursor[data-client="${clientId}"]`)) {
            cursor.classList.remove("is-active");
            // Restart the fade: the class comes back on the next frame.
            requestAnimationFrame(() => cursor.classList.add("is-active"));
          }
        }
      };
      awareness.on("change", changed);
      return { destroy: () => awareness.off("change", changed) };
    },
  });
}

/**
 * What someone else just wrote, tinted in their caret's colour and fading out
 * (pages-live-document.md §3.1), so a person sees where an Agent or another
 * person is changing the page. Each change is kept as Yjs positions of the
 * items they added, because a remote update redraws the whole document.
 */
interface RemoteChange { client: number; from: Y.RelativePosition; to: Y.RelativePosition; node: boolean; at: number }

export const REMOTE_CHANGE_MS = 4000;
const remoteChangesKey = new PluginKey<DecorationSet>("page-remote-changes");

function appendBlockChangeDecoration(
  decorations: Decoration[], state: EditorState, from: number, attrs: Record<string, string>,
): void {
  const node = state.doc.nodeAt(from);
  if (node && !node.isText) decorations.push(Decoration.node(from, from + node.nodeSize, attrs));
}

function remoteChangeDecorations(state: EditorState, fragment: Y.XmlFragment, awareness: Awareness,
  changes: readonly RemoteChange[], now: number): DecorationSet {
  const mapping = yMapping(state);
  if (!mapping || !fragment.doc || changes.length === 0) return DecorationSet.empty;
  const decorations: Decoration[] = [];
  for (const change of changes) {
    const user = (awareness.getStates().get(change.client) as { user?: { color?: string } } | undefined)?.user;
    // Text from someone who has left, or the session's own merges, is not anyone's to mark.
    if (!user?.color) continue;
    const resolve = (position: Y.RelativePosition) => {
      try {
        return relativePositionToAbsolutePosition(fragment.doc!, fragment, position, mapping as never);
      } catch {
        return null;
      }
    };
    const from = resolve(change.from);
    if (from === null || from >= state.doc.content.size) continue;
    const attrs = { class: "page-remote-change", "data-client": String(change.client),
      style: `--page-change-color: ${user.color}; animation-delay: -${Math.max(0, now - change.at)}ms` };
    if (change.node) {
      appendBlockChangeDecoration(decorations, state, from, attrs);
      continue;
    }
    const to = resolve(change.to);
    if (to !== null && to > from && to <= state.doc.content.size) decorations.push(Decoration.inline(from, to, attrs));
  }
  return DecorationSet.create(state.doc, decorations);
}

function remoteChanges(fragment: Y.XmlFragment, awareness: Awareness): Plugin {
  let changes: RemoteChange[] = [];
  return new Plugin({
    key: remoteChangesKey,
    state: {
      init: () => DecorationSet.empty,
      apply: (tr, value, _old, state) => tr.docChanged || tr.getMeta(remoteChangesKey)
        ? remoteChangeDecorations(state, fragment, awareness, changes, Date.now()) : value,
    },
    props: { decorations: (state) => remoteChangesKey.getState(state) },
    view: (view) => {
      let expiry = 0;
      let redraw = 0;
      const refresh = () => {
        if (redraw) return;
        // After the sync plugin has put the update into the editor, so the positions resolve against it.
        redraw = requestAnimationFrame(() => {
          redraw = 0;
          const now = Date.now();
          changes = changes.filter((change) => now - change.at < REMOTE_CHANGE_MS);
          view.dispatch(view.state.tr.setMeta(remoteChangesKey, true));
          window.clearTimeout(expiry);
          if (changes.length) expiry = window.setTimeout(refresh, REMOTE_CHANGE_MS - (now - changes[0]!.at) + 20);
        });
      };
      const observe = (events: Array<Y.YEvent<Y.XmlElement | Y.XmlText | Y.XmlFragment>>, transaction: Y.Transaction) => {
        // The update that first fills the document is the page arriving, not anyone writing.
        if (transaction.local || transaction.beforeState.size === 0) return;
        const at = Date.now();
        for (const event of events) {
          // A text event reports no added items in `changes`, so each type's items are asked directly.
          for (let item = event.target._start; item; item = item.right) {
            if (item.deleted || !item.countable || !event.adds(item)) continue;
            const { client, clock } = item.id;
            const node = item.content instanceof Y.ContentType;
            changes.push({ client, node, at, from: Y.createRelativePositionFromJSON({ item: { client, clock } }),
              to: Y.createRelativePositionFromJSON({ item: { client, clock: clock + item.length - 1 }, assoc: -1 }) });
          }
        }
        // Someone typing adds an item per keystroke; the newest few hundred are plenty to draw.
        if (changes.length > 400) changes = changes.slice(-400);
        refresh();
      };
      // An Agent's change can arrive before the presence that names it.
      const presenceChanged = () => { if (changes.length) refresh(); };
      fragment.observeDeep(observe);
      awareness.on("change", presenceChanged);
      return {
        destroy: () => {
          fragment.unobserveDeep(observe);
          awareness.off("change", presenceChanged);
          cancelAnimationFrame(redraw);
          window.clearTimeout(expiry);
        },
      };
    },
  });
}

/**
 * What changed since this reader last had the page on screen (§3.1): new text
 * appears and is tinted, text taken out is struck and folds away. Each change
 * plays when it first scrolls into view, so a change below the fold is not
 * spent before it is read. Positions are Yjs relative positions, because a
 * remote update redraws the whole document.
 */
interface ReaderChange {
  id: number;
  kind: "added" | "removed";
  block: boolean;
  from: Y.RelativePosition;
  to: Y.RelativePosition | null;
  text: string;
  /** When it began to play, staggered within the changes that came into view together; null until seen. */
  startsAt: number | null;
}

export const READER_CHANGE_MS = 4200;
const READER_STAGGER_MS = 60;
const READER_STAGGER_MAX_MS = 900;
export const readerChangesKey = new PluginKey<DecorationSet>("page-reader-changes");

function readerStyle(change: ReaderChange, now: number): string {
  return change.startsAt === null ? "animation-play-state: paused"
    : `animation-delay: ${change.startsAt - now}ms`;
}

function removedWidget(change: ReaderChange, now: number): HTMLElement {
  const element = document.createElement(change.block ? "div" : "span");
  element.className = `page-reader-removed${change.block ? " is-block" : ""}`;
  element.dataset.readerChange = String(change.id);
  element.contentEditable = "false";
  element.setAttribute("aria-hidden", "true");
  element.textContent = change.text.length > 280 ? `${change.text.slice(0, 280)}…` : change.text;
  element.setAttribute("style", readerStyle(change, now));
  return element;
}

function readerDecorations(state: EditorState, fragment: Y.XmlFragment, changes: readonly ReaderChange[],
  now: number): DecorationSet {
  const mapping = yMapping(state);
  if (!mapping || !fragment.doc || changes.length === 0) return DecorationSet.empty;
  const size = state.doc.content.size;
  const resolve = (position: Y.RelativePosition) => {
    try {
      return relativePositionToAbsolutePosition(fragment.doc!, fragment, position, mapping as never);
    } catch {
      return null;
    }
  };
  const decorations: Decoration[] = [];
  for (const change of changes) {
    const from = resolve(change.from);
    if (from === null || from > size) continue;
    if (change.kind === "removed") {
      decorations.push(Decoration.widget(from, () => removedWidget(change, now), {
        side: -1, ignoreSelection: true, marks: [], key: `reader-removed-${change.id}-${change.startsAt ?? "waiting"}`,
      }));
      continue;
    }
    const attrs = { class: change.block ? "page-reader-change is-block" : "page-reader-change",
      "data-reader-change": String(change.id), style: readerStyle(change, now) };
    if (change.block) {
      appendBlockChangeDecoration(decorations, state, from, attrs);
      continue;
    }
    const to = change.to ? resolve(change.to) : null;
    if (to !== null && to > from && to <= size) decorations.push(Decoration.inline(from, to, attrs));
  }
  return DecorationSet.create(state.doc, decorations);
}

function readerChanges(fragment: Y.XmlFragment): Plugin {
  let changes: ReaderChange[] = [];
  return new Plugin({
    key: readerChangesKey,
    state: {
      init: () => DecorationSet.empty,
      apply: (tr, value, _old, state) => {
        const set = tr.getMeta(readerChangesKey) as ReaderChange[] | true | undefined;
        if (Array.isArray(set)) changes = set;
        return tr.docChanged || set ? readerDecorations(state, fragment, changes, Date.now()) : value;
      },
    },
    props: { decorations: (state) => readerChangesKey.getState(state) },
    view: (view) => {
      let expiry = 0;
      const seen = new Set<number>();
      const redraw = () => view.dispatch(view.state.tr.setMeta(readerChangesKey, true));
      const expire = () => {
        const now = Date.now();
        const before = changes.length;
        changes = changes.filter((change) => change.startsAt === null || now - change.startsAt < READER_CHANGE_MS);
        if (changes.length !== before) redraw();
        window.clearTimeout(expiry);
        const next = Math.min(...changes.flatMap((change) => change.startsAt === null ? [] : [change.startsAt]));
        if (Number.isFinite(next)) expiry = window.setTimeout(expire, next + READER_CHANGE_MS - now + 20);
      };
      // The changes that came into view play together, top to bottom, each a moment after the last.
      const play = () => {
        if (document.visibilityState !== "visible" || seen.size === 0) return;
        const now = Date.now();
        let order = 0;
        for (const change of changes) {
          if (change.startsAt !== null || !seen.has(change.id)) continue;
          change.startsAt = now + Math.min(order++ * READER_STAGGER_MS, READER_STAGGER_MAX_MS);
        }
        seen.clear();
        if (order) { redraw(); expire(); }
      };
      const observer = typeof IntersectionObserver === "undefined" ? null : new IntersectionObserver((entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          seen.add(Number((entry.target as HTMLElement).dataset.readerChange));
          observer!.unobserve(entry.target);
        }
        play();
      });
      const observe = () => {
        const waiting = new Set(changes.filter((change) => change.startsAt === null).map((change) => String(change.id)));
        if (!waiting.size) return;
        observer?.disconnect();
        for (const element of view.dom.querySelectorAll<HTMLElement>("[data-reader-change]")) {
          if (!waiting.has(element.dataset.readerChange ?? "")) continue;
          if (observer) observer.observe(element);
          else seen.add(Number(element.dataset.readerChange));
        }
        if (!observer) play();
      };
      document.addEventListener("visibilitychange", play);
      return {
        update: (_view, previous) => {
          if (readerChangesKey.getState(view.state) !== readerChangesKey.getState(previous)) observe();
        },
        destroy: () => {
          observer?.disconnect();
          document.removeEventListener("visibilitychange", play);
          window.clearTimeout(expiry);
        },
      };
    },
  });
}

/**
 * Shows what changed since the revision the reader last had on screen, read as
 * its markdown, against the document the editor holds now.
 */
export function showReaderChanges(view: EditorView, fragment: Y.XmlFragment, baseline: string): void {
  const mapping = yMapping(view.state);
  if (!mapping) return;
  const relative = (pos: number) => absolutePositionToRelativePosition(pos, fragment, mapping as never);
  const changes = pageDocChanges(markdownToPageDoc(baseline), view.state.doc).map((change, id): ReaderChange =>
    change.kind === "added"
      ? { id, kind: "added", block: change.block, from: relative(change.from), to: change.block ? null : relative(change.to),
        text: "", startsAt: null }
      : { id, kind: "removed", block: change.block, from: relative(change.at), to: null, text: change.text,
        startsAt: null });
  view.dispatch(view.state.tr.setMeta(readerChangesKey, changes));
}

/** Whether `/` opened the insert menu, and what has been typed after it. */
export interface SlashState { from: number; to: number; query: string }
export const slashKey = new PluginKey<SlashState | null>("page-slash");

function slashMenu(): Plugin<SlashState | null> {
  return new Plugin<SlashState | null>({
    key: slashKey,
    state: {
      init: () => null,
      apply(tr, _value, _old, state) {
        if (tr.getMeta(slashKey) === "close") return null;
        const { $from, empty } = state.selection;
        if (!empty || !$from.parent.isTextblock || $from.parent.type === nodes.code_block) return null;
        const before = $from.parent.textBetween(0, $from.parentOffset, undefined, "￼");
        const match = /(?:^|\s)\/([^\s/]{0,24})$/u.exec(before);
        if (!match) return null;
        return { from: $from.pos - match[1]!.length - 1, to: $from.pos, query: match[1]! };
      },
    },
  });
}

export function editorPlugins(input: {
  fragment: Y.XmlFragment; awareness: Awareness; placeholder: string;
  onBlockChange?: (blockId: string) => void;
  handleKeyDown: (view: EditorView, event: KeyboardEvent) => boolean;
  openConversation: (conversationId: string) => void;
  /** Brings a discussion's card forward in the margin. */
  focusConversation: (conversationId: string) => void;
  headingActions: () => HeadingActions;
  cursorPresence: () => CursorPresence;
}): Plugin[] {
  const presenceOf = (clientId: number) => {
    const state = input.awareness.getStates().get(clientId);
    return state ? input.cursorPresence()(state) : null;
  };
  return [
    ySyncPlugin(input.fragment),
    yCursorPlugin(input.awareness, {
      awarenessStateFilter: (own: number, clientId: number) => own !== clientId && presenceOf(clientId) !== null,
      cursorBuilder: (user, clientId) => namedCursor(user, clientId, presenceOf(clientId) === "idle"),
    }),
    cursorActivity(input.awareness),
    cursorIdle(presenceOf),
    yUndoPlugin(),
    new Plugin({ props: { handleKeyDown: input.handleKeyDown } }),
    typoraKeymap(),
    slashMenu(),
    markdownShortcuts(),
    syntaxPlugin(),
    taskShortcut,
    pasteLink,
    editorKeymap(),
    keymap(baseKeymap),
    dropCursor(),
    gapCursor(),
    tableEditing(),
    placeholder(input.placeholder),
    presence(input.awareness, input.onBlockChange),
    sectionOverlay(input.openConversation, input.headingActions),
    currentHeading(),
    discussionOverlay(input.fragment, input.openConversation, input.focusConversation),
    cursorConversations(input.openConversation),
    remoteChanges(input.fragment, input.awareness),
    readerChanges(input.fragment),
    automationChips(input.openConversation),
  ];
}

export const nodeViews = {
  list_item: (node: DocNode, view: EditorView, getPos: () => number | undefined) => new ListItemView(node, view, getPos),
};
