import type { ReactNode } from "react";
import type { ClientDefectAction } from "@xmatrix/protocol";

import { ErrorNotice } from "@/components/ui/error-notice";
import { statusChipClass, type StatusTone } from "@/components/ui/status-tone";
import { ToolDetailSection } from "./tool-split";

/**
 * A request waiting on a person's decision, drawn on the paper like the
 * question card: its name and where it stands on a hairline, then what is
 * asked as one line led by the request's icon. Nothing frames it; the paper
 * it sits on is the card.
 */
export function ApprovalCard({ title, status, icon, state, children }: {
  title: string;
  /** Where the request stands, as a label at the end of its name. */
  status?: { tone: StatusTone; label: string } | false | null;
  icon: ReactNode;
  /** Brass while it waits on a decision, plain ink once granted, stepped back when closed. */
  state: "attention" | "running" | "offline";
  children: ReactNode;
}) {
  return (
    <div className="app-paper-card mt-1 w-full max-w-2xl" data-approval-card={state === "attention" ? "open" : "settled"}>
      <ToolDetailSection title={title}
        action={status ? <span className={statusChipClass(status.tone)}>{status.label}</span> : undefined}>
        <div className="flex min-w-0 items-start gap-3 py-2">
          <span className="app-tool-state-icon mt-0.5 shrink-0" data-state={state} aria-hidden="true">{icon}</span>
          <div className="min-w-0 flex-1 text-sm">{children}</div>
        </div>
      </ToolDetailSection>
    </div>
  );
}

/** Why a card could not act on a decision, or could not load what it asks. */
export function ApprovalError({ error, loadError, action, onRetry }: {
  error: string | null;
  loadError: unknown;
  action: ClientDefectAction;
  onRetry: () => void;
}) {
  const className = "mt-2 text-xs text-destructive";
  return error ? <div role="alert" className={className}>{error}</div>
    : <ErrorNotice error={loadError} action={action} className={className} onRetry={onRetry} />;
}
