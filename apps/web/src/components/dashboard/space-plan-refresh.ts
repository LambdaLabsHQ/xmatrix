import { spacePlanMark, type SpacePlanBilling } from "./space-plan-mark";

/** Other open tabs of this origin hear a plan change on this channel. */
export const SPACE_PLAN_REFRESH_CHANNEL = "xmatrix-space-plan";

export interface SpacePlanRefreshNotice {
  userId: string;
  spaceId: string;
  signature: string;
}

/** The parts of a billing summary the mark actually shows.
 *
 * Seat counts and period dates stay out of it: a notice is "the chip would
 * paint something else", not "any byte of the summary moved". */
export function spacePlanMarkSignature(
  billing: SpacePlanBilling | null | undefined,
): string | null {
  const mark = spacePlanMark(billing);
  if (!mark) return null;
  return `${mark.plan}|${mark.state}|${mark.title}`;
}

/** A signature worth telling other tabs about.
 *
 * The first time a tab reads a plan, `previous` is missing. Publishing that
 * would make every other open tab refetch just because this one loaded.
 * A later change — Free with the allowance used up, then Pro — is the event
 * the other tabs are stale about. */
export function spacePlanRefreshToPublish(
  previous: string | null | undefined,
  next: string | null,
): string | null {
  if (previous === undefined || previous === null || next === null || previous === next) return null;
  return next;
}

/** Whether a notice describes a plan this tab is not already showing.
 *
 * A tab ignores notices for another Space or user, and a notice of the plan
 * it already has. Refetching those would bounce the read between tabs. */
export function spacePlanNoticeNeedsFetch(
  notice: SpacePlanRefreshNotice | null | undefined,
  local: { userId: string; spaceId: string; signature: string | null },
): boolean {
  if (!notice || notice.userId !== local.userId || notice.spaceId !== local.spaceId) return false;
  if (!notice.signature) return false;
  return notice.signature !== local.signature;
}

let refreshChannel: BroadcastChannel | null = null;

function spacePlanRefreshBus(): BroadcastChannel | null {
  if (typeof BroadcastChannel === "undefined") return null;
  if (!refreshChannel) refreshChannel = new BroadcastChannel(SPACE_PLAN_REFRESH_CHANNEL);
  return refreshChannel;
}

/** Tell other tabs the mark changed. This tab's own listener does not hear
 * it: one channel both posts and subscribes, and a channel does not deliver
 * a message to the object that posted it. */
export function postSpacePlanRefresh(notice: SpacePlanRefreshNotice): void {
  spacePlanRefreshBus()?.postMessage(notice);
}

export function subscribeSpacePlanRefresh(
  listener: (notice: SpacePlanRefreshNotice) => void,
): () => void {
  const channel = spacePlanRefreshBus();
  if (!channel) return () => {};
  const onMessage = (event: MessageEvent<SpacePlanRefreshNotice>) => {
    listener(event.data);
  };
  channel.addEventListener("message", onMessage);
  return () => channel.removeEventListener("message", onMessage);
}
