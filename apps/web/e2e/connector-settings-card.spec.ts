import type { Page } from "@playwright/test";

import { expect, test } from "./fixtures";
import {
  E2E_CHANNEL,
  E2E_DESKTOP_CONTEXT,
  E2E_NOW,
  E2E_SPACE,
  fixtureJson,
  fixtureRequestBodies,
  fixtureRequests,
  fixtureRule,
  installWorkspaceStubs,
} from "./workspace-fixtures";

test.use(E2E_DESKTOP_CONTEXT);

const SPACE = E2E_SPACE.id;
const EXECUTION = "app-execution:command-1:appstoreconnect:sales";
const APPS = `**/api/xmatrix/spaces/${SPACE}/app-connections`;
const ASC = `**/api/xmatrix/spaces/${SPACE}/app-connections/appstoreconnect`;

/** The App Store Connect receipt for a `sales` read that stopped for want of a web session, as the Hub writes it. */
function receipt(fixes: unknown, provenance = "system_fact") {
  return {
    messageId: "system:command-1:appstoreconnect", channelId: E2E_CHANNEL.id, sequence: 1, sentAt: E2E_NOW,
    body: "App connector command status:\n- App Store Connect sales: failed; sign in to App Store Connect under Credentials.",
    from: { identityId: "app:appstoreconnect", kind: "app", label: "App Store Connect", name: "App Store Connect", userId: "", email: "",
      avatarUrl: "/app-connectors/appstoreconnect.svg" },
    metadata: { xmatrixProvenance: provenance, xmatrixConnectorFixes: fixes },
  };
}
const FIX = [{ providerId: "appstoreconnect", actionId: "sales", executionId: EXECUTION,
  remedy: { kind: "credential", field: "webSession" } }];
const connection = (status: string, lastCheckedAt?: string) => ({ id: `${SPACE}:appstoreconnect`, spaceId: SPACE,
  providerId: "appstoreconnect", providerName: "App Store Connect", status, authMode: "api-token", scopes: [], secretRefs: [],
  capabilities: [], channelIds: [], credentialFields: ["keyId", "privateKey", ...(lastCheckedAt ? ["webSession", "vendorNumber"] : [])],
  createdBy: "e2e-user", createdAt: E2E_NOW, updatedAt: E2E_NOW, ...(lastCheckedAt ? { lastCheckedAt } : {}) });
const LATER = "2026-07-01T00:05:00.000Z";

async function openReceipt(page: Page, message: unknown, { admin, saved = { credentialFields: ["keyId", "privateKey", "webSession"] } }:
  { admin: boolean; saved?: Record<string, unknown> }) {
  await installWorkspaceStubs(page, { spaces: [E2E_SPACE],
    channels: [{ ...E2E_CHANNEL, messageCount: 1, lastMessageSequence: 1 }] });
  await fixtureJson(page, "history", "**/api/xmatrix/channels/channel-general/history**", { messages: [message], hasMore: false });
  await fixtureRule(page, { id: "connections", pattern: APPS, method: "GET", responder: { kind: "sequence",
    responses: [{ json: { connections: [connection("configured")] } }, { json: { connections: [connection("configured", LATER)] } }] } });
  await fixtureJson(page, "credentials", `${ASC}/credentials`, admin ? { credentialFields: ["keyId", "privateKey"] }
    : { error: "Not found" }, { method: "GET", ...(admin ? {} : { status: 404 }) });
  await fixtureJson(page, "save", `${ASC}/credentials`, saved, { method: "PUT" });
  await fixtureJson(page, "check", `${ASC}/check`, { connection: connection("configured", LATER) }, { method: "POST" });
  await fixtureJson(page, "rerun", `**/api/xmatrix/spaces/${SPACE}/app-executions/*/retry`,
    { summary: "App Store sales for Line Jump!: 49 downloads" }, { method: "POST" });
  await page.goto("/app/personal-sspaceperso/channels/general-cchannelgen");
  return page.locator("[data-settings-card]");
}

test("a stopped command's setting is fixed on its card: saved, checked, and the read runs again", async ({ page }) => {
  const card = await openReceipt(page, receipt(FIX), { admin: true });
  await expect(card).toHaveAttribute("data-settings-card", "open");
  await expect(card.getByText("Sign in to App Store Connect")).toBeVisible();
  await expect(card.getByText("connector:appstoreconnect/webSession")).toBeVisible();
  await expect(card.getByRole("status")).toHaveText("Not signed in");
  // A browser has no sign-in window: the session is pasted, and never shown back.
  const field = card.getByLabel(/Web session/u);
  await expect(field).toHaveAttribute("type", "password");
  // Paper, not glass: the action is flat ink and the field a hairline, neither casts a shadow.
  const save = card.getByRole("button", { name: "Save and check" });
  expect(await save.evaluate((element) => getComputedStyle(element).boxShadow)).toBe("none");
  expect(await field.evaluate((element) => getComputedStyle(element).boxShadow)).not.toMatch(/\b[1-9]\d*px [1-9]\d*px\b/u);
  expect(await save.evaluate((element) => getComputedStyle(element).backdropFilter)).toBe("none");
  await field.fill("myacinfo=session");
  await card.getByRole("button", { name: "Save and check" }).click();

  await expect(card).toHaveAttribute("data-settings-card", "settled");
  await expect(card.getByText("App Store Connect is ready")).toBeVisible();
  await expect(card.getByText("Ran it again: App Store sales for Line Jump!: 49 downloads")).toBeVisible();
  expect(await fixtureRequestBodies(page, "save")).toEqual([{ fields: { webSession: "myacinfo=session" } }]);
  expect(await fixtureRequests(page, "check")).toHaveLength(1);
  expect((await fixtureRequests(page, "rerun"))[0]).toContain(encodeURIComponent(EXECUTION));
});

test("someone who cannot change the connection sees who can, and no control", async ({ page }) => {
  const card = await openReceipt(page, receipt(FIX), { admin: false });
  await expect(card.getByText("A Space admin can fix this.")).toBeVisible();
  await expect(card.getByRole("button")).toHaveCount(0);
  await expect(card.locator("input")).toHaveCount(0);
});

test("a fix in a message the Hub did not write draws no card", async ({ page }) => {
  await openReceipt(page, receipt(FIX, "approved_action_result"), { admin: true });
  await expect(page.getByText(/App Store Connect sales/u).first()).toBeVisible();
  await expect(page.locator("[data-settings-card]")).toHaveCount(0);
});

test("a card an Agent asked for names who asked and why, and is settled the same way, with nothing to run again", async ({ page }) => {
  const request = {
    messageId: "settings-request:abc", channelId: E2E_CHANNEL.id, sequence: 1, sentAt: E2E_NOW,
    body: "**claude** asks a Space admin for sign in to App Store Connect: Line Jump's App Store downloads",
    from: { identityId: "user:e2e-user", kind: "user", label: "xMatrix settings request", name: "xMatrix settings request",
      userId: "e2e-user", email: "e2e@xmatrix.test" },
    metadata: { xmatrixProvenance: "system_fact", xmatrixSystemNotice: true,
      xmatrixConnectorFixes: [{ providerId: "appstoreconnect", actionId: "settings", remedy: { kind: "credential", field: "webSession" } }],
      xmatrixSettingsRequest: { agentName: "claude", reason: "Line Jump's App Store downloads" } },
  };
  const card = await openReceipt(page, request, { admin: true });
  const asked = page.locator("[data-settings-request]");
  await expect(asked.getByText("asks a Space admin for this setting:")).toBeVisible();
  await expect(asked.getByText("Line Jump's App Store downloads")).toBeVisible();
  await expect(card.getByText("Settings", { exact: true })).toBeVisible();
  await card.getByLabel(/Web session/u).fill("myacinfo=session");
  await card.getByRole("button", { name: "Save and check" }).click();
  await expect(card).toHaveAttribute("data-settings-card", "settled");
  expect(await fixtureRequests(page, "check")).toHaveLength(1);
  expect(await fixtureRequests(page, "rerun")).toHaveLength(0);
});

test("an Agent's suggested vendor number is typed in the open, and saved only when an admin confirms it", async ({ page }) => {
  const VENDOR = { providerId: "appstoreconnect", actionId: "settings", remedy: { kind: "credential", field: "vendorNumber" },
    proposed: "87654321" };
  const request = {
    messageId: "settings-request:vendor", channelId: E2E_CHANNEL.id, sequence: 1, sentAt: E2E_NOW,
    body: "**claude** asks a Space admin for App Store Connect Vendor number (sales reports).",
    from: { identityId: "user:e2e-user", kind: "user", label: "xMatrix settings request", name: "xMatrix settings request",
      userId: "e2e-user", email: "e2e@xmatrix.test" },
    metadata: { xmatrixProvenance: "system_fact", xmatrixSystemNotice: true, xmatrixConnectorFixes: [VENDOR],
      xmatrixSettingsRequest: { agentName: "claude" } },
  };
  const card = await openReceipt(page, request, { admin: true,
    saved: { credentialFields: ["keyId", "privateKey", "vendorNumber"], plain: { vendorNumber: "87654321" } } });
  const field = card.getByLabel(/Vendor number/u);
  await expect(field).toHaveAttribute("type", "text");
  await expect(field).toHaveValue("87654321");
  await expect(card.getByText("Suggested by claude; it is saved only when you confirm.")).toBeVisible();
  expect(await fixtureRequests(page, "save")).toHaveLength(0);
  await card.getByRole("button", { name: "Confirm and check" }).click();
  await expect(card).toHaveAttribute("data-settings-card", "settled");
  await expect(card.getByRole("status")).toHaveText("87654321");
  expect(await fixtureRequestBodies(page, "save")).toEqual([{ fields: { vendorNumber: "87654321" } }]);
});
