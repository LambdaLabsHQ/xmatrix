"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { ChevronDown } from "lucide-react";
import type { EditorView } from "prosemirror-view";
import { carryPageDocKnown } from "@xmatrix/protocol/page-document";
import { agentPresetAvatarUrl, normalizeAgentPresetRuntime, pageAuthorLabel, type PageAuthor, type PageBlame } from "@xmatrix/protocol";
import { IdentityAvatar } from "@/components/dashboard/identity-avatar";
import { avatarInitials } from "@/components/dashboard/completion-option-button";
import type { Node as DocNode } from "prosemirror-model";
import { PaperPopover } from "@/components/ui/material-surfaces";
import { formatRelativeAge } from "@/components/dashboard/time-display";
import { cn } from "@/lib/utils";
import { blameDoc, blameOf, type BlameDoc, type BlameSummary, type BlameWriter } from "./page-blame-model";

/** Where a page reads who wrote it, and opens the conversation a passage was written in. */
export interface PageBlameSource {
  /** The blame of the page's newest revision; the caller keeps it while that revision is the head. */
  read: () => Promise<PageBlame>;
  /** Opens `conversationId` beside the page at the message it was at when `revision` was written. */
  open: (conversationId: string, revision: number) => void;
}

/** How long the pointer rests on a paragraph before its writers show beside it. */
const HOVER_MS = 600;
/** How long a selection stays still before its writers show over it. */
const SELECTION_MS = 250;

const docs = new WeakMap<PageBlame, BlameDoc>();
const carriedTo = new WeakMap<BlameDoc, WeakMap<DocNode, Int32Array>>();

/** Who wrote `from`..`to` of the page as it is now. */
function summarize(blame: PageBlame, now: DocNode, from: number, to: number): BlameSummary {
  let base = docs.get(blame);
  if (!base) docs.set(blame, base = blameDoc(blame));
  let byDoc = carriedTo.get(base);
  if (!byDoc) carriedTo.set(base, byDoc = new WeakMap());
  let carried = byDoc.get(now);
  if (!carried) byDoc.set(now, carried = carryPageDocKnown(base.doc, base.known, now));
  return blameOf(base, carried, now, from, to);
}

/** Where its writers show: `above` stands its bottom at `top`, so a note that opens grows away from the passage. */
interface Shown {
  from: number; to: number; left: number; top: number; above?: boolean; summary: BlameSummary | null;
  /** Where it stands under the passage instead, when it grows past the top of the view. */
  under?: number;
}

function names(writers: readonly BlameWriter[]): string {
  const shown = writers.slice(0, 2).map((writer) => pageAuthorLabel(writer.author));
  return writers.length > 2 ? `${shown.join(", ")} +${writers.length - 2}` : shown.join(", ");
}

function exactTime(at: string): string {
  return new Date(at).toLocaleString(undefined, { month: "long", day: "numeric", year: "numeric", hour: "numeric",
    minute: "2-digit" });
}

/** A writer's face, as the margin draws the Agents and people on the page. */
function Face({ author }: { author: PageAuthor }) {
  const label = pageAuthorLabel(author);
  const imageUrl = author.kind === "agent"
    ? agentPresetAvatarUrl(normalizeAgentPresetRuntime(author.label.split(":")[0] ?? "")) : undefined;
  return (
    <IdentityAvatar kind={author.kind === "agent" ? "agent" : "human"} label={label} imageUrl={imageUrl}
      initials={avatarInitials(label)} size="xs" shape="circle" glass={false} className="shrink-0" />
  );
}

/** One line of who wrote it: their names, and when the newest of them wrote. */
function Byline({ summary }: { summary: BlameSummary }) {
  const newest = summary.writers[0];
  if (!newest) return <span>Being written now</span>;
  return (
    <>
      <span className="flex shrink-0 -space-x-1.5">
        {summary.writers.slice(0, 2).map((writer) => <Face key={`${writer.author.kind}:${writer.author.id}`} author={writer.author} />)}
      </span>
      <span className="truncate font-medium text-foreground">{names(summary.writers)}</span>
      <span aria-hidden="true">·</span>
      <time dateTime={newest.at} title={exactTime(newest.at)} className="shrink-0">
        {formatRelativeAge(newest.at) ?? exactTime(newest.at)}</time>
      {summary.writing && <><span aria-hidden="true">·</span><span className="shrink-0">being written</span></>}
    </>
  );
}

function ConversationLink({ writer, onOpen }: { writer: BlameWriter; onOpen: (conversationId: string, revision: number) => void }) {
  if (!writer.conversation) return null;
  const { id, name } = writer.conversation;
  return (
    <button type="button" className="min-w-0 truncate underline decoration-muted-foreground/40 underline-offset-2 hover:text-foreground"
      onMouseDown={(event) => event.preventDefault()} onClick={() => onOpen(id, writer.revision)}>
      in {name || "a conversation"}
    </button>
  );
}

/** Tints each writer's stretches of the passage in their colour, while the note lists them one by one. */
function useTint(view: RefObject<EditorView | null>, stretches: BlameSummary["stretches"] | null) {
  useEffect(() => {
    const current = view.current;
    const registry = typeof CSS !== "undefined" ? CSS.highlights : undefined;
    if (!current || !stretches?.length || !registry || typeof Highlight === "undefined") return;
    const names: string[] = [];
    const byColor = new Map<string, Range[]>();
    for (const stretch of stretches) {
      try {
        const range = document.createRange();
        const start = current.domAtPos(stretch.from);
        const end = current.domAtPos(stretch.to);
        range.setStart(start.node, start.offset);
        range.setEnd(end.node, end.offset);
        byColor.set(stretch.color, [...(byColor.get(stretch.color) ?? []), range]);
      } catch {
        // A position the view no longer draws has nothing to tint.
      }
    }
    const style = document.createElement("style");
    [...byColor].forEach(([color, ranges], index) => {
      const name = `page-blame-${index}`;
      names.push(name);
      registry.set(name, new Highlight(...ranges));
      style.textContent += `::highlight(${name}) { background-color: color-mix(in oklab, ${color} 18%, transparent); }\n`;
    });
    document.head.append(style);
    return () => {
      for (const name of names) registry.delete(name);
      style.remove();
    };
  }, [stretches, view]);
}

/**
 * Who wrote what, read where the reader is (pages-live-document.md §3, Facts): resting the pointer on a paragraph
 * shows who wrote it and when, beside it in the margin; selecting a passage shows it on a note over the
 * passage, with the conversation it was written in to open there. A passage several people wrote opens to each
 * of them, their stretches tinted in their colours. What is being typed and not yet in a revision says so.
 */
export function PageBlameLayer({ view, frame, source, inMargin }: {
  view: RefObject<EditorView | null>;
  /** The element the editor and its overlays are placed in. */
  frame: RefObject<HTMLElement | null>;
  source: PageBlameSource;
  /** The page has a margin beside it, where a paragraph's writers show. */
  inMargin: boolean;
}) {
  const [hovered, setHovered] = useState<Shown | null>(null);
  const [selected, setSelected] = useState<Shown | null>(null);
  const [open, setOpen] = useState(false);
  const blame = useRef<PageBlame | null>(null);
  const reader = useRef(source);
  reader.current = source;

  /** The writers of `from`..`to`, once the page's blame is read; null when it cannot be. */
  const writersOf = useCallback(async (from: number, to: number): Promise<BlameSummary | null> => {
    try {
      blame.current = await reader.current.read();
    } catch {
      return null;
    }
    const current = view.current;
    if (!current || !blame.current) return null;
    return summarize(blame.current, current.state.doc, from, to);
  }, [view]);

  // A paragraph the pointer rests on.
  useEffect(() => {
    const element = frame.current;
    if (!element || !inMargin) return;
    let timer = 0;
    let block: { from: number; to: number } | null = null;
    const clear = () => {
      window.clearTimeout(timer);
      block = null;
      setHovered(null);
    };
    const move = (event: MouseEvent) => {
      const current = view.current;
      if (!current || !(event.target instanceof Node) || !current.dom.contains(event.target)) {
        if (block) clear();
        return;
      }
      const at = current.posAtCoords({ left: event.clientX, top: event.clientY });
      const $pos = at ? current.state.doc.resolve(at.pos) : null;
      if (!$pos || !$pos.parent.isTextblock || $pos.parent.type.spec.code || !$pos.parent.textContent.trim()) {
        if (block) clear();
        return;
      }
      const from = $pos.start();
      const to = $pos.end();
      if (block?.from === from && block.to === to) return;
      clear();
      block = { from, to };
      timer = window.setTimeout(() => {
        const box = element.getBoundingClientRect();
        const first = current.coordsAtPos(from, 1);
        const shown = { from, to, left: 0, top: first.top - box.top, summary: null };
        void writersOf(from, to).then((summary) => {
          if (block?.from === from && block.to === to && summary) setHovered({ ...shown, summary });
        });
      }, HOVER_MS);
    };
    element.addEventListener("mousemove", move);
    element.addEventListener("mouseleave", clear);
    return () => {
      window.clearTimeout(timer);
      element.removeEventListener("mousemove", move);
      element.removeEventListener("mouseleave", clear);
    };
  }, [frame, inMargin, view, writersOf]);

  // A passage the reader selected, once it is still: while a button is held it is still being chosen.
  useEffect(() => {
    let timer = 0;
    let pressed = false;
    let shownFor = "";
    const check = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        const current = view.current;
        const element = frame.current;
        if (pressed || !current || !element) return;
        const { selection } = current.state;
        // The comment box the passage opened is beside it, and takes the focus.
        const inside = current.hasFocus() || element.contains(document.activeElement)
          || current.dom.contains(document.getSelection()?.anchorNode ?? null);
        if (selection.empty || !inside || selection.$from.parent.type.spec.code) {
          shownFor = "";
          setSelected(null);
          setOpen(false);
          return;
        }
        const key = `${selection.from}:${selection.to}`;
        if (key === shownFor) return;
        shownFor = key;
        const { from, to } = selection;
        const box = element.getBoundingClientRect();
        const start = current.coordsAtPos(from, 1);
        const end = current.coordsAtPos(to, -1);
        const scroller = current.dom.closest("article")?.getBoundingClientRect();
        const phone = window.matchMedia("(pointer: coarse)").matches;
        // Over the passage's first line, unless that is out of view or a phone's own menu stands there; then
        // under its last, where the comment box is not.
        const above = !phone && (!inMargin || start.top - 40 > (scroller?.top ?? 0));
        const left = Math.max(0, Math.min(start.left - box.left - 6, box.width - 320));
        const top = above ? start.top - box.top - 6 : end.bottom - box.top + 6;
        setOpen(false);
        const under = end.bottom - box.top + 6;
        setSelected({ from, to, left, top, above, under, summary: null });
        void writersOf(from, to).then((summary) => {
          if (shownFor === key) setSelected(summary ? { from, to, left, top, above, under, summary } : null);
        });
      }, SELECTION_MS);
    };
    const down = (event: PointerEvent) => {
      if (event.target instanceof Element && event.target.closest("[data-page-blame]")) return;
      pressed = true;
    };
    const up = () => {
      pressed = false;
      check();
    };
    document.addEventListener("selectionchange", check);
    document.addEventListener("pointerdown", down, true);
    document.addEventListener("pointerup", up, true);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("selectionchange", check);
      document.removeEventListener("pointerdown", down, true);
      document.removeEventListener("pointerup", up, true);
    };
  }, [frame, inMargin, view, writersOf]);

  const openAt = (conversationId: string, revision: number) => {
    setOpen(false);
    reader.current.open(conversationId, revision);
  };
  const selectedSummary = selected?.summary ?? null;
  // Opened over a passage at the top of the view, the list would run under the page's controls: it goes under it.
  const note = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    const element = note.current;
    const scroller = view.current?.dom.closest("article")?.getBoundingClientRect();
    if (!open || !element || !scroller || !selected?.above || selected.under === undefined) return;
    if (element.getBoundingClientRect().top < scroller.top) {
      setSelected({ ...selected, above: false, top: selected.under });
    }
  }, [open, selected, view]);
  useTint(view, open ? selectedSummary?.stretches ?? null : null);

  return (
    <>
      {hovered?.summary && !selected && (
        <div className="pointer-events-none absolute z-20 flex w-80 items-center gap-1.5 text-[12.5px] text-muted-foreground"
          style={{ left: "calc(100% + 1.5rem)", top: hovered.top }} data-testid="page-blame-line">
          <Byline summary={hovered.summary} />
        </div>
      )}
      {selectedSummary && (selectedSummary.writers.length > 0 || selectedSummary.writing) && (
        <PaperPopover ref={note} data-page-blame="" data-testid="page-blame-note"
          className={cn("absolute z-40 max-w-80 rounded-lg px-2 py-1 text-[12.5px] text-muted-foreground",
            selected!.above && "-translate-y-full")}
          style={{ left: selected!.left, top: selected!.top }} onMouseDown={(event) => event.preventDefault()}>
          {selectedSummary.writers.length > 1 ? (
            <button type="button" className="flex w-full min-w-0 items-center gap-1.5 text-left" aria-expanded={open}
              onClick={() => setOpen((value) => !value)}>
              <Byline summary={selectedSummary} />
              <ChevronDown className={cn("size-3.5 shrink-0 transition-transform", open && "rotate-180")} />
            </button>
          ) : (
            <div className="flex min-w-0 items-center gap-1.5">
              <Byline summary={selectedSummary} />
              {selectedSummary.writers[0] && (
                <><span aria-hidden="true">·</span><ConversationLink writer={selectedSummary.writers[0]} onOpen={openAt} /></>
              )}
            </div>
          )}
          {open && (
            <ul className="mt-1 space-y-1 border-t border-foreground/10 pt-1.5 pb-0.5">
              {selectedSummary.writers.map((writer) => (
                <li key={`${writer.author.kind}:${writer.author.id}`} className="flex min-w-0 items-center gap-1.5">
                  <Face author={writer.author} />
                  <span className="truncate font-medium text-foreground">{pageAuthorLabel(writer.author)}</span>
                  <span aria-hidden="true">·</span>
                  <time dateTime={writer.at} title={exactTime(writer.at)} className="shrink-0">
                    {formatRelativeAge(writer.at) ?? exactTime(writer.at)}</time>
                  {writer.conversation && <><span aria-hidden="true">·</span><ConversationLink writer={writer} onOpen={openAt} /></>}
                </li>
              ))}
            </ul>
          )}
        </PaperPopover>
      )}
    </>
  );
}
