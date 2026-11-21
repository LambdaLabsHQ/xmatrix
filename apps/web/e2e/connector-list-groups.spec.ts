import { expect, test, type Page } from "./fixtures";
import { E2E_DESKTOP_CONTEXT, E2E_SPACE, E2E_CHANNEL, E2E_NOW, fixtureJson, fixtureRequestBodies, fixtureRequests, openWorkspaceWithStubs } from "./workspace-fixtures";

test.use(E2E_DESKTOP_CONTEXT);
const connection = (providerId: string, providerName: string, status: string, authMode = "api-token") => ({
  id: `${E2E_SPACE.id}:${providerId}`, spaceId: E2E_SPACE.id, providerId, providerName, status, error: null,
  version: 1, authMode, scopes: [], secretRefs: [], capabilities: [], channelIds: [], metadata: {},
  credentialFields: [], createdBy: "e2e-user", createdAt: E2E_NOW, updatedAt: E2E_NOW, lastCheckedAt: E2E_NOW });

/** Opens Apps with these one-click providers and connections, then the named app when given. */
async function openApps(page: Page, { providers = [], connections = [], app, permission = { mode: "write", inherited: true } }: {
  providers?: string[]; connections?: unknown[]; app?: string; permission?: unknown;
}) {
  await openWorkspaceWithStubs(page, { spaces: [E2E_SPACE], channels: [E2E_CHANNEL] });
  await fixtureJson(page, "providers", `**/api/xmatrix/connectors/oauth/providers?spaceId=${E2E_SPACE.id}`, { providers, nativeProviders: [] });
  await fixtureJson(page, "connections", /\/api\/xmatrix\/spaces\/[^/]+\/app-connections$/, { connections });
  await fixtureJson(page, "executions", "**/api/xmatrix/spaces/*/app-executions", { executions: [] });
  await fixtureJson(page, "policies", /\/app-connections\/[^/]+\/policies$/, permission);
  await fixtureJson(page, "credentials", /\/app-connections\/[^/]+\/credentials$/, { credentialFields: [] });
  await page.getByRole("button", { name: "App", exact: true }).click();
  if (app) await page.getByTestId("connector-row").filter({ hasText: app }).click();
}

const page_ = (page: Page) => page.locator(".app-tool-detail-scroll:visible");

test("Apps groups by connection state: needs a hand, connected (green tick), then not connected by category", async ({ page }) => {
  await openApps(page, { connections: [connection("sentry", "Sentry", "error"), connection("linear", "Linear", "configured")] });

  const groups = page.locator(".app-connectors-list .app-tool-list-group");
  await expect(groups).toHaveCount(3);
  await expect(groups.nth(0)).toHaveAttribute("aria-label", "Needs attention");
  await expect(groups.nth(1)).toHaveAttribute("aria-label", "Connected");
  await expect(groups.nth(2)).toHaveAttribute("aria-label", "Not connected");
  const linear = page.getByRole("region", { name: "Connected" }).getByTestId("connector-row").filter({ hasText: "Linear" });
  await expect(linear.getByRole("img", { name: "Connected" })).toBeVisible();
  // Categories are subheadings inside Not connected, never sections beside Connected.
  const notConnected = page.getByRole("region", { name: "Not connected" });
  await expect(notConnected.locator(".app-tool-list-subheading").first()).toHaveText("Code & CI");
  const gitlab = notConnected.getByTestId("connector-row").filter({ hasText: "GitLab" });
  await expect(gitlab).toHaveText("GitLab");
  await expect(gitlab.locator(".app-tool-state-icon")).toHaveCount(0);
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

test("a connected app shows no call to action; Switch account, Pause and Remove come before what it does", async ({ page }) => {
  await openApps(page, { providers: ["linear"], connections: [connection("linear", "Linear", "configured", "oauth")], app: "Linear" });

  await expect(page.getByTestId("connector-status")).toContainText("Connected · via Linear sign-in");
  await expect(page.getByTestId("connector-lead")).toHaveCount(0);
  await expect(page_(page).locator(".app-action-primary")).toHaveCount(0);
  const order = await page_(page).locator("section[aria-label]").evaluateAll((sections) =>
    sections.map((section) => section.getAttribute("aria-label")));
  expect(order.indexOf("Account")).toBeGreaterThanOrEqual(0);
  expect(order.indexOf("Account")).toBeLessThan(order.indexOf("Permissions"));
  expect(order.at(-1)).toBe("Commands");
  for (const name of ["Switch Linear account", "Pause Linear", "Remove Linear"]) await expect(page.getByRole("button", { name })).toBeVisible();
  await expect(page.getByTestId("connector-policy")).toContainText("Agents read and make changes directly");
});

test("Permissions are one choice for the app: read only, ask first, or read and write", async ({ page }) => {
  await openApps(page, { providers: ["googlecalendar"], connections: [connection("googlecalendar", "Google Calendar", "configured", "oauth")],
    app: "Google Calendar" });
  await fixtureJson(page, "policy-put", /\/app-connections\/googlecalendar\/policies$/, { ok: true }, { method: "PUT" });

  const permissions = page.getByTestId("connector-policy");
  const choice = permissions.getByRole("combobox", { name: "Agents may" });
  await expect(choice).toContainText("Read and write");
  await expect(permissions).toContainText("Agents read and make changes directly");
  await expect(permissions.getByText(/channel/i)).toHaveCount(0);
  await choice.click();
  for (const label of ["Read only", "Ask first", "Read and write"]) await expect(page.getByRole("option", { name: label })).toBeVisible();
  await page.getByRole("option", { name: "Ask first" }).click();
  await expect.poll(() => fixtureRequestBodies(page, "policy-put")).toEqual([{ mode: "ask" }]);
});

test("a Google sign-in is switched or signed out, never paused", async ({ page }) => {
  await openApps(page, { providers: ["googlesearchconsole"],
    connections: [connection("googlesearchconsole", "Google Search Console", "configured", "oauth")], app: "Google Search Console" });
  await expect(page.getByRole("button", { name: "Switch Google Search Console account" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign out of Google Search Console" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Pause Google Search Console" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Remove Google Search Console" })).toHaveCount(0);
});

test("Remove asks first, then deletes the connection with what it saved", async ({ page }) => {
  await openApps(page, { providers: ["linear"], connections: [connection("linear", "Linear", "configured", "oauth")], app: "Linear" });
  await fixtureJson(page, "remove", /\/app-connections\/linear$/, { ok: true }, { method: "DELETE" });
  page.once("dialog", (dialog) => void dialog.dismiss());
  await page.getByRole("button", { name: "Remove Linear" }).click();
  expect(await fixtureRequests(page, "remove")).toHaveLength(0);
  await fixtureJson(page, "connections", /\/api\/xmatrix\/spaces\/[^/]+\/app-connections$/, { connections: [] });
  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByRole("button", { name: "Remove Linear" }).click();
  await expect.poll(() => fixtureRequests(page, "remove")).toHaveLength(1);
  await expect(page_(page).getByRole("button", { name: "Connect with Linear" })).toBeVisible();
});

test("a saved credential is replaced from one of the Space's secrets without typing it", async ({ page }) => {
  await openApps(page, { connections: [{ ...connection("bingwebmaster", "Bing Webmaster Tools", "configured"), credentialFields: ["apiKey"] }],
    app: "Bing Webmaster Tools" });
  await fixtureJson(page, "secrets", /\/api\/xmatrix\/spaces\/[^/]+\/secrets$/, { canManage: true, secrets: [
    { secretRef: "bing-webmaster-yiming", envName: "BING_WEBMASTER_API_KEY", access: "ask", createdByUserId: "e2e-user", createdAt: E2E_NOW, updatedAt: E2E_NOW },
  ] });
  await fixtureJson(page, "fill", /\/app-connections\/bingwebmaster\/credentials$/, { credentialFields: ["apiKey"] }, { method: "PUT" });
  await page.reload();
  await page.getByRole("button", { name: "App", exact: true }).click();
  await page.getByTestId("connector-row").filter({ hasText: "Bing Webmaster Tools" }).click();
  const rows = page_(page).getByTestId("connector-credential-rows");
  await rows.getByRole("button", { name: "Use a saved secret" }).first().click();
  await expect(rows.getByRole("combobox", { name: "Saved secret" })).toContainText("bing-webmaster-yiming");
  await rows.getByRole("button", { name: "Use it" }).click();
  await expect.poll(() => fixtureRequestBodies(page, "fill")).toEqual([{ fromSecrets: { apiKey: "bing-webmaster-yiming" } }]);
});
