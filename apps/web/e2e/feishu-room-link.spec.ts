import { expect, test, type Page } from "./fixtures";
import { E2E_DESKTOP_CONTEXT, E2E_SPACE, E2E_CHANNEL, E2E_NOW, fixtureJson, fixtureRule,
  fixtureRequests, fixtureRequestBodies, releaseFixture, openWorkspaceWithStubs } from "./workspace-fixtures";
test.use(E2E_DESKTOP_CONTEXT);
const nonce = "private-fixture-confirmation-ABC";
const chatSpace = "tenantA/oc_AbCd";
const link = /\/api\/xmatrix\/spaces\/[^/]+\/app-connections\/feishu\/link$/;
const connection = { id: E2E_SPACE.id + ":feishu", spaceId: E2E_SPACE.id, providerId: "feishu", providerName: "Feishu",
  status: "disconnected", authMode: "api-token", scopes: [], secretRefs: [], capabilities: [], channelIds: [], metadata: {},
  credentialFields: [], version: 1, createdBy: "e2e-user", createdAt: E2E_NOW, updatedAt: E2E_NOW };
async function open(page: Page) {
  await openWorkspaceWithStubs(page, { spaces: [E2E_SPACE], channels: [E2E_CHANNEL] });
  await fixtureJson(page, "feishu-native", "**/api/xmatrix/connectors/oauth/providers", { providers: [], nativeProviders: ["feishu"] });
  await fixtureJson(page, "feishu-connections", /\/api\/xmatrix\/spaces\/[^/]+\/app-connections$/, { connections: [] });
  await fixtureJson(page, "feishu-create", /\/api\/xmatrix\/spaces\/[^/]+\/app-connections\/feishu$/, { connection }, { method: "PATCH" });
  await fixtureJson(page, "feishu-executions", "**/api/xmatrix/spaces/*/app-executions", { executions: [] });
  await page.getByRole("button", { name: "App", exact: true }).click();
  await page.getByTestId("connector-row").filter({ hasText: "Feishu" }).click();
  await expect(page.getByLabel("Feishu tenant key")).toBeVisible();
  await expect(page.getByLabel("Feishu group chat ID")).toBeVisible();
}
async function start(page: Page) {
  await page.getByLabel("Feishu tenant key").fill("tenantA"); await page.getByLabel("Feishu group chat ID").fill("oc_AbCd");
  await page.getByRole("button", { name: "Start confirmation", exact: true }).click();
}
function challenge() { return { chatSpace, nonce, expiresAt: new Date(Date.now()+180000).toISOString() }; }
test("Feishu selection requires tenant and group; private confirmation alone does not mark Connected", async ({ page }) => {
  await open(page); await page.getByLabel("Feishu group chat ID").fill("oc_AbCd");
  await expect(page.getByRole("button", { name: "Start confirmation", exact: true })).toBeDisabled();
  await fixtureJson(page, "feishu-start", link, challenge(), { method: "POST" }); await start(page);
  await expect(page.getByText("@xMatrix link " + nonce, { exact: true })).toBeVisible();
  expect(await fixtureRequestBodies(page, "feishu-start")).toEqual([{ tenantKey: "tenantA", chatId: "oc_AbCd" }]);
  await expect(page.getByTestId("connector-row").filter({ hasText: "Feishu" }).getByRole("img", { name: "Disconnected" })).toBeVisible();
  expect(await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage }, url: location.href }))).not.toContain(nonce);
  await expect(page.getByText("Saving your own app credentials or generating a manual ingress URL replaces all linked company app groups.", { exact: true })).toBeVisible();
});
test("Feishu refresh exposes several independently authorized groups and unlink selects only one", async ({ page }) => {
  await open(page); await fixtureJson(page, "feishu-start", link, challenge(), { method: "POST" }); await start(page);
  await fixtureJson(page, "feishu-bound", link, { bindings: [{ chatSpace, sourceRef: "feishu:room-fixture-a" },
    { chatSpace: "tenantB/oc_Other", sourceRef: "feishu:room-fixture-b" }] }, { method: "GET" });
  await fixtureJson(page, "feishu-connections", /\/api\/xmatrix\/spaces\/[^/]+\/app-connections$/, { connections: [{ ...connection, status: "configured" }] });
  await page.getByRole("button", { name: "Refresh connection", exact: true }).click();
  await expect(page.getByText("@xMatrix link " + nonce, { exact: true })).toHaveCount(0);
  await expect(page.getByText("Connected Feishu group:", { exact: false })).toHaveCount(2);
  await expect(page.getByText("Feishu company app", { exact: true })).toBeVisible();
  await fixtureJson(page, "feishu-unlink", link, { ok: true }, { method: "DELETE" });
  await page.getByRole("button", { name: "Unlink group", exact: true }).first().click();
  expect(await fixtureRequestBodies(page, "feishu-unlink")).toEqual([{ tenantKey: "tenantA", chatId: "oc_AbCd" }]);
  await expect(page.getByText("Connected Feishu group:", { exact: false })).toHaveCount(1);
  await expect(page.getByText("tenantB/oc_Other", { exact: true })).toBeVisible();
});
test("Feishu denial does not retry or reveal a nonce; leaving detail fences a late confirmation", async ({ page }) => {
  await open(page); await fixtureJson(page, "feishu-denied", link, { error: "Feishu group access was not confirmed" }, { method: "POST", status: 403 });
  await start(page); await expect(page.locator("#feishu-room-link").getByRole("alert")).toContainText("Feishu group access was not confirmed");
  expect(await fixtureRequests(page, "feishu-denied")).toHaveLength(1);
  await fixtureRule(page, { id: "feishu-late", pattern: link, method: "POST", responder: { kind: "deferred", json: challenge() } });
  await start(page); await expect.poll(async () => (await fixtureRequests(page, "feishu-late")).length).toBe(1);
  await page.getByTestId("connector-row").filter({ hasText: "Linear" }).click(); await releaseFixture(page, "feishu-late");
  await page.getByTestId("connector-row").filter({ hasText: "Feishu" }).click();
  await expect(page.getByText("@xMatrix link " + nonce, { exact: true })).toHaveCount(0); await expect(page.getByLabel("Feishu tenant key")).toHaveValue("");
});
