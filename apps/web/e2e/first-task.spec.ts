import { expect, test } from "./fixtures";
import {
  E2E_CHANNEL, E2E_DESKTOP_CONTEXT, E2E_MOBILE_CONTEXT, E2E_SPACE, fixtureRequestBodies, fixtureRule,
  harnessRegistrations, installWorkspaceStubs,
} from "./workspace-fixtures";

const STARTED = { ...E2E_CHANNEL, id: "channel-first-task", name: "Write a page about a project I'm working on" };

for (const [name, viewport] of [["desktop", E2E_DESKTOP_CONTEXT], ["mobile", E2E_MOBILE_CONTEXT]] as const) {
  test.describe(name, () => {
    test.use(viewport);

    test("an agent in a Space with no conversation gets a first task that ends in a page", async ({ page }) => {
      await installWorkspaceStubs(page, { spaces: [E2E_SPACE], registrations: harnessRegistrations(["codex"]) });
      await fixtureRule(page, { id: "create-conversation", pattern: "**/api/xmatrix/channels", method: "POST",
        responder: { kind: "static", json: { channel: STARTED } } });
      await fixtureRule(page, { id: "first-message", pattern: `**/api/xmatrix/channels/${STARTED.id}/messages`, method: "POST",
        responder: { kind: "static", json: {} } });
      await page.goto("/app", { waitUntil: "domcontentloaded" });
      const card = page.getByTestId("first-task");
      await expect(card).toBeVisible({ timeout: 20_000 });
      await expect(card).toContainText("Just talk. Agents keep the facts in Pages");
      // A browser and a phone have no folder picker; the agent works in its own folder.
      await expect(card.getByText("Work in a folder of yours (optional)")).toHaveCount(0);

      await card.getByRole("radio", { name: "A plan" }).click();
      await card.getByRole("button", { name: "Start" }).click();
      await expect.poll(() => fixtureRequestBodies(page, "first-message")).toEqual([
        { body: "@auto Help me plan something I'm working on, and keep the plan in a page as we go." },
      ]);
    });
  });
}
