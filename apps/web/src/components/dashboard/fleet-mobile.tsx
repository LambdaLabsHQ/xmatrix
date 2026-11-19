"use client";

import { ChevronRight, Plus } from "lucide-react";
import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { PaperPopover } from "@/components/ui/material-surfaces";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";

import { Face } from "./face";
import {
  cellId,
  FleetCellAgentReadout,
  FleetCellBusyReadout,
  type FleetMatrixCell,
  type FleetMatrixCellKey,
  type FleetMatrixEditor,
  type FleetMatrixRow,
} from "./fleet-matrix";
import { listenForOverlayDismissal } from "./use-overlay-dismiss";

export type MobileAddOption = { harness: string; name: string };

/**
 * Compact 2-column grid of (machine, agent) tiles beneath one machine heading
 * on a phone: Space-registered agents, installed-but-off programs, live installs,
 * and one + Add tile when more programs can be installed on this machine.
 */
export function MobileMachineCellGrid({
  row,
  harnesses,
  installable,
  selected,
  onSelect,
  onOpenAdd,
}: {
  row: FleetMatrixRow;
  harnesses: readonly string[];
  installable: readonly MobileAddOption[];
  selected: FleetMatrixCellKey | null;
  onSelect: (cell: FleetMatrixCellKey | null) => void;
  onOpenAdd: () => void;
}) {
  const visibleCells = harnesses.flatMap((harness): Array<{ harness: string; cell: FleetMatrixCell }> => {
    const cell = row.cells[harness];
    if (!cell) return [];
    if (cell.busy || cell.kind === "agent" || cell.kind === "off") return [{ harness, cell }];
    return [];
  });
  if (visibleCells.length === 0 && installable.length === 0) return null;
  const selectedId = selected ? cellId(selected) : null;

  return (
    <div className={cn("grid grid-cols-2 gap-2 px-[var(--mobile-content-inset,1rem)] pt-1 pb-3", row.dimmed && "opacity-65")}>
      {visibleCells.map(({ harness, cell }) => {
        const key: FleetMatrixCellKey = { row: row.key, harness };
        const id = cellId(key);
        const active = id === selectedId;
        const choose = () => onSelect(active ? null : key);
        const attention = cell.kind === "agent" && !cell.busy && cell.state === "attention";
        const tileClass = cn(
          "flex min-w-0 flex-col justify-between gap-1 rounded-xl border px-2.5 py-2 text-left transition-colors",
          attention
            ? "border-[var(--m-ink-attention,var(--accent))]/35 bg-[var(--m-ink-attention,var(--accent))]/[0.06] hover:bg-[var(--m-ink-attention,var(--accent))]/10"
            : cell.kind === "off" && !cell.busy
              ? "border-foreground/10 bg-foreground/[0.025] text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground"
              : "border-foreground/10 bg-foreground/[0.04] hover:bg-foreground/[0.07] active:bg-foreground/10",
          active && "ring-2 ring-foreground/40 ring-offset-1 ring-offset-background",
        );

        if (cell.busy) {
          return (
            <button key={harness} type="button" onClick={choose} data-cell={id} aria-expanded={active} aria-haspopup="dialog"
              data-testid={cell.kind === "agent" ? "agent-row" : "fleet-cell"} data-state="busy"
              aria-label={`${harness} on ${row.name}: ${cell.busy}`} className={tileClass}>
              <span className="flex min-w-0 items-center gap-1.5">
                <Face of={{ kind: "agent", name: harness, harness }} size="xs" showKindBadge={false} className="shrink-0" />
                <span className="min-w-0 truncate text-[13px] font-semibold leading-tight">{harness}</span>
              </span>
              <FleetCellBusyReadout busy={cell.busy} />
            </button>
          );
        }

        if (cell.kind === "off") {
          return (
            <button key={harness} type="button" onClick={choose} data-cell={id} aria-expanded={active} aria-haspopup="dialog"
              data-testid="fleet-cell" data-state="off"
              aria-label={`${harness} on ${row.name}: off in this Space`} className={tileClass}>
              <span className="flex min-w-0 items-center gap-1.5">
                <Face of={{ kind: "agent", name: harness, harness }} size="xs" showKindBadge={false} className="shrink-0 opacity-65" />
                <span className="min-w-0 truncate text-[13px] font-medium leading-tight">{harness}</span>
              </span>
              <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <span className="size-2 shrink-0 rounded-full border border-current" aria-hidden="true" />Off
              </span>
            </button>
          );
        }

        if (cell.kind !== "agent") return null;
        return (
          <button key={harness} type="button" onClick={choose} data-cell={id} aria-expanded={active} aria-haspopup="dialog"
            data-testid="agent-row" data-state={cell.state}
            aria-label={`${cell.name ?? harness} on ${row.name}: ${cell.detail}`} className={tileClass}>
            <span className="flex min-w-0 items-center gap-1.5">
              <Face of={{ kind: "agent", name: harness, harness }} size="xs" showKindBadge={false} className="shrink-0" />
              <span className="min-w-0 truncate text-[13px] font-semibold leading-tight">{cell.name ?? harness}</span>
            </span>
            <FleetCellAgentReadout cell={cell} />
          </button>
        );
      })}

      {installable.length > 0 && (
        <button type="button" onClick={onOpenAdd} data-testid="fleet-mobile-add-cell"
          aria-label={`Add an agent to ${row.name}`}
          className="flex min-w-0 items-center gap-1.5 rounded-xl border border-dashed border-foreground/15 px-2.5 py-2 text-left text-xs font-semibold text-muted-foreground transition-colors hover:border-foreground/25 hover:bg-foreground/[0.04] hover:text-foreground">
          <Plus className="size-3.5 shrink-0" aria-hidden="true" />
          <span className="truncate">Add agent</span>
        </button>
      )}
    </div>
  );
}

/**
 * Bottom sheets backing mobile's cell edits and per-machine "+ Add agent" picker.
 * Cell editors stay mounted while hidden so an in-progress install finishes in
 * the background, matching desktop's AnchoredPaper lifecycle.
 */
export function MobileFleetSheets({
  editors,
  selected,
  onSelect,
  addingOn,
  onPickInstallable,
  onCloseAdd,
}: {
  editors: FleetMatrixEditor[];
  selected: FleetMatrixCellKey | null;
  onSelect: (cell: FleetMatrixCellKey | null) => void;
  addingOn: { machineName: string; options: MobileAddOption[] } | null;
  onPickInstallable: (harness: string) => void;
  onCloseAdd: () => void;
}) {
  const selectedId = selected ? cellId(selected) : null;
  return (
    <>
      {editors.map((editor) => {
        const id = cellId(editor);
        return (
          <MobileEditorSheet key={id} visible={id === selectedId} label={editor.label} onClose={() => onSelect(null)}>
            {editor.node}
          </MobileEditorSheet>
        );
      })}
      <Sheet open={Boolean(addingOn)} onOpenChange={(open) => { if (!open) onCloseAdd(); }}>
        <SheetContent side="bottom" showCloseButton={false} className="xmatrix-app app-mobile-space-sheet md:hidden">
          <div className="app-mobile-space-sheet-grabber" aria-hidden="true" />
          <div className="app-mobile-space-sheet-header">
            <h2>{addingOn ? `Add an agent to ${addingOn.machineName}` : "Add an agent"}</h2>
          </div>
          <ul className="space-y-0.5 pt-1" data-testid="fleet-mobile-add-menu">
            {addingOn?.options.map((option) => (
              <li key={option.harness}>
                <button type="button" onClick={() => onPickInstallable(option.harness)} className="app-mobile-space-option">
                  <Face of={{ kind: "agent", name: option.harness, harness: option.harness }} size="sm" showKindBadge={false} className="shrink-0" />
                  <span className="min-w-0 flex-1 truncate font-semibold">{option.name}</span>
                  <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
        </SheetContent>
      </Sheet>
    </>
  );
}

function MobileEditorSheet({ visible, label, onClose, children }: {
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
      style={visible ? { background: "rgba(0, 0, 0, 0.25)", backdropFilter: "blur(4px)" } : { display: "none" }}>
      <PaperPopover ref={sheet} role="dialog" aria-modal="true" aria-label={label} data-testid="fleet-cell-editor"
        className="xmatrix-app app-mobile-space-sheet app-tool-detail w-full border-t border-foreground/10 shadow-2xl">
        <div className="app-mobile-space-sheet-grabber" aria-hidden="true" />
        <div className="px-1 pt-0.5 pb-1">{children}</div>
      </PaperPopover>
    </div>,
    document.body,
  );
}
