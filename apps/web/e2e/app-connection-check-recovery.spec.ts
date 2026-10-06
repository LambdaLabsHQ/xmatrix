import { expect, test, type Page } from "./fixtures";
import { E2E_DESKTOP_CONTEXT, E2E_SPACE, E2E_CHANNEL, E2E_NOW, fixtureJson, fixtureRule,
  fixtureRequests, releaseFixture, openWorkspaceWithStubs } from "./workspace-fixtures";

test.use(E2E_DESKTOP_CONTEXT);
const connection = {
  id: `${E2E_SPACE.id}:sentry`, spaceId: E2E_SPACE.id, providerId: "sentry", providerName: "Sentry",
  status: "error", error: "Sentry installation request could not complete", version: 4,
  authMode: "oauth", scopes: [], secretRefs: [], capabilities: [], channelIds: [], metadata: {},
  credentialFields: [], createdBy: "e2e-user", createdAt: E2E_NOW, updatedAt: E2E_NOW,
};
const endpoint = /\/api\/xmatrix\/spaces\/[^/]+\/app-connections\/sentry\/check$/;

async function open(page: Page, status = "error") {
  await openWorkspaceWithStubs(page, { spaces: [E2E_SPACE], channels: [E2E_CHANNEL] });
  await fixtureJson(page, "sentry-providers", "**/api/xmatrix/connectors/oauth/providers", { providers: ["sentry"] });
  await fixtureJson(page, "sentry-connections", /\/api\/xmatrix\/spaces\/[^/]+\/app-connections$/, {
    connections: [{ ...connection, status, error: status === "error" ? connection.error : null }],
  });
  await fixtureJson(page, "sentry-executions", "**/api/xmatrix/spaces/*/app-executions", { executions: [] });
  await page.getByRole("button", { name: "App", exact: true }).click();
  await page.getByTestId("connector-row").filter({ hasText: "Sentry" }).click();
}

test("a failed Check can be retried without reconnecting and only server success restores Connected", async ({ page }) => {
  await open(page);
  const row = page.getByTestId("connector-row").filter({ hasText: "Sentry" });
  const check = page.getByRole("button", { name: "Check Sentry connection", exact: true });
  await expect(row.getByRole("img", { name: "Needs attention" })).toBeVisible();
  await expect(check).toBeEnabled();
  await fixtureRule(page, { id: "sentry-failed-check", pattern: endpoint, method: "POST", responder: {
    kind: "deferred", status: 200, json: { ok: false, message: "Check failed", connection: { ...connection, version: 5 } },
  } });
  await check.click();
  await expect.poll(async () => (await fixtureRequests(page, "sentry-failed-check")).length).toBe(1);
  await expect(check).toBeDisabled();
  await releaseFixture(page, "sentry-failed-check");
  await expect(check).toBeEnabled();
  await expect(row.getByRole("img", { name: "Needs attention" })).toBeVisible();
  await fixtureJson(page, "sentry-passed-check", endpoint, { ok: true, connection: {
    ...connection, status: "configured", error: null, version: 6, lastCheckedAt: E2E_NOW,
  } }, { method: "POST" });
  await check.click();
  await expect(row.getByRole("img", { name: "Connected" })).toBeVisible();
  await expect(check).toBeEnabled();
  expect(await fixtureRequests(page, "sentry-failed-check")).toHaveLength(1);
  expect(await fixtureRequests(page, "sentry-passed-check")).toHaveLength(1);
});

test("an explicitly disconnected connection still requires reconnecting before Check", async ({ page }) => {
  await open(page, "disconnected");
  await expect(page.getByRole("button", { name: "Check Sentry connection", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Reconnect", exact: true })).toBeVisible();
});
