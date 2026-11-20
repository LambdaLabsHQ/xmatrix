"use client";

import { ArrowUp, ChevronRight, KeyRound, Loader2, Plus } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { actionClass } from "@/components/ui/action-tone";
import { AnimatedIcon } from "@/components/ui/animated-icon";
import { PaperPopover } from "@/components/ui/material-surfaces";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { statusInkClass } from "@/components/ui/status-tone";
import { cn } from "@/lib/utils";

import { Face } from "./face";
import {
  cellId,
  tightest,
  type FleetMatrixCell,
  type FleetMatrixCellKey,
  type FleetMatrixColumn,
  type FleetMatrixEditor,
} from "./fleet-matrix";
import { MachineGlyph } from "./machine-glyph";
import { meterTone, type MachineGlanceReading } from "./machine-load";
import { MachineLoadGlanceBars } from "./machine-load-panel";
import type { MachineOs } from "./machine-os";
import { listenForOverlayDismissal } from "./use-overlay-dismiss";

export type MobileMatrixRow = {
  key: string;
  name: string;
  os: MachineOs;
  /** Whether the reader owns this machine and can install agents on it. */
  own: boolean;
  online: boolean;
  stalled?: boolean;
  dimmed: boolean;
  group?: string;
  /** Tag for the device currently running the app, when known. */
  localTag?: ReactNode;
  /** Inline exception beside the machine name (sign-in, limit, unresponsive). */
  exception?: string | null;
  /** Inline strained system readings (CPU / Mem / Disk >= 70%). */
  loadAlerts: readonly MachineGlanceReading[];
  /** Quiet context beside offline or teammate machines (e.g. "Offline · 5h ago", "Alex"). */
  quietNote?: string | null;
  onOpenMachine?: () => void;
  cells: Record<string, FleetMatrixCell>;
};

/** Short human exception phrase placed directly beside the machine name on mobile. */
export function mobileAttentionPhrase(harness: string, label: string): string {
  if (label === "Sign in") return `${harness} needs sign-in`;
  if (label === "Update") return `${harness} needs update`;
  if (label === "No balance") return `${harness} has no balance`;
  if (label === "Out of quota") return `${harness} out of quota`;
  if (label === "Set up") return `${harness} needs setup`;
  return `${harness} ${label}`;
}

/**
 * Two-layer avatar matrix for a phone:
 * 1. Base map (always calm): machine name above a full-width aligned strip of
 *    agent avatars (color = ready, dimmed = off, dashed ghost / dot = absent).
 * 2. Events (drawn only when active): subtle pulse ring when working, amber
 *    ring + semantic badge + inline machine note when waiting on a person,
 *    quota bar and load reading only under strain (>= 70%).
 */
export function MobileAvatarMatrix({
  columns,
  rows,
  ownMachineCount,
  attentionCount,
  workingCount,
  selected,
  onSelect,
  editors,
  addColumn,
  addRow,
}: {
  columns: FleetMatrixColumn[];
  rows: MobileMatrixRow[];
  ownMachineCount: number;
  attentionCount: number;
  workingCount: number;
  selected: FleetMatrixCellKey | null;
  onSelect: (cell: FleetMatrixCellKey | null) => void;
  editors: FleetMatrixEditor[];
  addColumn?: { options: Array<{ harness: string; name: string }>; onAdd: (harness: string) => void };
  addRow?: { open: boolean; onToggle: () => void; content: ReactNode };
}) {
  const [choosingColumn, setChoosingColumn] = useState(false);
  const selectedId = selected ? cellId(selected) : null;
  const hasAddableColumn = Boolean(addColumn && addColumn.options.length > 0);
  // Fewer than 3 agents: show a dashed + slot inline at the end of each online own row.
  const showInlineAdd = columns.length < 3 && hasAddableColumn;
  const slotCount = columns.length + (showInlineAdd ? 1 : 0);
  const scrollable = slotCount > 8;
  const gridStyle = scrollable
    ? { gridTemplateColumns: `repeat(${slotCount}, 2.75rem)` }
    : { gridTemplateColumns: `repeat(${Math.max(slotCount, 1)}, min(2.75rem, calc(100% / ${Math.max(slotCount, 1)})))` };
  // A missing agent is a quiet dot. It is drawn as the agent's outline only where most of the reader's own machines
  // have it (two at least): there it reads as the one that is missing, and the grid is not filled with outlines.
  const ownRows = rows.filter((row) => row.own);
  const peerPresent = new Set(columns.map((column) => column.harness).filter((harness) => {
    const have = ownRows.filter((row) => ["agent", "off"].includes(row.cells[harness]?.kind ?? "")).length;
    return have >= 2 && have * 2 > ownRows.length;
  }));
  let inlineAddAssigned = false;

  return (
    <div data-testid="fleet-matrix" className="space-y-1">
      {(attentionCount > 0 || workingCount > 0 || (hasAddableColumn && !showInlineAdd)) && (
        <div className="flex min-h-7 items-center justify-between gap-2 pb-1">
          <div className="flex min-w-0 items-center gap-2.5 text-sm">
            {attentionCount > 0 ? (
              <span className={cn("font-bold", statusInkClass("attention"))} data-testid="fleet-attention-count">
                {attentionCount} {attentionCount === 1 ? "needs" : "need"} attention
              </span>
            ) : workingCount > 0 ? (
              <span className="inline-flex items-center gap-1.5 font-semibold text-foreground">
                <span className="size-2 shrink-0 rounded-full bg-[var(--m-ink-running,currentColor)] animate-pulse" aria-hidden="true" />
                Working
              </span>
            ) : null}
          </div>
          {hasAddableColumn && !showInlineAdd && (
            <button type="button" onClick={() => setChoosingColumn(true)} aria-expanded={choosingColumn}
              aria-haspopup="menu" data-testid="fleet-add-column" aria-label="Add an agent"
              className={actionClass({ variant: "quiet", size: "sm" }, "gap-1 px-2 text-xs text-muted-foreground")}>
              <Plus className="size-3.5" aria-hidden="true" />Add agent
            </button>
          )}
        </div>
      )}

      {rows.map((row, index) => {
        const groupLabel = row.group && row.group !== rows[index - 1]?.group ? row.group : null;
        const canAddInline = showInlineAdd && row.own && row.online;
        const assignAddTestId = canAddInline && !inlineAddAssigned;
        if (assignAddTestId) inlineAddAssigned = true;

        const headingCopy = (
          <>
            <span className="app-tool-state-icon flex size-4 shrink-0 items-center justify-center"
              data-state={row.stalled ? "attention" : row.online ? "running" : "offline"} aria-hidden="true">
              <MachineGlyph os={row.os} className="size-4" />
            </span>
            {/* The name keeps its room: what is said after it gives way first. */}
            <span className="max-w-[62%] shrink-0 truncate text-[15px] font-bold tracking-tight text-foreground">{row.name}</span>
            {row.localTag}
            {row.exception && (
              <span data-testid="fleet-machine-exception" className={cn("min-w-0 truncate text-xs font-semibold", statusInkClass("attention"))}>
                {row.exception}
              </span>
            )}
            {/* A reading under strain, with its bar: the same glance a desktop's row draws. */}
            {row.loadAlerts.length > 0 && <span className="shrink-0"><MachineLoadGlanceBars glance={row.loadAlerts} /></span>}
            {!row.exception && row.quietNote && (
              <span className="shrink-0 text-xs text-muted-foreground">{row.quietNote}</span>
            )}
          </>
        );

        return (
          <div key={row.key}>
            {groupLabel && (
              <h2 className="pt-4 pb-1 text-xs font-bold text-muted-foreground">{groupLabel}</h2>
            )}
            <section aria-label={row.name} data-testid="fleet-machine"
              className={cn("py-2.5", index > 0 && !groupLabel && "border-t border-foreground/[0.08]", row.dimmed && "opacity-60")}>
              {row.onOpenMachine ? (
                <button type="button" data-testid="machine-row" onClick={row.onOpenMachine}
                  className="flex w-full min-w-0 items-center gap-2 pb-1.5 text-left">
                  {headingCopy}
                  <ChevronRight className="ml-auto size-3.5 shrink-0 text-muted-foreground/45" aria-hidden="true" />
                </button>
              ) : (
                <div className="flex w-full min-w-0 items-center gap-2 pb-1.5">{headingCopy}</div>
              )}

              <div className={cn(scrollable && "-mx-[var(--mobile-content-inset,1rem)] overflow-x-auto px-[var(--mobile-content-inset,1rem)] scroll-px-[var(--mobile-content-inset,1rem)] snap-x")}>
                <div className="grid items-center" style={gridStyle}>
                  {columns.map((column) => {
                    const id = cellId({ row: row.key, harness: column.harness });
                    const cell = row.cells[column.harness] ?? { kind: "unknown" };
                    return (
                      <MobileAvatarCell key={column.harness} cell={cell} harness={column.harness} machine={row.name}
                        id={id} selected={id === selectedId} offline={row.dimmed}
                        ghostHint={row.own && row.online && peerPresent.has(column.harness) && rows.length > 1}
                        onSelect={() => onSelect(id === selectedId ? null : { row: row.key, harness: column.harness })} />
                    );
                  })}
                  {canAddInline && (
                    <button type="button" onClick={() => setChoosingColumn(true)} aria-expanded={choosingColumn}
                      aria-haspopup="menu" data-testid={assignAddTestId ? "fleet-add-column" : undefined}
                      aria-label="Add an agent"
                      className="flex flex-col items-center justify-center gap-1 rounded-xl py-1 text-muted-foreground hover:text-foreground">
                      <span className="flex size-8 items-center justify-center rounded-full border border-dashed border-foreground/25">
                        <Plus className="size-3.5" aria-hidden="true" />
                      </span>
                      <span className="h-1" aria-hidden="true" />
                    </button>
                  )}
                </div>
              </div>
            </section>
          </div>
        );
      })}

      {addRow && (
        <div className="border-t border-dashed border-foreground/12 pt-3">
          <button type="button" onClick={addRow.onToggle} aria-expanded={addRow.open} data-testid="fleet-add-row"
            className="group block w-full text-left">
            <span className="flex items-center gap-1.5 text-[14px] font-semibold text-muted-foreground transition-colors group-hover:text-foreground">
              <Plus className={cn("size-4 shrink-0 transition-transform", addRow.open && "rotate-45")} aria-hidden="true" />
              <span>Add a machine</span>
            </span>
            {ownMachineCount <= 1 && (
              <span className="mt-0.5 block text-xs text-muted-foreground/80">
                Keep agents running when this computer sleeps
              </span>
            )}
            <span className="mt-2 grid items-center" style={gridStyle} aria-hidden="true">
              {Array.from({ length: Math.min(Math.max(columns.length, 2), 8) }).map((_, slot) => (
                <span key={slot} className="flex flex-col items-center justify-center py-1">
                  <span className="size-8 rounded-full border border-dashed border-foreground/20" />
                </span>
              ))}
            </span>
          </button>
          {addRow.open && <div className="pt-3" data-testid="fleet-add-row-steps">{addRow.content}</div>}
        </div>
      )}

      {editors.map((editor) => {
        const id = cellId(editor);
        return (
          <MobileEditorSheet key={id} visible={id === selectedId} label={editor.label} onClose={() => onSelect(null)}>
            {editor.node}
          </MobileEditorSheet>
        );
      })}

      {addColumn && (
        <MobileAddColumnSheet open={choosingColumn} options={addColumn.options}
          onAdd={addColumn.onAdd} onClose={() => setChoosingColumn(false)} />
      )}
    </div>
  );
}

function MobileAvatarCell({ cell, harness, machine, id, selected, offline, ghostHint, onSelect }: {
  cell: FleetMatrixCell;
  harness: string;
  machine: string;
  id: string;
  selected: boolean;
  offline: boolean;
  ghostHint: boolean;
  onSelect: () => void;
}) {
  if (cell.kind === "unknown") return <span className="flex flex-col items-center py-1" aria-hidden="true"><span className="size-8" /><span className="mt-1 h-1" /></span>;
  if (cell.kind === "unsupported") {
    return (
      <span className="flex flex-col items-center justify-center py-1" data-testid="fleet-cell" data-state="unsupported"
        title={`${harness} cannot run on ${machine}`}>
        <span className="size-8" aria-hidden="true" />
        <span className="mt-1 h-1" aria-hidden="true" />
        <span className="sr-only">{harness} cannot run on {machine}</span>
      </span>
    );
  }

  const edits = { type: "button" as const, onClick: onSelect, "data-cell": id, "aria-expanded": selected, "aria-haspopup": "dialog" as const };
  const buttonClass = cn(
    "flex flex-col items-center justify-center gap-1 rounded-xl py-1 transition-colors snap-start",
    selected && "bg-foreground/[0.05] ring-2 ring-foreground/65",
  );

  if (cell.busy) {
    return (
      <button {...edits} data-testid={cell.kind === "agent" ? "agent-row" : "fleet-cell"} data-state="busy"
        aria-label={`${harness} on ${machine}: ${cell.busy}`} className={buttonClass}>
        <span className="relative flex size-8 items-center justify-center">
          <Face of={{ kind: "agent", name: harness, harness }} size="sm" shape="circle" showKindBadge={false} className="opacity-40" />
          <AnimatedIcon icon={Loader2} className="absolute size-4 animate-spin text-foreground" />
        </span>
        <span className="h-1" aria-hidden="true" />
      </button>
    );
  }

  if (cell.kind === "absent") {
    return (
      <button {...edits} data-testid="fleet-cell" data-state="absent" data-outline={ghostHint ? "" : undefined}
        aria-label={`${harness} is not installed on ${machine}`} className={buttonClass}>
        <span className="flex size-8 items-center justify-center">
          {ghostHint ? (
            <span className="flex size-8 items-center justify-center rounded-full border border-dashed border-foreground/25">
              <Face of={{ kind: "agent", name: harness, harness }} size="xs" shape="circle" showKindBadge={false} className="opacity-30 grayscale" />
            </span>
          ) : (
            <span className="size-1.5 rounded-full bg-foreground/20" aria-hidden="true" />
          )}
        </span>
        <span className="h-1" aria-hidden="true" />
      </button>
    );
  }

  if (cell.kind === "off") {
    return (
      <button {...edits} data-testid="fleet-cell" data-state="off"
        aria-label={`${harness} on ${machine}: off in this Space`} className={buttonClass}>
        <span className="flex size-8 items-center justify-center">
          <Face of={{ kind: "agent", name: harness, harness }} size="sm" shape="circle" showKindBadge={false} className="opacity-35 grayscale" />
        </span>
        <span className="h-1" aria-hidden="true" />
      </button>
    );
  }

  const working = cell.working > 0;
  const attention = cell.state === "attention";
  const worst = tightest(cell.usage)[0];
  const strainedQuota = worst && meterTone(worst.percent) !== "green" ? worst : null;
  const attentionBadge = attention && (
    <span aria-hidden="true"
      className="absolute -top-1 -right-1 flex size-4 items-center justify-center rounded-full bg-[var(--m-ink-attention,var(--accent))] text-[var(--app-panel-paper,white)] ring-[1.5px] ring-[var(--app-panel-paper,var(--background))]">
      {cell.label === "Sign in" ? <KeyRound className="size-2.5" strokeWidth={2.5} />
        : cell.label === "Update" ? <ArrowUp className="size-2.5" strokeWidth={2.75} />
          : <span className="text-[10px] font-black leading-none">!</span>}
    </span>
  );

  return (
    <button {...edits} data-testid="agent-row" data-state={cell.state}
      aria-label={`${cell.name ?? harness} on ${machine}: ${cell.detail}`} className={buttonClass}>
      <span className={cn("relative flex size-8 items-center justify-center rounded-full",
        attention && "ring-2 ring-[var(--m-ink-attention,var(--accent))] ring-offset-2 ring-offset-[var(--app-panel-paper,var(--background))]")}>
        {working && !attention && (
          <span aria-hidden="true"
            className="pointer-events-none absolute -inset-1 rounded-full border-2 border-[var(--m-ink-running,var(--foreground))]/40 animate-pulse" />
        )}
        <Face of={{ kind: "agent", name: harness, harness }} size="sm" shape="circle" showKindBadge={false}
          className={cn(offline && "grayscale-[45%]")} />
        {attentionBadge}
      </span>
      <span className="flex h-1 w-6 items-center justify-center">
        {strainedQuota && (
          <span role="img" data-testid="agent-usage-glance"
            aria-label={cell.usage.map((reading) => reading.detail).join(", ")}
            className="block h-[3px] w-5 overflow-hidden rounded-full bg-foreground/12">
            <span className="app-usage-meter-fill block h-full rounded-full" data-tone={meterTone(strainedQuota.percent)}
              style={{ width: `${Math.max(strainedQuota.percent, 10)}%` }} />
          </span>
        )}
      </span>
    </button>
  );
}

/**
 * Bottom sheet for editing one matrix cell on a phone. Uses a light scrim
 * without blur so the ringed avatar and machine row stay legible above it,
 * and stays mounted while hidden so installs continue in the background.
 */
export function MobileEditorSheet({ visible, label, onClose, children }: {
  visible: boolean; label: string; onClose: () => void; children: ReactNode;
}) {
  const sheet = useRef<HTMLDivElement | null>(null);
  const close = useRef(onClose);
  useEffect(() => { close.current = onClose; });

  useEffect(() => {
    if (!visible) return;
    return listenForOverlayDismissal((event) => {
      const target = event.target instanceof Element ? event.target : null;
      if (!target || sheet.current?.contains(target) || target.closest('[role="dialog"]')) return;
      close.current();
    }, () => close.current());
  }, [visible]);

  if (typeof document === "undefined") return null;
  return createPortal(
    <div className="xmatrix-app fixed inset-0 z-50 flex flex-col justify-end"
      style={visible ? { background: "rgba(0, 0, 0, 0.14)" } : { display: "none" }}>
      <PaperPopover ref={sheet} role="dialog" aria-modal="true" aria-label={label} data-testid="fleet-cell-editor"
        className="xmatrix-app app-mobile-space-sheet app-tool-detail w-full border-t border-foreground/10 shadow-2xl">
        <div className="app-mobile-space-sheet-grabber" aria-hidden="true" />
        <div className="px-1 pt-0.5 pb-1">{children}</div>
      </PaperPopover>
    </div>,
    document.body,
  );
}

/** Bottom sheet picker for adding an agent column on a phone. */
export function MobileAddColumnSheet({ open, options, onAdd, onClose }: {
  open: boolean;
  options: Array<{ harness: string; name: string }>;
  onAdd: (harness: string) => void;
  onClose: () => void;
}) {
  return (
    <Sheet open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <SheetContent side="bottom" showCloseButton={false} className="xmatrix-app app-mobile-space-sheet md:hidden">
        <div className="app-mobile-space-sheet-grabber" aria-hidden="true" />
        <div className="app-mobile-space-sheet-header">
          <h2>Add an agent</h2>
        </div>
        <ul role="menu" aria-label="Agents no machine has yet" className="space-y-0.5 pt-1">
          {options.map((option) => (
            <li key={option.harness}>
              <button type="button" role="menuitem" data-testid="fleet-add-column-option"
                onClick={() => { onClose(); onAdd(option.harness); }}
                className="app-mobile-space-option">
                <Face of={{ kind: "agent", name: option.harness, harness: option.harness }} size="sm" showKindBadge={false} className="shrink-0" />
                <span className="min-w-0 flex-1 truncate font-semibold">{option.name}</span>
                <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      </SheetContent>
    </Sheet>
  );
}
