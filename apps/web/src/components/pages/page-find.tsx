"use client";

/**
 * ⌘F / Ctrl+F on a page finds in that page, as a reader expects: one glass
 * field where the search control stands, every match marked in the text, the
 * current one stronger and scrolled into view. Enter and Shift+Enter step
 * through them; Esc closes. The field does not cover the page, so the reader
 * keeps scrolling and writing while it is open, and matches follow the text
 * as people and Agents change it. Search across the Space stays on the
 * search control.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, ChevronUp, X } from "lucide-react";
import { SearchGlyph } from "@/components/ui/search-glyph";
import { LiquidGlassCard } from "@/components/ui/material-surfaces";
import { isImeKeyDown } from "@/lib/ime-keydown";
import { cn } from "@/lib/utils";
import { searchPanelPlacement, visibleSearchAnchor } from "@/components/dashboard/workspace-search-panel";
import { pageFindFirstFrom, pageFindMatches, pageFindStep } from "./page-find-model";

const MATCHES = "page-find";
const CURRENT = "page-find-current";
/** The field is narrower than the Space's search: it holds a word, not results. */
const WIDTH = 360;
const MATERIAL = { blur: 16 } as const;
/** Blocks that end a line of text: a match stops at their edge. */
const BLOCK = "p, h1, h2, h3, h4, h5, h6, li, td, th, pre, blockquote, figcaption";

type Found = { ranges: Range[]; tops: number[] };

/** The page's text as shown, and where each match of the query stands in it. */
function findIn(scope: HTMLElement, query: string): Found {
  const nodes: Array<{ node: Text; start: number }> = [];
  let text = "";
  let block: Element | null = null;
  for (const root of Array.from(scope.querySelectorAll<HTMLElement>(".page-document"))) {
    if (root.getClientRects().length === 0) continue;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
      const parent = node.parentElement;
      if (!parent || !node.data || parent.closest("[aria-hidden='true']")) continue;
      const owner = parent.closest(BLOCK) ?? root;
      if (owner !== block && text) text += "\n";
      block = owner;
      nodes.push({ node, start: text.length });
      text += node.data;
    }
    block = null;
  }
  const at = (offset: number, end: boolean) => {
    let low = 0;
    let high = nodes.length - 1;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (nodes[middle]!.start < offset || (!end && nodes[middle]!.start === offset)) low = middle;
      else high = middle - 1;
    }
    const { node, start } = nodes[low]!;
    return { node, offset: Math.min(offset - start, node.data.length) };
  };
  const ranges: Range[] = [];
  const tops: number[] = [];
  for (const [from, to] of pageFindMatches(text, query)) {
    const start = at(from, false);
    const end = at(to, true);
    const range = document.createRange();
    range.setStart(start.node, start.offset);
    range.setEnd(end.node, end.offset);
    ranges.push(range);
    tops.push(range.getBoundingClientRect().top);
  }
  return { ranges, tops };
}

function paint(found: Found, current: number) {
  if (typeof CSS === "undefined" || !("highlights" in CSS) || typeof Highlight === "undefined") return;
  CSS.highlights.set(MATCHES, new Highlight(...found.ranges.filter((_, index) => index !== current)));
  const range = found.ranges[current];
  if (range) CSS.highlights.set(CURRENT, new Highlight(range));
  else CSS.highlights.delete(CURRENT);
}

function unpaint() {
  if (typeof CSS === "undefined" || !("highlights" in CSS)) return;
  CSS.highlights.delete(MATCHES);
  CSS.highlights.delete(CURRENT);
}

/** Brings a match to a third of the way down the page's scroller, unless it is already in view. */
function reveal(scroller: HTMLElement, range: Range) {
  const box = range.getBoundingClientRect();
  const view = scroller.getBoundingClientRect();
  if (box.top >= view.top + 48 && box.bottom <= view.bottom - 24) return;
  scroller.scrollTo({ top: scroller.scrollTop + box.top - view.top - view.height / 3 });
}

export function PageFind({ scope }: { scope: RefObject<HTMLElement | null> }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [current, setCurrent] = useState(0);
  const [count, setCount] = useState(0);
  const [placement, setPlacement] = useState<{ top: number; right: number; width: number; row: number; column: number } | null>(null);
  const input = useRef<HTMLInputElement | null>(null);
  const found = useRef<Found>({ ranges: [], tops: [] });
  const currentRef = useRef(0);

  // The page owns ⌘F while it is shown: it runs before the shell's Space search, which leaves a handled key alone.
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey || event.key.toLowerCase() !== "f") return;
      if (!scope.current || scope.current.getClientRects().length === 0) return;
      event.preventDefault();
      setOpen(true);
      input.current?.focus();
      input.current?.select();
    };
    window.addEventListener("keydown", keydown, true);
    return () => window.removeEventListener("keydown", keydown, true);
  }, [scope]);

  const close = useCallback(() => {
    setOpen(false);
    setQuery("");
  }, []);

  // Find again whenever the query or the page's text changes; the current match keeps its place in the list.
  useEffect(() => {
    const scroller = scope.current;
    if (!open || !scroller) return undefined;
    let frame = 0;
    const run = (fresh: boolean) => {
      frame = 0;
      found.current = findIn(scroller, query);
      const total = found.current.ranges.length;
      const next = fresh ? pageFindFirstFrom(found.current.tops, scroller.getBoundingClientRect().top)
        : Math.min(currentRef.current, Math.max(0, total - 1));
      currentRef.current = next;
      setCount(total);
      setCurrent(next);
      paint(found.current, next);
      const range = found.current.ranges[next];
      if (fresh && range) reveal(scroller, range);
    };
    run(true);
    const observer = new MutationObserver(() => {
      if (!frame) frame = requestAnimationFrame(() => run(false));
    });
    observer.observe(scroller, { subtree: true, childList: true, characterData: true });
    return () => {
      observer.disconnect();
      if (frame) cancelAnimationFrame(frame);
      unpaint();
    };
  }, [open, query, scope]);

  const step = useCallback((direction: 1 | -1) => {
    const scroller = scope.current;
    const total = found.current.ranges.length;
    if (!scroller || total === 0) return;
    const next = pageFindStep(currentRef.current, total, direction);
    currentRef.current = next;
    setCurrent(next);
    paint(found.current, next);
    reveal(scroller, found.current.ranges[next]!);
  }, [scope]);

  // The field stands where the search control is, as the Space's search does, but holds only the field row.
  useLayoutEffect(() => {
    if (!open) {
      setPlacement(null);
      return undefined;
    }
    const place = () => {
      const at = searchPanelPlacement(visibleSearchAnchor(), { width: window.innerWidth, height: window.innerHeight });
      const width = Math.min(WIDTH, at.width);
      setPlacement({ top: at.top, right: at.right, width, row: at.row, column: at.column });
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [open]);

  // The field takes the keys once it is placed: hidden until then, it cannot hold focus.
  const placed = placement !== null;
  useEffect(() => {
    if (placed) input.current?.focus();
  }, [placed]);

  if (!open || typeof document === "undefined") return null;
  const status = !query.trim() ? "" : count === 0 ? "No matches" : `${current + 1} of ${count}`;
  return createPortal(
    <div className="xmatrix-app app-search-overlay app-page-find pointer-events-none fixed inset-0 z-[var(--z-popover)]">
      <div className={cn("app-search-panel-frame pointer-events-auto fixed flex", !placement && "invisible")}
        style={placement ? { top: placement.top, right: placement.right, width: placement.width,
          "--app-search-panel-row": `${placement.row}px`,
          "--app-search-panel-column": `${placement.column}px` } as React.CSSProperties : undefined}>
        <LiquidGlassCard role="search" aria-label="Find in page" material={MATERIAL}
          className="app-search-panel flex w-full flex-col text-foreground"
          style={placement ? { transformOrigin: `calc(100% - ${placement.column}px) ${placement.row / 2}px` } : undefined}>
          <div className="app-search-panel-field flex shrink-0 items-center gap-3">
            <SearchGlyph className="size-4 shrink-0 text-muted-foreground" />
            <input ref={input} type="text" value={query} placeholder="Find in page" aria-label="Find in page"
              data-testid="page-find-input" className="app-search-panel-input min-w-0 flex-1"
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (isImeKeyDown(event.nativeEvent)) return;
                if (event.key === "Enter") {
                  event.preventDefault();
                  step(event.shiftKey ? -1 : 1);
                } else if (event.key === "Escape") {
                  event.preventDefault();
                  close();
                }
              }} />
            {status && <span className="app-page-find-count shrink-0 text-muted-foreground" aria-live="polite"
              data-testid="page-find-count">{status}</span>}
            <span className="flex shrink-0 items-center">
              <button type="button" aria-label="Previous match" title="Previous (Shift+Enter)" disabled={count === 0}
                onClick={() => step(-1)} className="app-search-panel-close flex size-8 items-center justify-center text-muted-foreground">
                <ChevronUp className="size-4" />
              </button>
              <button type="button" aria-label="Next match" title="Next (Enter)" disabled={count === 0}
                onClick={() => step(1)} className="app-search-panel-close flex size-8 items-center justify-center text-muted-foreground">
                <ChevronDown className="size-4" />
              </button>
              <button type="button" aria-label="Close find" title="Close (Esc)" onClick={close}
                className="app-search-panel-close flex size-8 items-center justify-center text-muted-foreground">
                <X className="size-4" />
              </button>
            </span>
          </div>
        </LiquidGlassCard>
      </div>
    </div>,
    document.body
  );
}
