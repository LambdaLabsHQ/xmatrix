"use client";

import { Plus } from "lucide-react";
import type { ReactNode } from "react";

import { actionClass } from "@/components/ui/action-tone";
import { cn } from "@/lib/utils";

import { Face } from "./face";
import { MachineLoadGlanceBars } from "./machine-load-panel";
import { ToolStateDot, type ToolState } from "./tool-split";

/** What one agent is on one machine, as its cell says it. */
export type FleetMatrixCell =
  /** An agent of this Space: its state, and its page. */
  | { kind: "agent"; id: string; state: ToolState; label: string; detail: string; working: number;
    /** A name the Space gave it, where that is not its program's. */
    name?: string;
    usage: readonly { key: string; label: string; percent: number; detail?: string }[]; onOpen: () => void }
  /** Installed on the reader's own machine and not in this Space: turned on from the machine's page. */
  | { kind: "off"; onOpen: () => void }
  /** Not installed on the reader's own machine: installed from the machine's page. */
  | { kind: "absent"; onOpen: () => void }
  /** Its machine cannot run it. */
  | { kind: "unsupported" }
  /** Nothing is known: another member's machine, or one that has not reported what it holds. */
  | { kind: "unknown" };

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

/** The window closest to its limit: the one that decides whether this agent can take more work. */
function tightest(usage: Extract<FleetMatrixCell, { kind: "agent" }>["usage"]) {
  return usage.length ? [usage.reduce((worst, reading) => reading.percent > worst.percent ? reading : worst)] : [];
}

/**
 * Agents × machines. A row is a machine, a column an agent, and a cell is
 * that agent on that machine: working, ready, waiting on its owner, off in
 * this Space, or not installed. It is the list of both at once, so a machine
 * and an agent are each named once and a gap shows where an agent could be
 * added. A heading opens its machine or its agent; a cell opens their meeting.
 */
export function FleetMatrix({ columns, rows, more }: {
  columns: FleetMatrixColumn[];
  rows: FleetMatrixRow[];
  /** Agents installed nowhere yet, shown as further columns when asked for. */
  more?: { count: number; open: boolean; onToggle: () => void };
}) {
  const sticky = "sticky left-0 z-10 bg-[var(--app-panel-paper,var(--background))]";
  return (
    <div className="app-fleet-matrix -mx-2 overflow-x-auto px-2" data-testid="fleet-matrix">
      <table className="w-full border-separate border-spacing-0 text-sm">
        <thead>
          <tr>
            <th scope="col" className={cn(sticky, "w-56 min-w-44 border-b border-foreground/10 pb-2 text-left align-bottom")}>
              <span className="text-xs font-bold text-muted-foreground">Machine</span>
            </th>
            {columns.map((column) => (
              <th key={column.harness} scope="col" className="min-w-[5.25rem] border-b border-foreground/10 px-1 pb-1 text-left align-bottom font-normal">
                {column.onOpen ? (
                  <button type="button" onClick={column.onOpen} data-testid="fleet-agent-column" title={column.summary}
                    aria-label={`${column.harness}: ${column.summary}`}
                    className="flex w-full min-w-0 flex-col items-start gap-1 rounded px-1.5 py-1 text-left hover:bg-foreground/5">
                    <Face of={{ kind: "agent", name: column.harness, harness: column.harness }} size="sm" showKindBadge={false} className="shrink-0" />
                    <span className="block w-full truncate text-[13px] font-semibold">{column.harness}</span>
                  </button>
                ) : (
                  <span data-testid="fleet-agent-column" title={column.summary}
                    className="flex w-full min-w-0 flex-col items-start gap-1 px-1.5 py-1 text-muted-foreground">
                    <Face of={{ kind: "agent", name: column.harness, harness: column.harness }} size="sm" showKindBadge={false} className="shrink-0 opacity-60" />
                    <span className="block w-full truncate text-[13px] font-semibold">{column.harness}</span>
                  </span>
                )}
              </th>
            ))}
            {more && more.count > 0 && (
              <th scope="col" className="w-10 border-b border-foreground/10 pb-2 align-bottom font-normal">
                <button type="button" onClick={more.onToggle} aria-expanded={more.open} data-testid="fleet-more-agents"
                  title={more.open ? "Hide the agents installed nowhere yet" : `Show ${more.count} more agents that can be installed`}
                  aria-label={more.open ? "Hide the agents installed nowhere yet" : `Show ${more.count} more agents that can be installed`}
                  className={actionClass({ variant: "quiet", size: "icon-sm" })}>
                  <Plus className={cn("size-4 transition-transform", more.open && "rotate-45")} aria-hidden="true" />
                </button>
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <FleetMatrixRowLines key={row.key} row={row} columns={columns} sticky={sticky}
              label={row.group && row.group !== rows[index - 1]?.group ? row.group : null} spare={Boolean(more && more.count > 0)} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function FleetMatrixRowLines({ row, columns, sticky, label, spare }: {
  row: FleetMatrixRow; columns: FleetMatrixColumn[]; sticky: string; label: string | null; spare: boolean;
}) {
  return (
    <>
      {label && (
        <tr>
          <th scope="rowgroup" colSpan={columns.length + 1 + (spare ? 1 : 0)}
            className="pt-5 pb-1 text-left text-xs font-bold text-muted-foreground">{label}</th>
        </tr>
      )}
      <tr aria-label={row.name} data-testid="fleet-machine" className="group/row">
        <th scope="row" className={cn(sticky, "border-b border-foreground/10 py-1 pr-2 text-left align-middle font-normal")}>
          {row.heading}
        </th>
        {columns.map((column) => (
          <td key={column.harness} className={cn("border-b border-foreground/10 px-1 py-1 align-middle", row.dimmed && "opacity-55")}>
            <FleetMatrixCellView cell={row.cells[column.harness] ?? { kind: "unknown" }} harness={column.harness} machine={row.name} />
          </td>
        ))}
        {spare && <td className="border-b border-foreground/10" />}
      </tr>
    </>
  );
}

const CELL = "flex min-h-11 w-full min-w-0 flex-col justify-center gap-1 rounded px-1.5 py-1 text-left";

function FleetMatrixCellView({ cell, harness, machine }: { cell: FleetMatrixCell; harness: string; machine: string }) {
  if (cell.kind === "unknown") return null;
  if (cell.kind === "unsupported") {
    return <span className="block px-1.5 text-muted-foreground/50" data-testid="fleet-cell" data-state="unsupported"
      title={`${harness} cannot run on ${machine}`}><span aria-hidden="true">—</span>
      <span className="sr-only">{harness} cannot run on {machine}</span></span>;
  }
  if (cell.kind === "absent") {
    return (
      <button type="button" onClick={cell.onOpen} data-testid="fleet-cell" data-state="absent"
        title={`${harness} is not installed on ${machine}. Open the machine to install it.`}
        aria-label={`${harness} is not installed on ${machine}`}
        className={cn(CELL, "text-muted-foreground/40 hover:bg-foreground/5 hover:text-foreground")}>
        <Plus className="size-4" aria-hidden="true" />
      </button>
    );
  }
  if (cell.kind === "off") {
    return (
      <button type="button" onClick={cell.onOpen} data-testid="fleet-cell" data-state="off"
        title={`${harness} is installed on ${machine} and off in this Space. Open the machine to turn it on.`}
        aria-label={`${harness} on ${machine}: off in this Space`}
        className={cn(CELL, "text-muted-foreground hover:bg-foreground/5 hover:text-foreground")}>
        <span className="flex items-center gap-1.5 text-xs"><span className="size-2 shrink-0 rounded-full border border-current" aria-hidden="true" />Off</span>
      </button>
    );
  }
  const meter = tightest(cell.usage);
  return (
    <button type="button" onClick={cell.onOpen} data-testid="agent-row" data-state={cell.state}
      title={`${cell.name ?? harness} on ${machine}: ${cell.detail}`}
      aria-label={`${cell.name ?? harness} on ${machine}: ${cell.detail}`}
      className={cn(CELL, "hover:bg-foreground/5")}>
      {cell.name && <span className="block w-full truncate text-xs text-muted-foreground">{cell.name}</span>}
      <span className={cn("flex w-full min-w-0 items-center gap-1.5 text-xs",
        cell.state === "attention" ? "font-semibold text-[var(--m-ink-attention,var(--accent))]"
          : cell.working > 0 ? "font-semibold text-foreground" : "text-muted-foreground")}>
        {/* On, though its machine is away: the row is dimmed, and the mark stays the one of an agent that is on. */}
        <ToolStateDot state={cell.state === "offline" ? "running" : cell.state} />
        <span className="min-w-0 truncate">{cell.label}</span>
      </span>
      {meter.length > 0 && <MachineLoadGlanceBars glance={meter} testId="agent-usage-glance"
        label={cell.usage.map((reading) => reading.detail).join(", ")} />}
    </button>
  );
}
