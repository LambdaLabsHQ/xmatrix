import { expect, test, type Page } from "./fixtures";
import { E2E_DESKTOP_CONTEXT, E2E_MOBILE_CONTEXT, E2E_SPACE, E2E_CHANNEL, E2E_NOW,
  fixtureJson, fixtureRequestBodies, installWorkspaceStubs } from "./workspace-fixtures";

const accountsPath = /\/api\/xmatrix\/spaces\/[^/]+\/app-connections\/stripe\/accounts$/;
const first = { id: "acct_first", name: "acct_first", generation: "11111111-1111-4111-8111-111111111111",
  status: "active", connectedBy: "e2e-user", connectedAt: E2E_NOW };
const second = { ...first, id: "acct_second", name: "acct_second", generation: "22222222-2222-4222-8222-222222222222" };

async function setup(page: Page) {
  await installWorkspaceStubs(page, { spaces: [E2E_SPACE], channels: [E2E_CHANNEL] });
  await fixtureJson(page, "stripe-providers", /\/api\/xmatrix\/connectors\/oauth\/providers\?/, { providers: ["stripe"] });
  await fixtureJson(page, "stripe-connections", /\/api\/xmatrix\/spaces\/[^/]+\/app-connections$/, { connections: [{
    id: `${E2E_SPACE.id}:stripe`, spaceId: E2E_SPACE.id, providerId: "stripe", providerName: "Stripe", status: "configured",
    version: 2, authMode: "oauth", scopes: [], secretRefs: [], capabilities: [], channelIds: [], metadata: {},
    credentialFields: ["stripeAccounts"], createdBy: "e2e-user", createdAt: E2E_NOW, updatedAt: E2E_NOW,
  }] });
  await fixtureJson(page, "stripe-executions", "**/api/xmatrix/spaces/*/app-executions", { executions: [] });
  await fixtureJson(page, "stripe-accounts", accountsPath, { accounts: [first], after: null });
}

for (const [label, context] of [["desktop", E2E_DESKTOP_CONTEXT], ["phone", E2E_MOBILE_CONTEXT]] as const) {
  test.describe(`Stripe accounts on ${label}`, () => {
    test.use(context);
    test("a second authorization adds an account, and removing one preserves the other", async ({ page }) => {
      await setup(page);
      await page.goto(`/app/${E2E_SPACE.id}/apps?connector=stripe`);
      const section = page.getByTestId("stripe-accounts");
      await expect(section.getByText("acct_first", { exact: true })).toBeVisible();
      await expect(section.getByRole("button", { name: "Add Stripe account" })).toBeVisible();

      await fixtureJson(page, "stripe-accounts", accountsPath, { accounts: [first, second], after: null });
      await page.goto(`/app/${E2E_SPACE.id}/apps?connector=stripe&oauth=connected`);
      await expect(section.getByText("acct_first", { exact: true })).toBeVisible();
      await expect(section.getByText("acct_second", { exact: true })).toBeVisible();
      await expect(page).toHaveURL(/\/apps\?connector=stripe$/u);

      await fixtureJson(page, "stripe-account-remove", /\/app-connections\/stripe\/accounts\/acct_first$/, { ok: true }, { method: "DELETE" });
      await fixtureJson(page, "stripe-accounts", accountsPath, { accounts: [second], after: null });
      page.once("dialog", dialog => void dialog.accept());
      await section.getByRole("button", { name: "Remove acct_first" }).click();
      await expect(section.getByText("acct_first", { exact: true })).toHaveCount(0);
      await expect(section.getByText("acct_second", { exact: true })).toBeVisible();
      expect(await fixtureRequestBodies(page, "stripe-account-remove")).toEqual([{ generation: first.generation }]);
    });
  });
}

test.describe("Stripe account pagination", () => {
  test.use(E2E_DESKTOP_CONTEXT);
  test("the next page appends metadata using the provider account cursor", async ({ page }) => {
    await setup(page);
    await fixtureJson(page, "stripe-accounts", accountsPath, { accounts: [first], after: first.id });
    await fixtureJson(page, "stripe-next-page", /\/app-connections\/stripe\/accounts\?after=acct_first$/, { accounts: [second], after: null });
    await page.goto(`/app/${E2E_SPACE.id}/apps?connector=stripe`);
    const section = page.getByTestId("stripe-accounts");
    await section.getByRole("button", { name: "Show more accounts" }).click();
    await expect(section.getByText("acct_first", { exact: true })).toBeVisible();
    await expect(section.getByText("acct_second", { exact: true })).toBeVisible();
    await expect(section.getByRole("button", { name: "Show more accounts" })).toHaveCount(0);
  });
});
