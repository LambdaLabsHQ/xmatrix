import { expect, test } from "./fixtures";
import {
  E2E_CHANNEL, E2E_MOBILE_CONTEXT, E2E_SPACE, fixtureRequests, fixtureRule, installWorkspaceStubs,
} from "./workspace-fixtures";

test.use(E2E_MOBILE_CONTEXT);

test("a phone with no agent says the next step is on the computer and mails the link there", async ({ page }) => {
  await installWorkspaceStubs(page, { spaces: [E2E_SPACE] });
  await fixtureRule(page, { id: "setup-link-email", pattern: "**/api/xmatrix/setup-link-email", method: "POST",
    responder: { kind: "static", status: 202, json: { sentTo: "e2e@xmatrix.test" } } });
  await fixtureRule(page, { id: "setup-intent-create", pattern: "**/api/xmatrix/setup-intents", method: "POST",
    responder: { kind: "static", json: {} } });
  await page.goto("/app", { waitUntil: "domcontentloaded" });
  const card = page.getByTestId("continue-on-computer");
  await expect(card).toBeVisible({ timeout: 20_000 });
  await expect(card).toContainText("Open xmatrix.sh there and sign in");
  await expect(card.getByLabel("Claude Code")).toBeVisible();
  // A phone cannot paste a command, so it never prepares one.
  expect(await fixtureRequests(page, "setup-intent-create")).toHaveLength(0);
  await expect(page.getByText(/install\.sh/u)).toHaveCount(0);

  await card.getByRole("button", { name: "Email me the link" }).click();
  await expect(card.getByRole("status")).toContainText("Sent to e2e@xmatrix.test. Open it on your computer.");
  expect(await fixtureRequests(page, "setup-link-email")).toHaveLength(1);
});

test("a phone keeps its conversations listed even while the Space has no agent", async ({ page }) => {
  await installWorkspaceStubs(page, { spaces: [E2E_SPACE], channels: [E2E_CHANNEL] });
  await page.goto("/app", { waitUntil: "domcontentloaded" });
  await expect(page.locator(".app-mobile-channel-list-pane").getByText(E2E_CHANNEL.name, { exact: true }))
    .toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("continue-on-computer")).toHaveCount(0);
});
