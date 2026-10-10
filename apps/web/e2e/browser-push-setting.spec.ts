import { expect, test, type Page } from "./fixtures";
import { E2E_DESKTOP_CONTEXT, E2E_SPACE, openWorkspaceWithStubs } from "./workspace-fixtures";
import { fixtureJson } from "./in-page-api-fixtures";

/* Settings › Notifications is this browser's push: one row that says where it
   stands. The Hub's key decides whether it can be turned on at all. */

test.use(E2E_DESKTOP_CONTEXT);

async function openNotifications(page: Page, config: Record<string, unknown>) {
  await openWorkspaceWithStubs(page, { spaces: [E2E_SPACE] });
  await fixtureJson(page, "push-config", "**/api/xmatrix/push/config", config);
  await page.goto("/app/personal-sspaceperso/settings?item=notifications");
  await expect(page.getByText("Push notifications", { exact: true })).toBeVisible();
}

test("a browser that can be pushed to offers to turn it on", async ({ page }) => {
  await openNotifications(page, { vapidPublicKey: "B".repeat(87) });
  await expect(page.getByRole("button", { name: "Turn on" })).toBeVisible();
  await expect(page.getByText("Be told in this browser when something is addressed to you", { exact: false })).toBeVisible();
});

test("a Hub without a push key says so and offers nothing to turn on", async ({ page }) => {
  await openNotifications(page, {});
  await expect(page.getByText("This xMatrix does not push to browsers.", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Turn on" })).toHaveCount(0);
});
