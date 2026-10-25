import { expect, test } from "./fixtures";
import { E2E_CHANNEL, E2E_DESKTOP_CONTEXT, E2E_SPACE, openWorkspaceWithStubs } from "./workspace-fixtures";
import { fixtureJson } from "./in-page-api-fixtures";

/* A Free Space that ran out mid-task left its owner looking at Agents that had
   gone quiet: the refusal was only on a failed row of their own, and an Agent's
   refused reply leaves nothing in the timeline (user 2026-10-25). The composer
   now says, before and after the limit, what is about to stop and where to go. */

test.use(E2E_DESKTOP_CONTEXT);

const CHANNEL_PATH = `/app/${encodeURIComponent(E2E_SPACE.id)}/channels/${encodeURIComponent(`${E2E_CHANNEL.name}--${E2E_CHANNEL.id}`)}`;

function freeBilling(remaining: number, canManage = true) {
  return { billing: {
    plan: "free", canManage, seats: { used: 1, limit: 3 },
    freeUsage: { acceptedMessages: 500 - remaining, limit: 500, remaining }, subscription: null,
  } };
}

test("a used-up Free Space says so above the composer and opens Billing", async ({ page }, testInfo) => {
  await openWorkspaceWithStubs(page, { spaces: [E2E_SPACE], channels: [E2E_CHANNEL] });
  await fixtureJson(page, "space-billing", /\/api\/xmatrix\/spaces\/[^/]+\/billing$/u, freeBilling(0));
  await page.goto(CHANNEL_PATH, { waitUntil: "domcontentloaded" });
  const notice = page.getByTestId("space-allowance-notice");
  await expect(notice).toHaveAttribute("data-allowance", "free-used");
  await expect(notice).toContainText("New messages and Agent replies can't be saved");
  await page.screenshot({ path: testInfo.outputPath("free-used.png") });
  await notice.getByRole("button", { name: "Upgrade to Pro" }).click();
  await expect(page).toHaveURL(/\/settings\?item=billing/u);
  await expect(page.getByTestId("space-billing")).toBeVisible();
});

test("the last fifth of Free is counted down; a member is sent to the owner", async ({ page }, testInfo) => {
  await openWorkspaceWithStubs(page, { spaces: [E2E_SPACE], channels: [E2E_CHANNEL] });
  await fixtureJson(page, "space-billing", /\/api\/xmatrix\/spaces\/[^/]+\/billing$/u, freeBilling(42, false));
  await page.goto(CHANNEL_PATH, { waitUntil: "domcontentloaded" });
  const notice = page.getByTestId("space-allowance-notice");
  await expect(notice).toHaveAttribute("data-allowance", "free-low");
  await expect(notice).toContainText("42 of 500 free writes left");
  await expect(notice).toContainText("Ask the Space owner to upgrade.");
  await expect(notice.getByRole("button")).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("free-low.png") });
});

test("a Space with room left shows nothing", async ({ page }) => {
  await openWorkspaceWithStubs(page, { spaces: [E2E_SPACE], channels: [E2E_CHANNEL] });
  await fixtureJson(page, "space-billing", /\/api\/xmatrix\/spaces\/[^/]+\/billing$/u, freeBilling(300));
  await page.goto(CHANNEL_PATH, { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("textbox").first()).toBeVisible();
  await expect(page.getByTestId("space-allowance-notice")).toHaveCount(0);
});
