import type { Page } from "@playwright/test";

/* Where the timeline's messages stand in every frame the browser paints.

   A frame is read in a task posted from its animation frame callback. That
   task runs after the frame's layout, its resize observers and its paint, and
   ahead of anything the frame itself queued, so it sees what the reader saw.
   Reading inside the frame instead (from a resize observer, say) reports
   layouts the page corrects before it paints, and misses ones it paints. */

/** One painted frame: each visible message's top edge, by its row id. */
type PaintedTimelineFrame = {
  at: number;
  /** The selector the recording was started with matches something. */
  open: boolean;
  /** The conversation is still drawn by its opening rows, not by the list. */
  opening: boolean;
  /** How far the timeline is scrolled, and how tall its content is. */
  scrollTop: number;
  scrollHeight: number;
  tops: Record<string, number>;
  /** Each visible message's bottom edge, by its row id. */
  bottoms: Record<string, number>;
};

type RecordingWindow = Window & { __paintedTimelineFrames?: PaintedTimelineFrame[] };

/** The pushed screen's content edge after paint, below its floating title bar. */
export async function paintedMainTop(page: Page) {
  return page.evaluate(() => new Promise<{ contentTop: number; titleBottom: number }>(resolve => {
    const painted = new MessageChannel();
    painted.port1.onmessage = () => {
      const main = document.querySelector(".app-main")!;
      const title = document.querySelector(".app-topbar")!;
      const contentTop = main.getBoundingClientRect().top + parseFloat(getComputedStyle(main).paddingTop);
      const titleBottom = title.getBoundingClientRect().bottom;
      painted.port1.close();
      painted.port2.close();
      resolve({ contentTop, titleBottom });
    };
    requestAnimationFrame(() => painted.port2.postMessage(null));
  }));
}

/** Starts recording; `openSelector` marks the frames a spec cares about. */
export async function recordPaintedTimelineFrames(page: Page, openSelector = ".app-message-timeline") {
  await page.evaluate((selector) => {
    const frames: PaintedTimelineFrame[] = [];
    (window as RecordingWindow).__paintedTimelineFrames = frames;
    const painted = new MessageChannel();
    painted.port1.onmessage = () => {
      const timeline = document.querySelector(".app-message-timeline");
      const view = timeline?.getBoundingClientRect();
      const tops: Record<string, number> = {};
      const bottoms: Record<string, number> = {};
      for (const row of timeline?.querySelectorAll<HTMLElement>("[id^='message:']") ?? []) {
        const box = row.getBoundingClientRect();
        if (!view || box.height === 0 || box.bottom <= view.top || box.top >= view.bottom) continue;
        if (getComputedStyle(row).visibility === "hidden") continue;
        tops[row.id] = box.top;
        bottoms[row.id] = box.bottom;
      }
      frames.push({
        at: performance.now(),
        open: Boolean(document.querySelector(selector)),
        opening: Boolean(timeline?.querySelector(".app-message-timeline-opening-tail")),
        scrollTop: timeline?.scrollTop ?? 0,
        scrollHeight: timeline?.scrollHeight ?? 0,
        tops,
        bottoms,
      });
    };
    const eachFrame = () => {
      // A spec that starts a second recording replaces the first.
      if ((window as RecordingWindow).__paintedTimelineFrames !== frames) return;
      painted.port2.postMessage(null);
      requestAnimationFrame(eachFrame);
    };
    requestAnimationFrame(eachFrame);
  }, openSelector);
}

/** The frames painted since the recording started. */
export async function paintedTimelineFrames(page: Page): Promise<PaintedTimelineFrame[]> {
  // A few frames more, so a move that comes late is recorded too.
  await page.evaluate(() => new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))));
  return page.evaluate(() => (window as RecordingWindow).__paintedTimelineFrames ?? []);
}

/** A message that stood in two frames running and was not in the same place. */
type PaintedRowMove = { row: string; at: number; by: number };

/** Every move of more than a pixel between one painted frame and the next. */
export function paintedRowMoves(frames: readonly PaintedTimelineFrame[]): PaintedRowMove[] {
  const moves: PaintedRowMove[] = [];
  frames.forEach((frame, index) => {
    const before = frames[index - 1];
    if (!before) return;
    for (const [row, top] of Object.entries(frame.tops)) {
      const was = before.tops[row];
      if (was !== undefined && Math.abs(top - was) > 1) moves.push({ row, at: frame.at, by: top - was });
    }
  });
  return moves;
}

/** A message drawn over the one above it in a painted frame. */
type PaintedRowOverlap = { row: string; above: string; at: number; by: number };

/** Every frame in which a message reaches more than a pixel into the next one down. */
export function paintedRowOverlaps(frames: readonly PaintedTimelineFrame[]): PaintedRowOverlap[] {
  const overlaps: PaintedRowOverlap[] = [];
  for (const frame of frames) {
    // Recorded in the order the page holds them, top to bottom.
    const rows = Object.keys(frame.tops);
    rows.forEach((row, index) => {
      const above = rows[index - 1];
      if (!above) return;
      const by = frame.bottoms[above]! - frame.tops[row]!;
      if (by > 1) overlaps.push({ row, above, at: frame.at, by });
    });
  }
  return overlaps;
}
