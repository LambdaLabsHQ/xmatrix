"use client";

/**
 * The search panel drops down from the search control that opened it: one
 * liquid-glass sheet whose field row sits on the control, so the magnifier
 * becomes the field and the place it was pressed becomes the close button.
 * Results hang under the field inside the same glass; nothing in it carries
 * its own material.
 */
import { useLayoutEffect, useState, type MutableRefObject } from "react";
import { createPortal } from "react-dom";
import { Search, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { LiquidGlassCard } from "@/components/ui/material-surfaces";
import { useEscapeDismiss } from "./use-overlay-dismiss";
import { useAndroidBackDismiss } from "./use-android-back";

/** Marks a control that opens search; the panel unfolds from it. */
export const SEARCH_ANCHOR_ATTRIBUTE = "data-search-anchor";

/** Height of the field row: the panel's top is centred on the anchor by it. */
const FIELD_ROW = 44;
/** Space kept between the panel and the window's edges. */
const EDGE = 8;
/** The top edge may come closer: the field row centres on a top-band control. */
const TOP_EDGE = 4;
const WIDTH = 520;
const MAX_HEIGHT = 560;

type PanelPlacement = { top: number; right: number; width: number; maxHeight: number };

/** The visible search control nearest the window's top right, if any. */
function visibleSearchAnchor(): DOMRect | null {
  let best: DOMRect | null = null;
  for (const element of Array.from(document.querySelectorAll<HTMLElement>(`[${SEARCH_ANCHOR_ATTRIBUTE}]`))) {
    const box = element.getBoundingClientRect();
    if (!box.width || !box.height || element.closest("[aria-hidden='true']")) continue;
    if (!best || box.top < best.top - 1 || (Math.abs(box.top - best.top) <= 1 && box.right > best.right)) best = box;
  }
  return best;
}

/**
 * Where the panel stands: its field row is centred on the anchor and its
 * right edge reaches just past it, so the close button lands where the
 * magnifier was. Without an anchor on screen it takes the window's top right.
 */
export function searchPanelPlacement(anchor: Pick<DOMRect, "top" | "right" | "height"> | null,
  viewport: { width: number; height: number }): PanelPlacement {
  const width = Math.min(WIDTH, viewport.width - 2 * EDGE);
  const inset = anchor ? Math.max(0, (FIELD_ROW - anchor.height) / 2) : 0;
  const anchorRight = anchor ? anchor.right + inset : viewport.width - EDGE;
  const right = Math.max(EDGE, Math.min(viewport.width - anchorRight, viewport.width - width - EDGE));
  const top = Math.max(TOP_EDGE, anchor ? anchor.top + anchor.height / 2 - FIELD_ROW / 2 : EDGE);
  return { top, right, width, maxHeight: Math.min(MAX_HEIGHT, viewport.height - top - EDGE) };
}

export function SearchPanel({
  open,
  title,
  query,
  inputRef,
  placeholder,
  emptyLabel,
  activeIndex,
  resultCount,
  children,
  chips,
  onRemoveLastChip,
  onQueryChange,
  onActiveIndexChange,
  onCancel,
  onSubmit,
}: {
  open: boolean;
  title: string;
  query: string;
  inputRef: MutableRefObject<HTMLInputElement | null>;
  placeholder: string;
  emptyLabel: string;
  activeIndex: number;
  resultCount: number;
  children: React.ReactNode;
  /** Filters already applied, drawn in the field ahead of the text. */
  chips?: React.ReactNode;
  /** Backspace in an empty field takes the last filter off. */
  onRemoveLastChip?: () => void;
  onQueryChange: (query: string) => void;
  onActiveIndexChange: (index: number) => void;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  const [placement, setPlacement] = useState<PanelPlacement | null>(null);

  useAndroidBackDismiss(open, onCancel);
  useEscapeDismiss(open, onCancel);

  useLayoutEffect(() => {
    if (!open) {
      setPlacement(null);
      return undefined;
    }
    const place = () => setPlacement(searchPanelPlacement(visibleSearchAnchor(),
      { width: window.innerWidth, height: window.innerHeight }));
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [open]);

  if (!open || typeof document === "undefined") return null;

  return createPortal(
    <div
      className="xmatrix-app app-search-overlay fixed inset-0 z-50"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
    >
      <div
        className={cn("app-search-panel-frame fixed flex", !placement && "invisible")}
        style={placement ? { top: placement.top, right: placement.right, width: placement.width,
          maxHeight: placement.maxHeight } : undefined}
      >
        <LiquidGlassCard
          role="dialog"
          aria-modal="true"
          aria-label={title}
          className="app-search-panel flex min-h-0 w-full flex-col text-foreground"
          style={{ transformOrigin: `calc(100% - ${FIELD_ROW / 2}px) ${FIELD_ROW / 2}px` }}
        >
          <div className="app-search-panel-field flex shrink-0 items-center gap-2">
            <Search className="size-4 shrink-0 text-muted-foreground" />
            {chips}
            <input
              ref={inputRef}
              type="text"
              autoFocus
              value={query}
              onChange={(event) => onQueryChange(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "ArrowDown" && resultCount > 0) {
                  event.preventDefault();
                  onActiveIndexChange((activeIndex + 1) % resultCount);
                } else if (event.key === "ArrowUp" && resultCount > 0) {
                  event.preventDefault();
                  onActiveIndexChange(activeIndex === 0 ? resultCount - 1 : activeIndex - 1);
                } else if (event.key === "Enter") {
                  event.preventDefault();
                  onSubmit();
                } else if (event.key === "Escape") {
                  event.preventDefault();
                  onCancel();
                } else if (event.key === "Backspace" && !query && onRemoveLastChip) {
                  event.preventDefault();
                  onRemoveLastChip();
                }
              }}
              data-workspace-search-input=""
              placeholder={placeholder}
              aria-label={title}
              className="app-search-panel-input min-w-0 flex-1"
            />
            <button type="button" aria-label="Close search" title="Close (Esc)" onClick={onCancel}
              className="app-search-panel-close flex size-8 shrink-0 items-center justify-center text-muted-foreground">
              <X className="size-4" />
            </button>
          </div>
          <div className="app-search-panel-results min-h-0 flex-1 overflow-y-auto">
            {resultCount === 0 ? (
              <div className="app-search-panel-empty text-muted-foreground">{emptyLabel}</div>
            ) : children}
          </div>
        </LiquidGlassCard>
      </div>
    </div>,
    document.body
  );
}

export function SearchResultRow({
  active,
  icon: Icon,
  title,
  subtitle,
  hint,
  refCallback,
  onMouseEnter,
  onSelect,
}: {
  active: boolean;
  icon: React.ComponentType<{ className?: string }>;
  title: React.ReactNode;
  subtitle: string;
  /** A key that chooses this row, shown at its end. */
  hint?: string;
  refCallback: (node: HTMLButtonElement | null) => void;
  onMouseEnter: () => void;
  onSelect: () => void;
}) {
  return (
    <button
      ref={refCallback}
      type="button"
      onMouseEnter={onMouseEnter}
      onClick={onSelect}
      className={cn("app-search-panel-row flex w-full items-center gap-3 text-left", active && "app-search-panel-row-active")}
    >
      <Icon className="size-4 shrink-0 text-muted-foreground" />
      <span className="w-0 min-w-0 flex-1">
        <span className="block truncate text-[13px] font-semibold leading-5">{title}</span>
        <span className="block truncate text-[11px] leading-4 text-muted-foreground">{subtitle}</span>
      </span>
      {hint && <kbd className="app-search-panel-hint shrink-0 text-muted-foreground">{hint}</kbd>}
    </button>
  );
}
