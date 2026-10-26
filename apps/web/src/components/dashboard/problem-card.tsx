"use client";

import { useState, type ReactNode } from "react";
import { Check, Copy } from "lucide-react";

/**
 * Something went wrong and the reader can do something about it. Its first
 * line says what happened in the reader's words; under it why, then the steps
 * that fix it, where the problem stands right now, and the action that
 * continues the work. Codes and raw diagnostics are folded into Details, for
 * a person reporting it, never in the sentence. One failure is one card: the
 * chip on the message that caused it only names the state.
 */
export function ProblemCard({ icon, title, explanation, stepsLabel, steps, status, actions, detailsLabel, details }: {
  icon: ReactNode;
  /** What happened, as the reader would say it: "mac-mini is offline". */
  title: ReactNode;
  /** Why it matters here: what did not happen because of it. */
  explanation?: ReactNode;
  stepsLabel?: string;
  /** What fixes it, in order. Empty when the reader cannot fix it. */
  steps?: readonly ReactNode[];
  /** Where it stands right now, when that can change while the card is open. */
  status?: { resolved: boolean; label: ReactNode };
  actions?: ReactNode;
  detailsLabel: string;
  details?: ReactNode;
}) {
  return (
    <section className="app-paper-card app-problem-card mt-1.5 w-full max-w-2xl" data-problem-card={status?.resolved ? "resolved" : "open"}
      role="group" aria-label={typeof title === "string" ? title : undefined}>
      <h3 className="flex items-start gap-2 text-[17px] font-extrabold leading-snug tracking-tight [overflow-wrap:anywhere]">
        <span className="app-problem-card-icon mt-[3px] shrink-0" aria-hidden="true">{icon}</span>
        <span className="min-w-0">{title}</span>
      </h3>
      {explanation ? <p className="mt-1 text-[14px] leading-[1.5] text-muted-foreground">{explanation}</p> : null}
      {steps?.length ? <div className="mt-3">
        {stepsLabel ? <p className="text-xs font-extrabold text-muted-foreground">{stepsLabel}</p> : null}
        <ol className="mt-1 list-decimal space-y-1 pl-5 text-[14px] leading-[1.5]">
          {steps.map((step, index) => <li key={index}>{step}</li>)}
        </ol>
      </div> : null}
      {status ? <p role="status" className="app-problem-card-status mt-3 flex items-center gap-1.5 text-[13px] font-bold"
        data-resolved={status.resolved ? "true" : "false"}>
        <span className="app-problem-card-dot size-2 shrink-0 rounded-full" aria-hidden="true" />
        {status.label}
      </p> : null}
      {actions ? <div className="mt-3 flex flex-wrap items-center gap-2">{actions}</div> : null}
      {details ? <details className="mt-3 text-xs text-muted-foreground">
        <summary className="cursor-pointer select-none font-bold">{detailsLabel}</summary>
        <div className="mt-1 space-y-0.5 [overflow-wrap:anywhere]">{details}</div>
      </details> : null}
    </section>
  );
}

/** A command the reader runs elsewhere, with a copy button beside it. */
export function ProblemCommand({ command, copyLabel, copiedLabel }: { command: string; copyLabel: string; copiedLabel: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <span className="inline-flex max-w-full items-center gap-1 align-middle">
      <code className="app-problem-card-command min-w-0 truncate rounded px-1.5 py-0.5 font-mono text-[13px]">{command}</code>
      <button type="button" className="inline-flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-foreground"
        aria-label={copied ? copiedLabel : copyLabel} title={copied ? copiedLabel : copyLabel}
        onClick={() => void navigator.clipboard?.writeText(command).then(() => setCopied(true), () => undefined)}>
        {copied ? <Check className="size-3.5" aria-hidden="true" /> : <Copy className="size-3.5" aria-hidden="true" />}
      </button>
    </span>
  );
}
