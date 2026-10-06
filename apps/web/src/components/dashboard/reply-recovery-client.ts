export type ReplyRecoveryResult = { status: "committed"; messageId: string }
  | { status: "selection_required"; candidates: Array<{ messageId: string; createdAt: number }> }
  | { status: "unavailable"; code: string };

const copy: Record<string, string> = {
  saved_reply_unavailable: "No saved final reply was found for this execution.",
  recovery_broker_unavailable: "The original machine cannot recover this reply right now.",
  reply_recovery_machine_unavailable: "Connect the original machine with a CLI version that supports reply recovery.",
  reply_recovery_run_ended: "The original agent has stopped. Its expired credentials cannot resend this reply.",
  reply_recovery_forbidden: "This recovery requires the original input and its Run owner.",
};
export function replyRecoveryError(code?: string) {
  return code && Object.hasOwn(copy, code) ? copy[code]! : "The saved reply could not be recovered. Its original record is retained.";
}

function pause(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, 1500);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}
export async function recoverReply(fetcher: typeof fetch, input: {
  channelId: string; bindingId: string; token: string; requestId: string; messageId?: string;
}, signal: AbortSignal): Promise<ReplyRecoveryResult> {
  const bounded = AbortSignal.any([signal, AbortSignal.timeout(60_000)]);
  const endpoint = `/api/xmatrix/channels/${encodeURIComponent(input.channelId)}/executions/${encodeURIComponent(input.bindingId)}/recover-reply`;
  const selection = { requestId: input.requestId, ...(input.messageId ? { messageId: input.messageId } : {}) };
  for (let attempt = 0; attempt < 32; attempt++) {
    bounded.throwIfAborted();
    const response = await fetcher(attempt ? `${endpoint}?${new URLSearchParams(selection)}` : endpoint, {
      method: attempt ? "GET" : "POST", signal: bounded,
      headers: { authorization: `Bearer ${input.token}`, "content-type": "application/json" },
      ...(attempt ? {} : { body: JSON.stringify(selection) }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(replyRecoveryError(body.code));
    if (body.requestId !== input.requestId) throw new Error("Recovery returned a different request reference.");
    if (["completed", "failed"].includes(body.status)) {
      const result = body.result;
      const validId = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9._:-]{1,160}$/u.test(value);
      if (result?.status === "committed" && validId(result.messageId) &&
          (!input.messageId || result.messageId === input.messageId)) return { status: "committed", messageId: result.messageId };
      if (result?.status === "selection_required" && Array.isArray(result.candidates) && result.candidates.length > 1 && result.candidates.length <= 20 &&
          result.candidates.every((item: { messageId?: unknown; createdAt?: unknown } | null) => item && validId(item.messageId) && Number.isSafeInteger(item.createdAt) &&
            Number(item.createdAt) >= 0 && Number(item.createdAt) <= 8_640_000_000_000)) {
        const candidates = result.candidates.map((item: { messageId: string; createdAt: number }) => ({ messageId: item.messageId, createdAt: item.createdAt }));
        if (new Set(candidates.map((item: { messageId: string }) => item.messageId)).size === candidates.length) return { status: "selection_required", candidates };
      }
      return { status: "unavailable", code: typeof result?.code === "string" ? result.code : "reply_recovery_failed" };
    }
    if (!["queued", "leased", "admitted", "pending"].includes(body.status)) throw new Error("The recovery request is no longer available.");
    await pause(bounded);
  }
  throw new Error("Recovery is still waiting for the original machine. Checking again will reuse this request.");
}
