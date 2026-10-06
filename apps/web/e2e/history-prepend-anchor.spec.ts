import { expect, test, type Page } from "./fixtures";
import {
  E2E_CHANNEL,
  E2E_DESKTOP_CONTEXT,
  E2E_NOW,
  E2E_USER_SENDER,
  openGeneralChannelWithPagedHistory,
  requestedHistoryCursors,
} from "./workspace-fixtures";

test.use(E2E_DESKTOP_CONTEXT);

/* Rows of uneven height, three hours apart. The prepended page is measured
   rather than estimated, the old first row loses its day divider once its
   same-day predecessor arrives, and the last page retires the older-history
   loader above the list: every way the reader's message used to jump. */
const HISTORY = Array.from({ length: 56 }, (_, index) => ({
  messageId: `message-anchor-${index + 1}`,
  channelId: E2E_CHANNEL.id,
  sequence: index + 1,
  body: `Message ${index + 1}. ${"Channel history content that wraps. ".repeat(1 + ((index * 7) % 9))}`,
  sentAt: new Date(Date.parse(E2E_NOW) - (56 - index) * 3 * 60 * 60 * 1_000).toISOString(),
  from: E2E_USER_SENDER,
}));

/* `prepended`: the older page has reached the DOM - its rows, the
   virtualizer's prepend margin, or the scroll that absorbs it. */
type Frame = { textTop: number | null; scrollTop: number; prepended: boolean };

/**
 * Scroll to `startScrollTop` (which pages in 47 and older), then scroll up by
 * `step` once per frame and sample, as each frame paints, where the text of the
 * first message visible at the start sits on screen.
 */
async function sampleReaderAcrossPrepend(
  page: Page,
  options: { startScrollTop: number; step: number; frames: number },
): Promise<Frame[]> {
  await openGeneralChannelWithPagedHistory(page, HISTORY);
  const timeline = page.locator(".app-message-timeline");
  await expect(timeline.getByText("Message 56.", { exact: false })).toBeVisible();

  // A constrained renderer exposes delayed virtualizer measurements that
  // otherwise finish between our scroll and the next painted frame.
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 8 });

  const frames = await timeline.evaluate(async (root, { startScrollTop, step, frames: count }) => {
    root.dispatchEvent(new WheelEvent("wheel", { deltaY: -1, bubbles: true }));
    root.scrollTo({ top: startScrollTop });
    const rootTop = root.getBoundingClientRect().top;
    const row = [...root.querySelectorAll<HTMLElement>("[id^='message:']")]
      .find((candidate) => candidate.getBoundingClientRect().top >= rootTop);
    const label = row?.textContent?.match(/Message \d+\./)?.[0];
    if (!row || !label) throw new Error("no visible message");
    const textTop = () => {
      const current = document.getElementById(row.id);
      if (!current) return null;
      const walker = document.createTreeWalker(current, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (!node.textContent?.includes(label)) continue;
        const range = document.createRange();
        range.selectNodeContents(node);
        return range.getBoundingClientRect().top - root.getBoundingClientRect().top;
      }
      return null;
    };
    const sample = () => {
      const list = root.querySelector<HTMLElement>("[data-testid='virtuoso-item-list']");
      return {
        textTop: textTop(),
        scrollTop: root.scrollTop,
        prepended: Boolean(document.getElementById("message:message-anchor-46")) ||
          (list !== null && list.style.marginTop !== "" && list.style.marginTop !== "0px") ||
          root.scrollTop > 5_000,
      };
    };
    /* What the next frame paints: sampled from a ResizeObserver created in
       that frame. Observers run in creation order after layout, so the
       newest one sees every correction the app's observers made. */
    const painted = () => new Promise<ReturnType<typeof sample>>((resolve) => {
      requestAnimationFrame(() => {
        const observer = new ResizeObserver(() => {
          observer.disconnect();
          resolve(sample());
        });
        observer.observe(root);
      });
    });
    const samples = [sample()];
    for (let frame = 0; frame < count; frame += 1) {
      if (step !== 0) {
        root.dispatchEvent(new WheelEvent("wheel", { deltaY: -step, bubbles: true }));
        root.scrollTop -= step;
      }
      samples.push(await painted());
    }
    return samples;
  }, options);

  expect(await requestedHistoryCursors(page)).toContain(47);
  for (const frame of frames) expect(frame.textTop).not.toBeNull();
  return frames;
}

test("loading an older page keeps the message the reader is looking at in place", async ({ page }) => {
  const frames = await sampleReaderAcrossPrepend(page, { startScrollTop: 120, step: 0, frames: 90 });
  // The page lands while nobody scrolls: every painted frame from then on
  // shows the text exactly where it was just before - no flash, no jump.
  const prependedAt = frames.findIndex((frame) => frame.prepended);
  expect(prependedAt).toBeGreaterThan(0);
  const before = frames[prependedAt - 1]!.textTop!;
  for (const frame of frames.slice(prependedAt)) {
    expect(Math.abs(frame.textTop! - before)).toBeLessThanOrEqual(1);
  }
});

test("a reader who keeps scrolling through the prepend is never pulled back or thrown", async ({ page }) => {
  const STEP = 40;
  const frames = await sampleReaderAcrossPrepend(page, { startScrollTop: 300, step: STEP, frames: 24 });
  const prependedAt = frames.findIndex((frame) => frame.prepended);
  expect(prependedAt).toBeGreaterThan(0);
  // From the last frame before the page to the end of the gesture.
  for (let index = prependedAt; index < frames.length; index += 1) {
    const moved = frames[index]!.textTop! - frames[index - 1]!.textTop!;
    // Scrolling up moves the text down by at most one step per frame: never
    // up (thrown), never more than the reader asked for.
    expect(moved).toBeGreaterThanOrEqual(-1);
    expect(moved).toBeLessThanOrEqual(STEP + 1);
  }
  // And the anchor does not hold the reader still once the page has landed.
  const after = frames.slice(prependedAt + 2);
  const travelled = after.at(-1)!.textTop! - after[0]!.textTop!;
  expect(travelled).toBeGreaterThan((after.length - 1) * STEP * 0.75);
});
