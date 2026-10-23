"use client";

import { useCallback, useEffect, useRef, useState, type MutableRefObject, type ReactNode } from "react";
import {
  markdownToPageDoc, pageDocBlockAt, pageDocBlocks, pageDocToMarkdown, pageSchema, pageSeenDoc, type PageDocBlock,
} from "@xmatrix/protocol/page-document";
import {
  BetweenHorizontalEnd, BetweenVerticalEnd, Code2, Columns3, FileCode2, Rows3, Trash2, Heading1, Heading2, Heading3, Link2,
  FileText, Hash, List, ListChecks, ListOrdered, MessageSquare, Minus, Pilcrow, Quote, Table,
} from "lucide-react";
import type { Node as DocNode, ResolvedPos } from "prosemirror-model";
import { toggleMark } from "prosemirror-commands";
import { EditorState, Selection, TextSelection, type Command } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { yCursorPluginKey, ySyncPluginKey } from "y-prosemirror";
import {
  channelReferenceToken, gitHubFileReferenceFrom, gitHubFileReferenceHref, pageBlocks, pageReferenceToken,
  type PageAuthor, type PageSummary, type SerializedAutomation,
} from "@xmatrix/protocol";
import { Face } from "@/components/dashboard/face";
import type { ChannelReference } from "@/components/dashboard/message-reference-catalog";
import {
  channelReferenceCandidates, pageReferenceCandidates, sectionReferenceCandidates, type ReferenceCandidate,
} from "@/components/dashboard/reference-complete";
import { PaperPopover } from "@/components/ui/material-surfaces";
import { sameValue } from "@/lib/same-value";
import type { PageLiveSession } from "@/lib/pages/page-client";
import { automationsKey } from "./page-automation-chips";
import type { ReadGitHubFile } from "./page-github-file-embeds";
import type { LocalMedia, PageMediaUrl, UploadPageMedia } from "./page-media";
import { referencesKey, type PageReferenceTargets } from "./page-reference-chips";
import { PageCommentBox } from "./page-comment-box";
import type { MarginAgent } from "./page-margin-model";
import { PageBlameLayer, PageByline, type PageBlameSource } from "./page-blame";
import { SectionAgentsInPage } from "./page-section-agents";
import type { PageSessionChanges } from "./page-session-changes";
import {
  addColumnAfter, addRowAfter, anchorOffsets, blockKind, caretBlockAnchor, deleteColumn, deleteRow, deleteTable, discussionsKey,
  editorPlugins, isInTable, insertRule, insertTable, linkAt, nodeViews, scrollToSection, showReaderChanges,
  sectionsKey, selectionAnchor, setBlockKind, setLink, type BlockKind, type CursorPresence, type Discussion,
  type HeadingActions, type SectionNote,
} from "./page-editor-setup";
import { insertReference, triggersKey, type PageTrigger } from "./page-triggers";
import type { WriteAgent } from "./page-write-with";
import {
  currentSuggestionTop, leaveSuggestion, pageSuggestions, showSuggestions, stepSuggestion, suggestionsKey,
  takeSuggestion, type PageSuggestion, type SuggestionsReport,
} from "./page-suggestions";

/** The page's own controls over the suggestions laid over it. */
export interface SuggestionControl { take(): void; leave(): void; step(by: -1 | 0 | 1): void }
/**
 * What of the page its reader has seen (pages-live-document.md §3.1): `see` takes in the blocks within
 * `area` (screen coordinates) as they are now, and says what the reader has seen of the page, and whether
 * that is all of it; `seeAll` takes in the whole page.
 */
export interface PageReading {
  see(area: { top: number; bottom: number }): { body: string; whole: boolean } | null;
  seeAll(): void;
}

export type { CursorPresence, Discussion, HeadingActions, SectionNote };

/**
 * The page, edited as a document (docs/design/pages-live-document.md §4):
 * markdown is typed, and the caret's line shows its markers. People and
 * Agents share one document with named cursors; the page session keeps its
 * markdown for Agents, revisions and git.
 */

/**
 * What a selected passage offers; the page view owns the action. Only Discuss: what acts on the whole
 * section (copying its link, who changed it) is the heading's, and asking an Agent is mentioning it in
 * the discussion.
 */
export interface PageSectionActions {
  /** A conversation about the section; from a selection, anchored to that text. */
  discuss?: (blockId: string, anchor?: PassageAnchor) => void;
  /**
   * A comment on a passage (§4.2): a discussion of the passage whose first message is the comment, which an
   * Agent takes and answers there and in the page.
   */
  comment?: (blockId: string, anchor: PassageAnchor, text: string) => void;
  /** The Agent at work on the page that takes a comment on the block, shown under the box. */
  commentTaker?: (blockId: string) => MarginAgent | undefined;
}

type PassageAnchor = { quote: string; from: unknown; to: unknown };

/** A comment being written on a passage, in the box under it. */
interface CommentDraft { blockId: string; anchor: PassageAnchor; left: number; top: number; text: string }

interface Toolbar {
  kind: BlockKind;
  link: string | null;
  empty: boolean;
  focused: boolean;
  /** The selection is in a table, which shows its row and column controls. */
  inTable: boolean;
  trigger: PageTrigger | null;
}

function readToolbar(view: EditorView): Toolbar {
  const { state } = view;
  return {
    kind: blockKind(state),
    link: linkAt(state),
    empty: state.selection.empty,
    inTable: isInTable(state),
    focused: view.hasFocus(),
    trigger: triggersKey.getState(state) ?? null,
  };
}

interface InsertItem { label: string; hint: string; keywords: string; icon: ReactNode; run: Command }

const INSERT_ITEMS: InsertItem[] = [
  { label: "Text", hint: "Plain paragraph", keywords: "text paragraph normal", icon: <Pilcrow />, run: setBlockKind("paragraph") },
  { label: "Heading 1", hint: "#", keywords: "heading title h1", icon: <Heading1 />, run: setBlockKind("h1") },
  { label: "Heading 2", hint: "##", keywords: "heading section h2", icon: <Heading2 />, run: setBlockKind("h2") },
  { label: "Heading 3", hint: "###", keywords: "heading subsection h3", icon: <Heading3 />, run: setBlockKind("h3") },
  { label: "Bulleted list", hint: "-", keywords: "bullet list unordered", icon: <List />, run: setBlockKind("bullet") },
  { label: "Numbered list", hint: "1.", keywords: "numbered ordered list", icon: <ListOrdered />, run: setBlockKind("ordered") },
  { label: "Checklist", hint: "[ ]", keywords: "todo task checklist checkbox", icon: <ListChecks />, run: setBlockKind("task") },
  { label: "Quote", hint: ">", keywords: "quote blockquote", icon: <Quote />, run: setBlockKind("quote") },
  { label: "Code", hint: "```", keywords: "code snippet", icon: <Code2 />, run: setBlockKind("code") },
  { label: "Table", hint: "3 × 3", keywords: "table grid", icon: <Table />, run: insertTable },
  { label: "Divider", hint: "---", keywords: "divider rule line hr", icon: <Minus />, run: insertRule },
  { label: "GitHub file", hint: "Embed", keywords: "github file embed repository code markdown", icon: <FileCode2 />,
    run: (_state, dispatch, editor) => {
      if (dispatch) editor?.dom.dispatchEvent(new CustomEvent("xmatrix-embed-github-file", { bubbles: true }));
      return true;
    } },
];

/** Puts a GitHub file's embed at the caret: a link the editor draws with the file below it (pages-live-document.md §6.5). */
function embedGitHubFile(text: string): Command | null {
  const reference = gitHubFileReferenceFrom(text);
  if (!reference) return null;
  return (state, dispatch) => {
    if (dispatch) {
      const link = pageSchema.marks.link.create({ href: gitHubFileReferenceHref(reference) });
      // Labelled with the file's name; the embed's header names its repository and path.
      const name = reference.path.slice(reference.path.lastIndexOf("/") + 1);
      dispatch(state.tr.replaceSelectionWith(pageSchema.text(name, [link]), false));
    }
    return true;
  };
}

/** What `[[`, `#` and `@` complete on a page, and what picking an Agent does. */
export interface PageCompletion {
  spaceId: string;
  pages: readonly PageSummary[];
  channels: readonly ChannelReference[];
  agents: readonly WriteAgent[];
  /** A page's title and markdown, for its sections after `[[page#`. */
  readPage: (pageId: string) => Promise<{ pageId: string; title: string; body: string }>;
  /** `@` picked an Agent: it comes to co-write the page from where it was mentioned, told nothing more. */
  summonAgent: (harness: string, blockId: string) => void;
}

/** One row of the menu typing opened. */
interface MenuItem { key: string; label: string; hint: string; icon: ReactNode; run: (view: EditorView) => void }

type PageSections = { pageId: string; title: string; blocks: ReturnType<typeof pageBlocks> };

function referenceItem(trigger: PageTrigger, candidate: ReferenceCandidate): MenuItem {
  const token = candidate.kind === "channel" ? channelReferenceToken(candidate.channelId)
    : pageReferenceToken(candidate.pageId, candidate.blockId);
  return {
    key: candidate.id, label: candidate.label, hint: candidate.detail,
    icon: candidate.kind === "channel" ? <Hash /> : <FileText />,
    run: (view) => { insertReference(trigger, token)(view.state, view.dispatch, view); },
  };
}

function triggerItems(trigger: PageTrigger, completion: PageCompletion | undefined,
  sections: ReadonlyMap<string, PageSections>): MenuItem[] {
  if (trigger.kind === "insert") {
    return matchingItems(trigger.query).map((item) => ({ key: item.label, label: item.label, hint: item.hint, icon: item.icon,
      run: (view) => {
        view.dispatch(view.state.tr.delete(trigger.from, trigger.to).setMeta(triggersKey, "close"));
        item.run(view.state, view.dispatch, view);
      } }));
  }
  if (!completion) return [];
  if (trigger.kind === "channel") {
    return channelReferenceCandidates(completion.channels, trigger.query, completion.spaceId, null)
      .map((candidate) => referenceItem(trigger, candidate));
  }
  if (trigger.kind === "page") {
    if (trigger.section === null) {
      return pageReferenceCandidates(completion.pages, trigger.query).map((candidate) => referenceItem(trigger, candidate));
    }
    const page = sectionPage(trigger, completion);
    const read = page ? sections.get(page) : undefined;
    return read ? sectionReferenceCandidates(read, read.blocks, trigger.section)
      .map((candidate) => referenceItem(trigger, candidate)) : [];
  }
  const wanted = trigger.query.toLowerCase();
  return completion.agents.filter((agent) => agent.harness.toLowerCase().includes(wanted))
    .sort((a, b) => Number(!a.harness.toLowerCase().startsWith(wanted)) - Number(!b.harness.toLowerCase().startsWith(wanted)))
    .map((agent) => ({
      key: agent.harness, label: agent.harness, hint: "Agent",
      icon: <Face of={{ kind: "agent", name: agent.harness, harness: agent.harness }} size="xs" shape="circle" glass={false}
        className="pointer-events-none rounded-full" />,
      // The mention stays in the page, and calls the Agent to co-write from there.
      run: (view) => {
        const blockId = pageDocBlockAt(view.state.doc, trigger.from);
        insertReference(trigger, `@${agent.harness}`)(view.state, view.dispatch, view);
        completion.summonAgent(agent.harness, blockId);
      },
    }));
}

/** The page `[[page#` names: the best match for what was typed before the `#`. */
function sectionPage(trigger: PageTrigger & { kind: "page" }, completion: PageCompletion): string | null {
  const best = pageReferenceCandidates(completion.pages, trigger.query)[0];
  return best?.kind === "page" ? best.pageId : null;
}

const MENU_LABELS: Record<PageTrigger["kind"], string> = {
  insert: "Insert", page: "Pages", channel: "Channels", agent: "Agents",
};

/** A menu starts again at its first row when what it lists changes. */
function triggerKey(trigger: PageTrigger | null): string {
  if (!trigger) return "";
  return `${trigger.kind}:${trigger.from}:${trigger.query}:${trigger.kind === "page" ? trigger.section ?? "" : ""}`;
}

function matchingItems(query: string): InsertItem[] {
  const needle = query.toLowerCase();
  return needle ? INSERT_ITEMS.filter((item) => item.keywords.includes(needle) || item.label.toLowerCase().includes(needle))
    : INSERT_ITEMS;
}

function ToolButton({ label, active = false, disabled = false, onRun, children }: {
  label: string; active?: boolean; disabled?: boolean; onRun: () => void; children: ReactNode;
}) {
  return (
    <button type="button" title={label} aria-label={label} aria-pressed={active} disabled={disabled}
      // Keep the editor's selection: the button acts on it.
      onMouseDown={(event) => event.preventDefault()} onClick={onRun}
      className={`flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors
        hover:text-foreground disabled:opacity-40 [&_svg]:size-4 ${active ? "text-foreground" : ""}`}>
      {children}
    </button>
  );
}

export function PageEditor({ session, canEdit, onBlockChange, onBlocks, actions, sections, follow, writeOn,
  onOpenConversation, discussions, automations, headingActions, focusedConversationId = null, onFocusConversation,
  onAnchorOffsets, cursorPresence, onReady, readerBaseline = null, readerShown = false, commentInMargin = false, onReaderChanges, onWrite, readFrom, reading,
  suggestions = null, onSuggestions, suggestionControl, readGitHubFile, references, completion, placeholder, mediaUrl,
  uploadMedia, onChanges, blame, writing }: {
  session: PageLiveSession;
  /** Who wrote what, shown where the reader rests or selects and under the title; without it the page does not say. */
  blame?: PageBlameSource;
  /** Whether one of the page's authors is changing it now. */
  writing?: (author: PageAuthor) => boolean;
  /** What an empty page asks for instead of its title: someone co-writing it asks for its first line. */
  placeholder?: string;
  canEdit: boolean;
  onBlockChange?: (blockId: string) => void;
  /** The page's sections, whenever they change. */
  onBlocks?: (blocks: PageDocBlock[]) => void;
  actions?: PageSectionActions;
  /** The page has a margin beside it: the comment box stands there, level with its passage, as a comment card does. */
  commentInMargin?: boolean;
  /** Who is on each section and when it last changed, drawn beside it. */
  sections?: Map<string, SectionNote>;
  /** A section to bring into view; a new `seq` follows again. */
  follow?: { blockId: string; seq: number } | null;
  /** Each new value puts the writer's caret at the end of the text, to go on writing there. */
  writeOn?: number;
  onOpenConversation?: (conversationId: string) => void;
  /** Open discussions anchored in the text. */
  discussions?: Discussion[];
  /** The page's Automations, drawn as chips where the text references them. */
  automations?: Map<string, SerializedAutomation>;
  /** What a heading offers: Discuss, Copy link, Claim, Attach. */
  headingActions?: HeadingActions;
  /** The conversation whose passage is marked, because its card is being read. */
  focusedConversationId?: string | null;
  onFocusConversation?: (conversationId: string) => void;
  /**
   * Where the margin's anchors are, from the top of the editor, whenever the
   * document or its layout moves them (pages-live-document.md §4.4).
   */
  onAnchorOffsets?: (offsets: Map<string, number>) => void;
  /** Which others' carets show, and which of them are idle; carets are drawn again when it changes. */
  cursorPresence?: CursorPresence;
  /** The editor is drawn and may take the place of the page's preview. */
  onReady?: () => void;
  /** The page as this reader last read it, as markdown, and the revision to diff it against: what changed since is shown as a diff. */
  readerBaseline?: { body: string; head: number } | null;
  /** Whether that diff is marked over the text; otherwise the page shows as it is and the changes are only counted. */
  readerShown?: boolean;
  /** Suggestions waiting on the page, laid over it change by change until the reader takes or leaves each. */
  suggestions?: readonly PageSuggestion[] | null;
  /** How many changes are left, which is in front of the reader, and whose. */
  onSuggestions?: (report: SuggestionsReport) => void;
  /** Lets the page's own controls take, leave or step through the changes. */
  suggestionControl?: MutableRefObject<SuggestionControl | null>;
  /** How many changes that diff shows. */
  onReaderChanges?: (count: number) => void;
  /** The changes Ctrl+Z steps back through, everyone's since the page opened; null once the editor is gone. */
  onChanges?: (changes: PageSessionChanges | null) => void;
  /** This person changed the text themselves, not someone else's change arriving. */
  onWrite?: () => void;
  /**
   * The page as its reader had seen it when it opened, as markdown; null when they had seen it as it opened.
   * Undefined until that is known; what they see from then on is taken in through `reading`.
   */
  readFrom?: string | null;
  reading?: MutableRefObject<PageReading | null>;
  /** Reads a GitHub file the page embeds, through the Hub. */
  readGitHubFile?: ReadGitHubFile;
  /** What `page:<id>` and `channel:<id>` in the text name and open. */
  references?: PageReferenceTargets;
  /** What typing `[[`, `#` and `@` offers. */
  completion?: PageCompletion;
  /** Where the page reads an image or video pasted into it. */
  mediaUrl?: PageMediaUrl;
  /** Uploads an image or video pasted or dropped into the page. */
  uploadMedia?: UploadPageMedia;
}) {
  const frame = useRef<HTMLDivElement | null>(null);
  const host = useRef<HTMLDivElement | null>(null);
  const wrote = useRef(onWrite);
  wrote.current = onWrite;
  const view = useRef<EditorView | null>(null);
  // The editor once it is drawn, for what is placed by it as it appears (the byline).
  const [drawnView, setDrawnView] = useState<EditorView | null>(null);
  const placeholderText = useRef(placeholder);
  useEffect(() => {
    placeholderText.current = placeholder;
    // Decorations are read on a transaction: an empty one draws the new hint.
    view.current?.dispatch(view.current.state.tr.setMeta("placeholder", placeholder));
  }, [placeholder]);
  const editable = useRef(canEdit);
  editable.current = canEdit;
  const blockChange = useRef(onBlockChange);
  blockChange.current = onBlockChange;
  const blocksChange = useRef(onBlocks);
  blocksChange.current = onBlocks;
  const openConversation = useRef(onOpenConversation);
  openConversation.current = onOpenConversation;
  const focusConversation = useRef(onFocusConversation);
  focusConversation.current = onFocusConversation;
  const heading = useRef<HeadingActions>(headingActions ?? { canEdit });
  heading.current = headingActions ?? { canEdit };
  const ready = useRef(onReady);
  ready.current = onReady;
  const readFile = useRef(readGitHubFile);
  readFile.current = readGitHubFile;
  const referenceTargets = useRef(references);
  referenceTargets.current = references;
  const media = useRef({ url: mediaUrl, upload: uploadMedia });
  media.current = { url: mediaUrl, upload: uploadMedia };
  // The files this writer pasted, shown from their own copy; let go with the editor.
  const [localMedia] = useState(() => new Map<string, LocalMedia>());
  useEffect(() => () => {
    for (const local of localMedia.values()) URL.revokeObjectURL(local.url);
    localMedia.clear();
  }, [localMedia]);
  const [mediaFailure, setMediaFailure] = useState<string | null>(null);
  const passageActions = useRef(actions);
  passageActions.current = actions;
  const inMargin = useRef(commentInMargin);
  inMargin.current = commentInMargin;
  const [commentDraft, setCommentDraftState] = useState<CommentDraft | null>(null);
  const draftRef = useRef<CommentDraft | null>(null);
  /** A comment closed before it was sent, by its passage's text. */
  const unsent = useRef<{ quote: string; text: string } | null>(null);
  const setCommentDraft = useCallback((next: CommentDraft | null) => {
    draftRef.current = next;
    setCommentDraftState(next);
  }, []);
  // A selection made with the mouse opens the comment box under it once the clicks settle (a double click
  // may be the first two of a triple); one made from the keyboard is being edited, and shows the menu.
  const selectedWithMouse = useRef(false);
  const commentTimer = useRef(0);
  const anchorsChange = useRef(onAnchorOffsets);
  anchorsChange.current = onAnchorOffsets;
  const presenceOf = useRef<CursorPresence>(cursorPresence ?? (() => "active"));
  presenceOf.current = cursorPresence ?? (() => "active");
  const discussionList = useRef<Discussion[]>(discussions ?? []);
  discussionList.current = discussions ?? [];
  const measureFrame = useRef(0);
  const lastOffsets = useRef("");
  // Anchors move with typing, remote edits, decorations and resizes; one measure per frame follows them.
  const measure = useCallback(() => {
    if (!anchorsChange.current || measureFrame.current) return;
    measureFrame.current = requestAnimationFrame(() => {
      measureFrame.current = 0;
      const current = view.current;
      if (!current || !frame.current || !anchorsChange.current) return;
      const offsets = anchorOffsets(current, session.fragment, frame.current, discussionList.current,
        session.awareness);
      // The change in front of the reader, where the face of the Agent that suggested it stands.
      const suggested = currentSuggestionTop(current);
      if (suggested !== null) offsets.set("suggestion", suggested - frame.current.getBoundingClientRect().top);
      const key = JSON.stringify([...offsets].map(([anchor, top]) => [anchor, Math.round(top)]));
      if (key === lastOffsets.current) return;
      lastOffsets.current = key;
      anchorsChange.current(offsets);
    });
  }, [session]);
  const [toolbar, setToolbar] = useState<Toolbar | null>(null);
  const shownToolbar = useRef<Toolbar | null>(null);
  const showToolbar = useCallback((next: Toolbar) => {
    shownToolbar.current = next;
    setToolbar(next);
  }, []);
  const [menuIndex, setMenuIndex] = useState(0);
  const [linkDraft, setLinkDraft] = useState<string | null>(null);
  // A GitHub file link being pasted to embed, and why the last one was not a file.
  const [fileDraft, setFileDraft] = useState<string | null>(null);
  const [fileDraftError, setFileDraftError] = useState(false);
  const menu = useRef({ trigger: null as PageTrigger | null, items: [] as MenuItem[], index: 0 });
  // The sections of pages `[[page#` named, as they are read.
  const [sectionsRead, setSectionsRead] = useState<ReadonlyMap<string, PageSections>>(() => new Map());

  const run = useCallback((command: Command) => {
    const current = view.current;
    if (!current) return;
    command(current.state, current.dispatch, current);
    current.focus();
  }, []);

  const applyItem = useCallback((item: MenuItem) => {
    const current = view.current;
    if (!current) return;
    item.run(current);
    current.focus();
  }, []);

  /** Opens the comment box under the selection, or, with `caretBlock`, under the caret's paragraph. */
  const openComment = useCallback((current: EditorView, caretBlock: boolean) => {
    if (!passageActions.current?.comment || !frame.current) return false;
    const { selection } = current.state;
    if (selection.$from.parent.type.spec.code) return false;
    const anchor = selectionAnchor(current.state, session.fragment)
      ?? (caretBlock ? caretBlockAnchor(current.state, session.fragment) : null);
    if (!anchor) return false;
    const [from, to] = selection.empty ? [selection.$from.start(), selection.$from.end()] : [selection.from, selection.to];
    const box = frame.current.getBoundingClientRect();
    const start = current.coordsAtPos(from, 1);
    const end = current.coordsAtPos(to, -1);
    // In the margin, level with the passage's first line; else under its last line, from where it starts when it
    // is one line, else from the text's edge.
    const oneLine = Math.abs(start.top - end.top) < 4;
    const left = Math.max(0, Math.min(oneLine ? start.left - box.left - 10 : 0, box.width - 448));
    const top = inMargin.current ? start.top - box.top - 8 : end.bottom - box.top + 6;
    const text = unsent.current?.quote === anchor.quote ? unsent.current.text : "";
    setCommentDraft({ blockId: pageDocBlockAt(current.state.doc, from), anchor, left, top, text });
    current.dispatch(current.state.tr.setMeta(discussionsKey, { draft: { from: anchor.from, to: anchor.to } }));
    return true;
  }, [session, setCommentDraft]);

  /**
   * Closes the box. Sent (`collapse`) or left for somewhere else (`away`), the passage is no longer selected, so
   * what is typed next does not replace it; left, the focus stays where the reader went. A comment closed unsent
   * is kept for the passage.
   */
  const closeComment = useCallback(({ collapse = false, away = false } = {}) => {
    const draft = draftRef.current;
    if (!draft) return;
    unsent.current = !collapse && draft.text.trim() ? { quote: draft.anchor.quote, text: draft.text } : null;
    setCommentDraft(null);
    const current = view.current;
    if (!current) return;
    const tr = current.state.tr.setMeta(discussionsKey, { draft: null });
    if (collapse || away) tr.setSelection(TextSelection.create(tr.doc, current.state.selection.to));
    current.dispatch(tr);
    if (!away) current.focus();
  }, [setCommentDraft]);

  const sessionChanges = useRef(onChanges);
  sessionChanges.current = onChanges;
  useEffect(() => {
    if (!host.current) return;
    const handleKeyDown = (_view: EditorView, event: KeyboardEvent) => {
      selectedWithMouse.current = false;
      // As in Google Docs: ⌘⌥M comments on the selection, or on the caret's paragraph.
      if (event.code === "KeyM" && event.altKey && (event.metaKey || event.ctrlKey) && openComment(_view, true)) return true;
      const trigger = menu.current.trigger;
      // As in Cursor: Tab takes the suggested change in front of the reader, Escape leaves it.
      if (!trigger && !event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey
        && suggestionsKey.getState(_view.state)?.hunks.length) {
        if (event.key === "Tab") return takeSuggestion(_view);
        if (event.key === "Escape") return leaveSuggestion(_view);
      }
      const items = menu.current.items;
      if (!trigger || !items.length) return false;
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        const step = event.key === "ArrowDown" ? 1 : -1;
        const next = (menu.current.index + step + items.length) % items.length;
        menu.current.index = next;
        setMenuIndex(next);
        return true;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        applyItem(items[Math.min(menu.current.index, items.length - 1)]!);
        return true;
      }
      if (event.key === "Escape") {
        _view.dispatch(_view.state.tr.setMeta(triggersKey, "close"));
        return true;
      }
      return false;
    };
    let lastBlocks = "";
    const readBlocks = (current: EditorView) => {
      const blocks = pageDocBlocks(current.state.doc);
      const key = blocks.map((block) => `${block.id}\u0000${block.depth}\u0000${block.title}`).join("\u0001");
      if (key === lastBlocks) return;
      lastBlocks = key;
      blocksChange.current?.(blocks);
    };
    const editor = new EditorView(host.current, {
      state: EditorState.create({ schema: pageSchema, plugins: [...editorPlugins({
        fragment: session.fragment, awareness: session.awareness, session, handleKeyDown,
        onChanges: (changes) => sessionChanges.current?.(changes),
        placeholder: () => placeholderText.current,
        onBlockChange: (blockId) => blockChange.current?.(blockId),
        openConversation: (conversationId) => openConversation.current?.(conversationId),
        focusConversation: (conversationId) => focusConversation.current?.(conversationId),
        headingActions: () => heading.current,
        cursorPresence: () => presenceOf.current,
        readGitHubFile: () => readFile.current,
        references: () => referenceTargets.current,
        uploadMedia: () => media.current.upload,
        localMedia,
        onMediaFailure: setMediaFailure,
      }), pageSuggestions(() => suggestionReport.current)] }),
      nodeViews: nodeViews(() => media.current.url
        ? { url: media.current.url, local: (file) => localMedia.get(file) } : undefined),
      editable: () => editable.current,
      attributes: { class: "page-document", spellcheck: "true", "data-editable": editable.current ? "true" : "false" },
      // Called as the view (possibly while it is still being constructed, when the document first syncs).
      dispatchTransaction(this: EditorView, tr) {
        // Collaboration can still deliver a transaction after the page unmounted the editor.
        if (this.isDestroyed) return;
        this.updateState(this.state.apply(tr));
        if (tr.docChanged) readBlocks(this);
        // What the shared document brings (others' writes, its first sync) carries the sync's meta.
        if (tr.docChanged && tr.getMeta(ySyncPluginKey) === undefined) wrote.current?.();
        const next = readToolbar(this);
        if (triggerKey(next.trigger) !== triggerKey(menu.current.trigger)) {
          menu.current.index = 0;
          setMenuIndex(0);
        }
        menu.current.trigger = next.trigger;
        // Metadata-only transactions do not move the selection menu. Document and selection changes
        // still render it, even when its controls match, to update its position.
        if (tr.docChanged || tr.selectionSet || tr.storedMarksSet || !sameValue(shownToolbar.current, next)) showToolbar(next);
        measure();
      },
      handleDOMEvents: {
        mousedown: (current) => {
          selectedWithMouse.current = true;
          window.clearTimeout(commentTimer.current);
          // A drag often ends past the text's edge, outside the editor; wherever the button comes up, it was made here.
          current.dom.ownerDocument.addEventListener("mouseup", () => {
            window.clearTimeout(commentTimer.current);
            commentTimer.current = window.setTimeout(() => {
              if (!current.isDestroyed && selectedWithMouse.current && !current.state.selection.empty && current.hasFocus()) {
                openComment(current, false);
              }
            }, 220);
          }, { once: true, capture: true });
          return false;
        },
        touchstart: () => { selectedWithMouse.current = false; return false; },
        focus: (focused) => { showToolbar(readToolbar(focused)); return false; },
        blur: (blurred, event) => {
          // Leaving for the page's own menus keeps them open.
          if (frame.current?.contains(event.relatedTarget as Node | null)) return false;
          showToolbar(readToolbar(blurred));
          return false;
        },
        click: (_view, event) => {
          const anchor = (event.target as HTMLElement | null)?.closest("a[href]");
          if (!anchor || (editable.current && !(event.metaKey || event.ctrlKey))) return false;
          event.preventDefault();
          window.open((anchor as HTMLAnchorElement).href, "_blank", "noopener,noreferrer");
          return true;
        },
      },
    });
    view.current = editor;
    setDrawnView(editor);
    showToolbar(readToolbar(editor));
    readBlocks(editor);
    const resized = new ResizeObserver(() => measure());
    resized.observe(editor.dom);
    // Others' carets move without the document changing.
    session.awareness.on("change", measure);
    measure();
    ready.current?.();
    return () => {
      resized.disconnect();
      session.awareness.off("change", measure);
      cancelAnimationFrame(measureFrame.current);
      measureFrame.current = 0;
      window.clearTimeout(commentTimer.current);
      editor.destroy();
      view.current = null;
      setDrawnView(null);
    };
    // The editor binds one session for its lifetime; the parent remounts it per page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);

  useEffect(() => {
    const current = view.current;
    // What a heading offers depends on whether this person can edit; the notes are drawn again when it changes.
    if (current && sections) current.dispatch(current.state.tr.setMeta(sectionsKey, new Map(sections)));
  }, [sections, canEdit]);

  useEffect(() => {
    if (view.current && follow) scrollToSection(view.current, follow.blockId);
  }, [follow]);
  useEffect(() => {
    const current = view.current;
    if (!current || !writeOn) return;
    current.dispatch(current.state.tr.setSelection(Selection.atEnd(current.state.doc)).scrollIntoView());
    current.focus();
  }, [writeOn]);

  const readerChanges = useRef(onReaderChanges);
  readerChanges.current = onReaderChanges;
  const readerBody = readerBaseline?.body ?? null;
  const readerHead = readerBaseline?.head;
  useEffect(() => {
    // After the synced document is in the editor, so the changes are measured against it.
    const frameId = requestAnimationFrame(() => {
      if (!view.current) return;
      const count = showReaderChanges(view.current, session.fragment, readerBody, readerShown);
      if (readerBody !== null) readerChanges.current?.(count);
    });
    return () => cancelAnimationFrame(frameId);
  }, [readerBody, readerHead, readerShown, session]);

  const seenDoc = useRef<DocNode | null>(null);
  useEffect(() => {
    if (readFrom === undefined) return;
    // After the synced document is in the editor, as the diff, so a page seen as it opened is that document.
    const frameId = requestAnimationFrame(() => {
      if (view.current) seenDoc.current = readFrom === null ? view.current.state.doc : markdownToPageDoc(readFrom);
    });
    return () => cancelAnimationFrame(frameId);
  }, [readFrom, session]);
  useEffect(() => {
    if (!reading) return;
    reading.current = {
      see: (area) => {
        const current = view.current;
        if (!current || !seenDoc.current) return null;
        const inView = (pos: number) => {
          const block = current.nodeDOM(pos);
          if (!(block instanceof HTMLElement)) return false;
          const box = block.getBoundingClientRect();
          return box.height > 0 && box.bottom > area.top && box.top < area.bottom;
        };
        seenDoc.current = pageSeenDoc(seenDoc.current, current.state.doc, inView);
        const body = pageDocToMarkdown(seenDoc.current);
        return { body, whole: body === pageDocToMarkdown(current.state.doc) };
      },
      seeAll: () => { if (view.current && seenDoc.current) seenDoc.current = view.current.state.doc; },
    };
    return () => { reading.current = null; };
  }, [reading, session]);

  const suggestionReport = useRef(onSuggestions);
  suggestionReport.current = onSuggestions;
  useEffect(() => {
    if (view.current) showSuggestions(view.current, suggestions ?? []);
  }, [suggestions, session]);
  useEffect(() => {
    if (!suggestionControl) return;
    suggestionControl.current = {
      take: () => { if (view.current) takeSuggestion(view.current); },
      leave: () => { if (view.current) leaveSuggestion(view.current); },
      step: (by) => { if (view.current) stepSuggestion(view.current, by); },
    };
    return () => { suggestionControl.current = null; };
  }, [suggestionControl, session]);

  useEffect(() => {
    // An Agent's Run going to sleep or waking changes whose carets show, with no awareness change.
    const current = view.current;
    if (current) current.dispatch(current.state.tr.setMeta(yCursorPluginKey, { awarenessUpdated: true }));
  }, [cursorPresence]);

  useEffect(() => {
    const current = view.current;
    if (current && discussions) current.dispatch(current.state.tr.setMeta(discussionsKey, { discussions }));
  }, [discussions]);

  useEffect(() => {
    const current = view.current;
    if (current && automations) current.dispatch(current.state.tr.setMeta(automationsKey, automations));
  }, [automations]);

  useEffect(() => {
    const current = view.current;
    if (current) current.dispatch(current.state.tr.setMeta(referencesKey, true));
  }, [references]);

  useEffect(() => {
    const current = view.current;
    if (current) current.dispatch(current.state.tr.setMeta(discussionsKey, { focused: focusedConversationId }));
  }, [focusedConversationId]);

  useEffect(() => {
    const node = frame.current;
    if (!node) return;
    const onEdit = (event: Event) => {
      setLinkDraft((event as CustomEvent<{ href?: string }>).detail?.href ?? "");
    };
    const onEmbed = () => {
      setFileDraft("");
      setFileDraftError(false);
    };
    node.addEventListener("xmatrix-edit-link", onEdit);
    node.addEventListener("xmatrix-embed-github-file", onEmbed);
    return () => {
      node.removeEventListener("xmatrix-edit-link", onEdit);
      node.removeEventListener("xmatrix-embed-github-file", onEmbed);
    };
  }, []);

  useEffect(() => {
    // `editable` is read on every update; this makes the view re-read it now.
    const current = view.current;
    if (!current) return;
    current.setProps({ editable: () => canEdit });
    current.dom.dataset.editable = canEdit ? "true" : "false";
  }, [canEdit]);

  const current = view.current;
  const place = (pos: number) => {
    if (!current || !frame.current) return null;
    const box = frame.current.getBoundingClientRect();
    const at = current.coordsAtPos(pos);
    return { left: at.left - box.left, top: at.top - box.top, bottom: at.bottom - box.top };
  };
  const placeTable = ($pos: ResolvedPos) => {
    if (!current || !frame.current) return null;
    for (let depth = $pos.depth; depth > 0; depth--) {
      if ($pos.node(depth).type.spec.tableRole !== "table") continue;
      const table = current.nodeDOM($pos.before(depth));
      if (!(table instanceof HTMLElement)) return null;
      const box = frame.current.getBoundingClientRect();
      const at = table.getBoundingClientRect();
      return { left: at.left - box.left, top: at.top - box.top };
    }
    return null;
  };
  const section = current ? pageDocBlockAt(current.state.doc, current.state.selection.from) : "";
  const selectionActions = Boolean(actions?.discuss || actions?.comment);
  const selectionMenu = toolbar && !toolbar.empty && toolbar.focused && current && toolbar.kind !== "code" && selectionActions
    && !commentDraft && !(actions?.comment && selectedWithMouse.current) ? place(current.state.selection.from) : null;
  // A key meant for the passage, pressed while the box has nothing typed: it acts on the passage as before.
  const passageKey = (event: { key: string; metaKey: boolean; ctrlKey: boolean }) => {
    const editor = view.current;
    if (!editor) return false;
    const mod = event.metaKey || event.ctrlKey;
    const key = event.key.toLowerCase();
    const { from, to } = editor.state.selection;
    const passage = editor.state.doc.textBetween(from, to, "\n\n");
    if (mod && key === "c") { void navigator.clipboard?.writeText(passage); return true; }
    if (event.key === "Backspace" || event.key === "Delete" || (mod && key === "x")) {
      if (mod) void navigator.clipboard?.writeText(passage);
      closeComment();
      editor.dispatch(editor.state.tr.deleteSelection().scrollIntoView());
      return true;
    }
    const mark = mod ? { b: pageSchema.marks.strong, i: pageSchema.marks.em, e: pageSchema.marks.code }[key] : undefined;
    if (mark) {
      closeComment();
      toggleMark(mark)(editor.state, editor.dispatch, editor);
      return true;
    }
    return false;
  };
  const tableAt = toolbar?.inTable && current ? placeTable(current.state.selection.$from) : null;
  const linkAtPos = linkDraft !== null && current ? place(current.state.selection.from) : null;
  const fileAtPos = fileDraft !== null && current ? place(current.state.selection.from) : null;
  const trigger = canEdit && toolbar?.trigger && toolbar.focused ? toolbar.trigger : null;
  const menuItems = trigger ? triggerItems(trigger, completion, sectionsRead) : [];
  menu.current.items = menuItems;
  const menuAt = trigger && menuItems.length ? place(trigger.from) : null;
  const namedPage = trigger?.kind === "page" && trigger.section !== null && completion ? sectionPage(trigger, completion) : null;
  const readPage = completion?.readPage;
  useEffect(() => {
    if (!namedPage || !readPage || sectionsRead.has(namedPage)) return;
    let live = true;
    void readPage(namedPage).then((read) => {
      if (live) setSectionsRead((known) => new Map(known).set(read.pageId, { ...read, blocks: pageBlocks(read.body) }));
    }, () => undefined);
    return () => { live = false; };
  }, [namedPage, readPage, sectionsRead]);

  return (
    <div ref={frame} className="relative" data-testid="page-editor">
      <SectionAgentsInPage />
      {/* Surfaces are slips of the page's paper (PaperPopover); the wrappers place them. */}
      {/* Over the page, above the table: taking room in the page would move the text under the pointer. */}
      {canEdit && toolbar?.inTable && tableAt && (
        <div className="absolute z-10 w-fit -translate-y-full" style={{ left: tableAt.left, top: tableAt.top - 6 }}>
        <PaperPopover role="toolbar" aria-label="Table" className="flex items-center gap-0.5 px-1.5 py-1"
          data-testid="page-table-tools">
          <ToolButton label="Add a row below" onRun={() => run(addRowAfter)}><BetweenHorizontalEnd /></ToolButton>
          <ToolButton label="Add a column to the right" onRun={() => run(addColumnAfter)}><BetweenVerticalEnd /></ToolButton>
          <ToolButton label="Delete this row" onRun={() => run(deleteRow)}><Rows3 /></ToolButton>
          <ToolButton label="Delete this column" onRun={() => run(deleteColumn)}><Columns3 /></ToolButton>
          <ToolButton label="Delete the table" onRun={() => run(deleteTable)}><Trash2 /></ToolButton>
        </PaperPopover>
        </div>
      )}
      {linkDraft !== null && (
        <div className={linkAtPos ? "absolute z-30" : "mb-2"}
          style={linkAtPos ? { left: Math.max(0, linkAtPos.left - 8), top: linkAtPos.top - 6, transform: "translateY(-100%)" } : undefined}>
        <PaperPopover as="form" className="flex items-center gap-2 p-2"
          onSubmit={(event) => { event.preventDefault(); run(setLink(linkDraft)); setLinkDraft(null); }}>
          <Link2 className="size-4 shrink-0 text-muted-foreground" />
          <input autoFocus value={linkDraft} onChange={(event) => setLinkDraft(event.target.value)} placeholder="Paste a link"
            aria-label="Link address" className="min-w-0 flex-1 bg-transparent text-sm focus:outline-none"
            onKeyDown={(event) => { if (event.key === "Escape") { setLinkDraft(null); view.current?.focus(); } }} />
          <button type="submit" className="text-sm font-semibold">Apply</button>
          {toolbar?.link && (
            <button type="button" className="text-sm text-muted-foreground"
              onClick={() => { run(setLink("")); setLinkDraft(null); }}>Remove</button>
          )}
        </PaperPopover>
        </div>
      )}
      {fileDraft !== null && (
        <div className={fileAtPos ? "absolute z-30" : "mb-2"}
          style={fileAtPos ? { left: Math.max(0, fileAtPos.left - 8), top: fileAtPos.top - 6, transform: "translateY(-100%)" } : undefined}>
        <PaperPopover as="form" className="flex w-[min(32rem,80vw)] flex-col gap-1 p-2"
          data-testid="page-embed-github-file"
          onSubmit={(event) => {
            event.preventDefault();
            const command = embedGitHubFile(fileDraft);
            if (!command) { setFileDraftError(true); return; }
            run(command);
            setFileDraft(null);
          }}>
          <div className="flex items-center gap-2">
            <FileCode2 className="size-4 shrink-0 text-muted-foreground" />
            <input autoFocus value={fileDraft} onChange={(event) => { setFileDraft(event.target.value); setFileDraftError(false); }}
              placeholder="Paste a link to a file on GitHub" aria-label="GitHub file link"
              className="min-w-0 flex-1 bg-transparent text-sm focus:outline-none"
              onKeyDown={(event) => { if (event.key === "Escape") { setFileDraft(null); view.current?.focus(); } }} />
            <button type="submit" className="text-sm font-semibold">Embed</button>
          </div>
          {fileDraftError && (
            <p className="text-xs text-muted-foreground">Paste a file link, like https://github.com/owner/repo/blob/main/README.md</p>
          )}
        </PaperPopover>
        </div>
      )}
      {mediaFailure !== null && (
        <div role="alert" data-testid="page-media-failure"
          className="sticky top-2 z-20 mb-2 flex items-center gap-3 rounded-lg bg-muted px-3 py-2 text-sm">
          <span className="min-w-0 flex-1">{mediaFailure}</span>
          <button type="button" className="text-muted-foreground hover:text-foreground hover:underline"
            onClick={() => setMediaFailure(null)}>Dismiss</button>
        </div>
      )}
      <div ref={host} className="min-h-[50vh]" />
      {selectionMenu && (
        <div className="absolute z-20 -translate-y-full"
          style={{ left: Math.max(0, selectionMenu.left - 8), top: selectionMenu.top - 6 }}>
        <PaperPopover role="toolbar" aria-label="Selection" data-testid="page-selection-menu"
          className="flex items-center p-1">
          {actions?.comment ? (
            <button type="button" onMouseDown={(event) => event.preventDefault()}
              onClick={() => { if (current) openComment(current, false); }}
              className="flex h-8 items-center gap-1.5 rounded-md px-2 text-sm [&_svg]:size-4">
              <MessageSquare /> Comment
            </button>
          ) : actions?.discuss && (
            <button type="button" onMouseDown={(event) => event.preventDefault()}
              onClick={() => actions.discuss!(section, current ? selectionAnchor(current.state, session.fragment) ?? undefined
                : undefined)}
              className="flex h-8 items-center gap-1.5 rounded-md px-2 text-sm [&_svg]:size-4">
              <MessageSquare /> Discuss
            </button>
          )}
        </PaperPopover>
        </div>
      )}
      {commentDraft && (
        <div className={commentInMargin ? "absolute z-30 w-80" : "absolute z-30 w-[28rem] max-w-full"}
          style={{ left: commentInMargin ? "calc(100% + 1.5rem)" : commentDraft.left, top: commentDraft.top }}>
          <PageCommentBox text={commentDraft.text} taker={actions?.commentTaker?.(commentDraft.blockId)}
            onText={(text) => setCommentDraft({ ...commentDraft, text })}
            onClose={(away) => closeComment({ away })} onPassageKey={passageKey}
            onSend={(text) => {
              actions?.comment?.(commentDraft.blockId, commentDraft.anchor, text);
              closeComment({ collapse: true });
            }} />
        </div>
      )}
      {blame && <PageBlameLayer view={view} frame={frame} source={blame} inMargin={commentInMargin} />}
      {blame && drawnView && <PageByline view={drawnView} frame={frame} source={blame} writing={writing ?? (() => false)} />}
      {trigger && menuAt && (
        <div className="absolute z-20 w-64" style={{ left: menuAt.left, top: menuAt.bottom + 4 }}>
        <PaperPopover role="listbox" aria-label={MENU_LABELS[trigger.kind]} data-testid={`page-${trigger.kind}-menu`}
          className="max-h-80 overflow-y-auto p-1">
          {menuItems.map((item, index) => (
            <button key={item.key} type="button" role="option" aria-selected={index === menuIndex}
              onMouseDown={(event) => event.preventDefault()} onClick={() => applyItem(item)}
              onMouseEnter={() => { menu.current.index = index; setMenuIndex(index); }}
              className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm [&_svg]:size-4
                [&_svg]:shrink-0 [&_svg]:text-muted-foreground`}>
              {item.icon}
              <span className="min-w-0 flex-1 truncate">{item.label}</span>
              <span className="max-w-[45%] truncate text-xs text-muted-foreground">{item.hint}</span>
            </button>
          ))}
        </PaperPopover>
        </div>
      )}
    </div>
  );
}
