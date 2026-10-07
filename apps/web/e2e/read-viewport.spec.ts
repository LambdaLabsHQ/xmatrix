import { test, expect } from "./fixtures";
import { type Page } from "@playwright/test";
import {
  E2E_CHANNEL,
  E2E_NOW,
  E2E_SPACE,
  fixtureChannelCatalog,
  fixtureJson,
  fixtureRequestBodies,
  fixtureSpaceResources,
  installApiFixtures,
} from "./workspace-fixtures";

/* Read-cursor honesty: opening a channel must only mark as read what was
   actually rendered in the timeline viewport. The channel advertises a
   messageCount far beyond the fetched history (an unloaded tail), and the
   fetched history itself is taller than the viewport. The read cursor
   reported to the hub must never exceed the highest sequence that a rendered
   row exposed — never the advertised messageCount. */

const DESKTOP_VIEWPORT = { width: 1512, height: 945 };
const HISTORY_TOP_SEQUENCE = 40;
const ADVERTISED_MESSAGE_COUNT = 100;

const CHANNEL = { ...E2E_CHANNEL, messageCount: ADVERTISED_MESSAGE_COUNT };

const historyMessage = (sequence: number) => ({
  messageId: `message-${sequence}`,
  channelId: CHANNEL.id,
  sequence,
  body: `history message ${sequence}\n\nline two keeps each row tall enough that the full backlog cannot fit in one viewport.`,
  sentAt: new Date(Date.parse(E2E_NOW) + sequence * 1000).toISOString(),
  from: { kind: "user", label: "E2E Tester", userId: "e2e-user", email: "e2e@xmatrix.test" },
});

const HISTORY = Array.from({ length: HISTORY_TOP_SEQUENCE }, (_, index) => historyMessage(index + 1));

/* All routes are registered before goto so the auto-selected channel's
   initial history fetch already hits the stub (later registrations win,
   catch-all first). */
const READ_RULE = "channel-read";

async function openChannelRecordingReads(page: Page): Promise<void> {
  await installApiFixtures(page);
  await fixtureJson(page, "api-catch-all", "**/api/xmatrix/**", {});
  const stubs: Array<[string, string, Record<string, unknown>]> = [
    ["spaces", "**/api/xmatrix/spaces**", { spaces: [E2E_SPACE] }],
    ["channels", "**/api/xmatrix/channels", { channels: [CHANNEL] }],
    ["channel-history", "**/api/xmatrix/channels/*/history**", { messages: HISTORY, hasMore: false }],
  ];
  for (const [id, pattern, payload] of stubs) {
    await fixtureJson(page, id, pattern, payload);
  }
  await fixtureSpaceResources(page);
  await fixtureChannelCatalog(page, "channel-catalog", [CHANNEL]);
  await fixtureJson(page, READ_RULE, "**/api/xmatrix/channels/*/read", { ok: true });
  await page.goto("/app");
  await page.getByText("general", { exact: true }).first().click();
  await expect(page.getByText(`history message ${HISTORY_TOP_SEQUENCE}`).first()).toBeVisible();
}

/** The sequences the app reported as read, oldest first. */
async function readSequencesFrom(page: Page): Promise<number[]> {
  const bodies = await fixtureRequestBodies(page, READ_RULE);
  return bodies.flatMap((body) => (typeof body.sequence === "number" ? [body.sequence] : []));
}

test.use({ viewport: DESKTOP_VIEWPORT, isMobile: false, hasTouch: false, deviceScaleFactor: 1 });

test.describe("viewport-based read cursor", () => {
  test("opening a channel reports read only for rendered messages, never the advertised count", async ({ page }) => {
    await openChannelRecordingReads(page);

    /* The timeline opens pinned to the bottom, so the newest fetched message
       is exposed and the cursor reaches the top of the loaded history. */
    await expect
      .poll(async () => (await readSequencesFrom(page)).at(-1), { timeout: 10_000 })
      .toBe(HISTORY_TOP_SEQUENCE);

    /* The unloaded tail (messageCount = 100) was never rendered, so no
       report may ever exceed what the viewport actually exposed. */
    expect(Math.max(...(await readSequencesFrom(page)))).toBeLessThanOrEqual(HISTORY_TOP_SEQUENCE);
  });

  test("scrolling through the backlog keeps the reported cursor monotonic", async ({ page }) => {
    await openChannelRecordingReads(page);
    await expect
      .poll(async () => (await readSequencesFrom(page)).at(-1), { timeout: 10_000 })
      .toBe(HISTORY_TOP_SEQUENCE);

    /* Scrolling up re-exposes old rows; the reported cursor must not move
       backwards because of that. */
    await page.locator(".app-message-timeline").first().evaluate((element) => {
      element.scrollTop = 0;
    });
    await page.waitForTimeout(500);
    const readSequences = await readSequencesFrom(page);
    for (let index = 1; index < readSequences.length; index += 1) {
      expect(readSequences[index]).toBeGreaterThanOrEqual(readSequences[index - 1]);
    }
    expect(Math.max(...readSequences)).toBeLessThanOrEqual(HISTORY_TOP_SEQUENCE);
  });
});
