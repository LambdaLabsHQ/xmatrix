"use client";

import { useState, type ButtonHTMLAttributes, type ReactNode } from "react";
import { Check, ChevronDown, Copy, Plus, RefreshCw } from "lucide-react";
import { actionClass } from "@/components/ui/action-tone";
import { cn } from "@/lib/utils";

/*
 * The parts an App's page is made of. A page has one lead: when the reader has
 * something to do (connect, reconnect, fix), that one thing is a sheet of
 * tinted paper carrying the page's only solid action. Everything else is plain
 * paper in headed parts, most used first and reference last; their rows are
 * set apart by space, never rules, and act through quiet text actions. "Add"
 * is the last row of the list it adds to.
 */

/**
 * A headed part of the page. As the lead (`lead`) it is the tinted sheet that
 * carries what the reader has to do now, with the page's one solid action;
 * `alert` adds the rail of a problem card. Otherwise it is plain paper: a
 * title, at most one line saying what it is for, then its content. Both are
 * the same elements, so a part that stops being the lead once the app
 * connects (a group being linked) keeps whatever its content holds.
 */
export function ConnectorBlock({ lead = false, tone = "plain", title, note, action, children, testId }: {
  lead?: boolean;
  tone?: "plain" | "alert";
  title: ReactNode;
  note?: ReactNode;
  /** Upkeep of the whole part (Refresh, Rotate), at the end of its title. */
  action?: ReactNode;
  children?: ReactNode;
  testId?: string;
}) {
  return (
    <section className={lead ? "app-connector-sheet" : "app-connector-section"} data-tone={lead ? tone : undefined}
      data-testid={testId} aria-label={typeof title === "string" ? title : undefined}>
      <div className="flex min-h-7 min-w-0 items-center justify-between gap-3">
        <h3 className={cn("min-w-0 tracking-tight [overflow-wrap:anywhere]",
          lead ? "text-[17px] font-extrabold leading-snug" : "truncate text-[15px] font-extrabold")}>{title}</h3>
        {action ? <div className="-mr-2 flex shrink-0 items-center gap-1">{action}</div> : null}
      </div>
      {note ? (
        <div className={cn("max-w-[62ch] text-muted-foreground [overflow-wrap:anywhere]",
          lead ? "mt-1 text-[14px] leading-[1.5]" : "text-[13px] leading-[1.45]")}>{note}</div>
      ) : null}
      <div className={children ? lead ? "mt-4" : "mt-2" : undefined}>{children}</div>
    </section>
  );
}

/** The lead sheet: what the reader has to do now. */
export function ConnectorSheet({ body, ...props }: Omit<Parameters<typeof ConnectorBlock>[0], "lead" | "note"> & { body?: ReactNode }) {
  return <ConnectorBlock lead note={body} {...props} />;
}

/** One plain headed part of the page. */
export function ConnectorSection(props: Omit<Parameters<typeof ConnectorBlock>[0], "lead" | "tone"> & { title: string }) {
  return <ConnectorBlock {...props} />;
}

export function ConnectorRows({ children, testId, className }: { children: ReactNode; testId?: string; className?: string }) {
  return <ul className={cn("app-connector-rows", className)} data-testid={testId}>{children}</ul>;
}

/**
 * A thing the App reaches (an account, a mailbox, a group) or something it did:
 * its mark, its name, one line about it, and what can be done to it. On a
 * phone the actions go under the name instead of squeezing it.
 */
export function ConnectorRow({ leading, title, meta, trailing, trailingAtTitle = false, children, testId }: {
  leading?: ReactNode;
  title: ReactNode;
  meta?: ReactNode;
  trailing?: ReactNode;
  /** Keep what trails on the title's line when what is under it can open tall (a run's result). */
  trailingAtTitle?: boolean;
  /** More about the row, under its line: a field, a command. */
  children?: ReactNode;
  testId?: string;
}) {
  return (
    <li className="app-connector-row flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5" data-testid={testId}>
      {leading ? <span className="flex size-8 shrink-0 items-center justify-center self-start">{leading}</span> : null}
      <div className="min-w-0 flex-1 basis-56">
        <div className="min-w-0 text-sm font-semibold [overflow-wrap:anywhere]">{title}</div>
        {meta ? <div className="mt-0.5 text-[13px] leading-[1.45] text-muted-foreground [overflow-wrap:anywhere]">{meta}</div> : null}
        {children}
      </div>
      {trailing ? <div className={cn("-mr-2 flex shrink-0 items-center gap-0.5", trailingAtTitle && "self-start", leading && "max-sm:pl-11")}>{trailing}</div> : null}
    </li>
  );
}

/** The last row of a list: adds one more of what it lists. */
export function ConnectorAddRow({ label, onClick, disabled, busy, testId }: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  busy?: boolean;
  testId?: string;
}) {
  return (
    <li>
      <button type="button" onClick={onClick} disabled={disabled || busy} data-testid={testId}
        className="app-connector-add-row flex w-full items-center gap-3 py-2.5 text-left text-sm font-semibold text-muted-foreground hover:text-foreground disabled:pointer-events-none disabled:opacity-50">
        <span className="flex size-8 shrink-0 items-center justify-center" aria-hidden="true">
          <Plus className={cn("size-4", busy && "animate-pulse")} />
        </span>
        {label}
      </button>
    </li>
  );
}

/** What a list says when it has nothing in it yet. */
export function ConnectorEmpty({ children }: { children: ReactNode }) {
  return <li className="py-2.5 text-[13px] leading-[1.45] text-muted-foreground">{children}</li>;
}

/** A quiet text action on a row or a part's title. */
export function ConnectorAction({ className, children, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button type="button" {...props} className={actionClass({ variant: "quiet", size: "sm" }, className)}>
      {children}
    </button>
  );
}

/** A line of text the reader pastes somewhere else, with Copy beside it. */
export function ConnectorCopyLine({ value, label, display }: { value: string; label: string; display?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="app-connector-copy-line flex min-w-0 items-center gap-1">
      <code className="min-w-0 flex-1 truncate rounded-none px-2.5 py-1.5 font-mono text-[13px]">{display ?? value}</code>
      <ConnectorAction aria-label={`Copy ${label}`} title={`Copy ${label}`}
        onClick={() => void navigator.clipboard?.writeText(value).then(() => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1_500);
        }, () => undefined)}>
        {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />} {copied ? "Copied" : "Copy"}
      </ConnectorAction>
    </div>
  );
}

/** Reference the reader opens when they need it: closed until asked. */
export function ConnectorFold({ summary, children, testId }: { summary: ReactNode; children: ReactNode; testId?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div data-testid={testId}>
      <button type="button" aria-expanded={open} onClick={() => setOpen((value) => !value)}
        className="flex items-center gap-1 py-1 text-[13px] font-semibold text-muted-foreground hover:text-foreground">
        {summary}
        <ChevronDown aria-hidden="true" className={cn("size-3.5 transition-transform", open && "rotate-180")} />
      </button>
      {open ? <div className="mt-1">{children}</div> : null}
    </div>
  );
}

/** A labelled field on the page: label, the control, one line of help under it. */
export function ConnectorField({ label, help, required, saved, children }: {
  label: string;
  help?: ReactNode;
  required?: boolean;
  /** A value is stored already; typing replaces it. */
  saved?: boolean;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 flex items-baseline gap-2 text-[13px] font-semibold">
        {label}
        {required ? <span className="font-normal text-muted-foreground">Required</span> : null}
        {saved ? <span className="font-normal text-muted-foreground">Saved</span> : null}
      </span>
      {children}
      {help ? <span className="mt-1.5 block max-w-[62ch] text-[12px] leading-[1.45] text-muted-foreground">{help}</span> : null}
    </label>
  );
}

/**
 * Linking a group or a company: the step that starts it (solid while it is the
 * page's lead) and Refresh connection, which reads back what the provider
 * confirmed; then what went wrong, if anything did.
 */
export function ConnectorLinkActions({ lead, busy, startLabel, startId, startDisabled, onStart, onRefresh, error, start = "button" }: {
  lead: boolean;
  busy: boolean;
  startLabel: string;
  startId?: string;
  startDisabled?: boolean;
  /** A form's submit starts it when the step's fields are a form. */
  start?: "button" | "submit";
  onStart?: () => void;
  onRefresh: () => void;
  error?: string | null;
}) {
  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <button id={startId} type={start} disabled={busy || startDisabled} onClick={onStart}
          className={actionClass({ variant: lead ? "primary" : "secondary", size: "md" })}>
          {busy ? "Working…" : startLabel}
        </button>
        <ConnectorAction disabled={busy} onClick={onRefresh}>
          <RefreshCw className="size-3.5" /> Refresh connection
        </ConnectorAction>
      </div>
      {error ? <p role="alert" className="text-[13px] text-destructive">{error}</p> : null}
    </>
  );
}
