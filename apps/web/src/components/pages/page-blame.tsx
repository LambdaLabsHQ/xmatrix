"use client";

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type { EditorView } from "prosemirror-view";
import { carryPageDocKnown } from "@xmatrix/protocol/page-document";
import { faceOfPageAuthor, pageAuthorLabel, type PageAuthor, type PageBlame } from "@xmatrix/protocol";
import { Face } from "@/components/dashboard/face";
import type { Node as DocNode } from "prosemirror-model";
import { formatRelativeAge } from "@/components/dashboard/time-display";
import { MARGIN_ITEM } from "./page-margin";
import { blameDoc, blameOf, type BlameDoc, type BlameSummary, type BlameWriter } from "./page-blame-model";

/** Where a page reads who wrote it. */
export interface PageBlameSource {
  /** The blame of the page's newest revision; the caller keeps it while that revision is the head. */
  read: () => Promise<PageBlame>;
}

/** How long the pointer rests on a paragraph before its writers show beside it. */
const HOVER_MS = 600;

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

/** The height of a paragraph's byline in the margin. */
const BYLINE_HEIGHT = 20;

/** Whether a card, pill or edge card in the margin stands across `top`..`bottom` of the view. */
function marginTaken(top: number, bottom: number): boolean {
  return [...document.querySelectorAll(MARGIN_ITEM)].some((item) => {
    const box = item.getBoundingClientRect();
    return box.height > 0 && box.top < bottom && box.bottom > top;
  });
}

/** A paragraph's writers, placed beside its first line. */
interface Shown {
  top: number;
  summary: BlameSummary;
}

function names(writers: readonly BlameWriter[]): string {
  const shown = writers.slice(0, 2).map((writer) => pageAuthorLabel(writer.author));
  return writers.length > 2 ? `${shown.join(", ")} +${writers.length - 2}` : shown.join(", ");
}

function exactTime(at: string): string {
  return new Date(at).toLocaleString(undefined, { month: "long", day: "numeric", year: "numeric", hour: "numeric",
    minute: "2-digit" });
}

/** A writer's face: a person's own picture, an Agent's vendor mark (protocol faces.ts). */
function WriterFace({ author }: { author: PageAuthor }) {
  return <Face of={faceOfPageAuthor(author)} size="xs" shape="circle" glass={false} className="shrink-0" />;
}

/** One line of who wrote it: their names, and when the newest of them wrote. */
function Byline({ summary }: { summary: BlameSummary }) {
  const newest = summary.writers[0];
  if (!newest) return <span>Being written now</span>;
  return (
    <>
      <span className="flex shrink-0 -space-x-1.5">
        {summary.writers.slice(0, 2).map((writer) => <WriterFace key={`${writer.author.kind}:${writer.author.id}`} author={writer.author} />)}
      </span>
      <span className="truncate font-medium text-foreground">{names(summary.writers)}</span>
      <span aria-hidden="true">·</span>
      <time dateTime={newest.at} title={exactTime(newest.at)} className="shrink-0">
        {formatRelativeAge(newest.at) ?? exactTime(newest.at)}</time>
      {summary.writing && <><span aria-hidden="true">·</span><span className="shrink-0">being written</span></>}
    </>
  );
}

/** Resting the pointer on a paragraph shows who wrote it and when in the margin. */
export function PageBlameLayer({ view, frame, source, inMargin }: {
  view: RefObject<EditorView | null>;
  /** The element the editor and its overlays are placed in. */
  frame: RefObject<HTMLElement | null>;
  source: PageBlameSource;
  /** The page has a margin beside it, where a paragraph's writers show. */
  inMargin: boolean;
}) {
  const [hovered, setHovered] = useState<Shown | null>(null);
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
      if (!current || !current.state.selection.empty || !(event.target instanceof Node) || !current.dom.contains(event.target)) {
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
        // The margin's cards are what the reader came to it for: the byline does not draw over them.
        if (marginTaken(first.top, first.top + BYLINE_HEIGHT)) return;
        void writersOf(from, to).then((summary) => {
          if (block?.from === from && block.to === to && summary) setHovered({ top: first.top - box.top, summary });
        });
      }, HOVER_MS);
    };
    document.addEventListener("selectionchange", clear);
    element.addEventListener("mousemove", move);
    element.addEventListener("mouseleave", clear);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("selectionchange", clear);
      element.removeEventListener("mousemove", move);
      element.removeEventListener("mouseleave", clear);
    };
  }, [frame, inMargin, view, writersOf]);

  return hovered && (
    <div className="pointer-events-none absolute z-20 flex w-80 items-center gap-1.5 text-[12.5px] text-muted-foreground"
      style={{ left: "calc(100% + 1.5rem)", top: hovered.top }} data-testid="page-blame-line">
      <Byline summary={hovered.summary} />
    </div>
  );
}
