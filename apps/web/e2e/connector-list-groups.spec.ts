import { expect, test, type Page } from "./fixtures";
import { E2E_DESKTOP_CONTEXT, E2E_SPACE, E2E_CHANNEL, E2E_NOW, fixtureJson, openWorkspaceWithStubs } from "./workspace-fixtures";

test.use(E2E_DESKTOP_CONTEXT);
const connection = (providerId: string, providerName: string, status: string, authMode = "api-token") => ({
  id: `${E2E_SPACE.id}:${providerId}`, spaceId: E2E_SPACE.id, providerId, providerName, status, error: null,
  version: 1, authMode, scopes: [], secretRefs: [], capabilities: [], channelIds: [], metadata: {},
  credentialFields: [], createdBy: "e2e-user", createdAt: E2E_NOW, updatedAt: E2E_NOW, lastCheckedAt: E2E_NOW });

/** Opens Apps with these one-click providers and connections, then the named app when given. */
async function openApps(page: Page, { providers = [], connections = [], app }: {
  providers?: string[]; connections?: unknown[]; app?: string;
}) {
  await openWorkspaceWithStubs(page, { spaces: [E2E_SPACE], channels: [E2E_CHANNEL] });
  await fixtureJson(page, "providers", "**/api/xmatrix/connectors/oauth/providers", { providers, nativeProviders: [] });
  await fixtureJson(page, "connections", /\/api\/xmatrix\/spaces\/[^/]+\/app-connections$/, { connections });
  await fixtureJson(page, "executions", "**/api/xmatrix/spaces/*/app-executions", { executions: [] });
  await fixtureJson(page, "policies", /\/app-connections\/[^/]+\/policies$/, { policies: [] });
  await fixtureJson(page, "credentials", /\/app-connections\/[^/]+\/credentials$/, { credentialFields: [] });
  await page.getByRole("button", { name: "App", exact: true }).click();
  if (app) await page.getByTestId("connector-row").filter({ hasText: app }).click();
}

const page_ = (page: Page) => page.locator(".app-tool-detail-scroll:visible");

test("Apps lists what needs a hand first, then what works, then the rest by category", async ({ page }) => {
  await openApps(page, { connections: [connection("sentry", "Sentry", "error"), connection("linear", "Linear", "configured")] });

  const groups = page.locator(".app-connectors-list .app-tool-list-group");
  await expect(groups.first()).toHaveAttribute("aria-label", "Needs attention");
  await expect(groups.nth(1)).toHaveAttribute("aria-label", "Connected");
  await expect(page.getByRole("region", { name: "Connected" })).toContainText("Linear");
  // An app nobody connected sits under its category, with no line repeating an invitation.
  const gitlab = page.getByRole("region", { name: "Code & CI" }).getByTestId("connector-row").filter({ hasText: "GitLab" });
  await expect(gitlab).toHaveText("GitLab");
});

test("a credentials-only app leads with its form; the command reference stays folded", async ({ page }) => {
  await openApps(page, { app: "App Store Connect" });

  const lead = page.getByTestId("connector-lead");
  await expect(lead).toContainText("Connect App Store Connect");
  await expect(lead.getByTestId("connector-credential-form")).toBeVisible();
  // The one solid action on the page is the lead's.
  await expect(page_(page).locator(".app-action-primary")).toHaveCount(1);
  await expect(page.getByTestId("connector-commands")).toHaveCount(0);
  await page.getByRole("button", { name: /Show all \d+ commands/ }).click();
  expect(await page.getByTestId("connector-commands").locator("li").count()).toBeGreaterThan(4);
});

test("a connected app shows no call to action, and Disconnect comes last", async ({ page }) => {
  await openApps(page, { providers: ["linear"], connections: [connection("linear", "Linear", "configured", "oauth")], app: "Linear" });

  await expect(page.getByTestId("connector-status")).toContainText("Connected · via Linear sign-in");
  await expect(page.getByTestId("connector-lead")).toHaveCount(0);
  await expect(page_(page).locator(".app-action-primary")).toHaveCount(0);
  await expect(page_(page).locator("section[aria-label]").last()).toHaveAttribute("aria-label", "Disconnect");
  await expect(page.getByTestId("connector-policy")).toContainText(/unless a channel has a rule of its own/i);
});
