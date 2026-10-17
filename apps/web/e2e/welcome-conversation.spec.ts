import { expect, test } from "./fixtures";
import {
  E2E_CHANNEL, E2E_DESKTOP_CONTEXT, E2E_MOBILE_CONTEXT, E2E_NOW, E2E_SPACE, fixtureChannelCatalog, fixtureJson,
  fixtureRequestBodies, fixtureRequests, fixtureRule, harnessRegistrations, installWorkspaceStubs, openWorkspaceWithStubs,
  releaseFixture,
} from "./workspace-fixtures";

const WELCOME = { ...E2E_CHANNEL, id: "channel-welcome", name: "Welcome to xMatrix", mode: "closed",
  messageCount: 1, lastMessageSequence: 1, updatedAt: E2E_NOW };
const XMATRIX = { identityId: "user:e2e-user", kind: "user", userId: "e2e-user", email: "e2e@xmatrix.test",
  label: "xMatrix", name: "xMatrix", avatarUrl: "/brand/xmatrix-management-icon.png" };
const step = (sequence: number, stage: string, body: string) => ({
  messageId: `system:welcome:${WELCOME.id}:${stage}`, channelId: WELCOME.id, sequence, body, sentAt: E2E_NOW, from: XMATRIX,
  metadata: { kind: "xmatrix.onboarding.v1", stage, xmatrixSystemNotice: true, xmatrixProvenance: "system_fact" },
});
const BRING = step(1, "bring-agents", "Bring your agents into xMatrix.");
const IN = step(2, "agents-in", "@codex is in. Mention it here to give it work.");

async function welcomeOnFirstOpen(page: import("@playwright/test").Page) {
  await installWorkspaceStubs(page, { spaces: [E2E_SPACE] });
  await fixtureRule(page, { id: "welcome", pattern: `**/api/xmatrix/spaces/${E2E_SPACE.id}/welcome`, method: "POST",
    responder: { kind: "deferred", json: { channelId: WELCOME.id } } });
  await page.goto("/app", { waitUntil: "domcontentloaded" });
  await expect.poll(async () => (await fixtureRequests(page, "welcome")).length, { timeout: 20_000 }).toBe(1);
  // While the Hub answers, nothing stands in for the conversation it makes.
  await expect(page.getByTestId("connect-machine")).not.toBeVisible();
  await fixtureChannelCatalog(page, "channel-catalog", [WELCOME]);
  await fixtureJson(page, "history", `**/api/xmatrix/channels/${WELCOME.id}/history**`, { messages: [BRING], hasMore: false });
  await releaseFixture(page, "welcome");
}

test.describe("desktop", () => {
  test.use(E2E_DESKTOP_CONTEXT);

  test("a new personal Space opens xMatrix's welcome, which brings the agents in", async ({ page }) => {
    await welcomeOnFirstOpen(page);
    const welcome = page.getByTestId("connect-machine");
    await expect(welcome).toBeVisible({ timeout: 20_000 });
    await expect(welcome).toContainText("Bring your agents into xMatrix.");
    await expect(page.getByText("Welcome to xMatrix").first()).toBeVisible();
  });

  test("once an agent is in, a starter is sent as the person's own message to Auto", async ({ page }) => {
    await openWorkspaceWithStubs(page, { spaces: [E2E_SPACE], channels: [{ ...WELCOME, messageCount: 2, lastMessageSequence: 2 }],
      registrations: harnessRegistrations(["codex"]) });
    await fixtureJson(page, "history", `**/api/xmatrix/channels/${WELCOME.id}/history**`, { messages: [BRING, IN], hasMore: false });
    await fixtureJson(page, "send", `**/api/xmatrix/channels/${WELCOME.id}/messages`, { message: { id: "sent" } }, { method: "POST" });
    await page.goto("/app/personal-sspaceperso/channels/welcome-to-xmatrix-cchannelwel");
    const agentsIn = page.locator('[data-onboarding-stage="agents-in"]');
    await expect(agentsIn).toContainText("@codex is in. Mention it here to give it work", { timeout: 20_000 });
    await agentsIn.getByRole("button", { name: /Plan something with me/u }).click();
    await expect.poll(async () => (await fixtureRequestBodies(page, "send")).map((sent) => (sent as { body?: string }).body))
      .toEqual(["@auto Help me plan something I'm working on, and keep the plan in a page as we go."]);
  });
});

test.describe("mobile", () => {
  test.use(E2E_MOBILE_CONTEXT);

  test("a phone lists xMatrix's welcome instead of an empty Space", async ({ page }) => {
    await welcomeOnFirstOpen(page);
    await expect(page.locator(".app-mobile-channel-list-pane").getByText("Welcome to xMatrix", { exact: true }))
      .toBeVisible({ timeout: 20_000 });
  });
});
