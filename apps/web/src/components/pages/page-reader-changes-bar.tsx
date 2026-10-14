"use client";

import { useCallback, useEffect, useState, type RefObject } from "react";
import { Check, ChevronDown } from "lucide-react";
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
 * On a phone, what changed since the reader last read the page is one glass capsule under the thumb,
 * as Google Docs offers "See new changes": a tap takes them to the next change, and Viewed says they
 * have read it.
 */
export function PageReaderChangesBar({ document, changes, onViewed }: {
  /** Where the page's text is drawn. */
  document: RefObject<HTMLElement | null>;
  changes: number;
  onViewed: () => void;
}) {
  // Which change the reader stepped to; none until they step.
  const [at, setAt] = useState<{ index: number; of: number } | null>(null);
  // The capsule counts the stops it steps through, once the page has drawn its changes.
  const [stops, setStops] = useState<number | null>(null);
  useEffect(() => {
    const frameId = requestAnimationFrame(() => setStops(changedBlocks(document.current).length || null));
    return () => cancelAnimationFrame(frameId);
  }, [changes, document]);
  const total = stops ?? changes;
  const next = useCallback(() => {
    const blocks = changedBlocks(document.current);
    if (blocks.length === 0) return;
    const index = at === null ? 0 : (at.index + 1) % blocks.length;
    blocks[index]!.scrollIntoView({ block: "center", behavior: "smooth" });
    setAt({ index, of: blocks.length });
  }, [at, document]);

  return (
    <LiquidGlassPill className="pointer-events-auto flex h-14 min-w-0 flex-1 items-center rounded-full p-1"
      role="toolbar" aria-label="Changes since you last read this page" data-testid="page-reader-diff">
      <button type="button" onClick={next} aria-label="Next change"
        className="flex h-12 min-w-0 flex-1 items-center gap-2.5 rounded-full pl-2 pr-3 text-left active:bg-foreground/[0.06]">
        <span className="page-reader-capsule-mark grid size-8 shrink-0 place-items-center rounded-full" aria-hidden="true">
          <ChevronDown className="size-4" />
        </span>
        <span className="flex min-w-0 flex-col leading-tight" aria-live="polite">
          <span className="truncate text-[15px] font-semibold tabular-nums">
            {at ? `Change ${at.index + 1} of ${at.of}` : total === 1 ? "1 change" : `${total} changes`}
          </span>
          <span className="truncate text-xs text-muted-foreground">{at ? "Tap for the next" : "since you last read"}</span>
        </span>
      </button>
      <span className="h-6 w-px shrink-0 bg-foreground/15" aria-hidden="true" />
      <button type="button" onClick={onViewed}
        className="flex h-12 shrink-0 items-center gap-1.5 rounded-full px-4 text-[15px] font-semibold active:bg-foreground/[0.06]">
        <Check className="size-4" /> Viewed
      </button>
    </LiquidGlassPill>
  );
}
