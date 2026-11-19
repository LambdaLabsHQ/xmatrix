"use client";

import { Loader2, Plus } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";

import { actionClass } from "@/components/ui/action-tone";
import { AnimatedIcon } from "@/components/ui/animated-icon";
import { PaperPopover } from "@/components/ui/material-surfaces";
import { cn } from "@/lib/utils";

import { Face } from "./face";
import { MachineLoadGlanceBars } from "./machine-load-panel";
import { ToolStateDot, type ToolState } from "./tool-split";
import { listenForOverlayDismissal } from "./use-overlay-dismiss";

/** What one agent is on one machine, as its cell says it. */
export type FleetMatrixCell = (
  /** An agent of this Space: its state. */
  | { kind: "agent"; state: ToolState; label: string; detail: string; working: number;
    /** A name the Space gave it, where that is not its program's. */
    name?: string;
    usage: readonly { key: string; label: string; percent: number; detail?: string }[] }
  /** Installed on the reader's own machine and not in this Space. */
  | { kind: "off" }
  /** Not installed on the reader's own machine. */
  | { kind: "absent" }
  /** Its machine cannot run it. */
  | { kind: "unsupported" }
  /** Nothing is known: another member's machine, or one that has not reported what it holds. */
  | { kind: "unknown" }
) & {
  /** What is being done to it on its machine now ("Installing…"): said in place of its state until it is done. */
  busy?: string;
};

export type FleetMatrixColumn = {
  harness: string;
  /** What this agent does across the machines, for its heading's hint. */
  summary: string;
  /** Opens what the Space set on this agent; an agent the Space does not have yet opens nothing. */
  onOpen?: () => void;
};

export type FleetMatrixRow = {
  key: string;
  name: string;
  /** The machine as the row's heading: its mark, name, what it does, and how it is opened. */
  heading: ReactNode;
  /** Offline: what is on it cannot work now, so its row steps back. */
  dimmed: boolean;
  /** Rows of one group stand together under its label; the reader's own machines have none. */
  group?: string;
  cells: Record<string, FleetMatrixCell>;
};

export type FleetMatrixCellKey = { row: string; harness: string };

/** A cell's editor, kept alive while its cell is chosen or while what it started still runs. */
export type FleetMatrixEditor = FleetMatrixCellKey & { label: string; node: ReactNode };

export const cellId = (cell: FleetMatrixCellKey) => `${cell.row}|${cell.harness}`;

/** The window closest to its limit: the one that decides whether this agent can take more work. */
export function tightest(usage: Extract<FleetMatrixCell, { kind: "agent" }>["usage"]) {
  return usage.length ? [usage.reduce((worst, reading) => reading.percent > worst.percent ? reading : worst)] : [];
}

/** Shared status readout + tightest quota bar for one Space-registered cell (matrix or mobile grid). */
export function FleetCellBusyReadout({ busy }: { busy: string }) {
  return (
    <span className="flex w-full min-w-0 items-center gap-1.5 text-xs font-semibold">
      <AnimatedIcon icon={Loader2} className="size-3 shrink-0 animate-spin" />
      <span className="min-w-0 truncate">{busy}</span>
    </span>
  );
}

/** Shared state line and tightest usage bar for an active agent cell. */
export function FleetCellAgentReadout({ cell }: { cell: Extract<FleetMatrixCell, { kind: "agent" }> }) {
  const meter = tightest(cell.usage);
  return (
    <>
      <span className={cn("flex w-full min-w-0 items-center gap-1.5 text-[12.5px] leading-snug",
        cell.state === "attention" ? "font-semibold text-[var(--m-ink-attention,var(--accent))]"
          : cell.working > 0 ? "font-semibold text-foreground"
            : cell.state === "offline" ? "text-muted-foreground" : "font-medium text-foreground/80")}>
        {/* On, though its machine is away: the row is dimmed, and the mark stays the one of an agent that is on. */}
        <ToolStateDot state={cell.state === "offline" ? "running" : cell.state} />
        <span className="min-w-0 truncate">{cell.label}</span>
      </span>
      {meter.length > 0 && <MachineLoadGlanceBars glance={meter} testId="agent-usage-glance"
        label={cell.usage.map((reading) => reading.detail).join(", ")} />}
    </>
  );
}

/**
 * Agents × machines, as a table that is edited where it is read. A row is a
 * machine, a column an agent, and a cell is that agent on that machine:
 * working, ready, waiting on its owner, off in this Space, or not installed.
 * Choosing a cell opens its editor under it, where it is installed, signed in,
 * turned on or off, without leaving the table. The + at the end of the
 * headings adds a column (an agent no machine has yet); the last row adds a
 * row (a machine). A heading still opens its machine or its agent.
 */
export function FleetMatrix({ columns, rows, selected, onSelect, editors, addColumn, addRow }: {
  columns: FleetMatrixColumn[];
  rows: FleetMatrixRow[];
  selected: FleetMatrixCellKey | null;
  onSelect: (cell: FleetMatrixCellKey | null) => void;
  editors: FleetMatrixEditor[];
  /** Agents no machine has yet: choosing one adds its column. */
  addColumn?: { options: Array<{ harness: string; name: string }>; onAdd: (harness: string) => void };
  /** How another machine joins: the table's last row, opened in place. */
  addRow?: { open: boolean; onToggle: () => void; content: ReactNode };
}) {
  const table = useRef<HTMLDivElement | null>(null);
  const [choosingColumn, setChoosingColumn] = useState(false);
  const [scrollEdge, setScrollEdge] = useState({ left: false, right: false });
  // Few columns keep a natural column width with a trailing filler so + sits beside the last agent rather than far right.
  const hasFiller = columns.length <= 6;
  const sticky = cn(
    "sticky left-0 z-10 bg-[var(--app-panel-paper,var(--background))] transition-[background-color,box-shadow]",
    scrollEdge.left && "shadow-[inset_-1px_0_0_color-mix(in_oklab,var(--foreground)_10%,transparent),8px_0_16px_-10px_rgb(0_0_0/0.14)]",
  );
  const span = columns.length + 1 + (addColumn ? 1 : 0) + (hasFiller ? 1 : 0);
  const selectedId = selected ? cellId(selected) : null;

  useEffect(() => {
    const scroller = table.current;
    if (!scroller) return;
    const sync = () => {
      const left = scroller.scrollLeft > 1;
      const right = scroller.scrollLeft + scroller.clientWidth < scroller.scrollWidth - 1;
      setScrollEdge((current) => current.left === left && current.right === right ? current : { left, right });
    };
    sync();
    const resized = new ResizeObserver(sync);
    resized.observe(scroller);
    if (scroller.firstElementChild) resized.observe(scroller.firstElementChild);
    scroller.addEventListener("scroll", sync, { passive: true });
    return () => {
      resized.disconnect();
      scroller.removeEventListener("scroll", sync);
    };
  }, [columns.length, rows.length]);

  return (
    <div className="relative -mx-2">
      <div className="app-fleet-matrix overflow-x-auto" data-testid="fleet-matrix" ref={table}>
        <table className="w-full border-separate border-spacing-0 text-sm">
          <thead>
            <tr>
              <th scope="col" className={cn(sticky, "w-56 min-w-[12.5rem] max-w-[16rem] border-b border-foreground/10 pb-2.5 pl-2 pr-3 text-left align-bottom")}>
                <span className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground/80">Machine</span>
              </th>
              {columns.map((column) => {
                const heading = (
                  <>
                    <Face of={{ kind: "agent", name: column.harness, harness: column.harness }} size="sm"
                      showKindBadge={false} className={cn("shrink-0", !column.onOpen && "opacity-60")} />
                    <span className="block w-full truncate text-[13px] font-semibold tracking-[-0.01em]">{column.harness}</span>
                  </>
                );
                const headingClass = "flex w-full min-w-0 flex-col items-start gap-1.5 px-2 py-1.5";
                return (
                  <th key={column.harness} scope="col" className={cn(
                    "border-b border-foreground/10 px-0.5 pb-1.5 text-left align-bottom font-normal",
                    hasFiller ? "w-[7.5rem] min-w-[6.75rem]" : "min-w-[5.75rem]",
                  )}>
                    {column.onOpen ? (
                      <button type="button" onClick={column.onOpen} data-testid="fleet-agent-column" title={column.summary}
                        aria-label={`${column.harness}: ${column.summary}`}
                        className={cn(headingClass, "rounded-md text-left transition-colors hover:bg-foreground/5")}>
                        {heading}
                      </button>
                    ) : (
                      <span data-testid="fleet-agent-column" title={column.summary} className={cn(headingClass, "text-muted-foreground")}>
                        {heading}
                      </span>
                    )}
                  </th>
                );
              })}
              {addColumn && (
                <th scope="col" className="w-9 border-b border-foreground/10 pb-1.5 pl-1 text-left align-bottom font-normal">
                  <button type="button" onClick={() => setChoosingColumn(!choosingColumn)} aria-expanded={choosingColumn}
                    aria-haspopup="menu" data-testid="fleet-add-column" data-cell="+" disabled={addColumn.options.length === 0}
                    title={addColumn.options.length ? "Add an agent: a column for one no machine has yet" : "Every agent xMatrix knows is already a column"}
                    aria-label="Add an agent"
                    className={actionClass({ variant: "quiet", size: "icon-sm" })}>
                    <Plus className="size-4" aria-hidden="true" />
                  </button>
                </th>
              )}
              {hasFiller && <th aria-hidden="true" className="w-full border-b border-foreground/10" />}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <FleetMatrixRowLines key={row.key} row={row} columns={columns} sticky={sticky} span={span}
                hasAddColumn={Boolean(addColumn)} hasFiller={hasFiller} selectedId={selectedId}
                onSelect={onSelect} label={row.group && row.group !== rows[index - 1]?.group ? row.group : null} />
            ))}
            {addRow && (
              <>
                <tr>
                  <th scope="row" colSpan={span} className="pt-2 pb-1 text-left font-normal">
                    <button type="button" onClick={addRow.onToggle} aria-expanded={addRow.open} data-testid="fleet-add-row"
                      className="flex items-center gap-2.5 rounded-md px-2 py-2 text-left text-sm font-semibold text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground">
                      <Plus className={cn("size-4 shrink-0 transition-transform", addRow.open && "rotate-45")} aria-hidden="true" />
                      Add a machine
                    </button>
                  </th>
                </tr>
                {addRow.open && <tr><td colSpan={span} className="pb-4 pl-9" data-testid="fleet-add-row-steps">{addRow.content}</td></tr>}
              </>
            )}
          </tbody>
        </table>
        {editors.map((editor) => (
          <AnchoredPaper key={cellId(editor)} root={table} cell={cellId(editor)} visible={cellId(editor) === selectedId}
            label={editor.label} onClose={() => onSelect(null)}>{editor.node}</AnchoredPaper>
        ))}
        {addColumn && (
          <AnchoredPaper root={table} cell="+" visible={choosingColumn} label="Add an agent" onClose={() => setChoosingColumn(false)} narrow>
            <p className="px-1 pb-1.5 text-xs font-bold text-muted-foreground">Add an agent</p>
            <ul role="menu" aria-label="Agents no machine has yet">
              {addColumn.options.map((option) => (
                <li key={option.harness}>
                  <button type="button" role="menuitem" data-testid="fleet-add-column-option"
                    onClick={() => { setChoosingColumn(false); addColumn.onAdd(option.harness); }}
                    className="flex w-full min-w-0 items-center gap-2 rounded px-1.5 py-1.5 text-left text-sm hover:bg-foreground/5">
                    <Face of={{ kind: "agent", name: option.harness, harness: option.harness }} size="xs" showKindBadge={false} className="shrink-0" />
                    <span className="min-w-0 truncate font-semibold">{option.name}</span>
                  </button>
                </li>
              ))}
            </ul>
          </AnchoredPaper>
        )}
      </div>
      {scrollEdge.right && (
        <div aria-hidden="true"
          className="pointer-events-none absolute inset-y-0 right-0 z-20 w-10 bg-gradient-to-l from-[var(--app-panel-paper,var(--background))] to-transparent" />
      )}
    </div>
  );
}

function FleetMatrixRowLines({ row, columns, sticky, span, hasAddColumn, hasFiller, label, selectedId, onSelect }: {
  row: FleetMatrixRow; columns: FleetMatrixColumn[]; sticky: string; span: number;
  hasAddColumn: boolean; hasFiller: boolean; label: string | null;
  selectedId: string | null; onSelect: (cell: FleetMatrixCellKey | null) => void;
}) {
  return (
    <>
      {label && (
        <tr>
          <th scope="rowgroup" colSpan={span} className="pt-5 pb-1.5 pl-2 text-left text-[11px] font-bold uppercase tracking-wider text-muted-foreground/80">{label}</th>
        </tr>
      )}
      <tr aria-label={row.name} data-testid="fleet-machine" className="group/row transition-colors hover:bg-foreground/[0.025]">
        <th scope="row" className={cn(
          sticky,
          "border-b border-foreground/10 py-2 pr-3 text-left align-middle font-normal group-hover/row:bg-[color-mix(in_oklab,var(--foreground)_2.5%,var(--app-panel-paper,var(--background)))]",
        )}>
          {row.heading}
        </th>
        {columns.map((column) => {
          const id = cellId({ row: row.key, harness: column.harness });
          return (
            <td key={column.harness} className={cn("border-b border-foreground/10 px-0.5 py-2 align-middle", row.dimmed && "opacity-55")}>
              <FleetMatrixCellView cell={row.cells[column.harness] ?? { kind: "unknown" }} harness={column.harness} machine={row.name}
                id={id} selected={id === selectedId}
                onSelect={() => onSelect(id === selectedId ? null : { row: row.key, harness: column.harness })} />
            </td>
          );
        })}
        {hasAddColumn && <td className="border-b border-foreground/10" />}
        {hasFiller && <td aria-hidden="true" className="border-b border-foreground/10" />}
      </tr>
    </>
  );
}

const CELL = "flex min-h-12 w-full min-w-0 flex-col justify-center gap-1 rounded-md px-2 py-1.5 text-left transition-colors";
/** The chosen cell is ringed, as a spreadsheet rings the cell being edited. */
const CHOSEN = "bg-foreground/5 outline outline-2 -outline-offset-2 outline-foreground/40";

function FleetMatrixCellView({ cell, harness, machine, id, selected, onSelect }: {
  cell: FleetMatrixCell; harness: string; machine: string; id: string; selected: boolean; onSelect: () => void;
}) {
  if (cell.kind === "unknown") return null;
  if (cell.kind === "unsupported") {
    return <span className="block px-2 text-muted-foreground/45" data-testid="fleet-cell" data-state="unsupported"
      title={`${harness} cannot run on ${machine}`}><span aria-hidden="true">—</span>
      <span className="sr-only">{harness} cannot run on {machine}</span></span>;
  }
  const edits = { type: "button" as const, onClick: onSelect, "data-cell": id, "aria-expanded": selected, "aria-haspopup": "dialog" as const };
  if (cell.busy) {
    return (
      <button {...edits} data-testid={cell.kind === "agent" ? "agent-row" : "fleet-cell"} data-state="busy"
        aria-label={`${harness} on ${machine}: ${cell.busy}`} className={cn(CELL, "hover:bg-foreground/5", selected && CHOSEN)}>
        <FleetCellBusyReadout busy={cell.busy} />
      </button>
    );
  }
  if (cell.kind === "absent") {
    return (
      <button {...edits} data-testid="fleet-cell" data-state="absent"
        title={`${harness} is not installed on ${machine}. Choose the cell to install it.`}
        aria-label={`${harness} is not installed on ${machine}`}
        className={cn(CELL, "text-muted-foreground/30 group-hover/row:text-muted-foreground/55 hover:bg-foreground/5 hover:!text-foreground", selected && CHOSEN, selected && "!text-foreground")}>
        <Plus className="size-3.5" aria-hidden="true" />
      </button>
    );
  }
  if (cell.kind === "off") {
    return (
      <button {...edits} data-testid="fleet-cell" data-state="off"
        title={`${harness} is installed on ${machine} and off in this Space. Choose the cell to turn it on.`}
        aria-label={`${harness} on ${machine}: off in this Space`}
        className={cn(CELL, "text-muted-foreground/65 hover:bg-foreground/5 hover:text-foreground", selected && CHOSEN)}>
        <span className="flex items-center gap-1.5 text-[12.5px] leading-snug"><span className="size-2 shrink-0 rounded-full border border-current" aria-hidden="true" />Off</span>
      </button>
    );
  }
  return (
    <button {...edits} data-testid="agent-row" data-state={cell.state}
      title={`${cell.name ?? harness} on ${machine}: ${cell.detail}`}
      aria-label={`${cell.name ?? harness} on ${machine}: ${cell.detail}`}
      className={cn(CELL, "hover:bg-foreground/5", selected && CHOSEN)}>
      {cell.name && <span className="block w-full truncate text-xs text-muted-foreground">{cell.name}</span>}
      <FleetCellAgentReadout cell={cell} />
    </button>
  );
}

/**
 * A slip of the paper under the cell it belongs to. It is placed on the
 * window, not in the table, so the table's scroll never clips it; it follows
 * its cell as the page scrolls and flips above it where there is no room
 * below. Unseen it stays mounted: what was started in it goes on.
 */
function AnchoredPaper({ root, cell, visible, label, onClose, narrow, children }: {
  root: RefObject<HTMLDivElement | null>; cell: string; visible: boolean; label: string; onClose: () => void;
  narrow?: boolean; children: ReactNode;
}) {
  const paper = useRef<HTMLDivElement | null>(null);
  const [place, setPlace] = useState<{ left: number; top: number; maxHeight: number } | null>(null);
  const close = useRef(onClose);
  useEffect(() => { close.current = onClose; });
  const anchor = () => root.current?.querySelector<HTMLElement>(`[data-cell="${CSS.escape(cell)}"]`) ?? null;

  useLayoutEffect(() => {
    if (!visible) return;
    const put = () => {
      const at = anchor()?.getBoundingClientRect();
      if (!at) return;
      const width = paper.current?.offsetWidth ?? 0;
      const height = Math.min(paper.current?.scrollHeight ?? 0, window.innerHeight * 0.7);
      const left = Math.max(12, Math.min(at.left, window.innerWidth - width - 12));
      const below = Math.max(0, window.innerHeight - 12 - (at.bottom + 6));
      const above = Math.max(0, at.top - 6 - 12);
      const useAbove = height > below && above > below;
      const maxHeight = Math.min(window.innerHeight * 0.7, useAbove ? above : below);
      const top = useAbove ? at.top - 6 - Math.min(height, maxHeight) : at.bottom + 6;
      setPlace({ left, top, maxHeight });
    };
    put();
    const resized = new ResizeObserver(put);
    if (paper.current) resized.observe(paper.current);
    window.addEventListener("resize", put);
    document.addEventListener("scroll", put, true);
    return () => {
      resized.disconnect();
      window.removeEventListener("resize", put);
      document.removeEventListener("scroll", put, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the anchor is looked up by `cell` each time it is placed
  }, [visible, cell]);

  useEffect(() => {
    if (!visible) return;
    return listenForOverlayDismissal((event) => {
      const target = event.target instanceof Element ? event.target : null;
      // A question asked from the slip (what access to grant) is part of what it is doing, not a click away from it.
      if (!target || paper.current?.contains(target) || anchor()?.contains(target) || target.closest('[role="dialog"]')) return;
      close.current();
    }, () => close.current());
    // eslint-disable-next-line react-hooks/exhaustive-deps -- as above
  }, [visible, cell]);

  if (typeof document === "undefined") return null;
  return createPortal(
    // The app root paints paper; this one only carries the theme to the slip.
    // Stay just under `--z-overlay` so confirmation dialogs opened from the slip always stack above it.
    <div className="xmatrix-app fixed z-[calc(var(--z-overlay)-1)]"
      style={visible && place ? { left: place.left, top: place.top, background: "transparent" }
        : visible ? { left: 0, top: 0, visibility: "hidden", background: "transparent" } : { display: "none" }}>
      <PaperPopover ref={paper} role="dialog" aria-label={label} data-testid="fleet-cell-editor"
        style={place ? { maxHeight: place.maxHeight } : undefined}
        className={cn("app-tool-detail max-h-[70vh] max-w-[calc(100vw-1.5rem)] overflow-y-auto border border-foreground/10 p-3",
          narrow ? "w-56" : "w-[24rem]")}>
        {children}
      </PaperPopover>
    </div>,
    document.body
  );
}
