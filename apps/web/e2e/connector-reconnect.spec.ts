import { expect, test, type Page } from "./fixtures";
import { E2E_DESKTOP_CONTEXT, E2E_SPACE, E2E_CHANNEL, E2E_NOW, fixtureJson, fixtureRequests,
  openWorkspaceWithStubs } from "./workspace-fixtures";

test.use(E2E_DESKTOP_CONTEXT);
const connections = /\/api\/xmatrix\/spaces\/[^/]+\/app-connections$/;
const check = /\/api\/xmatrix\/spaces\/[^/]+\/app-connections\/appstoreconnect\/check$/;
const connection = (status: string, credentialFields: string[]) => ({ id: E2E_SPACE.id + ":appstoreconnect",
  spaceId: E2E_SPACE.id, providerId: "appstoreconnect", providerName: "App Store Connect", status,
  authMode: "api-token", scopes: [], secretRefs: [], capabilities: [], channelIds: [], metadata: {},
  credentialFields, version: 2, createdBy: "e2e-user", createdAt: E2E_NOW, updatedAt: E2E_NOW });

async function open(page: Page, credentialFields: string[]) {
  await openWorkspaceWithStubs(page, { spaces: [E2E_SPACE], channels: [E2E_CHANNEL] });
  await fixtureJson(page, "oauth-providers", "**/api/xmatrix/connectors/oauth/providers", { providers: [], nativeProviders: [] });
  await fixtureJson(page, "connections", connections, { connections: [connection("disconnected", credentialFields)] });
  await fixtureJson(page, "credentials", /\/app-connections\/appstoreconnect\/credentials$/, { credentialFields });
  await fixtureJson(page, "executions", "**/api/xmatrix/spaces/*/app-executions", { executions: [] });
  await fixtureJson(page, "check", check, { connection: { ...connection("configured", credentialFields), lastCheckedAt: E2E_NOW } },
    { method: "POST" });
  await page.getByRole("button", { name: "App", exact: true }).click();
  await page.getByTestId("connector-row").filter({ hasText: "App Store Connect" }).click();
}

test("a disconnected app whose credentials are still saved reconnects by a check", async ({ page }) => {
  await open(page, ["issuerId", "keyId", "privateKey", "webhookSecret"]);
  await page.getByRole("button", { name: "Reconnect", exact: true }).click();
  const connected = page.getByRole("region", { name: "Connected" }).getByTestId("connector-row");
  await expect(connected.filter({ hasText: "App Store Connect" })).toBeVisible();
  expect(await fixtureRequests(page, "check")).toHaveLength(1);
});

test("a disconnected app missing a required credential asks for it instead of offering Reconnect", async ({ page }) => {
  await open(page, ["keyId"]);
  await expect(page.getByTestId("connector-lead")).toContainText("Reconnect App Store Connect");
  await expect(page.getByRole("button", { name: "Reconnect", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Save and connect" })).toBeVisible();
  expect(await fixtureRequests(page, "check")).toHaveLength(0);
});
