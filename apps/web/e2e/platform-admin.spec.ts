import { expect, test } from "./fixtures";
import { fixtureRequests, fixtureRule, releaseFixture } from "./in-page-api-fixtures";
import { OVERVIEW, USER_DETAIL, openWorkspaceAs } from "./platform-admin-fixtures";
import { fixtureJson } from "./workspace-fixtures";

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
  // Recent access alone must not outrank a person who actually sent a message.
  await fixtureJson(page, "admin-overview", /\/api\/xmatrix\/admin\/overview(?:\?.*)?$/, {
    overview: { ...OVERVIEW, users: [
      { ...OVERVIEW.users[0], userId: "idle", name: "Idle daemon", email: "idle@example.com",
        lastSessionAt: "2026-08-05T12:00:00.000Z", lastMessageAt: undefined },
      { ...OVERVIEW.users[0], userId: "older", name: "Older sender", email: "older@example.com",
        lastSessionAt: "2026-08-05T11:00:00.000Z", lastMessageAt: "2026-08-03T11:00:00.000Z" },
      OVERVIEW.users[0],
    ] },
  });
  await page.goto("/app/personal-sspaceperso/admin?item=users");

  const users = page.getByRole("region", { name: "Registered users" });
  await expect(users.getByRole("columnheader", { name: "Last message" })).toHaveAttribute("aria-sort", "descending");
  const rows = users.locator("tbody tr");
  await expect(rows.nth(0)).toContainText("owner@example.com");
  await expect(rows.nth(1)).toContainText("older@example.com");
  await expect(rows.nth(2)).toContainText("Never");
  await expect(rows.nth(0).locator('[title="2026-08-04T11:00:00.000Z"]')).toBeVisible();
  await users.getByRole("button", { name: "Last access", exact: true }).click();
  await expect(rows.first()).toContainText("idle@example.com");
  await users.getByText("owner@example.com").click();
  await expect(page).toHaveURL(/user=user%3A1/);

  await expect(page.getByRole("heading", { name: "Owner" })).toBeVisible();
  const account = page.getByRole("region", { name: "Account", exact: true });
  await expect(account.getByText("Last message", { exact: true })).toBeVisible();
  await expect(account.locator('[title="2026-08-04T11:00:00.000Z"]')).toBeVisible();
  await expect(page.getByRole("region", { name: "Spaces (1)" }).getByText("pro · active · 4 seats")).toBeVisible();
  await expect(page.getByRole("region", { name: "Agents (1)" }).getByText("claude-reviewer")).toBeVisible();
  await expect(page.getByRole("region", { name: "Machines (1)" }).getByText("online", { exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "Connectors added (1)" }).getByText("GitHub")).toBeVisible();
  const connectors = page.getByRole("region", { name: "Connectors added (1)" });
  await expect(connectors.getByText("17 / 24", { exact: true })).toBeVisible();
  await expect(connectors.getByText("31 / 48", { exact: true })).toBeVisible();
  await expect(connectors.getByText(/19 completed/)).toBeVisible();
  await expect(connectors.getByText(/2 failed/)).toBeVisible();
  await expect(connectors.getByText(/Activity covers all callers/)).toBeVisible();
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

test("connector activity stays unknown with an older Hub", async ({ page }) => {
  await openWorkspaceAs(page, true);
  await fixtureJson(page, "admin-user", /\/api\/xmatrix\/admin\/users\/[^/?]+(?:\?.*)?$/, {
    detail: { ...USER_DETAIL, connectors: USER_DETAIL.connectors.map((connector) => ({
      ...connector, usage: undefined,
    })) },
  });
  await page.goto("/app/personal-sspaceperso/admin?item=users&user=user%3A1");
  const connectors = page.getByRole("region", { name: "Connectors added (1)" });
  await expect(connectors.getByText("GitHub")).toBeVisible();
  await expect(connectors.getByText("—", { exact: true })).toHaveCount(5);
  await expect(connectors.getByText("0 / 0", { exact: true })).toHaveCount(0);
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

test("a Space opens from the list with billing, members, and usage, and a member opens their user", async ({ page }, testInfo) => {
  await openWorkspaceAs(page, true);
  await page.goto("/app/personal-sspaceperso/admin?item=spaces");
  await page.getByRole("region", { name: "Spaces" }).getByText("Lambda Labs").click();
  await expect(page).toHaveURL(/space=space%3Alambda/);

  await expect(page.getByRole("heading", { name: "Lambda Labs" })).toBeVisible();
  const usage = page.getByRole("region", { name: "Usage", exact: true });
  await expect(usage.getByText("70%", { exact: true })).toBeVisible();
  await expect(usage.getByText("1 open invites · 2 join requests")).toBeVisible();
  const billing = page.getByRole("region", { name: "Billing", exact: true });
  await expect(billing.getByText("past_due")).toBeVisible();
  await expect(billing.getByText("2026-08-11 00:00 UTC")).toBeVisible();
  await expect(page.getByRole("region", { name: "Connectors (1)" }).getByText("GitHub")).toBeVisible();
  await expect(page.getByRole("region", { name: "Paid calls", exact: true }).getByText("jev_turn")).toBeVisible();
  await expect(page.getByText("Occurrences by status: dispatched 36 · failed 4")).toBeVisible();
  await expect(page.getByRole("img", { name: /This Space's daily messages/ })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("desktop-space-detail.png"), fullPage: true });

  await page.getByRole("region", { name: "Members (2)" }).getByText("member@example.com").click();
  await expect(page).toHaveURL(/item=users/);
  await expect(page).toHaveURL(/user=user%3A3/);
  await expect(page).not.toHaveURL(/space=/);
  await expect(page.getByRole("heading", { name: "Owner" })).toBeVisible();

  // The user's Spaces lead back to the Space detail.
  await page.getByRole("region", { name: "Spaces (1)" }).getByText("Lambda Labs").click();
  await expect(page).toHaveURL(/item=spaces/);
  await expect(page.getByRole("heading", { name: "Lambda Labs" })).toBeVisible();
  await page.getByRole("button", { name: "Spaces", exact: true }).first().click();
  await expect(page).not.toHaveURL(/space=/);
  await expect(page.getByRole("region", { name: "Spaces" }).getByText("Solo Space")).toBeVisible();
});

test("Operations shows Machines, runtimes, Runs, and a stalled delivery notice", async ({ page }, testInfo) => {
  await openWorkspaceAs(page, true);
  await page.goto("/app/personal-sspaceperso/admin?item=operations");
  await expect(page.getByRole("heading", { name: "Operations" })).toBeVisible();
  await expect(page.getByRole("status").getByText(/Event delivery is behind/)).toBeVisible();
  const machines = page.getByRole("region", { name: "Machines", exact: true });
  await expect(machines.getByText("machine:1")).toBeVisible();
  await expect(machines.getByText("offline 1 · online 1")).toBeVisible();
  await expect(page.getByRole("region", { name: "Agent runtimes" }).getByText("codex")).toBeVisible();
  await expect(page.getByText("9% of started")).toBeVisible();
  await expect(page.getByRole("img", { name: /Runs started per day/ })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("desktop-operations.png"), fullPage: true });
});

test("Billing lists subscriptions, webhooks, and platform paid calls", async ({ page }, testInfo) => {
  await openWorkspaceAs(page, true);
  await page.goto("/app/personal-sspaceperso/admin?item=billing");
  await expect(page.getByRole("status").getByText("1 Space is in a payment grace period.")).toBeVisible();
  const subscriptions = page.getByRole("region", { name: "Subscriptions", exact: true }).getByRole("region", { name: "Subscriptions" });
  await expect(subscriptions.getByText("Lambda Labs")).toBeVisible();
  await expect(page.getByRole("region", { name: "Billing webhooks" }).getByText("customer.subscription.updated")).toBeVisible();
  await expect(page.getByRole("region", { name: "Paid calls" }).getByText("ok 296 · uncertain 4")).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("desktop-billing.png"), fullPage: true });
  await subscriptions.getByText("Lambda Labs").click();
  await expect(page).toHaveURL(/item=spaces/);
  await expect(page.getByRole("heading", { name: "Lambda Labs" })).toBeVisible();
});
