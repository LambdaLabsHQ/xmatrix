import { expect, test, type Page } from "./fixtures";
import { openWorkspaceAs, OVERVIEW, USER_DETAIL } from "./platform-admin-fixtures";
import { E2E_MOBILE_CONTEXT, fixtureJson } from "./workspace-fixtures";

test.use(E2E_MOBILE_CONTEXT);

const ADMIN = "/app/personal-sspaceperso/admin";

async function expectPaperFits(page: Page) {
  const paper = page.locator(".app-tool-detail-scroll:visible");
  await expect(paper).toBeVisible();
  await expect.poll(() => paper.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
}

test("a phone enters Platform from More, opens a section, and returns to its sections", async ({ page }, testInfo) => {
  await openWorkspaceAs(page, true);
  const dock = page.getByRole("navigation", { name: "Primary" });
  await dock.getByRole("button", { name: "More", exact: true }).click();
  await page.getByRole("region", { name: "Platform", exact: true }).getByRole("button", { name: /^Platform admin/ }).click();
  const list = page.getByRole("navigation", { name: "Platform admin list" });
  await expect(list).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("mobile-sections.png") });
  await list.getByRole("button", { name: "Overview" }).click();
  await expect(page.getByRole("img", { name: /Daily message volume/ })).toBeVisible();
  await expectPaperFits(page);
  await page.screenshot({ path: testInfo.outputPath("mobile-overview.png") });
  await page.getByRole("button", { name: "Platform admin", exact: true }).click();
  await expect(list).toBeVisible();
});

test("a phone shares a filtered user list, opens a user, and Back restores the filter", async ({ page }, testInfo) => {
  await openWorkspaceAs(page, true);
  await page.goto(`${ADMIN}?item=users&uq=owner&usort=user`);
  const users = page.getByRole("region", { name: "Registered users" });
  await expect(users.getByRole("textbox")).toHaveValue("owner");
  await expect(users.locator("table")).toHaveCount(0);
  await expectPaperFits(page);
  await page.screenshot({ path: testInfo.outputPath("mobile-users.png") });
  await users.getByRole("button", { name: /owner@example.com/ }).click();
  await expect(page.getByRole("heading", { name: "Owner", exact: true })).toBeVisible();
  await expect(page).toHaveURL(/user=user%3A1/);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Owner", exact: true })).toBeVisible();
  await expectPaperFits(page);
  await page.screenshot({ path: testInfo.outputPath("mobile-user-detail.png") });
  const machines = page.getByRole("region", { name: "Machines (1)" });
  await machines.scrollIntoViewIfNeeded();
  await expect(machines.getByText("online", { exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("mobile-user-lists.png") });
  await page.goBack();
  await expect(users.getByRole("textbox")).toHaveValue("owner");
  await expect(page).not.toHaveURL(/user=/);
});

test("phone sorting, search, and CSV export work without table headers", async ({ page }, testInfo) => {
  await openWorkspaceAs(page, true);
  await page.goto(`${ADMIN}?item=spaces&sq=solo`);
  const spaces = page.getByRole("region", { name: "Spaces", exact: true });
  const search = spaces.getByRole("textbox");
  await expect(search).toHaveValue("solo");
  await expect(spaces.getByText("Lambda Labs")).toHaveCount(0);
  await search.fill("");
  await spaces.getByRole("combobox", { name: "Sort Spaces" }).click();
  await spaces.getByRole("option", { name: "Space", exact: true }).click();
  await expect(spaces.locator("li").first()).toContainText("Lambda Labs");
  await spaces.getByRole("button", { name: "Sorted ascending; sort descending" }).click();
  await expect(spaces.locator("li").first()).toContainText("Solo Space");
  await expect(page).toHaveURL(/ssort=-name/);
  await expectPaperFits(page);
  await page.screenshot({ path: testInfo.outputPath("mobile-spaces.png") });
  const download = page.waitForEvent("download");
  await spaces.getByRole("button", { name: "Export Spaces as CSV" }).click();
  await expect((await download).suggestedFilename()).toMatch(/^s-.*\.csv$/);
});

test("phone pagination and search reset remain in the shared address", async ({ page }) => {
  await openWorkspaceAs(page, true);
  await fixtureJson(page, "admin-overview", /\/api\/xmatrix\/admin\/overview(?:\?.*)?$/, {
    overview: { ...OVERVIEW, users: Array.from({ length: 51 }, (_, index) => ({
      ...OVERVIEW.users[0], userId: `user:${index}`, name: `Person ${index}`,
    })) },
  });
  await page.goto(`${ADMIN}?item=users&upage=2`);
  const users = page.getByRole("region", { name: "Registered users" });
  await expect(users.getByText("Page 2 of 2")).toBeVisible();
  await expect(users.locator("li")).toHaveCount(1);
  await users.getByRole("textbox").fill("Person 0");
  await expect(users.getByText("Person 0", { exact: true })).toBeVisible();
  await expect(page).not.toHaveURL(/upage=/);
  await expectPaperFits(page);
});

test("320px paper fits storage, long identities, user sublists, and the audit trail", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 320, height: 800 });
  await openWorkspaceAs(page, true);
  await page.goto(`${ADMIN}?item=overview`);
  await page.getByRole("region", { name: "Storage by category" }).scrollIntoViewIfNeeded();
  await expectPaperFits(page);
  const longId = "machine:" + "a".repeat(80);
  await fixtureJson(page, "admin-user", /\/api\/xmatrix\/admin\/users\/[^/?]+$/, {
    detail: { ...USER_DETAIL, user: { ...USER_DETAIL.user, name: "b".repeat(80), email: "c".repeat(80) + "@example.com" },
      machines: [{ ...USER_DETAIL.machines[0], machineId: longId }],
      agents: [{ ...USER_DETAIL.agents[0], displayName: "d".repeat(80) }] },
  });
  await page.goto(`${ADMIN}?item=users&user=user%3A1`);
  await expect(page.getByRole("heading", { name: "b".repeat(80) })).toBeVisible();
  await expectPaperFits(page);
  await page.getByRole("region", { name: "Sessions (1)" }).scrollIntoViewIfNeeded();
  await expectPaperFits(page);
  await page.goto(`${ADMIN}?item=audit`);
  await expect(page.getByRole("region", { name: "Audit trail" }).getByText("Opened a user")).toBeVisible();
  await expectPaperFits(page);
  await page.screenshot({ path: testInfo.outputPath("mobile-audit.png") });
});
