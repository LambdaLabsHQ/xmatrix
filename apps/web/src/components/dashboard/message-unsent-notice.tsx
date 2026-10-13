import { AlertCircle, CircleHelp, RotateCw, Trash2 } from "lucide-react";

/** What a determinate send failure says when the server gave no reason of its own. */
export const MESSAGE_SEND_FAILED_FALLBACK = "Couldn't send the message";

export type UnsentMessageAction = "retry" | "discard";

const ACTION_CLASS_NAME =
  "app-message-unsent-action inline-flex h-11 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-xs font-bold transition md:h-7";

/**
 * A message of the reader's own that is not in the conversation: the send
 * failed, or it passed its deadline and nobody knows. A label beside the time
 * was read as one more tag and the message was typed again (user 2026-10-13:
 * 这个很难看出来是我消息没发出去), so the row says it under the body, on a slip
 * of tinted paper like an ask's, with the two things left to do about it.
 * Sending again reuses the row's clientMessageId, which the Hub appends at most
 * once, so a send that did commit is not posted twice.
 */
export function MessageUnsentNotice({ status, error, onAction }: {
  status: "unconfirmed" | "failed";
  error?: string;
  onAction: (action: UnsentMessageAction) => void;
}) {
  const failed = status === "failed";
  const Icon = failed ? AlertCircle : CircleHelp;
  const detail = failed
    ? (error && error !== MESSAGE_SEND_FAILED_FALLBACK ? error : "Nobody else can see it.")
    : "It may not have been sent.";
  return (
    <div role={failed ? "alert" : "status"} data-message-unsent={status}
      className="app-message-unsent mt-1.5 flex w-fit max-w-full flex-wrap items-center gap-x-3 gap-y-1">
      <span className="flex min-w-0 items-center gap-2 text-[13px] leading-snug">
        <Icon aria-hidden="true" className="app-message-unsent-ink size-4 shrink-0" />
        <span className="min-w-0 [overflow-wrap:anywhere]">
          <strong className="app-message-unsent-ink font-extrabold">{failed ? "Not sent" : "Not confirmed"}</strong>
          <span className="text-muted-foreground"> · {detail}</span>
        </span>
      </span>
      <span className="flex items-center gap-1">
        <button type="button" className={ACTION_CLASS_NAME} data-unsent-action="retry" onClick={() => onAction("retry")}>
          <RotateCw aria-hidden="true" className="size-3.5" />
          Send again
        </button>
        <button type="button" className={ACTION_CLASS_NAME} data-unsent-action="discard" onClick={() => onAction("discard")}>
          <Trash2 aria-hidden="true" className="size-3.5" />
          Delete
        </button>
      </span>
    </div>
  );
}
