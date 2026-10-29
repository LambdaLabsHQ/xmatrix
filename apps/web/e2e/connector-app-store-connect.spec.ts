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

async function open(page: Page, credentialFields: string[], { status = "disconnected", executions = [], before }: {
  status?: string; executions?: unknown[]; before?: () => Promise<void>;
} = {}) {
  await openWorkspaceWithStubs(page, { spaces: [E2E_SPACE], channels: [E2E_CHANNEL] });
  await fixtureJson(page, "oauth-providers", `**/api/xmatrix/connectors/oauth/providers?spaceId=${E2E_SPACE.id}`, { providers: [], nativeProviders: [] });
  await fixtureJson(page, "connections", connections, { connections: [connection(status, credentialFields)] });
  await fixtureJson(page, "credentials", /\/app-connections\/appstoreconnect\/credentials$/, { credentialFields });
  await fixtureJson(page, "save-credentials", /\/app-connections\/appstoreconnect\/credentials$/, { credentialFields },
    { method: "PUT" });
  await fixtureJson(page, "executions", "**/api/xmatrix/spaces/*/app-executions", { executions });
  await fixtureJson(page, "check", check, { connection: { ...connection("configured", credentialFields), lastCheckedAt: E2E_NOW } },
    { method: "POST" });
  await before?.();
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

// Recent activity: a failed run is fixed where it shows.
const MASK = "Result: [hidden — private call]";
const EXPIRED = "The App Store Connect web session is missing or has expired; sign in again under Apps → App Store Connect → Credentials";
const execution = (id: string, status: string, outcome: Record<string, unknown>) => ({ id, spaceId: E2E_SPACE.id,
  channelId: E2E_CHANNEL.id, messageId: id, providerId: "appstoreconnect", providerName: "App Store Connect",
  actionId: "web_session", actionLabel: "Check web session", status, ...outcome,
  requestedBy: "e2e-user", requestedByLabel: "e2e-user", createdAt: E2E_NOW, updatedAt: E2E_NOW });
const signedIn = ["issuerId", "keyId", "privateKey", "webSession"];

test("an expired session is renewed from its failed row, which then runs the check again", async ({ page }) => {
  await open(page, signedIn, { status: "configured", executions: [execution("expired", "failed", { reason: EXPIRED,
    retryable: true, resultVisibility: "private", remedy: { kind: "credential", field: "webSession" } })] });
  await fixtureJson(page, "retry", /\/app-executions\/expired\/retry$/,
    { summary: "The App Store Connect web session works: signed in as E2E Tester, team Example." }, { method: "POST" });
  const row = page.getByTestId("connector-execution");
  await expect(row).toContainText("E2E Tester");
  await expect(row).not.toContainText("e2e-user");
  await expect(row).toContainText("The App Store Connect sign-in has expired.");
  await expect(row).not.toContainText("Apps → App Store Connect → Credentials");
  await row.getByRole("button", { name: "Sign in to App Store Connect again" }).click();
  await row.getByRole("textbox").fill("myacinfo=fixture");
  await row.getByRole("button", { name: "Save and retry" }).click();
  await expect(row.getByTestId("connector-execution-rerun")).toContainText("signed in as E2E Tester");
  await expect(row).toContainText("Fixed");
  expect(await fixtureRequests(page, "save-credentials")).toHaveLength(1);
  expect(await fixtureRequests(page, "retry")).toHaveLength(1);
});

test("a private call shows its original to the person it ran for, and can run again", async ({ page }) => {
  await open(page, signedIn, { status: "configured", executions: [execution("masked", "failed", { reason: MASK, retryable: true,
    resultVisibility: "private" })], before: async () => {
    await fixtureJson(page, "private-result", /\/api\/xmatrix\/channels\/[^/]+\/messages\/[^/]+\/connector-result$/u,
    { detail: "App Store Connect's website returned 500" });
  } });
  await fixtureJson(page, "retry", /\/app-executions\/masked\/retry$/, { summary: "It works now." }, { method: "POST" });
  const row = page.getByTestId("connector-execution");
  await expect(row.getByTestId("private-connector-result")).toHaveText("App Store Connect's website returned 500");
  await expect(row).toContainText("Only you can see this result");
  await expect(row).not.toContainText("hidden");
  expect((await fixtureRequests(page, "private-result")).map(url => new URL(url).pathname)).toEqual([
    `/api/xmatrix/channels/${E2E_CHANNEL.id}/messages/${encodeURIComponent("system:masked:appstoreconnect")}/connector-result`]);
  await row.getByRole("button", { name: "Retry" }).click();
  await expect(row.getByTestId("connector-execution-rerun")).toContainText("It works now.");
});
