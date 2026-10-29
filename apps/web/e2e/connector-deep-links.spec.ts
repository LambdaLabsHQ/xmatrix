import { expect, test, type Page } from "./fixtures";
import { E2E_DESKTOP_CONTEXT, E2E_SPACE, E2E_CHANNEL, fixtureJson, installWorkspaceStubs } from "./workspace-fixtures";

async function setup(page: Page) {
  await installWorkspaceStubs(page, { spaces: [E2E_SPACE], channels: [E2E_CHANNEL] });
  await fixtureJson(page, "providers", /\/api\/xmatrix\/connectors\/oauth\/providers\?/, { providers: ["stripe", "notion"] });
  await fixtureJson(page, "connections", /\/api\/xmatrix\/spaces\/[^/]+\/app-connections$/, { connections: [] });
  await fixtureJson(page, "executions", "**/api/xmatrix/spaces/*/app-executions", { executions: [] });
  await fixtureJson(page, "stripe-accounts", /\/app-connections\/stripe\/accounts$/, { accounts: [], after: null });
}

const detail = (page: Page) => page.locator(".app-tool-detail-scroll:visible");

test.describe("desktop connector navigation", () => {
  test.use(E2E_DESKTOP_CONTEXT);

  test("a plain Stripe link opens its detail and list selection only writes connector", async ({ page }) => {
    await setup(page);
    await page.goto(`/app/${E2E_SPACE.id}/apps?connector=stripe`);
    await expect(detail(page).getByRole("heading", { name: "Stripe", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Connect with Stripe", exact: true })).toBeVisible();
    await expect(page).toHaveURL(/\/app\/personal-sspaceperso\/apps\?connector=stripe$/u);

    await page.getByTestId("connector-row").filter({ hasText: "Notion" }).click();
    await expect(detail(page).getByRole("heading", { name: "Notion", exact: true })).toBeVisible();
    await expect(page).toHaveURL(/\/apps\?connector=notion$/u);

    // Browser navigation reads the same URL state without remounting the app.
    await page.evaluate(() => {
      window.history.pushState(null, "", "?connector=stripe");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    await expect(detail(page).getByRole("heading", { name: "Stripe", exact: true })).toBeVisible();
  });

  for (const outcome of ["connected", "failed"]) {
    test(`OAuth ${outcome} keeps the provider selected while consuming its outcome`, async ({ page }) => {
      await setup(page);
      await page.goto(`/app/${E2E_SPACE.id}/apps?item=github&connector=notion&oauth=${outcome}#detail`);
      await expect(detail(page).getByRole("heading", { name: "Notion", exact: true })).toBeVisible();
      const message = outcome === "connected" ? "Notion is connected." : "Notion did not finish connecting.";
      await expect(detail(page).getByText(message, { exact: false })).toBeVisible();
      await expect(page).toHaveURL(/\/apps\?connector=notion#detail$/u);
    });
  }
});

test("phone detail opens from connector and Back removes the selection; item alone is retired", async ({ page }) => {
  await setup(page);
  await page.goto(`/app/${E2E_SPACE.id}/apps?item=github&connector=stripe`);
  await expect(detail(page).getByRole("heading", { name: "Stripe", exact: true })).toBeVisible();
  await expect(page).toHaveURL(/\/apps\?connector=stripe$/u);
  await detail(page).getByRole("button", { name: "Apps", exact: true }).click();
  await expect(page.getByTestId("connector-row").filter({ hasText: "Stripe" })).toBeVisible();
  await expect(page).toHaveURL(/\/apps$/u);
  await page.getByTestId("connector-row").filter({ hasText: "Stripe" }).click();
  await expect(detail(page).getByRole("heading", { name: "Stripe", exact: true })).toBeVisible();
  await expect(page).toHaveURL(/\/apps\?connector=stripe$/u);

  await page.goto(`/app/${E2E_SPACE.id}/apps?item=stripe`);
  await expect(page.getByTestId("connector-row").filter({ hasText: "Stripe" })).toBeVisible();
  await expect(page).toHaveURL(/\/apps$/u);
  await expect(detail(page)).toHaveCount(0);
});
