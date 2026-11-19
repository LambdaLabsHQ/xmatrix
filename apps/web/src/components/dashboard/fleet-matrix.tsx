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
      <span className={cn("flex w-full min-w-0 items-center gap-1.5 text-xs",
        cell.state === "attention" ? "font-semibold text-[var(--m-ink-attention,var(--accent))]"
          : cell.working > 0 ? "font-semibold text-foreground" : "text-muted-foreground")}>
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
  const sticky = "sticky left-0 z-10 bg-[var(--app-panel-paper,var(--background))]";
  const span = columns.length + 1 + (addColumn ? 1 : 0);
  const selectedId = selected ? cellId(selected) : null;
  return (
    <div className="app-fleet-matrix -mx-2 overflow-x-auto px-2" data-testid="fleet-matrix" ref={table}>
      <table className="w-full border-separate border-spacing-0 text-sm">
        <thead>
          <tr>
            <th scope="col" className={cn(sticky, "w-56 min-w-44 border-b border-foreground/10 pb-2 text-left align-bottom")}>
              <span className="text-xs font-bold text-muted-foreground">Machine</span>
            </th>
            {columns.map((column) => {
              const heading = (
                <>
                  <Face of={{ kind: "agent", name: column.harness, harness: column.harness }} size="sm"
                    showKindBadge={false} className={cn("shrink-0", !column.onOpen && "opacity-60")} />
                  <span className="block w-full truncate text-[13px] font-semibold">{column.harness}</span>
                </>
              );
              const headingClass = "flex w-full min-w-0 flex-col items-start gap-1 px-1.5 py-1";
              return (
                <th key={column.harness} scope="col" className="min-w-[5.25rem] border-b border-foreground/10 px-1 pb-1 text-left align-bottom font-normal">
                  {column.onOpen ? (
                    <button type="button" onClick={column.onOpen} data-testid="fleet-agent-column" title={column.summary}
                      aria-label={`${column.harness}: ${column.summary}`}
                      className={cn(headingClass, "rounded text-left hover:bg-foreground/5")}>
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
              <th scope="col" className="w-10 border-b border-foreground/10 pb-2 align-bottom font-normal">
                <button type="button" onClick={() => setChoosingColumn(!choosingColumn)} aria-expanded={choosingColumn}
                  aria-haspopup="menu" data-testid="fleet-add-column" data-cell="+" disabled={addColumn.options.length === 0}
                  title={addColumn.options.length ? "Add an agent: a column for one no machine has yet" : "Every agent xMatrix knows is already a column"}
                  aria-label="Add an agent"
                  className={actionClass({ variant: "quiet", size: "icon-sm" })}>
                  <Plus className="size-4" aria-hidden="true" />
                </button>
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <FleetMatrixRowLines key={row.key} row={row} columns={columns} sticky={sticky} span={span} selectedId={selectedId}
              onSelect={onSelect} label={row.group && row.group !== rows[index - 1]?.group ? row.group : null} />
          ))}
          {addRow && (
            <>
              <tr>
                <th scope="row" colSpan={span} className="py-1 text-left font-normal">
                  <button type="button" onClick={addRow.onToggle} aria-expanded={addRow.open} data-testid="fleet-add-row"
                    className="flex items-center gap-2.5 rounded px-1.5 py-2 text-left text-sm font-semibold text-muted-foreground hover:bg-foreground/5 hover:text-foreground">
                    <Plus className={cn("size-5 shrink-0 transition-transform", addRow.open && "rotate-45")} aria-hidden="true" />
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
  );
}

function FleetMatrixRowLines({ row, columns, sticky, span, label, selectedId, onSelect }: {
  row: FleetMatrixRow; columns: FleetMatrixColumn[]; sticky: string; span: number; label: string | null;
  selectedId: string | null; onSelect: (cell: FleetMatrixCellKey | null) => void;
}) {
  return (
    <>
      {label && (
        <tr>
          <th scope="rowgroup" colSpan={span} className="pt-5 pb-1 text-left text-xs font-bold text-muted-foreground">{label}</th>
        </tr>
      )}
      <tr aria-label={row.name} data-testid="fleet-machine" className="group/row">
        <th scope="row" className={cn(sticky, "border-b border-foreground/10 py-1 pr-2 text-left align-middle font-normal")}>
          {row.heading}
        </th>
        {columns.map((column) => {
          const id = cellId({ row: row.key, harness: column.harness });
          return (
            <td key={column.harness} className={cn("border-b border-foreground/10 px-1 py-1 align-middle", row.dimmed && "opacity-55")}>
              <FleetMatrixCellView cell={row.cells[column.harness] ?? { kind: "unknown" }} harness={column.harness} machine={row.name}
                id={id} selected={id === selectedId}
                onSelect={() => onSelect(id === selectedId ? null : { row: row.key, harness: column.harness })} />
            </td>
          );
        })}
        {span > columns.length + 1 && <td className="border-b border-foreground/10" />}
      </tr>
    </>
  );
}

const CELL = "flex min-h-11 w-full min-w-0 flex-col justify-center gap-1 rounded px-1.5 py-1 text-left";
/** The chosen cell is ringed, as a spreadsheet rings the cell being edited. */
const CHOSEN = "bg-foreground/5 outline outline-2 -outline-offset-2 outline-foreground/40";

function FleetMatrixCellView({ cell, harness, machine, id, selected, onSelect }: {
  cell: FleetMatrixCell; harness: string; machine: string; id: string; selected: boolean; onSelect: () => void;
}) {
  if (cell.kind === "unknown") return null;
  if (cell.kind === "unsupported") {
    return <span className="block px-1.5 text-muted-foreground/50" data-testid="fleet-cell" data-state="unsupported"
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
        className={cn(CELL, "text-muted-foreground/40 hover:bg-foreground/5 hover:text-foreground", selected && CHOSEN, selected && "text-foreground")}>
        <Plus className="size-4" aria-hidden="true" />
      </button>
    );
  }
  if (cell.kind === "off") {
    return (
      <button {...edits} data-testid="fleet-cell" data-state="off"
        title={`${harness} is installed on ${machine} and off in this Space. Choose the cell to turn it on.`}
        aria-label={`${harness} on ${machine}: off in this Space`}
        className={cn(CELL, "text-muted-foreground hover:bg-foreground/5 hover:text-foreground", selected && CHOSEN)}>
        <span className="flex items-center gap-1.5 text-xs"><span className="size-2 shrink-0 rounded-full border border-current" aria-hidden="true" />Off</span>
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
    <div className="xmatrix-app fixed z-[var(--z-popover)]"
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
