import { expect, test } from "./fixtures";
import { E2E_DESKTOP_CONTEXT, E2E_SPACE, E2E_CHANNEL, E2E_NOW, fixtureJson, openWorkspaceWithStubs } from "./workspace-fixtures";

test.use(E2E_DESKTOP_CONTEXT);
const connection = (providerId: string, providerName: string, status: string) => ({
  id: `${E2E_SPACE.id}:${providerId}`, spaceId: E2E_SPACE.id, providerId, providerName, status, error: null,
  version: 1, authMode: "api-token", scopes: [], secretRefs: [], capabilities: [], channelIds: [], metadata: {},
  credentialFields: [], createdBy: "e2e-user", createdAt: E2E_NOW, updatedAt: E2E_NOW, lastCheckedAt: E2E_NOW });

test("Apps lists what needs a hand first, then what works, then the rest by category", async ({ page }) => {
  await openWorkspaceWithStubs(page, { spaces: [E2E_SPACE], channels: [E2E_CHANNEL] });
  await fixtureJson(page, "providers", "**/api/xmatrix/connectors/oauth/providers", { providers: [], nativeProviders: [] });
  await fixtureJson(page, "connections", /\/api\/xmatrix\/spaces\/[^/]+\/app-connections$/, { connections: [
    connection("sentry", "Sentry", "error"), connection("linear", "Linear", "configured")] });
  await fixtureJson(page, "executions", "**/api/xmatrix/spaces/*/app-executions", { executions: [] });
  await fixtureJson(page, "policies", /\/app-connections\/[^/]+\/policies$/, { policies: [] });
  await fixtureJson(page, "credentials", /\/app-connections\/[^/]+\/credentials$/, { credentialFields: [] });
  await page.getByRole("button", { name: "App", exact: true }).click();

  const groups = page.locator(".app-connectors-list .app-tool-list-group");
  await expect(groups.first()).toHaveAttribute("aria-label", "Needs attention");
  await expect(groups.nth(1)).toHaveAttribute("aria-label", "Connected");
  await expect(page.getByRole("region", { name: "Connected" })).toContainText("Linear");
  // An app nobody connected sits under its category, with no line repeating an invitation.
  const gitlab = page.getByRole("region", { name: "Code & CI" }).getByTestId("connector-row").filter({ hasText: "GitLab" });
  await expect(gitlab).toHaveText("GitLab");
});

test("a credentials-only app leads with its form; the command reference stays folded", async ({ page }) => {
  await openWorkspaceWithStubs(page, { spaces: [E2E_SPACE], channels: [E2E_CHANNEL] });
  await fixtureJson(page, "providers", "**/api/xmatrix/connectors/oauth/providers", { providers: [], nativeProviders: [] });
  await fixtureJson(page, "connections", /\/api\/xmatrix\/spaces\/[^/]+\/app-connections$/, { connections: [] });
  await fixtureJson(page, "executions", "**/api/xmatrix/spaces/*/app-executions", { executions: [] });
  await fixtureJson(page, "credentials", /\/app-connections\/[^/]+\/credentials$/, { credentialFields: [] });
  await page.getByRole("button", { name: "App", exact: true }).click();
  await page.getByTestId("connector-row").filter({ hasText: "App Store Connect" }).click();

  const lead = page.getByTestId("connector-lead");
  await expect(lead).toContainText("Connect App Store Connect");
  await expect(lead.getByTestId("connector-credential-form")).toBeVisible();
  // The one solid action on the page is the lead's.
  await expect(page.locator(".app-tool-detail-scroll:visible .app-action-primary")).toHaveCount(1);
  await expect(page.getByTestId("connector-commands")).toHaveCount(0);
  await page.getByRole("button", { name: /Show all \d+ commands/ }).click();
  expect(await page.getByTestId("connector-commands").locator("li").count()).toBeGreaterThan(4);
});

test("a connected app shows no call to action, and Disconnect comes last", async ({ page }) => {
  await openWorkspaceWithStubs(page, { spaces: [E2E_SPACE], channels: [E2E_CHANNEL] });
  await fixtureJson(page, "providers", "**/api/xmatrix/connectors/oauth/providers", { providers: ["linear"], nativeProviders: [] });
  await fixtureJson(page, "connections", /\/api\/xmatrix\/spaces\/[^/]+\/app-connections$/, { connections: [
    { ...connection("linear", "Linear", "configured"), authMode: "oauth" }] });
  await fixtureJson(page, "executions", "**/api/xmatrix/spaces/*/app-executions", { executions: [] });
  await fixtureJson(page, "policies", /\/app-connections\/[^/]+\/policies$/, { policies: [] });
  await fixtureJson(page, "credentials", /\/app-connections\/[^/]+\/credentials$/, { credentialFields: [] });
  await page.getByRole("button", { name: "App", exact: true }).click();
  await page.getByTestId("connector-row").filter({ hasText: "Linear" }).click();

  await expect(page.getByTestId("connector-status")).toContainText("Connected · via Linear sign-in");
  await expect(page.getByTestId("connector-lead")).toHaveCount(0);
  await expect(page.locator(".app-tool-detail-scroll:visible .app-action-primary")).toHaveCount(0);
  const sections = page.locator(".app-tool-detail-scroll:visible section[aria-label]");
  await expect(sections.last()).toHaveAttribute("aria-label", "Disconnect");
  await expect(page.getByTestId("connector-policy")).toContainText(/unless a channel has a rule of its own/i);
});
