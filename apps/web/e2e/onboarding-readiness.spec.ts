import { expect, test } from "./fixtures";
import {
  E2E_DESKTOP_CONTEXT, E2E_MOBILE_CONTEXT, E2E_SPACE, E2E_CHANNEL,
  fixtureRequests, fixtureRule, installWorkspaceStubs, releaseFixture,
} from "./workspace-fixtures";

for (const [name, viewport] of [
  ["desktop", E2E_DESKTOP_CONTEXT], ["mobile", E2E_MOBILE_CONTEXT],
] as const) {
  test.describe(name, () => {
    test.use(viewport);

    for (const first of ["channels", "agents"] as const) {
      test(`onboarding waits for both catalogs when ${first} finishes first`, async ({ page }) => {
        await installWorkspaceStubs(page, { spaces: [E2E_SPACE] });
        await fixtureRule(page, {
          id: "pending-channels", pattern: "**/api/xmatrix/channels/page?*",
          responder: { kind: "deferred", json: {
            protocolVersion: 1, catalogRevision: 1, rows: [], nextCursor: null,
            counts: { active: 0, archive: 0, unread: 0, mentions: 0 },
          } },
        });
        await fixtureRule(page, {
          id: "pending-agents", pattern: "**/api/xmatrix/spaces/*/agent-registrations",
          responder: { kind: "deferred", json: { registrations: [], capabilities: [] } },
        });
        await page.goto("/app", { waitUntil: "domcontentloaded" });
        await expect.poll(async () => (await fixtureRequests(page, "pending-channels")).length).toBeGreaterThan(0);
        await expect.poll(async () => (await fixtureRequests(page, "pending-agents")).length).toBeGreaterThan(0);
        const setup = page.getByText("Bring your agents into xMatrix", { exact: true });
        const setupCards = page.locator(".app-space-setup-card");
        await expect(setupCards).toHaveCount(0);
        await expect(page.getByText("Tap + to start one.", { exact: true })).toHaveCount(0);
        await releaseFixture(page, `pending-${first}`);
        // Let the released query notify React and commit before checking the
        // intermediate state; an immediate negative assertion can pass early.
        await page.evaluate(() => new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        }));
        await expect(setupCards).toHaveCount(0);
        await releaseFixture(page, `pending-${first === "channels" ? "agents" : "channels"}`);
        await expect(setup).toHaveCount(1);
        await expect(setup).toBeVisible();
        await expect(page.getByTestId("connect-machine")).toBeVisible();
      });
    }

    test("existing conversations remain reachable before the first agent is added", async ({ page }) => {
      await installWorkspaceStubs(page, { spaces: [E2E_SPACE], channels: [E2E_CHANNEL] });
      await page.goto("/app", { waitUntil: "domcontentloaded" });
      const row = page.locator(name === "mobile"
        ? `[data-mobile-channel-row-id="${E2E_CHANNEL.id}"]`
        : `[data-channel-row-id="${E2E_CHANNEL.id}"]`);
      await expect(row).toBeVisible();
      await row.click();
      await expect(page).toHaveURL(new RegExp(`--${E2E_CHANNEL.id}$`));
    });

    test("a failed agents read is on paper, not the setup wood", async ({ page }) => {
      await installWorkspaceStubs(page, { spaces: [E2E_SPACE] });
      await fixtureRule(page, {
        id: "failed-agents", pattern: "**/api/xmatrix/spaces/*/agent-registrations",
        responder: { kind: "static", status: 503, json: { error: "Query read timeout" } },
      });
      await page.goto("/app", { waitUntil: "domcontentloaded" });
      const title = page.getByText("Cannot reach xMatrix right now", { exact: true });
      await expect(title).toHaveCount(1, { timeout: 20_000 });
      await expect(page.locator(".app-tool-paper").filter({ has: title })).toHaveCount(1);
      await expect(page.locator(".app-message-surface-space-setup")).toHaveCount(0);
    });
  });
}
