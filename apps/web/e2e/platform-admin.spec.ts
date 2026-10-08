import { expect, test } from "./fixtures";
import { fixtureRequests, fixtureRule, releaseFixture } from "./in-page-api-fixtures";
import { OVERVIEW, openWorkspaceAs } from "./platform-admin-fixtures";

// The operator rail entry is desktop-only (md:flex), so this spec runs wide.
test.use({ viewport: { width: 1280, height: 900 } });

test("a platform admin sees platform totals, user access, and activity", async ({ page }, testInfo) => {
  await openWorkspaceAs(page, true);
  await page.goto("/app/personal-sspaceperso/admin");

  const totals = page.getByRole("region", { name: "Platform", exact: true });
  await expect(totals.getByText("12", { exact: true })).toBeVisible();
  await expect(totals.getByText("4.2k", { exact: true })).toBeVisible();
  await expect(totals.getByText("9 spaces", { exact: true })).toBeVisible();

  const access = page.getByRole("region", { name: "Registered users" });
  await expect(access.getByText("Active 7d")).toBeVisible();
  await expect(access.getByText("58% of users")).toBeVisible();
  await expect(page.getByRole("img", { name: /Daily message volume/ })).toBeVisible();

  // The rail offers the operator entry only for an allowlisted account.
  await expect(page.getByRole("button", { name: "Platform admin" })).toBeVisible();
  await page.getByRole("group", { name: "Activity range" }).getByRole("button", { name: "30d", exact: true }).click();
  await expect(page.getByRole("button", { name: "30d", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.screenshot({ path: testInfo.outputPath("desktop-overview.png") });
});

test("the Spaces table searches and sorts, keeping its state in the address", async ({ page }, testInfo) => {
  await openWorkspaceAs(page, true);
  await page.goto("/app/personal-sspaceperso/admin?item=spaces");

  const spaces = page.getByRole("region", { name: "Spaces" });
  await expect(spaces.getByText("Lambda Labs")).toBeVisible();
  await expect(spaces.getByText("owner@example.com")).toBeVisible();
  await expect(spaces.getByText("Solo Space")).toBeVisible();
  await expect(spaces.getByRole("textbox")).toHaveCSS("box-shadow", "none");
  // The default desktop width must show every Space column without hiding
  // the final date behind an otherwise invisible horizontal scroll.
  await expect.poll(() => spaces.locator(".overflow-x-auto").evaluate((element) =>
    element.scrollWidth - element.clientWidth,
  )).toBeLessThanOrEqual(1);
  await page.screenshot({ path: testInfo.outputPath("desktop-spaces.png") });

  await spaces.getByPlaceholder("Space, owner, id").fill("solo");
  await expect(spaces.getByText("Lambda Labs")).toHaveCount(0);
  await expect(spaces.getByText("Solo Space")).toBeVisible();
  await expect(page).toHaveURL(/sq=solo/);

  await spaces.getByPlaceholder("Space, owner, id").fill("");
  await spaces.getByRole("button", { name: "Space", exact: true }).click();
  await expect(spaces.locator("tbody tr").first()).toContainText("Lambda Labs");
  await spaces.getByRole("button", { name: "Space", exact: true }).click();
  await expect(spaces.locator("tbody tr").first()).toContainText("Solo Space");
});

test("opening a user shows their metadata-only detail, and Back returns to the list", async ({ page }) => {
  await openWorkspaceAs(page, true);
  await page.goto("/app/personal-sspaceperso/admin?item=users");

  const users = page.getByRole("region", { name: "Registered users" });
  await users.getByText("owner@example.com").click();
  await expect(page).toHaveURL(/user=user%3A1/);

  await expect(page.getByRole("heading", { name: "Owner" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Spaces (1)" }).getByText("pro · active · 4 seats")).toBeVisible();
  await expect(page.getByRole("region", { name: "Agents (1)" }).getByText("claude-reviewer")).toBeVisible();
  await expect(page.getByRole("region", { name: "Machines (1)" }).getByText("online", { exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "Connectors added (1)" }).getByText("GitHub")).toBeVisible();
  await expect(page.getByRole("region", { name: "Sessions (1)" }).getByText("active", { exact: true })).toBeVisible();
  await expect(page.getByText("Session addresses and devices are not shown to operators.")).toBeVisible();
  await expect(page.getByRole("img", { name: /This user's daily messages/ })).toBeVisible();

  await page.getByRole("button", { name: "Users", exact: true }).first().click();
  await expect(page).not.toHaveURL(/user=/);
  await expect(page.getByRole("region", { name: "Registered users" })).toBeVisible();
});

test("the audit trail lists operator reads", async ({ page }) => {
  await openWorkspaceAs(page, true);
  await page.goto("/app/personal-sspaceperso/admin?item=audit");
  const audit = page.getByRole("region", { name: "Audit trail" });
  await expect(audit.getByText("Opened a user")).toBeVisible();
  await expect(audit.getByText("user:user:1")).toBeVisible();
});

test("a non-admin account is offered no operator entry and the view fails closed", async ({ page }) => {
  await openWorkspaceAs(page, false, 403);
  await page.goto("/app/personal-sspaceperso/admin");

  await expect(page.getByRole("button", { name: "Platform admin" })).toHaveCount(0);
  await expect(page.getByText("Platform admin only")).toBeVisible();
  await expect(page.getByRole("region", { name: "Platform", exact: true })).toHaveCount(0);
});


test("changing the activity range keeps the overview visible while the new read waits", async ({ page }) => {
  await openWorkspaceAs(page, true);
  await page.goto("/app/personal-sspaceperso/admin");
  const platform = page.getByRole("region", { name: "Platform", exact: true });
  await expect(platform.getByText("4.2k", { exact: true })).toBeVisible();
  await fixtureRule(page, {
    id: "admin-range-pending",
    pattern: /\/api\/xmatrix\/admin\/overview.*activityDays=30/,
    responder: { kind: "deferred", json: { overview: { ...OVERVIEW, activityDays: 30 } } },
  });
  try {
    await page.getByRole("button", { name: "30d", exact: true }).click();
    await expect.poll(() => fixtureRequests(page, "admin-range-pending")).toHaveLength(1);
    await expect(platform.getByText("4.2k", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Refresh", exact: true })).toBeDisabled();
    await expect(page.getByText("Loading platform data")).toHaveCount(0);
  } finally {
    await releaseFixture(page, "admin-range-pending");
  }
  await expect(page.getByRole("img", { name: "Daily message volume for the last 30 days, peaking at 130" })).toBeVisible();
});
