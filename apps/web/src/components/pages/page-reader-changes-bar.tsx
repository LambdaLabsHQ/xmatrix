"use client";

import { useCallback, useEffect, useState, type RefObject } from "react";
import { Check, ChevronDown } from "lucide-react";
import { PageChangeMark } from "./page-chrome";

/** The blocks of the page that hold a change, in reading order: several marks in one paragraph are one stop. */
function changedBlocks(root: HTMLElement | null): HTMLElement[] {
  if (!root) return [];
  const blocks: HTMLElement[] = [];
  for (const mark of root.querySelectorAll<HTMLElement>(".page-reader-change, .page-reader-removed")) {
    const block = mark.closest<HTMLElement>(".ProseMirror > *") ?? mark;
    if (blocks.at(-1) !== block) blocks.push(block);
  }
  return blocks;
}

/**
 * On a phone, what changed since the reader last read the page is walked change by change from the
 * right edge, beside the change in front of them, as Google Docs keeps what others did to the text in
 * its margin: ↓ goes on to the next change, and ✓ says they have read them all.
 */
export function PageReaderChangeMark({ column, article, changes, onViewed }: {
  /** The document column the mark stands beside. */
  column: RefObject<HTMLElement | null>;
  /** What scrolls, to tell whether the change is in view. */
  article: RefObject<HTMLElement | null>;
  changes: number;
  onViewed: () => void;
}) {
  const [index, setIndex] = useState(0);
  const [place, setPlace] = useState<{ top: number; away: "above" | "below" | null; of: number } | null>(null);
  const measure = useCallback(() => {
    const blocks = changedBlocks(column.current);
    const block = blocks[Math.min(index, blocks.length - 1)];
    const frame = column.current?.getBoundingClientRect();
    const view = article.current?.getBoundingClientRect();
    if (!block || !frame || !view) { setPlace(null); return; }
    const box = block.getBoundingClientRect();
    const next = { top: Math.round(box.top - frame.top), of: blocks.length,
      away: box.bottom < view.top ? "above" as const : box.top > view.bottom - 96 ? "below" as const : null };
    // Scrolling measures every frame; only a change of place draws again.
    setPlace((current) => current && current.top === next.top && current.of === next.of && current.away === next.away
      ? current : next);
  }, [article, column, index]);
  useEffect(() => {
    const frameId = requestAnimationFrame(measure);
    const scroller = article.current;
    scroller?.addEventListener("scroll", measure, { passive: true });
    const resized = new ResizeObserver(measure);
    if (column.current) resized.observe(column.current);
    return () => { cancelAnimationFrame(frameId); scroller?.removeEventListener("scroll", measure); resized.disconnect(); };
  }, [article, changes, column, measure]);
  const next = () => {
    const blocks = changedBlocks(column.current);
    if (blocks.length === 0) return;
    const following = (index + 1) % blocks.length;
    setIndex(following);
    blocks[following]!.scrollIntoView({ block: "center", behavior: "smooth" });
  };
  if (!place) return null;
  return (
    <PageChangeMark top={place.top} away={place.away} label="Changes since you last read this page" testId="page-reader-diff">
      <span className="page-change-count" aria-live="polite">{Math.min(index, place.of - 1) + 1}/{place.of}</span>
      <button type="button" onClick={next} aria-label="Next change" className="page-change-button">
        <ChevronDown className="size-4" />
      </button>
      <button type="button" onClick={onViewed} aria-label="Viewed" title="Viewed" className="page-change-button is-primary">
        <Check className="size-4" />
      </button>
    </PageChangeMark>
  );
}
