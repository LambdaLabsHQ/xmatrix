/* Sending a message moves the timeline the way a chat app does: the new row
   rises out of the composer and the rows above it rise by the room it takes,
   instead of the whole list jumping in one frame. The scroll itself still
   lands at once; this only draws the way there, on the rows, so neither the
   virtualizer's measurements nor the scroll position are involved. */

const SEND_RISE_MS = 260;
const SEND_RISE_EASING = "cubic-bezier(0.2, 0.8, 0.2, 1)";
/* A short timeline has nothing to scroll, so its rows stay put and the new row
   alone rises this far. */
const SEND_RISE_MIN_PX = 24;
/* A row counts as just sent only this long after the send. The virtualizer
   mounts rows again as they scroll back into view, and a queued send can be
   restored much later; neither is a send the reader is watching. */
const SEND_RISE_FRESH_MS = 1_500;

export function isJustSentRow(message: { own?: boolean; sendStatus?: string; sentAt: string }): boolean {
  return Boolean(message.own) && message.sendStatus === "pending" &&
    Date.now() - Date.parse(message.sentAt) < SEND_RISE_FRESH_MS;
}

export function playTimelineSendRise(scrollRoot: HTMLElement, sentRow: HTMLElement) {
  if (
    typeof sentRow.animate !== "function" ||
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  ) {
    return;
  }
  const rowHeight = sentRow.offsetHeight;
  // How far the pending scroll to the newest message will move the rows. A
  // reader who sent from further up is brought down by more than that; the
  // rows still rise by one row, not across the whole distance.
  const growth = Math.min(
    Math.max(0, scrollRoot.scrollHeight - scrollRoot.clientHeight - scrollRoot.scrollTop),
    rowHeight,
  );
  const timing = { duration: SEND_RISE_MS, easing: SEND_RISE_EASING };
  if (growth >= 1) {
    for (const row of scrollRoot.querySelectorAll<HTMLElement>("[data-timeline-rise-row]")) {
      if (row === sentRow) continue;
      row.animate([{ transform: `translateY(${growth}px)` }, { transform: "none" }], timing);
    }
  }
  const sentRise = Math.max(growth, Math.min(rowHeight, SEND_RISE_MIN_PX));
  sentRow.animate(
    [
      { opacity: 0, transform: `translateY(${sentRise}px)` },
      { opacity: 1, offset: 0.6 },
      { opacity: 1, transform: "none" },
    ],
    timing,
  );
}
