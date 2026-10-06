import { expect, test, type Page } from "./fixtures";
import { E2E_DESKTOP_CONTEXT, E2E_SPACE, E2E_CHANNEL, E2E_NOW, fixtureJson, fixtureRule,
  fixtureRequests, fixtureRequestBodies, releaseFixture, openWorkspaceWithStubs } from "./workspace-fixtures";

test.use(E2E_DESKTOP_CONTEXT);
const room = "spaces/AbC-opaque";
const nonce = "private-fixture-confirmation-ABC";
const connection = { id: E2E_SPACE.id + ":googlechat", spaceId: E2E_SPACE.id, providerId: "googlechat",
  providerName: "Google Chat", status: "disconnected", authMode: "api-token", scopes: [], secretRefs: [],
  capabilities: [], channelIds: [], metadata: {}, credentialFields: [], version: 1,
  createdBy: "e2e-user", createdAt: E2E_NOW, updatedAt: E2E_NOW };
const baseLink = /\/api\/xmatrix\/spaces\/[^/]+\/app-connections\/googlechat\/link$/;

type Provider = "googlechat" | "teams";
const labelFor = (provider: Provider) => provider === "teams" ? "Microsoft Teams" : "Google Chat";
async function open(page: Page, provider: Provider) {
  const label = labelFor(provider);
  await openWorkspaceWithStubs(page, { spaces: [E2E_SPACE], channels: [E2E_CHANNEL] });
  await fixtureJson(page, "native-providers", "**/api/xmatrix/connectors/oauth/providers", { providers: [], nativeProviders: [provider] });
  await fixtureJson(page, "chat-connections", /\/api\/xmatrix\/spaces\/[^/]+\/app-connections$/, { connections: [] });
  await fixtureJson(page, "chat-create", /\/api\/xmatrix\/spaces\/[^/]+\/app-connections\/(?:googlechat|teams)$/, { connection: { ...connection, id: E2E_SPACE.id + ":" + provider, providerId: provider, providerName: label } }, { method: "PATCH" });
  await fixtureJson(page, "chat-executions", "**/api/xmatrix/spaces/*/app-executions", { executions: [] });
  await page.getByRole("button", { name: "App", exact: true }).click();
  await page.getByTestId("connector-row").filter({ hasText: label }).click();
  await expect(provider === "teams" ? page.locator("#teams-link-start") : page.getByLabel("Google Chat space ID")).toBeVisible();
  await expect(page.getByRole("button", { name: "Generate ingress URL", exact: true })).toHaveCount(0);
}
async function start(page: Page, provider: Provider) {
  if (provider === "googlechat") await page.getByLabel("Google Chat space ID").fill(room);
  await page.getByRole("button", { name: "Start confirmation", exact: true }).click();
}
function challenge(provider: Provider) { return { ...(provider === "googlechat" ? { chatSpace: room } : {}), nonce, expiresAt: new Date(Date.now() + 180000).toISOString() }; }

for (const provider of ["googlechat", "teams"] as const) {
  const label = labelFor(provider);
  const link = provider === "googlechat" ? baseLink : /\/api\/xmatrix\/spaces\/[^/]+\/app-connections\/teams\/link$/;
  const command = (provider === "teams" ? "link " : "@xMatrix link ") + nonce;
  const selected = provider === "teams" ? "room-" + "a".repeat(64) : room;

test(`${label} confirmation stays private and cannot mark a connection active before server binding`, async ({ page }) => {
  await open(page, provider);
  await fixtureJson(page, "chat-start", link, challenge(provider), { method: "POST" });
  await start(page, provider);
  await expect(page.getByText(command, { exact: true })).toBeVisible();
  const row = page.getByTestId("connector-row").filter({ hasText: label });
  await expect(row.getByRole("img", { name: "Disconnected" })).toBeVisible();
  expect(await fixtureRequestBodies(page, "chat-start")).toEqual([provider === "teams" ? {} : { chatSpace: room }]);
  expect(await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage }, url: location.href }))).not.toContain(nonce);
  await fixtureJson(page, "chat-bound", link, { binding: { chatSpace: selected, sourceRef: provider + ":room-fixture" } }, { method: "GET" });
  await fixtureJson(page, "chat-connections", /\/api\/xmatrix\/spaces\/[^/]+\/app-connections$/, {
    connections: [{ ...connection, id: E2E_SPACE.id + ":" + provider, providerId: provider, providerName: label, status: "configured", lastCheckedAt: new Date().toISOString() }] });
  await page.getByRole("button", { name: "Refresh connection", exact: true }).click();
  await expect(page.getByText(command, { exact: true })).toHaveCount(0);
  await expect(page.getByText(provider === "teams" ? "Connected Teams conversation:" : "Connected Chat space:", { exact: false })).toBeVisible();
  await expect(row.getByRole("img", { name: "Connected" })).toBeVisible();
  await expect(page.getByText(provider === "teams" ? "Microsoft Teams company app" : "Google Chat app", { exact: true })).toBeVisible();
  await expect(page.getByText(`Saving a manual ${provider === "teams" ? "Workflows" : "incoming"} webhook replaces the linked app connection.`, { exact: true })).toBeVisible();
});

test(`${label} denial exposes no confirmation and does not retry the authority-changing request`, async ({ page }) => {
  await open(page, provider);
  await fixtureJson(page, "chat-denied", link, { error: "Google Chat connection unavailable" }, { method: "POST", status: 403 });
  await start(page, provider);
  await expect(page.locator(`#${provider}-room-link`).getByRole("alert")).toContainText("Google Chat connection unavailable");
  await expect(page.getByText("@xMatrix link", { exact: false })).toHaveCount(0);
  expect(await fixtureRequests(page, "chat-denied")).toHaveLength(1);
});

test(`Leaving the ${label} detail fences a late confirmation response`, async ({ page }) => {
  await open(page, provider);
  await fixtureRule(page, { id: "chat-late", pattern: link, method: "POST", responder: { kind: "deferred", json: challenge(provider) } });
  await start(page, provider);
  await expect.poll(async () => (await fixtureRequests(page, "chat-late")).length).toBe(1);
  await page.getByTestId("connector-row").filter({ hasText: "Linear" }).click();
  await releaseFixture(page, "chat-late");
  await page.getByTestId("connector-row").filter({ hasText: label }).click();
  if (provider === "googlechat") await expect(page.getByLabel("Google Chat space ID")).toHaveValue("");
  await expect(page.getByText(command, { exact: true })).toHaveCount(0);
});

test(`${label} confirmation expires in the mounted form instead of surviving in client storage`, async ({ page }) => {
  await page.clock.install();
  await open(page, provider);
  await fixtureJson(page, "chat-expiry", link, challenge(provider), { method: "POST" });
  await start(page, provider);
  await expect(page.getByText(command, { exact: true })).toBeVisible();
  await page.clock.fastForward(181000);
  await expect(page.getByText(command, { exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }))).not.toContain(nonce);
});

}
