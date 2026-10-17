import { expect, test } from "./fixtures";
import {
  E2E_CHANNEL, E2E_MOBILE_CONTEXT, E2E_SPACE, fixtureRequests, fixtureRule, installWorkspaceStubs,
} from "./workspace-fixtures";

test.use(E2E_MOBILE_CONTEXT);

const INTENT = "0123456789abcdef0123456789abcdef";
const intent = { intentId: INTENT, spaceId: E2E_SPACE.id, expiresAt: "2099-01-01T00:00:00.000Z", registeredHarnesses: [] };

test("a phone with no agent sends the person to their computer with the same email", async ({ page }) => {
  await installWorkspaceStubs(page, { spaces: [E2E_SPACE] });
  await fixtureRule(page, { id: "intent-create", pattern: "**/api/xmatrix/setup-intents", method: "POST",
    responder: { kind: "static", json: { ...intent, phase: "waiting" } } });
  await page.goto("/app", { waitUntil: "domcontentloaded" });
  const connect = page.getByTestId("connect-machine");
  await expect(connect).toBeVisible({ timeout: 20_000 });
  await expect(connect).toContainText("Bring your agents into xMatrix.");
  await expect(connect).toContainText("Works with Claude Code, Codex, Cursor and");
  // A command is no use on a phone: the computer signs in and shows its own.
  await expect(connect).toContainText("On your computer, open xmatrix.sh and sign in with this same email");
  await expect(connect).not.toContainText(`--connect`);
  await expect(page.getByText("Tap + to start one.", { exact: true })).toHaveCount(0);
  expect(await fixtureRequests(page, "intent-create")).toHaveLength(0);
});

test("a phone keeps its conversations listed even while the Space has no agent", async ({ page }) => {
  await installWorkspaceStubs(page, { spaces: [E2E_SPACE], channels: [E2E_CHANNEL] });
  await page.goto("/app", { waitUntil: "domcontentloaded" });
  await expect(page.locator(".app-mobile-channel-list-pane").getByText(E2E_CHANNEL.name, { exact: true }))
    .toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("connect-machine")).not.toBeVisible();
});
