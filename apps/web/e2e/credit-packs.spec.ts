import { expect, test } from "./fixtures";
import { E2E_DESKTOP_CONTEXT, E2E_SPACE, openWorkspaceWithStubs } from "./workspace-fixtures";
import { fixtureJson, fixtureRequestRecords } from "./in-page-api-fixtures";

const billing = {
  plan: "pro", canManage: true, seats: { used: 1, limit: 1 },
  freeUsage: { acceptedMessages: 12, limit: 500, remaining: 488 },
  subscription: { status: "active", seatQuantity: 1, cancelAtPeriodEnd: false },
  credits: { periodStart: "2026-10-01", resetsOn: "2026-11-01", included: 5_000,
    includedUsed: 5_000, packUsed: 0, packBalance: 0, grace: 2_500, graceUsed: 0, paused: false, packCredits: 5_000 },
};

test.use(E2E_DESKTOP_CONTEXT);

test("a Pro owner starts a fixed-price pack checkout and sees a provider failure", async ({ page }) => {
  await openWorkspaceWithStubs(page, { spaces: [E2E_SPACE] });
  await fixtureJson(page, "pack-billing", /\/billing$/u, { billing });
  await fixtureJson(page, "pack-checkout", /\/billing\/credits\/checkout$/u,
    { error: "Credit pack checkout is temporarily unavailable" }, { status: 503 });
  await page.goto("/app/personal-sspaceperso/settings?section=billing");
  await page.getByRole("button", { name: "Buy 5,000 credits · $10" }).click();
  await expect(page.getByTestId("space-billing").getByRole("alert")).toContainText("Credit pack checkout is temporarily unavailable");
  const requests = await fixtureRequestRecords(page, "pack-checkout");
  expect(requests).toHaveLength(1);
  expect(requests[0].method).toBe("POST");
  expect(requests[0].body).toBeNull();
});

/** A workspace whose pack checkout the server confirms. */
async function stubPackReturn(page: Parameters<typeof openWorkspaceWithStubs>[0]) {
  await openWorkspaceWithStubs(page, { spaces: [E2E_SPACE] });
  await fixtureJson(page, "pack-billing", /\/billing$/u, { billing });
  await fixtureJson(page, "pack-reconcile", /\/billing\/credits\/reconcile$/u,
    { billing: { ...billing, credits: { ...billing.credits, packBalance: 5_000 } } });
}

test("returning from Checkout confirms through the server before showing the new balance", async ({ page }) => {
  await stubPackReturn(page);
  await page.goto("/app/personal-sspaceperso/settings?section=billing&credit_pack_checkout=success&credit_pack_session_id=cs_test_verified");
  await expect(page.getByRole("status").filter({ hasText: "Credit pack payment confirmed" })).toBeVisible();
  await expect(page.getByText("5,000 pack credits left", { exact: false })).toBeVisible();
  const requests = await fixtureRequestRecords(page, "pack-reconcile");
  expect(requests).toHaveLength(1);
  expect(JSON.parse(requests[0].body!)).toEqual({ sessionId: "cs_test_verified" });
  await expect(page).not.toHaveURL(/credit_pack_session_id/);
});

// Stripe returns to `/billing`, which must open this Space's Billing with the
// return intact (#1203 retired the field `/billing` still wrote).
test("Checkout's return address opens Billing and confirms there", async ({ page }) => {
  await stubPackReturn(page);
  await page.goto(`/billing?space=${E2E_SPACE.id}&credit_pack_checkout=success&credit_pack_session_id=cs_test_verified`);
  await expect(page).toHaveURL(/\/settings\?section=billing/u);
  await expect(page.getByTestId("space-billing")).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "Credit pack payment confirmed" })).toBeVisible();
  expect(await fixtureRequestRecords(page, "pack-reconcile")).toHaveLength(1);
});
