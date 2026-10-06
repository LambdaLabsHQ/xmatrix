"use client";

import { createPortal } from "react-dom";
import { Loader2 } from "lucide-react";

import { useEscapeDismiss } from "./use-overlay-dismiss";
import { useAndroidBackDismiss } from "@/components/dashboard/use-android-back";
import { LiquidGlassCard } from "@/components/ui/material-surfaces";
import { cn } from "@/lib/utils";

/* Its own module rather than a corner of workspace-composer-dialogs: that file
   imports the profile views, so any dialog a profile component opens would
   otherwise close an import cycle.

   Material (ruled by the design owner 2026-09-14): forms are pages in the main
   column (see agent-config-page.tsx); only short confirmations and pickers stay
   dialogs, and a dialog is one liquid-glass pane floating over the wood board
   with no full-screen scrim; the overlay only catches the outside click.
   Nothing inside the pane opens a second glass layer: inputs, option cards
   and read-only facts are thinner fills of the pane, and actions are flat
   capsules the way Apple's alerts draw them.
   Header text, body and footer share one left edge; there is no decorative
   icon to indent around.
   See themes/materials.css "dialogs and form pages". */
export function CenteredDialogShell({
  open,
  busy,
  labelledBy,
  overlayClassName,
  panelClassName,
  children,
  onCancel,
}: {
  open: boolean;
  busy: boolean;
  labelledBy: string;
  overlayClassName?: string;
  panelClassName?: string;
  children: React.ReactNode;
  onCancel: () => void;
}) {
  useAndroidBackDismiss(open, onCancel, busy);

  useEscapeDismiss(open && !busy, onCancel);

  if (!open || typeof document === "undefined") return null;

  return createPortal(
    <div
      className={cn(
        "xmatrix-app app-dialog-overlay fixed inset-0 z-50 flex items-center justify-center overflow-hidden px-3 py-3 text-foreground sm:px-4",
        overlayClassName
      )}
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onCancel();
      }}
    >
      <LiquidGlassCard
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        className={cn(
          "app-dialog-panel max-h-[calc(100dvh-1.5rem)] w-full text-foreground",
          panelClassName
        )}
      >
        {children}
      </LiquidGlassCard>
    </div>,
    document.body
  );
}

export function DialogPanelHeader({
  labelledBy,
  title,
  subtitle,
  description,
}: {
  labelledBy: string;
  title: string;
  subtitle?: string;
  description?: string;
}) {
  return (
    <div className="app-dialog-header border-b border-border px-5 py-4">
      <h2 id={labelledBy} className="text-base font-black leading-tight">
        {title}
      </h2>
      {subtitle && (
        <p className="mt-1 truncate text-xs font-bold text-muted-foreground">
          {subtitle}
        </p>
      )}
      {description && (
        <p className="mt-1 text-xs font-semibold text-muted-foreground">
          {description}
        </p>
      )}
    </div>
  );
}

export function DialogPanelFooter({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("app-dialog-footer flex justify-end gap-2 border-t border-border px-5 py-3", className)}>
      {children}
    </div>
  );
}

export type DialogButtonTone = "secondary" | "primary" | "destructive";

/* One button vocabulary for every dialog, Apple's alert buttons: flat
   capsules with no shadow or rim. The primary is solid dark ink, secondary
   actions a faint tint of the pane, destructive ones that same tint with red
   ink. */
export function DialogButton({
  tone = "secondary",
  busy = false,
  icon: Icon,
  className,
  children,
  ...props
}: Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "children"> & {
  tone?: DialogButtonTone;
  busy?: boolean;
  icon?: React.ComponentType<{ className?: string }>;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      className={cn(
        "app-dialog-button inline-flex h-9 min-w-24 shrink-0 items-center justify-center gap-2 rounded-full px-4 text-sm font-semibold disabled:pointer-events-none disabled:opacity-50",
        tone === "secondary" && "app-dialog-button-secondary",
        tone === "primary" && "bg-primary text-primary-foreground",
        tone === "destructive" && "app-dialog-button-destructive bg-destructive text-destructive-foreground",
        className
      )}
      {...props}
    >
      {busy ? <Loader2 className="size-4 animate-spin" /> : Icon ? <Icon className="size-4" /> : null}
      {children}
    </button>
  );
}

/* A glass block: read-only facts or a bounded option pinned inside the pane
   (request ids, reasons, review summaries, permission toggles, an open
   picker's list). It is the same material as the pane, one step thinner — the
   app has no second material to fall back on. */
export function DialogInset({
  as: Component = "div",
  label,
  tone = "default",
  className,
  children,
  ...props
}: React.HTMLAttributes<HTMLElement> & {
  as?: React.ElementType;
  label?: string;
  tone?: "default" | "destructive" | "warning";
  children: React.ReactNode;
}) {
  return (
    <Component
      className={cn(
        "app-dialog-inset px-3 py-2.5 text-sm",
        tone === "destructive" && "app-dialog-inset-destructive",
        tone === "warning" && "app-dialog-inset-warning",
        className
      )}
      {...props}
    >
      {label && <p className="truncate text-xs font-bold text-muted-foreground">{label}</p>}
      {children}
    </Component>
  );
}
