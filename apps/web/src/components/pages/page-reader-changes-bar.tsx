"use client";

import { useCallback, useEffect, useState, type RefObject } from "react";
import { Check, ChevronDown, ChevronUp } from "lucide-react";
import { LiquidGlassPill } from "@/components/ui/material-surfaces";

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
 * On a phone, what changed since the reader last read the page is walked through from one floating bar
 * under their thumb: step to the previous or next change, and tick the whole diff viewed.
 */
export function PageReaderChangesBar({ document, changes, onViewed }: {
  /** Where the page's text is drawn. */
  document: RefObject<HTMLElement | null>;
  changes: number;
  onViewed: () => void;
}) {
  // Which change the reader stepped to; none until they step.
  const [at, setAt] = useState<{ index: number; of: number } | null>(null);
  // The bar counts the stops it steps through, once the page has drawn its changes.
  const [stops, setStops] = useState<number | null>(null);
  useEffect(() => {
    const frameId = requestAnimationFrame(() => setStops(changedBlocks(document.current).length || null));
    return () => cancelAnimationFrame(frameId);
  }, [changes, document]);
  const total = stops ?? changes;
  const step = useCallback((by: 1 | -1) => {
    const blocks = changedBlocks(document.current);
    if (blocks.length === 0) return;
    const index = at === null ? (by === 1 ? 0 : blocks.length - 1) : (at.index + by + blocks.length) % blocks.length;
    blocks[index]!.scrollIntoView({ block: "center", behavior: "smooth" });
    setAt({ index, of: blocks.length });
  }, [at, document]);

  const stepClass = "flex size-11 shrink-0 items-center justify-center rounded-full text-foreground active:bg-foreground/10";
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-[calc(env(safe-area-inset-bottom)+0.75rem)] z-20 flex justify-center px-4">
      <LiquidGlassPill className="pointer-events-auto flex h-14 items-center gap-1 rounded-full p-1.5"
        role="toolbar" aria-label="Changes since you last read this page" data-testid="page-reader-diff">
        <button type="button" className={stepClass} aria-label="Previous change" onClick={() => step(-1)}>
          <ChevronUp className="size-5" />
        </button>
        <span className="min-w-[4.5rem] text-center text-sm tabular-nums text-muted-foreground" aria-live="polite">
          {at ? `${at.index + 1} of ${at.of}` : total === 1 ? "1 change" : `${total} changes`}
        </span>
        <button type="button" className={stepClass} aria-label="Next change" onClick={() => step(1)}>
          <ChevronDown className="size-5" />
        </button>
        <button type="button" onClick={onViewed}
          className="ml-1 flex h-11 items-center gap-1.5 rounded-full bg-foreground/[0.06] px-5 text-sm font-semibold text-foreground active:bg-foreground/[0.12]">
          <Check className="size-4" /> Viewed
        </button>
      </LiquidGlassPill>
    </div>
  );
}
