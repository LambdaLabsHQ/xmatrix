import { expect, test } from "./fixtures";
import { E2E_CHANNEL, E2E_DESKTOP_CONTEXT, E2E_MOBILE_CONTEXT, E2E_SPACE, fixtureJson,
  installWorkspaceStubs } from "./workspace-fixtures";

/* A notification the Hub pushed names its conversation by id alone. The phone
   and Mac shells open `/app?channel=<id>` when it is tapped, so that address
   must open the conversation whichever Space it is in. */

const RANDOM = { ...E2E_CHANNEL, id: "channel-random", name: "random" };

const TEAM_SPACE = { ...E2E_SPACE, id: "space-team", name: "Team" };
const ELSEWHERE = { ...E2E_CHANNEL, id: "channel-elsewhere", name: "elsewhere", spaceId: TEAM_SPACE.id };

test.describe("in another Space", () => {
  test.use(E2E_MOBILE_CONTEXT);

  test("a tapped push opens a conversation of a Space that is not the one on screen", async ({ page }) => {
    await installWorkspaceStubs(page, { spaces: [E2E_SPACE, TEAM_SPACE], channels: [E2E_CHANNEL, ELSEWHERE] });
    await fixtureJson(page, "elsewhere-history", "**/api/xmatrix/channels/channel-elsewhere/history**",
      { messages: [], hasMore: false });
    await page.goto("/app?channel=channel-elsewhere", { waitUntil: "domcontentloaded" });
    await expect(page.locator(".composer-textarea").first()).toBeVisible();
    await expect(page).toHaveURL(/\/channels\/elsewhere-/u);
  });
});

for (const [name, context] of [["a computer", E2E_DESKTOP_CONTEXT], ["a phone", E2E_MOBILE_CONTEXT]] as const) {
  test.describe(`on ${name}`, () => {
    test.use(context);

    test("a tapped push opens its conversation", async ({ page }) => {
      await installWorkspaceStubs(page, { spaces: [E2E_SPACE], channels: [E2E_CHANNEL, RANDOM] });
      await fixtureJson(page, "random-history", "**/api/xmatrix/channels/channel-random/history**",
        { messages: [], hasMore: false });
      await page.goto("/app?channel=channel-random", { waitUntil: "domcontentloaded" });
      await expect(page.locator(".composer-textarea").first()).toBeVisible();
      await expect(page).toHaveURL(/\/channels\/random-/u);
    });
  });
}
