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
const CARD = `**/api/xmatrix/channels/${E2E_CHANNEL.id}/settings-cards/**`;
const WEB = "connector:appstoreconnect/webSession";

/** A setting as the Hub describes it to this viewer; the card draws only this. */
const setting = (overrides: Record<string, unknown>) => ({ address: WEB, domain: "connector", scope: "App Store Connect",
  label: "Web session", control: "sign-in", sensitivity: "secret", writer: "space-admin", state: "missing", satisfied: false,
  canWrite: true, service: "appstoreconnect", href: `/app/${SPACE}/apps?connector=appstoreconnect`, ...overrides });
const view = (settings: unknown[], extra: Record<string, unknown> = {}) => ({ spaceId: SPACE, settings,
  satisfied: settings.every((item) => (item as { satisfied: boolean }).satisfied), ...extra });

/** The App Store Connect receipt for a `sales` read that stopped for want of a web session, as the Hub writes it. */
function receipt(provenance = "system_fact") {
  return {
    messageId: "system:command-1:appstoreconnect", channelId: E2E_CHANNEL.id, sequence: 1, sentAt: E2E_NOW,
    body: "App connector command status:\n- App Store Connect sales: failed; sign in to App Store Connect under Credentials.",
    from: { identityId: "app:appstoreconnect", kind: "app", label: "App Store Connect", name: "App Store Connect", userId: "", email: "",
      avatarUrl: "/app-connectors/appstoreconnect.svg" },
    metadata: { xmatrixProvenance: provenance, xmatrixConnectorFixes: [{ providerId: "appstoreconnect", actionId: "sales",
      executionId: EXECUTION, remedy: { kind: "credential", field: "webSession" } }] },
  };
}

/** The card an Agent posted, as the Hub writes it: settings by address only. */
function agentCard(settings: unknown[]) {
  return {
    messageId: "settings-request:abc", channelId: E2E_CHANNEL.id, sequence: 1, sentAt: E2E_NOW,
    body: "**claude** asks the people who can make them for these settings.",
    from: { identityId: "user:e2e-user", kind: "user", label: "xMatrix settings request", name: "xMatrix settings request",
      userId: "e2e-user", email: "e2e@xmatrix.test" },
    metadata: { xmatrixProvenance: "system_fact", xmatrixSystemNotice: true,
      xmatrixSettingsRequest: { agentName: "claude", reason: "Line Jump's App Store downloads", settings } },
  };
}

async function openCard(page: Page, message: unknown, reads: unknown[], made?: unknown) {
  await installWorkspaceStubs(page, { spaces: [E2E_SPACE], channels: [{ ...E2E_CHANNEL, messageCount: 1, lastMessageSequence: 1 }] });
  await fixtureJson(page, "history", "**/api/xmatrix/channels/channel-general/history**", { messages: [message], hasMore: false });
  await fixtureRule(page, { id: "card", pattern: CARD, method: "GET", responder: { kind: "sequence",
    responses: reads.map((json) => ({ json })) } });
  if (made) await fixtureJson(page, "make", CARD, made, { method: "PUT" });
  await fixtureJson(page, "rerun", `**/api/xmatrix/spaces/${SPACE}/app-executions/*/retry`,
    { summary: "App Store sales for Line Jump!: 49 downloads" }, { method: "POST" });
  await page.goto("/app/personal-sspaceperso/channels/general-cchannelgen");
  return page.locator("[data-settings-card]");
}

test("a stopped command's setting is made on its card: saved through the Hub, and the read runs again", async ({ page }) => {
  const card = await openCard(page, receipt(), [view([setting({})], { resumeExecutionId: EXECUTION })],
    view([setting({ state: "verified", satisfied: true })], { resumeExecutionId: EXECUTION }));
  await expect(card).toHaveAttribute("data-settings-card", "open");
  await expect(card.getByText("Sign in to App Store Connect")).toBeVisible();
  await expect(card.getByText(WEB)).toBeVisible();
  await expect(card.getByRole("status")).toHaveText("Not signed in");
  expect((await fixtureRequests(page, "card"))[0]).toContain("sequence=1");
  // A browser has no sign-in window: the session is pasted, and never shown back.
  const field = card.getByLabel(/Web session/u);
  await expect(field).toHaveAttribute("type", "password");
  // Paper, not glass: the action is flat ink and the field a hairline, neither casts a shadow.
  const save = card.getByRole("button", { name: "Save and check" });
  expect(await save.evaluate((element) => getComputedStyle(element).boxShadow)).toBe("none");
  expect(await field.evaluate((element) => getComputedStyle(element).boxShadow)).not.toMatch(/\b[1-9]\d*px [1-9]\d*px\b/u);
  expect(await save.evaluate((element) => getComputedStyle(element).backdropFilter)).toBe("none");
  await field.fill("myacinfo=session");
  await save.click();

  await expect(card).toHaveAttribute("data-settings-card", "settled");
  await expect(card.getByText("App Store Connect is ready")).toBeVisible();
  await expect(card.getByText("Ran it again: App Store sales for Line Jump!: 49 downloads")).toBeVisible();
  expect(await fixtureRequestBodies(page, "make")).toEqual([{ sequence: 1, address: WEB, value: "myacinfo=session" }]);
  expect((await fixtureRequests(page, "rerun"))[0]).toContain(encodeURIComponent(EXECUTION));
});

test("someone who cannot make a setting sees who can, and no control", async ({ page }) => {
  const card = await openCard(page, receipt(), [view([setting({ canWrite: false })])]);
  await expect(card.getByText("A Space admin can make this.")).toBeVisible();
  await expect(card.getByRole("button")).toHaveCount(0);
  await expect(card.locator("input")).toHaveCount(0);
});

test("a fix in a message the Hub did not write draws no card", async ({ page }) => {
  await openCard(page, receipt("approved_action_result"), [view([setting({})])]);
  await expect(page.getByText(/App Store Connect sales/u).first()).toBeVisible();
  await expect(page.locator("[data-settings-card]")).toHaveCount(0);
  expect(await fixtureRequests(page, "card")).toHaveLength(0);
});

test("an Agent's card names who asked and why, and draws each setting by its control whatever its domain", async ({ page }) => {
  const secret = setting({ address: "secret:play/service-account", domain: "secret", scope: "Space secrets",
    label: "play/service-account", control: "secret", service: undefined });
  const grant = setting({ address: "secret-access:metrics", domain: "secret-access", scope: "Space secrets",
    label: "Agents read metrics without asking", control: "grant", sensitivity: "plain", service: undefined });
  const harness = setting({ address: "harness:machine:a/codex/sign-in", domain: "harness", scope: "Codex on Laptop",
    label: "Sign in to Codex", control: "harness-sign-in", writer: "machine-owner", canWrite: false, service: undefined });
  const card = await openCard(page, agentCard([{ address: secret.address }, { address: grant.address }, { address: harness.address }]),
    [view([secret, grant, harness], { askedBy: "claude" })],
    view([{ ...secret, state: "set", satisfied: true }, grant, harness], { askedBy: "claude" }));
  const asked = card.locator("[data-settings-request]");
  await expect(asked.getByText("asks for these settings:")).toBeVisible();
  await expect(asked.getByText("Line Jump's App Store downloads")).toBeVisible();
  await expect(card.getByText("3 settings needed")).toBeVisible();
  const rows = (address: string) => card.locator(`[data-setting="${address}"]`);
  await expect(rows(secret.address).getByLabel("play/service-account")).toHaveAttribute("type", "password");
  await expect(rows(grant.address).getByRole("button", { name: "Allow" })).toBeVisible();
  await expect(rows(harness.address).getByText("The Machine's owner signs in on it.")).toBeVisible();
  await expect(rows(harness.address).getByRole("button")).toHaveCount(0);

  await rows(secret.address).getByLabel("play/service-account").fill("{\"type\":\"service_account\"}");
  await rows(secret.address).getByRole("button", { name: "Save" }).click();
  await expect(rows(secret.address).getByRole("status")).toHaveText("Done");
  expect(await fixtureRequestBodies(page, "make")).toEqual([{ sequence: 1, address: secret.address, value: "{\"type\":\"service_account\"}" }]);
  await expect(card).toHaveAttribute("data-settings-card", "open");
  expect(await fixtureRequests(page, "rerun")).toHaveLength(0);
});

test("an Agent's suggested vendor number is typed in the open, and saved only when a person confirms it", async ({ page }) => {
  const vendor = setting({ address: "connector:appstoreconnect/vendorNumber", label: "Vendor number (sales reports)",
    control: "text", sensitivity: "plain", service: undefined, proposed: "87654321" });
  const card = await openCard(page, agentCard([{ address: vendor.address, proposed: "87654321" }]),
    [view([vendor], { askedBy: "claude" })],
    view([{ ...vendor, proposed: undefined, value: "87654321", state: "verified", satisfied: true }], { askedBy: "claude" }));
  const field = card.getByLabel(/Vendor number/u);
  await expect(field).toHaveAttribute("type", "text");
  await expect(field).toHaveValue("87654321");
  await expect(card.getByText("Suggested by claude; it is saved only when you confirm.")).toBeVisible();
  expect(await fixtureRequests(page, "make")).toHaveLength(0);
  await card.getByRole("button", { name: "Confirm and check" }).click();
  await expect(card).toHaveAttribute("data-settings-card", "settled");
  await expect(card.getByRole("status")).toHaveText("87654321");
  expect(await fixtureRequestBodies(page, "make")).toEqual([{ sequence: 1, address: vendor.address, value: "87654321" }]);
});
