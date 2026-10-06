const POINTER_ACTIVATION_DEDUP_MS = 400;

const lastPointerActivation = {
  channelId: "",
  untilMs: Number.NEGATIVE_INFINITY,
};

export function rememberPointerActivation(channelId: string): void {
  if (!channelId) return;
  lastPointerActivation.channelId = channelId;
  lastPointerActivation.untilMs = performance.now() + POINTER_ACTIVATION_DEDUP_MS;
}

/** True when a mouse press already ran the full activate path for this Channel. */
export function pointerActivationAlreadyHandled(channelId: string): boolean {
  return Boolean(
    channelId &&
    channelId === lastPointerActivation.channelId &&
    performance.now() < lastPointerActivation.untilMs
  );
}

export function pointerActivationIsPending(): boolean {
  return performance.now() < lastPointerActivation.untilMs;
}
