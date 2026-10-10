import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { E2E_CHANNEL, channelHistoryFixture, openGeneralChannelWithHistory, routeHumanSocket } from "./workspace-fixtures";

/* The ask for a GitHub star (lib/star-prompt.ts). It opens beside the rail's
   Help button once an Agent has answered this person a few times, waits there
   without taking focus, and is answered by a person's own click: "Star on
   GitHub" opens the repository and ends the asking, "Later" keeps it away for
   days. Messages that did not notify this person are not answers to them. */

const VIEWPORT = { width: 1440, height: 900 };
const REPOSITORY = "https://github.com/LambdaLabsHQ/xmatrix";
const ASK = "Enjoying xMatrix?";

/** Opens the conversation and returns how an Agent's live message arrives in it. */
async function openWithLiveAgent(page: Page) {
  let send: ((message: unknown) => void) | undefined;
  await routeHumanSocket(page, (frame, reply) => {
    if (frame.type === "human_connect") send = reply;
  });
  await page.addInitScript(() => {
    const state = window as unknown as { __opened: string[] };
    state.__opened = [];
    window.open = ((url?: string | URL) => {
      state.__opened.push(String(url));
      return null;
    }) as typeof window.open;
  });
  await page.setViewportSize(VIEWPORT);
  await openGeneralChannelWithHistory(page, E2E_CHANNEL, channelHistoryFixture(2, "star"));
  await expect(page.locator(".app-rail")).toBeVisible();
  await expect.poll(() => Boolean(send)).toBe(true);

  let sequence = 100;
  return async (count: number, { notified = true } = {}) => {
    for (let index = 0; index < count; index += 1) {
      sequence += 1;
      send!({
        type: "channel_message_received",
        message: {
          messageId: `star-answer-${sequence}`, channelId: E2E_CHANNEL.id, sequence,
          body: `Answer ${sequence}`, sentAt: `2026-07-01T00:02:${String(sequence % 60).padStart(2, "0")}.000Z`,
          from: { kind: "agent", label: "claude", userId: "e2e-user", email: "e2e@xmatrix.test",
            identityId: "agent-claude", instanceId: "agent-claude:1" },
        },
        ...(notified ? { notification: { reason: "mention" } } : {}),
      });
      await expect(page.getByText(`Answer ${sequence}`, { exact: true })).toBeVisible();
    }
  };
}

const opened = (page: Page) => page.evaluate(() => (window as unknown as { __opened: string[] }).__opened);

test("the ask opens after an Agent's fifth answer and Later keeps it away", async ({ page }) => {
  const answer = await openWithLiveAgent(page);
  const ask = page.getByRole("complementary").filter({ hasText: ASK });

  // Messages that notified nobody here are not answers to this person.
  await answer(6, { notified: false });
  await answer(4);
  await expect(ask).toHaveCount(0);

  await answer(1);
  await expect(ask).toBeVisible();
  // It waits beside the Help button and leaves the keyboard where it was.
  const [help, panel] = await Promise.all([
    page.getByRole("button", { name: "Help" }).boundingBox(), ask.boundingBox()]);
  expect(panel!.x).toBeGreaterThanOrEqual(help!.x + help!.width);
  expect(panel!.y + panel!.height).toBeLessThanOrEqual(VIEWPORT.height);
  expect(await ask.evaluate((node) => node.contains(document.activeElement))).toBe(false);

  await ask.getByRole("button", { name: "Later" }).click();
  await expect(ask).toHaveCount(0);
  // Twice as many answers are not enough inside the quiet days.
  await answer(10);
  await expect(ask).toHaveCount(0);
  expect(await opened(page)).toEqual([]);
});

test("starring from the ask opens the repository and ends the asking", async ({ page }) => {
  const answer = await openWithLiveAgent(page);
  const ask = page.getByRole("complementary").filter({ hasText: ASK });
  await answer(5);
  await ask.getByRole("button", { name: "Star on GitHub" }).click();
  await expect(ask).toHaveCount(0);
  expect(await opened(page)).toEqual([REPOSITORY]);

  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.locator(".app-rail")).toBeVisible();
  await page.evaluate(() => {
    for (let index = 0; index < 50; index += 1) window.dispatchEvent(new Event("xmatrix:agent-answered"));
  });
  await expect(ask).toHaveCount(0);
});

test("the Help menu stars at any time", async ({ page }) => {
  await openWithLiveAgent(page);
  await page.getByRole("button", { name: "Help" }).click();
  await page.getByRole("menuitem", { name: "Star on GitHub" }).click();
  expect(await opened(page)).toEqual([REPOSITORY]);
});
