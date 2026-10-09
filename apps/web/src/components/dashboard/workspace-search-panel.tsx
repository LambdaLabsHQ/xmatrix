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
import { X } from "lucide-react";
import { SearchGlyph } from "@/components/ui/search-glyph";
import { cn } from "@/lib/utils";
import { LiquidGlassCard } from "@/components/ui/material-surfaces";
import { useEscapeDismiss } from "./use-overlay-dismiss";
import { useAndroidBackDismiss } from "./use-android-back";

/** Marks a control that opens search; the panel unfolds from it. */
export const SEARCH_ANCHOR_ATTRIBUTE = "data-search-anchor";

/** Height of the field row and of each result: the panel's top is centred on
 * the anchor by it. A phone's rows are a finger's height. */
const FIELD_ROW = 44;
const PHONE_FIELD_ROW = 48;
/** Below this width the panel is the phone's whole search screen. */
const PHONE_WIDTH = 640;
/** A phone's top-bar button is centred this far in from the panel's side. */
const PHONE_COLUMN = 32;
/** Space kept between the panel and the window's edges. */
const EDGE = 8;
/** The top edge may come closer: the field row centres on a top-band control. */
const TOP_EDGE = 4;
const WIDTH = 520;
const MAX_HEIGHT = 560;
/** Results are read through the glass: it frosts what is behind them, so a
 * title under the field does not show through the text. */
const PANEL_MATERIAL = { blur: 16 } as const;

type PanelPlacement = { top: number; right: number; width: number; maxHeight: number; row: number;
  /** How far in from each side the leading and trailing glyph columns are centred. */
  column: number;
  /** A phone's panel runs down to the keyboard or the screen's foot. */
  fill: boolean };

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
 * On a phone it spans the screen and reaches down to the keyboard: search is
 * the whole screen there, not a card over it. Its sides keep the phone's
 * margin, the one the top bar's controls and the dock keep, so the glyph
 * columns sit as far in as the top bar's button centre does.
 */
export function searchPanelPlacement(anchor: Pick<DOMRect, "top" | "right" | "width" | "height"> | null,
  viewport: { width: number; height: number }): PanelPlacement {
  const fill = viewport.width < PHONE_WIDTH;
  const row = fill ? PHONE_FIELD_ROW : FIELD_ROW;
  const column = fill ? PHONE_COLUMN : row / 2;
  const anchorRight = anchor ? anchor.right - anchor.width / 2 + column : viewport.width - EDGE;
  const margin = Math.max(EDGE, viewport.width - anchorRight);
  const width = fill ? viewport.width - 2 * margin : Math.min(WIDTH, viewport.width - 2 * EDGE);
  const right = Math.max(EDGE, Math.min(margin, viewport.width - width - EDGE));
  const top = Math.max(TOP_EDGE, anchor ? anchor.top + anchor.height / 2 - row / 2 : EDGE);
  const room = viewport.height - top - EDGE;
  return { top, right, width, maxHeight: fill ? room : Math.min(MAX_HEIGHT, room), row, column, fill };
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
    // The visual viewport shrinks when a phone's keyboard comes up.
    const place = () => setPlacement(searchPanelPlacement(visibleSearchAnchor(),
      { width: window.innerWidth, height: window.visualViewport?.height ?? window.innerHeight }));
    place();
    window.addEventListener("resize", place);
    window.visualViewport?.addEventListener("resize", place);
    return () => {
      window.removeEventListener("resize", place);
      window.visualViewport?.removeEventListener("resize", place);
    };
  }, [open]);

  if (!open || typeof document === "undefined") return null;

  return createPortal(
    <div
      className="xmatrix-app app-search-overlay fixed inset-0 z-[var(--z-popover)]"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
    >
      <div
        className={cn("app-search-panel-frame fixed flex", !placement && "invisible")}
        style={placement ? { top: placement.top, right: placement.right, width: placement.width,
          maxHeight: placement.maxHeight, ...(placement.fill ? { height: placement.maxHeight } : {}),
          "--app-search-panel-row": `${placement.row}px`,
          "--app-search-panel-column": `${placement.column}px` } as React.CSSProperties : undefined}
      >
        <LiquidGlassCard
          role="dialog"
          aria-modal="true"
          aria-label={title}
          material={PANEL_MATERIAL}
          className="app-search-panel flex min-h-0 w-full flex-col text-foreground"
          style={placement ? { transformOrigin: `calc(100% - ${placement.column}px) ${placement.row / 2}px` } : undefined}
        >
          <div className="app-search-panel-field flex shrink-0 items-center gap-3">
            <SearchGlyph className="size-4 shrink-0 text-muted-foreground" />
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
