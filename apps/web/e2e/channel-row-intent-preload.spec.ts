import { expect, test } from "./fixtures";
import {
  E2E_CHANNEL, E2E_SPACE, E2E_USER_SENDER,
  installWorkspaceStubs, fixtureJson, fixtureRequests,
} from "./workspace-fixtures";

/* Opening a Channel that has no cached rows costs one Hub round trip. A reader
   resting the pointer on its row is about to open it, so that round trip
   starts then, before the press. */

test.use({ viewport: { width: 1280, height: 900 } });

const OPS = {
  ...E2E_CHANNEL, id: "channel-ops", name: "ops",
  // An empty head keeps the background warm-up away from this Channel, so
  // only the reader's intent can read it.
  messageCount: 0,
};

test("resting on a Channel row reads its history before it is opened", async ({ page }) => {
  await installWorkspaceStubs(page, { spaces: [E2E_SPACE], channels: [E2E_CHANNEL, OPS] });
  await fixtureJson(page, "general-history", "**/api/xmatrix/channels/channel-general/history**",
    { messages: [], hasMore: false });
  await fixtureJson(page, "ops-history", "**/api/xmatrix/channels/channel-ops/history**", {
    messages: [{
      messageId: "ops-1", channelId: OPS.id, sequence: 1, from: E2E_USER_SENDER,
      body: "Ops history ready", sentAt: "2026-07-01T00:00:01.000Z",
      reactions: [], annotations: [], attachments: [],
    }],
    hasMore: false,
  });
  await page.goto("/app/personal-sspaceperso/channels/general--channel-general");

  const row = page.locator(`[data-channel-row-id="${OPS.id}"]`);
  await row.hover();
  await expect.poll(async () => (await fixtureRequests(page, "ops-history")).length).toBe(1);

  await row.click();
  await expect(page.getByText("Ops history ready", { exact: true })).toBeVisible();
  // The open takes the page that intent already read.
  expect(await fixtureRequests(page, "ops-history")).toHaveLength(1);
});
