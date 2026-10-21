"use client";

import { useCallback, useEffect, useState, type RefObject } from "react";
import { Check, ChevronDown, GitCompareArrows } from "lucide-react";
import { PageChangeMark } from "./page-chrome";
import { noticeClass } from "@/components/ui/status-tone";
import { cn } from "@/lib/utils";
import { sameValue } from "@/lib/same-value";

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

/** What a reader reads one at a time: a paragraph, a heading, code, a table, a rule, or a block taken out. */
const LINES = "p, h1, h2, h3, h4, h5, h6, pre, table, hr, .page-reader-removed.is-block";
const CHANGED = ".page-reader-change, .page-reader-removed";

/** The stretches of the page that changed, as runs of lines next to each other, where `root` draws them. */
function changeRuns(root: HTMLElement): { top: number; height: number; left: number }[] {
  const text = root.querySelector<HTMLElement>(".ProseMirror");
  if (!text) return [];
  const frame = root.getBoundingClientRect();
  const left = Math.round(text.getBoundingClientRect().left - frame.left) - 14;
  const runs: { top: number; height: number; left: number }[] = [];
  let open: { top: number; bottom: number } | null = null;
  const close = () => {
    if (open) runs.push({ top: open.top, height: open.bottom - open.top, left });
    open = null;
  };
  for (const line of text.querySelectorAll<HTMLElement>(LINES)) {
    // A line inside a table, or inside something drawn whole such as an embed, is part of it.
    if (line.parentElement?.closest(`${LINES}, [contenteditable="false"]`)) continue;
    // An empty line has nothing to read: it neither shows a change nor parts two of them.
    if (!line.matches("table, hr") && !line.textContent?.trim()) continue;
    if (!line.matches(CHANGED) && !line.closest(".page-reader-change") && !line.querySelector(CHANGED)) { close(); continue; }
    const box = line.getBoundingClientRect();
    const top = box.top - frame.top + 4;
    const bottom = box.bottom - frame.top - 4;
    if (open) open.bottom = bottom;
    else open = { top, bottom };
  }
  close();
  return runs;
}

/**
 * What changed since the reader last read the page, barred in brass in one line down its left margin, as
 * a word processor bars changed lines: lines changed next to each other are one bar, so a page mostly
 * rewritten shows a few stretches to read, not a mark beside every paragraph. The bar says where; the
 * underline and strike-through in the text say what.
 */
export function PageReaderChangeGutter({ column }: { column: RefObject<HTMLElement | null> }) {
  const [runs, setRuns] = useState<ReturnType<typeof changeRuns>>([]);
  useEffect(() => {
    const root = column.current;
    if (!root) return;
    let frameId = 0;
    const measure = () => {
      cancelAnimationFrame(frameId);
      frameId = requestAnimationFrame(() => {
        const next = changeRuns(root);
        setRuns((current) => sameValue(current, next) ? current : next);
      });
    };
    measure();
    // The marks come and go with the diff, and the lines move as the text is written or the column resized.
    const changed = new MutationObserver(measure);
    changed.observe(root, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["class"] });
    const resized = new ResizeObserver(measure);
    resized.observe(root);
    return () => { cancelAnimationFrame(frameId); changed.disconnect(); resized.disconnect(); };
  }, [column]);
  return (
    <div className="pointer-events-none absolute inset-0" aria-hidden="true" data-testid="page-reader-gutter">
      {runs.map((run) => <span key={run.top} className="page-reader-bar" style={run} />)}
    </div>
  );
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
    setPlace((current) => sameValue(current, next) ? current : next);
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

/** Buttons on paper are ink, as the comment box's send is: filled for what to do, bare for the way back. */
const INK_BUTTON = "inline-flex h-7 items-center gap-1 rounded-full bg-foreground px-3 text-[12px] font-medium text-background "
  + "hover:bg-foreground/85 [&_svg]:size-3.5";
const TEXT_BUTTON = "inline-flex h-7 items-center rounded-full px-3 text-[12px] font-medium text-muted-foreground "
  + "hover:bg-foreground/5 hover:text-foreground";

/**
 * The page opens as it is now; what changed since the reader last read it is offered here, for them to open:
 * as a card at the top of the margin, or above the page where there is no margin. Shown, the changes are
 * marked in the text, and the reader hides them again or is done with them, which reads them all.
 */
export function PageReaderChangesOffer({ changes, shown, inMargin, onShow, onHide, onDone }: {
  changes: number;
  shown: boolean;
  /** A card among the margin's, rather than a notice above the page. */
  inMargin: boolean;
  onShow: () => void;
  onHide: () => void;
  onDone: () => void;
}) {
  return (
    <div data-testid="page-reader-diff" className={inMargin
      ? "app-material-paper-popover flex flex-col gap-2 px-3 py-2.5"
      : noticeClass("attention", "mb-5 flex flex-wrap items-center gap-x-3 gap-y-2 py-2 pr-2")}>
      <span className={cn("flex min-w-0 items-start gap-2", !inMargin && "mr-auto")}>
        <GitCompareArrows className="mt-0.5 size-4 shrink-0 text-[var(--m-ink-attention,var(--accent))]" aria-hidden="true" />
        <span className="flex min-w-0 flex-col">
          <span className="text-[13px] font-semibold leading-5 text-foreground">
            {changes === 1 ? "1 change" : `${changes} changes`} since you last read this page
          </span>
          <span className="text-[12px] leading-5 text-muted-foreground">
            {shown ? "Marked in the text." : "You are reading the latest version."}
          </span>
        </span>
      </span>
      <span className={cn("flex items-center gap-2", inMargin && "pl-6")}>
        {shown ? (
          <>
            <button type="button" onClick={onDone} className={INK_BUTTON}>
              <Check aria-hidden="true" />Done
            </button>
            <button type="button" onClick={onHide} className={TEXT_BUTTON}>Hide changes</button>
          </>
        ) : (
          <button type="button" onClick={onShow} className={INK_BUTTON}>Show changes</button>
        )}
      </span>
    </div>
  );
}
