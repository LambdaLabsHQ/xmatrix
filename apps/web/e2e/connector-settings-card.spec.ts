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
  capabilities: [], channelIds: [], credentialFields: ["keyId", "privateKey", ...(lastCheckedAt ? ["webSession"] : [])],
  createdBy: "e2e-user", createdAt: E2E_NOW, updatedAt: E2E_NOW, ...(lastCheckedAt ? { lastCheckedAt } : {}) });
const LATER = "2026-07-01T00:05:00.000Z";

async function openReceipt(page: Page, message: unknown, { admin }: { admin: boolean }) {
  await installWorkspaceStubs(page, { spaces: [E2E_SPACE],
    channels: [{ ...E2E_CHANNEL, messageCount: 1, lastMessageSequence: 1 }] });
  await fixtureJson(page, "history", "**/api/xmatrix/channels/channel-general/history**", { messages: [message], hasMore: false });
  await fixtureRule(page, { id: "connections", pattern: APPS, method: "GET", responder: { kind: "sequence",
    responses: [{ json: { connections: [connection("configured")] } }, { json: { connections: [connection("configured", LATER)] } }] } });
  await fixtureJson(page, "credentials", `${ASC}/credentials`, admin ? { credentialFields: ["keyId", "privateKey"] }
    : { error: "Not found" }, { method: "GET", ...(admin ? {} : { status: 404 }) });
  await fixtureJson(page, "save", `${ASC}/credentials`, { credentialFields: ["keyId", "privateKey", "webSession"] }, { method: "PUT" });
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
