import type { ReactNode } from "react";
import type { ClientDefectAction } from "@xmatrix/protocol";
import { PanelRightOpen } from "lucide-react";

import { actionClass } from "@/components/ui/action-tone";
import { ErrorNotice } from "@/components/ui/error-notice";
import { statusChipClass, type StatusTone } from "@/components/ui/status-tone";

/**
 * Something an Agent asks a person: a question, a secret, a read grant. On
 * the paper a card is a slip of tinted paper laid on the page, not a box
 * lifted off it: one flat block of colour, no edge and no shadow. Its first
 * line is the question itself, the largest line it has, so the eye starts
 * where the ask is; under it who asks and about what, what the answer
 * covers, and the answer's controls last. The block is brass while it waits on the
 * reader; once answered it fades to a plain tint and a label says how it ended.
 */
export function AskCard({ who, kind, icon, open, question, detail, status, aside, children }: {
  /** The Agent or harness asking. */
  who: string;
  /** What the ask is about, in a word or two. */
  kind?: string;
  icon: ReactNode;
  /** Whether it still waits on the reader's answer. */
  open: boolean;
  question: ReactNode;
  detail?: ReactNode;
  /** Where it stands when that is not "waiting on you": who decides, or how it ended. */
  status?: { tone: StatusTone; label: string } | false | null;
  /** A quiet way out of the ask (Decline), at the end of the line saying who asks. */
  aside?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <section className="app-paper-card app-ask-card mt-1.5 w-full max-w-2xl" data-ask-card={open ? "open" : "settled"}>
      <h3 className="text-[17px] font-extrabold leading-snug tracking-tight [overflow-wrap:anywhere]">{question}</h3>
      <div className="mt-1 flex min-w-0 items-center gap-2">
        <span className="app-ask-card-kicker flex min-w-0 items-center gap-1.5 text-xs font-extrabold">
          <span className="shrink-0" aria-hidden="true">{icon}</span>
          <span className="min-w-0 truncate">{[`${who} asks`, kind].filter(Boolean).join(" · ")}</span>
        </span>
        {status ? <span className={statusChipClass(status.tone, "shrink-0")}>{status.label}</span> : null}
        {aside ? <span className="-my-1 ml-auto shrink-0">{aside}</span> : null}
      </div>
      {detail ? <div className="mt-0.5 text-[13px] leading-[1.45] text-muted-foreground">{detail}</div> : null}
      {children}
    </section>
  );
}

/** Why a card could not act on an answer, or could not load what it asks. */
export function AskError({ error, loadError, action, onRetry }: {
  error: string | null;
  loadError: unknown;
  action: ClientDefectAction;
  onRetry: () => void;
}) {
  const className = "mt-2 text-xs text-destructive";
  return error ? <div role="alert" className={className}>{error}</div>
    : <ErrorNotice error={loadError} action={action} className={className} onRetry={onRetry} />;
}

/**
 * Shown in place of interactive approval / decision controls when a conversation
 * is rendered inside an untrusted web page's inline popover card: clicking opens
 * this tab's Chrome side panel directly to the card so decisions never happen in
 * a page-hosted overlay.
 */
export function HandleInSidePanelButton({ onClick, className }: {
  onClick: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      data-handle-in-side-panel="true"
      onClick={onClick}
      className={actionClass({ variant: "primary", size: "sm" }, className)}
    >
      <PanelRightOpen className="size-3.5" />
      Handle in side panel
    </button>
  );
}
