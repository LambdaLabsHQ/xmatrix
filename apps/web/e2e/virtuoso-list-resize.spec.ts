import { expect, test } from "./fixtures";
import { E2E_DESKTOP_CONTEXT } from "./workspace-fixtures";
import { channelHistory, openWorkingAgentsSpace, workingAgentsSpace } from "./working-agents-fixtures";

test.use(E2E_DESKTOP_CONTEXT);

/* A list resize whose item list is no longer inside [data-virtuoso-scroller]
   threw `Cannot read properties of null (reading 'dataset')` from the
   ResizeObserver (WEB-T). The timeline and the channel lists scroll a parent
   outside Virtuoso, so that walk is not what they measure with. Growing a row
   must still publish its height, and removing the marker must not throw. */

test("a virtuoso list resize without its scroller marker still measures", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const space = workingAgentsSpace(2, "scroller");
  await openWorkingAgentsSpace(
    page,
    space,
    channelHistory(8, "scroller-message", (row) => `Row ${row}.`),
    "Row 8.",
  );
  await page.waitForFunction(() => {
    const list = document.querySelector<HTMLElement>(".app-message-timeline [data-testid='virtuoso-item-list']");
    return list !== null && getComputedStyle(list).visibility !== "hidden" && list.querySelector("[data-index]") !== null;
  });

  errors.length = 0;
  const measured = await page.evaluate(async () => {
    const frames = (count: number) => new Promise<void>((resolve) => {
      const step = (left: number) => {
        if (left === 0) resolve();
        else requestAnimationFrame(() => step(left - 1));
      };
      step(count);
    });
    const grow = async (list: HTMLElement) => {
      const item = list.querySelector<HTMLElement>("[data-index]");
      if (!item) throw new Error("virtuoso item missing");
      const before = Number(item.dataset.knownSize ?? "0");
      const height = item.getBoundingClientRect().height;
      item.style.minHeight = `${Math.max(height, before) + 40}px`;
      await frames(4);
      return { before, after: Number(item.dataset.knownSize ?? "0") };
    };
    const exercise = async (list: HTMLElement) => {
      const scroller = list.closest<HTMLElement>("[data-virtuoso-scroller]");
      if (!scroller) throw new Error("scroller marker missing before the resize");
      const withMarker = await grow(list);
      delete scroller.dataset.virtuosoScroller;
      const markerGone = list.closest("[data-virtuoso-scroller]") === null;
      const withoutMarker = await grow(list);
      return { withMarker, markerGone, withoutMarker };
    };
    const timeline = document.querySelector<HTMLElement>(".app-message-timeline [data-testid='virtuoso-item-list']");
    const sidebar = document.querySelector<HTMLElement>(".app-sidebar [data-testid='virtuoso-item-list']");
    if (!timeline || !sidebar) throw new Error("timeline or channel list missing");
    return { timeline: await exercise(timeline), sidebar: await exercise(sidebar) };
  });

  expect(errors, "list resize must not throw").toEqual([]);
  for (const list of [measured.timeline, measured.sidebar]) {
    expect(list.markerGone).toBe(true);
    expect(list.withMarker.after).toBeGreaterThan(list.withMarker.before);
    expect(list.withoutMarker.after).toBeGreaterThan(list.withoutMarker.before);
  }
});
