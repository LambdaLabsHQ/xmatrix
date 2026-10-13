/** What a determinate send failure says when the server gave no reason of its own. */
export const MESSAGE_SEND_FAILED_FALLBACK = "Couldn't send the message";

export type UnsentMessageAction = "retry" | "discard";

const ACTION_CLASS_NAME =
  "app-message-unsent-action inline-flex h-11 shrink-0 items-center text-[13px] font-bold md:h-5";

/**
 * A message of the reader's own that is not in the conversation: the send
 * failed, or it passed its deadline and nobody knows. A label beside the time
 * was read as one more tag and the message was typed again (user 2026-10-13:
 * 这个很难看出来是我消息没发出去), so the row says it the way chat apps do: the
 * filled red "!" of WeChat and Telegram, on a line under the greyed text with
 * the two things left to do, as Slack lays it out. A send whose result is
 * unknown wears a brass "?" instead, since it may have been written.
 * Sending again reuses the row's clientMessageId, which the Hub appends at most
 * once, so a send that did commit is not posted twice.
 */
export function MessageUnsentNotice({ status, error, onAction }: {
  status: "unconfirmed" | "failed";
  error?: string;
  onAction: (action: UnsentMessageAction) => void;
}) {
  const failed = status === "failed";
  const reason = failed && error && error !== MESSAGE_SEND_FAILED_FALLBACK ? error : null;
  return (
    <div role={failed ? "alert" : "status"} data-message-unsent={status}
      title={failed ? undefined : "The send timed out, so it may or may not have been written."}
      className="app-message-unsent mt-1 flex max-w-full flex-wrap items-center gap-x-2 text-[13px] leading-5">
      <span aria-hidden="true" className="app-message-unsent-badge">{failed ? "!" : "?"}</span>
      <span className="app-message-unsent-ink min-w-0 font-bold [overflow-wrap:anywhere]">
        {failed ? "Not sent" : "Not confirmed"}{reason ? ` · ${reason}` : null}
      </span>
      <button type="button" className={ACTION_CLASS_NAME} data-unsent-action="retry" onClick={() => onAction("retry")}>
        Send again
      </button>
      <button type="button" className={ACTION_CLASS_NAME} data-unsent-action="discard" onClick={() => onAction("discard")}>
        Delete
      </button>
    </div>
  );
}
