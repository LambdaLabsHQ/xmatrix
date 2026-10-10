import { expect, test } from "./fixtures";
import {
  E2E_CHANNEL,
  E2E_MOBILE_CONTEXT,
  E2E_NOW,
  E2E_SPACE,
  E2E_USER_SENDER,
  fixtureJson,
  fixtureRequests,
  fixtureRule,
  installWorkspaceStubs,
  releaseFixture,
} from "./workspace-fixtures";

/* A phone opens Channels from the list. Once the list has settled, the latest
   page of the Space's recent Channels is read ahead, so tapping one paints
   from memory instead of waiting a Hub round trip behind the skeleton. */

test.use(E2E_MOBILE_CONTEXT);

const WARM_HISTORY_RULE = "warm-channel-history";
const OPEN_HISTORY_RULE = "open-channel-history";
const MESSAGE_COUNT = 12;
const HISTORY = Array.from({ length: MESSAGE_COUNT }, (_, index) => ({
  messageId: `message-warm-${index + 1}`,
  channelId: E2E_CHANNEL.id,
  sequence: index + 1,
  body: `Warm message ${index + 1}.`,
  sentAt: new Date(Date.parse(E2E_NOW) + index * 1_000).toISOString(),
  from: E2E_USER_SENDER,
}));
const CHANNEL = {
  ...E2E_CHANNEL,
  messageCount: MESSAGE_COUNT,
  historyHeadSequence: MESSAGE_COUNT,
  updatedAt: E2E_NOW,
};

test("tapping a read-ahead Channel paints before its open read returns", async ({ page }) => {
  await installWorkspaceStubs(page, { spaces: [E2E_SPACE], channels: [CHANNEL] });
  await fixtureJson(page, WARM_HISTORY_RULE, "**/api/xmatrix/channels/channel-general/history**", {
    messages: HISTORY.slice(-10),
    hasMore: true,
    historyHeadSequence: MESSAGE_COUNT,
  });
  await page.goto("/app/personal-sspaceperso/channels", { waitUntil: "domcontentloaded" });
  const channelList = page.locator(".app-mobile-channel-list-pane");
  await expect(channelList).toBeVisible();
  await expect.poll(async () => (await fixtureRequests(page, WARM_HISTORY_RULE)).length).toBe(1);

  // Every read from here on is held, so only the read-ahead page can paint.
  await fixtureRule(page, {
    id: OPEN_HISTORY_RULE,
    pattern: "**/api/xmatrix/channels/channel-general/history**",
    responder: { kind: "deferred", json: { messages: [], hasMore: false, historyHeadSequence: MESSAGE_COUNT } },
  });
  await channelList.getByText("general", { exact: true }).first().tap();
  await expect(page.locator(".app-message-row").last()).toContainText(`Warm message ${MESSAGE_COUNT}.`);
  await expect(page.getByText("Loading message history…")).toHaveCount(0);
  await releaseFixture(page, OPEN_HISTORY_RULE);
});

for (const returnToList of [false, true]) {
  test(`read-ahead skips a waiting Channel that is ${returnToList ? "already cached" : "now open"}`, async ({ page }) => {
    const channels = ["first", "second", "third", "fourth"].map((name, index) => ({
      ...CHANNEL, id: `channel-${name}`, name,
      updatedAt: new Date(Date.parse(E2E_NOW) - index * 1_000).toISOString(),
    }));
    await installWorkspaceStubs(page, { spaces: [E2E_SPACE], channels });
    for (const channel of channels) {
      await fixtureRule(page, {
        id: channel.id,
        pattern: `**/api/xmatrix/channels/${channel.id}/history**`,
        responder: {
          kind: channel.name === "first" || channel.name === "second" ? "deferred" : "json",
          json: {
            messages: [{ ...HISTORY[0], channelId: channel.id, body: `${channel.name} history` }],
            hasMore: false, historyHeadSequence: 1,
          },
        },
      });
    }
    await page.goto("/app/personal-sspaceperso/channels", { waitUntil: "domcontentloaded" });
    const channelList = page.locator(".app-mobile-channel-list-pane");
    await expect(channelList).toBeVisible();
    for (const id of ["channel-first", "channel-second"]) {
      await expect.poll(async () => (await fixtureRequests(page, id)).length).toBe(1);
    }
    expect(await fixtureRequests(page, "channel-third")).toHaveLength(0);
    expect(await fixtureRequests(page, "channel-fourth")).toHaveLength(0);

    // Both speculative lanes are held. An interactive open overtakes the
    // waiting third Channel, which must no longer need a speculative read.
    await channelList.getByText("third", { exact: true }).first().tap();
    await expect(page.locator(".app-message-row", { hasText: "third history" })).toBeVisible();
    if (returnToList) {
      await page.getByRole("button", { name: "Back to channels" }).tap();
      await expect(channelList).toBeVisible();
    }
    // A read-ahead is a first page (`limit`, no cursor). The open Channel's own
    // tail catch-up (`afterSequence`) may land at any point and is not one.
    const firstPageReads = async () => (await fixtureRequests(page, "channel-third"))
      .filter((url) => !url.includes("afterSequence="));
    const interactiveReads = (await firstPageReads()).length;
    await releaseFixture(page, "channel-first");
    await expect.poll(async () => (await fixtureRequests(page, "channel-fourth")).length).toBe(1);
    expect(await firstPageReads()).toHaveLength(interactiveReads);
    await releaseFixture(page, "channel-second");
  });
}
