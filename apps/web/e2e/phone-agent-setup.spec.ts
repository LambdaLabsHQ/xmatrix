import { expect, test } from "./fixtures";
import {
  E2E_CHANNEL, E2E_MOBILE_CONTEXT, E2E_SPACE, fixtureRequests, fixtureRule, installWorkspaceStubs,
} from "./workspace-fixtures";

test.use(E2E_MOBILE_CONTEXT);

const INTENT = "0123456789abcdef0123456789abcdef";
const intent = { intentId: INTENT, spaceId: E2E_SPACE.id, expiresAt: "2099-01-01T00:00:00.000Z", registeredHarnesses: [] };

test("a phone with no agent shows how to bring one in on a computer and approves its terminal", async ({ page }) => {
  await installWorkspaceStubs(page, { spaces: [E2E_SPACE] });
  await fixtureRule(page, { id: "intent-create", pattern: "**/api/xmatrix/setup-intents", method: "POST",
    responder: { kind: "static", json: { ...intent, phase: "waiting" } } });
  await fixtureRule(page, { id: "intent-read", pattern: `**/api/xmatrix/setup-intents/${INTENT}`,
    responder: { kind: "static", json: { ...intent, phase: "waiting" } } });
  await fixtureRule(page, { id: "intent-approve", pattern: `**/api/xmatrix/setup-intents/${INTENT}/approve`, method: "POST",
    responder: { kind: "static", json: { ok: true } } });
  await page.goto("/app", { waitUntil: "domcontentloaded" });
  const connect = page.getByTestId("connect-machine");
  await expect(connect).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText("Bring your agents into xMatrix", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Claude Code")).toBeVisible();
  await expect(connect).toContainText(`bash -s -- --connect ${INTENT}`);
  await expect(page.getByText("Tap + to start one.", { exact: true })).toHaveCount(0);

  // The command runs on the computer; the phone in hand approves it.
  await fixtureRule(page, { id: "intent-read", pattern: `**/api/xmatrix/setup-intents/${INTENT}`, responder: { kind: "static",
    json: { ...intent, phase: "approval", terminal: { userCode: "WDJB-MJHT", hostname: "daniel-laptop", platform: "macos-aarch64" } } } });
  await expect(connect).toContainText("daniel-laptop wants to connect with code", { timeout: 20_000 });
  await connect.getByRole("button", { name: "Approve", exact: true }).click();
  await expect.poll(async () => (await fixtureRequests(page, "intent-approve")).length).toBe(1);
});

test("a phone keeps its conversations listed even while the Space has no agent", async ({ page }) => {
  await installWorkspaceStubs(page, { spaces: [E2E_SPACE], channels: [E2E_CHANNEL] });
  await page.goto("/app", { waitUntil: "domcontentloaded" });
  await expect(page.locator(".app-mobile-channel-list-pane").getByText(E2E_CHANNEL.name, { exact: true }))
    .toBeVisible({ timeout: 20_000 });
  await expect(page.getByText("Bring your agents into xMatrix", { exact: true })).not.toBeVisible();
});
