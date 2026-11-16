import { expect, test } from "./fixtures";
import {
  E2E_CHANNEL,
  E2E_DESKTOP_CONTEXT,
  E2E_SPACE,
  fixtureJson,
  installWorkspaceStubs,
} from "./workspace-fixtures";
import { channelHistory } from "./working-agents-fixtures";

const MESSAGE_COUNT = 150;
const messageBody = "A **status** update with `code` and a list:\n\n- one\n- two\n\n```ts\nconst x = 1;\n```\n";
const channel = {
  ...E2E_CHANNEL,
  summary: "Current work and linked pages",
  messageCount: MESSAGE_COUNT,
  historyHeadSequence: MESSAGE_COUNT,
  lastMessageSequence: MESSAGE_COUNT,
};
const messages = channelHistory(MESSAGE_COUNT, "scroll-scope", (row) => `Row ${row}. ${messageBody}`, channel.id);


/**
 * Scrolling the timeline mounts and unmounts rows. That must restyle the rows,
 * not the app: a `:has()` on the app root (or <body>) is re-checked on every
 * insertion beneath it, and any rule hanging broad descendants off it then
 * restyles every element in the window per mounted row - the desktop app's
 * scroll jank. The budget is in elements restyled, not milliseconds, so host
 * load cannot move it.
 */
for (const viewport of ["desktop", "phone"] as const) {
  test.describe(viewport, () => {
    if (viewport === "desktop") test.use(E2E_DESKTOP_CONTEXT);

    test("scrolling the timeline restyles the rows, never the whole app", async ({ page }, testInfo) => {
      await installWorkspaceStubs(page, { spaces: [E2E_SPACE], channels: [channel] });
      await fixtureJson(page, "scroll-scope-history", "**/api/xmatrix/channels/channel-general/history**", {
        messages,
        hasMore: false,
      });
      await page.goto("/app/personal-sspaceperso/channels/general-cchannelgen", { waitUntil: "domcontentloaded" });
      const timeline = page.locator(".app-message-timeline");
      await expect(timeline.getByText(`Row ${MESSAGE_COUNT}.`)).toBeVisible();
      const box = await timeline.boundingBox();
      if (!box) throw new Error("timeline has no box");
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);

      const cdp = await page.context().newCDPSession(page);
      const restyledDuring = async (action: () => Promise<void>) => {
        const events: Array<{ name: string; args?: { elementCount?: number } }> = [];
        const collect = (event: { value: unknown[] }) => events.push(...(event.value as typeof events));
        cdp.on("Tracing.dataCollected", collect);
        const complete = new Promise((resolve) => cdp.once("Tracing.tracingComplete", resolve));
        await cdp.send("Tracing.start", { categories: "devtools.timeline", transferMode: "ReportEvents" });
        await action();
        await cdp.send("Tracing.end");
        await complete;
        cdp.off("Tracing.dataCollected", collect);
        return events.filter((event) => event.name === "UpdateLayoutTree").map((event) => event.args?.elementCount ?? 0);
      };

      // What restyling the whole app costs: an inherited property changed on its root.
      const wholeApp = Math.max(...await restyledDuring(async () => {
        await page.locator(".xmatrix-app-shell:not([aria-busy])").evaluate((root) => {
          (root as HTMLElement).style.setProperty("--style-scope-probe", "1");
          void (root as HTMLElement).offsetHeight;
        });
      }));
      expect(wholeApp).toBeGreaterThan(0);
      const scrolling = await restyledDuring(async () => {
        for (let step = 0; step < 12; step += 1) {
          await page.mouse.wheel(0, step < 6 ? -400 : 400);
          await page.waitForTimeout(60);
        }
      });
      await testInfo.attach("restyled-elements", {
        body: JSON.stringify({ wholeApp, scrolling }), contentType: "application/json",
      });
      expect(scrolling.length).toBeGreaterThan(0);
      // The rows a frame mounts cost less than restyling the app; a root `:has()`
      // made every such frame cost about one and a half times that.
      expect(Math.max(...scrolling)).toBeLessThan(wholeApp);
    });
  });
}
