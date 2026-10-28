import { expect, test } from "./fixtures";
import { E2E_DESKTOP_CONTEXT, E2E_SPACE, E2E_CHANNEL, E2E_NOW, fixtureJson, openWorkspaceWithStubs } from "./workspace-fixtures";

test.use(E2E_DESKTOP_CONTEXT);
const MASK = "Result: [hidden — private call]";
const EXPIRED = "The App Store Connect web session is missing or has expired; sign in again under Apps → App Store Connect → Credentials";
const execution = (id: string, status: string, outcome: Record<string, string>) => ({ id, spaceId: E2E_SPACE.id,
  channelId: E2E_CHANNEL.id, messageId: id, providerId: "appstoreconnect", providerName: "App Store Connect",
  actionId: "web_session", actionLabel: "Check web session", status, ...outcome,
  requestedBy: "e2e-user", requestedByLabel: "e2e-user", createdAt: E2E_NOW, updatedAt: E2E_NOW });

test("recent activity names who ran a call and says what to do when it failed", async ({ page }) => {
  await openWorkspaceWithStubs(page, { spaces: [E2E_SPACE], channels: [E2E_CHANNEL] });
  await fixtureJson(page, "oauth-providers", "**/api/xmatrix/connectors/oauth/providers", { providers: [], nativeProviders: [] });
  await fixtureJson(page, "connections", /\/api\/xmatrix\/spaces\/[^/]+\/app-connections$/, { connections: [{
    id: `${E2E_SPACE.id}:appstoreconnect`, spaceId: E2E_SPACE.id, providerId: "appstoreconnect", providerName: "App Store Connect",
    status: "configured", authMode: "api-token", scopes: [], secretRefs: [], capabilities: [], channelIds: [], metadata: {},
    credentialFields: ["issuerId", "keyId", "privateKey", "webSession"], version: 2, createdBy: "e2e-user",
    createdAt: E2E_NOW, updatedAt: E2E_NOW }] });
  await fixtureJson(page, "credentials", /\/app-connections\/appstoreconnect\/credentials$/,
    { credentialFields: ["issuerId", "keyId", "privateKey", "webSession"] });
  await fixtureJson(page, "executions", "**/api/xmatrix/spaces/*/app-executions", { executions: [
    execution("expired", "failed", { reason: EXPIRED }),
    execution("masked", "failed", { reason: MASK }),
  ] });
  await page.getByRole("button", { name: "App", exact: true }).click();
  await page.getByTestId("connector-row").filter({ hasText: "App Store Connect" }).click();

  const rows = page.getByTestId("connector-execution");
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText("E2E Tester");
  await expect(rows.nth(0)).not.toContainText("e2e-user");
  await expect(rows.nth(0)).toContainText("sign in again under Apps → App Store Connect → Credentials");
  await expect(rows.nth(1)).not.toContainText("hidden");
  await rows.nth(1).getByRole("button", { name: "its conversation" }).click();
  await expect(page).toHaveURL(new RegExp(`/channels/[^/]*${E2E_CHANNEL.id}$`));
});
