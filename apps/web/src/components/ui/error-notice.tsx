"use client";

import { actionClass } from "@/components/ui/action-tone";
import { statusInkClass } from "@/components/ui/status-tone";
import { describeError } from "@/lib/user-facing-error";

/**
 * The one way a failure is shown: `describeError`'s sentence, a "Try again"
 * action when a retry can succeed, and the Hub's code for a person reporting
 * it. A request its caller cancelled renders nothing. `className` places and
 * sizes the notice; the default is alert ink on a bare run of text.
 */
export function ErrorNotice({ error, action, onRetry, className }: {
  error: unknown;
  /** What failed, as a sentence: "Couldn't load transfer proposals". */
  action: string;
  onRetry?: () => void;
  className?: string;
}) {
  const failure = describeError(error, action);
  if (!failure) return null;
  return <div role="alert" className={className ?? statusInkClass("alert", "text-sm")}>
    <p>{failure.message}</p>
    {(failure.reference || failure.report || (onRetry && failure.retryable)) && <p className="mt-1 flex flex-wrap items-center gap-2">
      {onRetry && failure.retryable && <button type="button" onClick={onRetry}
        className={actionClass({ variant: "secondary", size: "sm" })}>Try again</button>}
      {failure.reference && <span className="text-xs text-muted-foreground">Error code: {failure.reference}</span>}
      {failure.report && <span className="select-all text-xs text-muted-foreground">Report: {failure.report}</span>}
    </p>}
  </div>;
}
