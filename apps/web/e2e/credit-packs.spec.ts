import { expect, test } from "./fixtures";
import { E2E_DESKTOP_CONTEXT, E2E_SPACE, openWorkspaceWithStubs } from "./workspace-fixtures";
import { fixtureJson, fixtureRequestRecords } from "./in-page-api-fixtures";

const billing = {
  plan: "pro", canManage: true, seats: { used: 1, limit: 1 },
  freeUsage: { acceptedMessages: 12, limit: 500, remaining: 488 },
  subscription: { status: "active", seatQuantity: 1, cancelAtPeriodEnd: false },
  credits: { periodStart: "2026-10-01", resetsOn: "2026-11-01", included: 5_000,
    includedUsed: 5_000, packUsed: 0, packBalance: 0, grace: 2_500, graceUsed: 0, paused: false, packCredits: 10_000 },
};

test.use(E2E_DESKTOP_CONTEXT);

test("a Pro owner starts a fixed-price pack checkout and sees a provider failure", async ({ page }) => {
  await openWorkspaceWithStubs(page, { spaces: [E2E_SPACE] });
  await fixtureJson(page, "pack-billing", /\/billing$/u, { billing });
  await fixtureJson(page, "pack-checkout", /\/billing\/credits\/checkout$/u,
    { error: "Credit pack checkout is temporarily unavailable" }, { status: 503 });
  await page.goto("/app/personal-sspaceperso/settings?item=billing");
  await page.getByRole("button", { name: "Buy 10,000 credits · $10" }).click();
  await expect(page.getByTestId("space-billing").getByRole("alert")).toContainText("Credit pack checkout is temporarily unavailable");
  const requests = await fixtureRequestRecords(page, "pack-checkout");
  expect(requests).toHaveLength(1);
  expect(requests[0].method).toBe("POST");
  expect(requests[0].body).toBeNull();
});

test("returning from Checkout confirms through the server before showing the new balance", async ({ page }) => {
  await openWorkspaceWithStubs(page, { spaces: [E2E_SPACE] });
  await fixtureJson(page, "pack-billing", /\/billing$/u, { billing });
  await fixtureJson(page, "pack-reconcile", /\/billing\/credits\/reconcile$/u,
    { billing: { ...billing, credits: { ...billing.credits, packBalance: 10_000 } } });
  await page.goto("/app/personal-sspaceperso/settings?item=billing&credit_pack_checkout=success&credit_pack_session_id=cs_test_verified");
  await expect(page.getByRole("status").filter({ hasText: "Credit pack payment confirmed" })).toBeVisible();
  await expect(page.getByText("10,000 pack credits left", { exact: false })).toBeVisible();
  const requests = await fixtureRequestRecords(page, "pack-reconcile");
  expect(requests).toHaveLength(1);
  expect(JSON.parse(requests[0].body!)).toEqual({ sessionId: "cs_test_verified" });
  await expect(page).not.toHaveURL(/credit_pack_session_id/);
});
