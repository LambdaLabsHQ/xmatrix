"use client";

import { ChevronRight } from "lucide-react";
import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { PaperPopover } from "@/components/ui/material-surfaces";
import { Sheet, SheetContent } from "@/components/ui/sheet";

import { Face } from "./face";
import { listenForOverlayDismissal } from "./use-overlay-dismiss";

/**
 * Bottom sheet for editing one matrix cell on a phone. Stays mounted while
 * hidden so background operations (such as installing an agent) finish cleanly,
 * matching desktop's AnchoredPaper lifecycle.
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
