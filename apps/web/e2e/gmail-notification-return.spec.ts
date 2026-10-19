import { expect, test, type Page } from "./fixtures";
import { E2E_DESKTOP_CONTEXT, E2E_SPACE, E2E_CHANNEL, E2E_NOW, fixtureJson, fixtureRule,
  fixtureRequestBodies, installWorkspaceStubs, releaseFixture } from "./workspace-fixtures";

test.use(E2E_DESKTOP_CONTEXT);
const notifications = /\/api\/xmatrix\/spaces\/[^/]+\/app-connections\/gmail\/notifications$/;

async function setup(page: Page) {
  await installWorkspaceStubs(page, { spaces: [E2E_SPACE], channels: [E2E_CHANNEL] });
  // The owner view can mount after the shell normalizes its Space URL.
  await fixtureRule(page, { id: "gmail-connections", pattern: /\/api\/xmatrix\/spaces\/[^/]+\/app-connections$/,
    responder: { kind: "static", delayMs: 250, json: { connections: [{
      id: `${E2E_SPACE.id}:gmail`, spaceId: E2E_SPACE.id, providerId: "gmail", providerName: "Gmail",
      status: "configured", version: 1, authMode: "oauth", scopes: [], secretRefs: [], capabilities: [],
      channelIds: [], metadata: {}, credentialFields: [], createdBy: "e2e-user", createdAt: E2E_NOW, updatedAt: E2E_NOW,
    }] } } });
  await fixtureJson(page, "gmail-mailboxes", /\/api\/xmatrix\/spaces\/[^/]+\/app-connections\/gmail\/mailboxes$/,
    { mailboxes: [{ address: "owner@example.test", owner: "user:e2e-user" }] });
  await fixtureJson(page, "gmail-notifications", notifications, { available: true, notifications: [] }, { method: "GET" });
  await fixtureRule(page, { id: "gmail-complete", pattern: notifications, method: "POST",
    responder: { kind: "deferred", status: 200, json: { ok: true } } });
}

test("Gmail notification return survives Space hydration and completes once in the selected mailbox view", async ({ page }) => {
  await setup(page);
  await page.goto(`/app/${E2E_SPACE.id}/apps?connector=gmail&gmailWatchState=fixture-state&gmailWatchCode=fixture-code`);
  await expect(page.getByText("New mail notifications", { exact: true })).toBeVisible();
  await expect.poll(() => fixtureRequestBodies(page, "gmail-complete")).toEqual([
    { action: "complete", state: "fixture-state", code: "fixture-code" },
  ]);
  const url = new URL(page.url());
  expect(url.searchParams.get("item")).toBe("gmail");
  expect(url.searchParams.has("gmailWatchState")).toBe(false);
  expect(url.searchParams.has("gmailWatchCode")).toBe(false);
  await releaseFixture(page, "gmail-complete");
  await page.getByTestId("connector-row").filter({ hasText: "GitHub" }).click();
  await page.getByTestId("connector-row").filter({ hasText: "Gmail" }).click();
  await expect(page.getByText("New mail notifications", { exact: true })).toBeVisible();
  expect(await fixtureRequestBodies(page, "gmail-complete")).toHaveLength(1);
});

test("declined notification consent returns to Gmail with a retry notice and no code exchange", async ({ page }) => {
  await setup(page);
  await page.goto(`/app/${E2E_SPACE.id}/apps?connector=gmail&gmailWatch=failed`);
  await expect(page.getByText("Gmail notification authorization did not finish. Turn notifications on to try again.", { exact: true })).toBeVisible();
  await expect(page.getByText("New mail notifications", { exact: true })).toBeVisible();
  expect(new URL(page.url()).searchParams.get("item")).toBe("gmail");
  expect(await fixtureRequestBodies(page, "gmail-complete")).toHaveLength(0);
});
