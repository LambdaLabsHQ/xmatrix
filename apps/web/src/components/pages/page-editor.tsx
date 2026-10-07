"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { pageDocBlockAt, pageDocBlocks, pageSchema, type PageDocBlock } from "@xmatrix/protocol/page-document";
import {
  BetweenHorizontalEnd, BetweenVerticalEnd, Code2, Columns3, FileCode2, Flag, Rows3, Trash2, Heading1, Heading2, Heading3, Link2,
  List, ListChecks, ListOrdered, MessageSquarePlus, Minus, PenLine, Pilcrow, Quote, Sparkles, Table, Users,
} from "lucide-react";
import { EditorState, type Command } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { yCursorPluginKey } from "y-prosemirror";
import { gitHubFileReferenceFrom, gitHubFileReferenceHref, type SerializedAutomation } from "@xmatrix/protocol";
import type { PageLiveSession } from "@/lib/pages/page-client";
import { automationsKey } from "./page-automation-chips";
import type { ReadGitHubFile } from "./page-github-file-embeds";
import {
  addColumnAfter, addRowAfter, anchorOffsets, blockKind, deleteColumn, deleteRow, deleteTable, discussionsKey,
  editorPlugins, isInTable, insertRule, insertTable, linkAt, nodeViews, scrollToSection, showReaderChanges,
  sectionsKey, selectionAnchor, setBlockKind, setLink, slashKey, type BlockKind, type CursorPresence, type Discussion,
  type HeadingActions, type SectionNote, type SlashState,
} from "./page-editor-setup";

export type { CursorPresence, Discussion, HeadingActions, SectionNote };

/** Who last changed a section and when, as Google Docs' Show editors tells it for a selection. */
export interface SectionEditors {
  people: Array<{ name: string; color: string }>;
  when: string;
  conversation: { id: string; name: string } | null;
}

/**
 * The page, edited as a document (docs/design/pages-live-document.md §4):
 * markdown is typed, and the caret's line shows its markers. People and
 * Agents share one document with named cursors; the page session keeps its
 * markdown for Agents, revisions and git.
 */

/** What a section offers from the selection menu; the page view owns the actions. */
export interface PageSectionActions {
  /** A conversation about the section; from a selection, anchored to that text. */
  discuss?: (blockId: string, anchor?: { quote: string; from: unknown; to: unknown }) => void;
  copyLink?: (blockId: string) => void;
  claim?: (blockId: string) => void;
  /**
   * Ask about the passage, or ask an Agent to change it: a discussion anchored
   * to it whose first message addresses xMatrix, which picks the Agent.
   */
  ask?: (blockId: string, anchor: { quote: string; from: unknown; to: unknown },
    request: { mode: "ask" | "change"; prompt: string }) => Promise<void>;
  /** Who last changed the section the selection is in; null when it is not in recent history. */
  editors?: (blockId: string) => SectionEditors | null;
  /** Opens the page's History, where each change is shown in its author's colour. */
  history?: () => void;
}

interface Toolbar {
  kind: BlockKind;
  link: string | null;
  empty: boolean;
  focused: boolean;
  /** The selection is in a table, which shows its row and column controls. */
  inTable: boolean;
  slash: SlashState | null;
}

function readToolbar(view: EditorView): Toolbar {
  const { state } = view;
  return {
    kind: blockKind(state),
    link: linkAt(state),
    empty: state.selection.empty,
    inTable: isInTable(state),
    focused: view.hasFocus(),
    slash: slashKey.getState(state) ?? null,
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
      dispatch(state.tr.replaceSelectionWith(pageSchema.text(reference.path, [link]), false));
    }
    return true;
  };
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
        hover:bg-accent hover:text-foreground disabled:opacity-40 [&_svg]:size-4 ${active ? "bg-accent text-foreground" : ""}`}>
      {children}
    </button>
  );
}

export function PageEditor({ session, canEdit, onBlockChange, onBlocks, actions, sections, follow,
  onOpenConversation, discussions, automations, headingActions, focusedConversationId = null, onFocusConversation,
  onAnchorOffsets, cursorPresence, onReady, readerBaseline = null, readGitHubFile }: {
  session: PageLiveSession;
  canEdit: boolean;
  onBlockChange?: (blockId: string) => void;
  /** The page's sections, whenever they change. */
  onBlocks?: (blocks: PageDocBlock[]) => void;
  actions?: PageSectionActions;
  /** Who is on each section and when it last changed, drawn beside it. */
  sections?: Map<string, SectionNote>;
  /** A section to bring into view; a new `seq` follows again. */
  follow?: { blockId: string; seq: number } | null;
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
  /** The page as this reader last had it on screen, as markdown: what changed since is shown as it is read. */
  readerBaseline?: string | null;
  /** Reads a GitHub file the page embeds, through the Hub. */
  readGitHubFile?: ReadGitHubFile;
}) {
  const frame = useRef<HTMLDivElement | null>(null);
  const host = useRef<HTMLDivElement | null>(null);
  const view = useRef<EditorView | null>(null);
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
      const key = JSON.stringify([...offsets].map(([anchor, top]) => [anchor, Math.round(top)]));
      if (key === lastOffsets.current) return;
      lastOffsets.current = key;
      anchorsChange.current(offsets);
    });
  }, [session]);
  const [toolbar, setToolbar] = useState<Toolbar | null>(null);
  const [slashIndex, setSlashIndex] = useState(0);
  const [linkDraft, setLinkDraft] = useState<string | null>(null);
  // A GitHub file link being pasted to embed, and why the last one was not a file.
  const [fileDraft, setFileDraft] = useState<string | null>(null);
  const [fileDraftError, setFileDraftError] = useState(false);
  // The passage being asked about, kept while the question is typed (the editor loses its selection).
  const [asking, setAsking] = useState<{ mode: "ask" | "change"; blockId: string; left: number; top: number;
    anchor: { quote: string; from: unknown; to: unknown } } | null>(null);
  const [askText, setAskText] = useState("");
  const [askBusy, setAskBusy] = useState(false);
  const [editorsShown, setEditorsShown] = useState<{ blockId: string; left: number; top: number } | null>(null);
  const menu = useRef({ slash: null as SlashState | null, index: 0 });

  const run = useCallback((command: Command) => {
    const current = view.current;
    if (!current) return;
    command(current.state, current.dispatch, current);
    current.focus();
  }, []);

  const applyInsert = useCallback((item: InsertItem) => {
    const current = view.current;
    const slash = menu.current.slash;
    if (!current) return;
    if (slash) current.dispatch(current.state.tr.delete(slash.from, slash.to).setMeta(slashKey, "close"));
    item.run(current.state, current.dispatch, current);
    current.focus();
  }, []);

  useEffect(() => {
    if (!host.current) return;
    const handleKeyDown = (_view: EditorView, event: KeyboardEvent) => {
      const slash = menu.current.slash;
      if (!slash) return false;
      const items = matchingItems(slash.query);
      if (!items.length) return false;
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        const step = event.key === "ArrowDown" ? 1 : -1;
        const next = (menu.current.index + step + items.length) % items.length;
        menu.current.index = next;
        setSlashIndex(next);
        return true;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        applyInsert(items[Math.min(menu.current.index, items.length - 1)]!);
        return true;
      }
      if (event.key === "Escape") {
        _view.dispatch(_view.state.tr.setMeta(slashKey, "close"));
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
      state: EditorState.create({ schema: pageSchema, plugins: editorPlugins({
        fragment: session.fragment, awareness: session.awareness, handleKeyDown,
        placeholder: "Write the current state of this area…",
        onBlockChange: (blockId) => blockChange.current?.(blockId),
        openConversation: (conversationId) => openConversation.current?.(conversationId),
        focusConversation: (conversationId) => focusConversation.current?.(conversationId),
        headingActions: () => heading.current,
        cursorPresence: () => presenceOf.current,
        readGitHubFile: () => readFile.current,
      }) }),
      nodeViews,
      editable: () => editable.current,
      attributes: { class: "page-document", spellcheck: "true", "data-editable": editable.current ? "true" : "false" },
      // Called as the view (possibly while it is still being constructed, when the document first syncs).
      dispatchTransaction(this: EditorView, tr) {
        // Collaboration can still deliver a transaction after the page unmounted the editor.
        if (this.isDestroyed) return;
        this.updateState(this.state.apply(tr));
        if (tr.docChanged) readBlocks(this);
        const next = readToolbar(this);
        if (next.slash?.query !== menu.current.slash?.query || Boolean(next.slash) !== Boolean(menu.current.slash)) {
          menu.current.index = 0;
          setSlashIndex(0);
        }
        menu.current.slash = next.slash;
        setToolbar(next);
        measure();
      },
      handleDOMEvents: {
        focus: (focused) => { setToolbar(readToolbar(focused)); return false; },
        blur: (blurred, event) => {
          // Leaving for the page's own menus keeps them open.
          if (frame.current?.contains(event.relatedTarget as Node | null)) return false;
          setToolbar(readToolbar(blurred));
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
    setToolbar(readToolbar(editor));
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
      editor.destroy();
      view.current = null;
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
    if (readerBaseline === null) return;
    // After the synced document is in the editor, so the changes are measured against it.
    const frameId = requestAnimationFrame(() => {
      if (view.current) showReaderChanges(view.current, session.fragment, readerBaseline);
    });
    return () => cancelAnimationFrame(frameId);
  }, [readerBaseline, session]);

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
  const section = current ? pageDocBlockAt(current.state.doc, current.state.selection.from) : "";
  const selectionActions = Boolean(actions?.discuss || actions?.ask || (actions?.claim && canEdit) || actions?.copyLink);
  const selectionMenu = toolbar && !toolbar.empty && toolbar.focused && current && toolbar.kind !== "code" && selectionActions
    ? place(current.state.selection.from) : null;
  const linkAtPos = linkDraft !== null && current ? place(current.state.selection.from) : null;
  const fileAtPos = fileDraft !== null && current ? place(current.state.selection.from) : null;
  const slash = canEdit && toolbar?.slash && toolbar.focused ? toolbar.slash : null;
  const slashItems = slash ? matchingItems(slash.query) : [];
  const slashAt = slash && slashItems.length ? place(slash.from) : null;

  return (
    <div ref={frame} className="relative" data-testid="page-editor">
      {/* Surfaces take their material from the theme, which also sets their position;
          the wrappers place them. */}
      {canEdit && toolbar?.inTable && (
        <div className="sticky top-0 z-10 mb-2 w-fit">
        <div role="toolbar" aria-label="Table"
          className="flex items-center gap-0.5 rounded-lg border border-border bg-popover px-1.5 py-1"
          data-testid="page-table-tools">
          <ToolButton label="Add a row below" onRun={() => run(addRowAfter)}><BetweenHorizontalEnd /></ToolButton>
          <ToolButton label="Add a column to the right" onRun={() => run(addColumnAfter)}><BetweenVerticalEnd /></ToolButton>
          <ToolButton label="Delete this row" onRun={() => run(deleteRow)}><Rows3 /></ToolButton>
          <ToolButton label="Delete this column" onRun={() => run(deleteColumn)}><Columns3 /></ToolButton>
          <ToolButton label="Delete the table" onRun={() => run(deleteTable)}><Trash2 /></ToolButton>
        </div>
        </div>
      )}
      {linkDraft !== null && (
        <div className={linkAtPos ? "absolute z-30" : "mb-2"}
          style={linkAtPos ? { left: Math.max(0, linkAtPos.left - 8), top: linkAtPos.top - 6, transform: "translateY(-100%)" } : undefined}>
        <form className="flex items-center gap-2 rounded-lg border border-border bg-popover p-2"
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
        </form>
        </div>
      )}
      {fileDraft !== null && (
        <div className={fileAtPos ? "absolute z-30" : "mb-2"}
          style={fileAtPos ? { left: Math.max(0, fileAtPos.left - 8), top: fileAtPos.top - 6, transform: "translateY(-100%)" } : undefined}>
        <form className="flex w-[min(32rem,80vw)] flex-col gap-1 rounded-lg border border-border bg-popover p-2"
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
        </form>
        </div>
      )}
      <div ref={host} className="min-h-[50vh]" />
      {selectionMenu && (
        <div className="absolute z-20 -translate-y-full"
          style={{ left: Math.max(0, selectionMenu.left - 8), top: selectionMenu.top - 6 }}>
        <div role="toolbar" aria-label="Selection" data-testid="page-selection-menu"
          className="flex items-center gap-0.5 rounded-lg border border-border bg-popover p-1 text-popover-foreground">
          {actions?.discuss && (
            <button type="button" onMouseDown={(event) => event.preventDefault()}
              onClick={() => actions.discuss!(section, current ? selectionAnchor(current.state, session.fragment) ?? undefined
                : undefined)}
              className="flex h-8 items-center gap-1.5 rounded-md px-2 text-sm hover:bg-accent [&_svg]:size-4">
              <MessageSquarePlus /> Discuss
            </button>
          )}
          {actions?.ask && (["ask", "change"] as const).filter((mode) => mode === "ask" || canEdit).map((mode) => (
            <button key={mode} type="button" onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                const anchor = current ? selectionAnchor(current.state, session.fragment) : null;
                if (!anchor || !selectionMenu) return;
                setAskText("");
                setAsking({ mode, blockId: section, anchor, left: selectionMenu.left, top: selectionMenu.top });
              }}
              className="flex h-8 items-center gap-1.5 rounded-md px-2 text-sm hover:bg-accent [&_svg]:size-4">
              {mode === "ask" ? <><Sparkles /> Ask AI</> : <><PenLine /> Ask to change</>}
            </button>
          ))}
          {actions?.claim && canEdit && (
            <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => actions.claim!(section)}
              className="flex h-8 items-center gap-1.5 rounded-md px-2 text-sm hover:bg-accent [&_svg]:size-4">
              <Flag /> Claim
            </button>
          )}
          {actions?.editors && (
            <ToolButton label="Show editors" onRun={() => setEditorsShown({ blockId: section, left: selectionMenu.left,
              top: selectionMenu.top })}><Users /></ToolButton>
          )}
          {actions?.copyLink && (
            <ToolButton label="Copy a link to this section" onRun={() => actions.copyLink!(section)}><Link2 /></ToolButton>
          )}
        </div>
        </div>
      )}
      {editorsShown && actions?.editors && (
        <EditorsPopover at={editorsShown} editors={actions.editors(editorsShown.blockId)}
          onOpenConversation={(conversationId) => { setEditorsShown(null); openConversation.current?.(conversationId); }}
          onHistory={actions.history ? () => { setEditorsShown(null); actions.history!(); } : undefined}
          onClose={() => setEditorsShown(null)} />
      )}
      {asking && actions?.ask && (
        <div className="absolute z-30 w-[min(28rem,100%)] -translate-y-full"
          style={{ left: Math.max(0, asking.left - 8), top: asking.top - 6 }}>
          <form className="space-y-2 rounded-lg border border-border bg-popover p-2 text-popover-foreground"
            data-testid="page-ask" onSubmit={(event) => {
              event.preventDefault();
              if (!askText.trim() || askBusy) return;
              setAskBusy(true);
              void actions.ask!(asking.blockId, asking.anchor, { mode: asking.mode, prompt: askText.trim() })
                .then(() => setAsking(null), () => undefined).finally(() => setAskBusy(false));
            }}>
            <p className="line-clamp-2 border-l-2 border-border pl-2 text-xs italic text-muted-foreground">
              {asking.anchor.quote}
            </p>
            <textarea autoFocus rows={2} value={askText} onChange={(event) => setAskText(event.target.value)}
              aria-label={asking.mode === "ask" ? "Your question" : "What to change"}
              placeholder={asking.mode === "ask" ? "Ask about this passage…" : "Say how it should change…"}
              onKeyDown={(event) => {
                if (event.key === "Escape") setAsking(null);
                if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); }
              }}
              className="block w-full resize-none bg-transparent text-sm focus:outline-none" />
            <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
              <span>{asking.mode === "ask" ? "An Agent answers in a discussion on this passage."
                : "An Agent edits the page; you see its cursor."}</span>
              <span className="flex gap-2">
                <button type="button" onClick={() => setAsking(null)} className="hover:underline">Cancel</button>
                <button type="submit" disabled={!askText.trim() || askBusy}
                  className="font-semibold text-foreground disabled:opacity-40">{asking.mode === "ask" ? "Ask" : "Send"}</button>
              </span>
            </div>
          </form>
        </div>
      )}
      {slash && slashAt && (
        <div className="absolute z-20 w-64" style={{ left: slashAt.left, top: slashAt.bottom + 4 }}>
        <div role="listbox" aria-label="Insert" data-testid="page-insert-menu"
          className="max-h-80 overflow-y-auto rounded-lg border border-border bg-popover p-1 text-popover-foreground">
          {slashItems.map((item, index) => (
            <button key={item.label} type="button" role="option" aria-selected={index === slashIndex}
              onMouseDown={(event) => event.preventDefault()} onClick={() => applyInsert(item)}
              onMouseEnter={() => { menu.current.index = index; setSlashIndex(index); }}
              className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm [&_svg]:size-4
                [&_svg]:text-muted-foreground ${index === slashIndex ? "bg-accent" : ""}`}>
              {item.icon}
              <span className="flex-1">{item.label}</span>
              <span className="text-xs text-muted-foreground">{item.hint}</span>
            </button>
          ))}
        </div>
        </div>
      )}
    </div>
  );
}

/** Who changed the selected passage's section and when, with its conversation and History a click away. */
function EditorsPopover({ at, editors, onOpenConversation, onHistory, onClose }: {
  at: { left: number; top: number };
  editors: SectionEditors | null;
  onOpenConversation: (conversationId: string) => void;
  onHistory?: () => void;
  onClose: () => void;
}) {
  useEffect(() => {
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [onClose]);
  return (
    <div className="absolute z-30 w-72 -translate-y-full" style={{ left: Math.max(0, at.left - 8), top: at.top - 6 }}
      onMouseDown={(event) => event.preventDefault()}>
      <div role="dialog" aria-label="Editors" data-testid="page-editors"
        className="space-y-1.5 rounded-lg border border-border bg-popover p-2.5 text-sm text-popover-foreground">
        {editors ? (
          <>
            {editors.people.map((person) => (
              <div key={person.name} className="flex items-center gap-2">
                <span className="size-2 shrink-0 rounded-full" style={{ backgroundColor: person.color }} />
                <span className="truncate font-medium">{person.name}</span>
              </div>
            ))}
            <div className="text-xs text-muted-foreground">
              {editors.when}
              {editors.conversation && (
                <> · <button type="button" className="hover:text-foreground hover:underline"
                  onClick={() => onOpenConversation(editors.conversation!.id)}>{editors.conversation.name}</button></>
              )}
            </div>
          </>
        ) : <div className="text-xs text-muted-foreground">No recent changes here.</div>}
        <div className="flex justify-between gap-2 pt-1 text-xs">
          {onHistory ? <button type="button" className="font-semibold hover:underline" onClick={onHistory}>
            See version history</button> : <span />}
          <button type="button" className="text-muted-foreground hover:underline" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
