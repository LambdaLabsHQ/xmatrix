import { expect, test } from "./fixtures";
import { E2E_DESKTOP_CONTEXT, channelHistoryFixture, openGeneralChannelWithPagedHistory } from "./workspace-fixtures";

test.use(E2E_DESKTOP_CONTEXT);

/* A reader who had scrolled up to a place in a conversation saw it jump
   whenever a row above loaded late (a Gmail private result filling in, an
   image decoding), and the same while scrolling up, between two wheel ticks
   (user recording 2026-11-05). react-virtuoso made up for rows above the first
   one in view only while the reader was scrolling up; its scroll direction
   resets to none 50ms after the last scroll event. Patched
   (patches/react-virtuoso+4.18.11.patch) to make up for them in any direction
   and at rest. */

const HISTORY = 40;

test("a row above the reader that grows at rest moves nothing in view", async ({ page }) => {
  // Rows taller than a wheel tick, so the reader stays well inside the page.
  const history = channelHistoryFixture(HISTORY, "rows-above-grow").map((message) => ({
    ...message,
    body: `${message.body}\n\n${Array.from({ length: 3 }, () => "A paragraph of the conversation. ".repeat(6)).join("\n\n")}`,
  }));
  await openGeneralChannelWithPagedHistory(page, history);
  const timeline = page.locator(".app-message-timeline");
  await expect(timeline.getByText(`Message ${HISTORY}.`)).toBeVisible();
  // Past the opening landing: from here on only the reader moves the timeline.
  await page.waitForTimeout(1_500);

  await timeline.hover();
  for (let step = 0; step < 3; step += 1) await page.mouse.wheel(0, -200);
  // The reader stops; the list's scroll direction resets to none.
  await page.waitForTimeout(1_000);

  for (let growth = 0; growth < 3; growth += 1) {
    const placed = await timeline.evaluate((root) => {
      const rootTop = root.getBoundingClientRect().top;
      const rows = Array.from(root.querySelectorAll<HTMLElement>("[id^='message:']"));
      const inView = rows.find((row) => row.getBoundingClientRect().top >= rootTop);
      const above = rows.findLast((row) => row.getBoundingClientRect().bottom <= rootTop);
      if (!inView || !above) throw new Error("no mounted row wholly above the reader");
      const top = inView.getBoundingClientRect().top;
      const grown = document.createElement("div");
      grown.style.height = "320px";
      // Out of the reader's sight, as a private result card fills in.
      above.appendChild(grown);
      return { id: inView.id, top };
    });
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const top = await page.locator(`[id="${placed.id}"]`).evaluate((row) => row.getBoundingClientRect().top);
    expect(Math.abs(top - placed.top)).toBeLessThan(1);
  }
});
