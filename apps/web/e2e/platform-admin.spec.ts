import { expect, test, type Page } from "./fixtures";
import {
  E2E_CHANNEL,
  E2E_SPACE,
  fixtureJson,
  openWorkspaceWithStubs,
} from "./workspace-fixtures";

// The operator rail entry is desktop-only (md:flex), so this spec runs wide.
test.use({ viewport: { width: 1280, height: 900 } });

const OVERVIEW = {
  generatedAt: "2026-08-04T12:00:00.000Z",
  activityDays: 14,
  totals: {
    users: 12,
    spaces: 9,
    channels: 30,
    activeChannels: 25,
    archivedChannels: 5,
    messages: 4200,
    messagesLast24h: 120,
    messagesLast7d: 900,
    humanMessages: 1200,
    agentMessages: 3000,
    agentRegistrations: 7,
    runs: 40,
    activeRuns: 2,
    agentInstances: 3,
    machines: 6,
    onlineMachines: 4,
    scheduledTasks: 8,
    enabledScheduledTasks: 5,
    storageLogicalBytes: 1024 * 1024,
    archivedSegmentBytes: 2048,
  },
  spaces: [
    {
      id: "space:lambda",
      name: "Lambda Labs",
      ownerUserId: "user:1",
      ownerEmail: "owner@example.com",
      members: 4,
      channels: 6,
      activeChannels: 5,
      agentRegistrations: 3,
      messages: 3000,
      messagesLast7d: 700,
      createdAt: "2026-07-01T00:00:00.000Z",
      lastMessageAt: "2026-08-04T11:00:00.000Z",
    },
    {
      id: "space:solo",
      name: "Solo Space",
      ownerUserId: "user:2",
      members: 1,
      channels: 2,
      activeChannels: 2,
      agentRegistrations: 1,
      messages: 40,
      messagesLast7d: 5,
      createdAt: "2026-06-01T00:00:00.000Z",
    },
  ],
  users: [
    {
      userId: "user:1",
      name: "Owner",
      handle: "owner",
      email: "owner@example.com",
      spaces: 3,
      ownedSpaces: 2,
      agentRegistrations: 3,
      machines: 2,
      messages: 800,
      registeredAt: "2026-07-01T00:00:00.000Z",
      lastSessionAt: "2026-08-04T11:30:00.000Z",
      sessionCount: 4,
      activeSessions: 1,
      emailVerified: true,
      profileCompleted: true,
      providers: ["github"],
      lastMessageAt: "2026-08-04T11:00:00.000Z",
    },
  ],
  userAccess: {
    registeredUsers: 12,
    emailVerifiedUsers: 10,
    completedProfiles: 8,
    activeUsersLast24h: 4,
    activeUsersLast7d: 7,
    activeUsersLast30d: 9,
  },
  activity: Array.from({ length: 14 }, (_, index) => ({
    date: new Date(Date.UTC(2026, 6, 22) + index * 86_400_000).toISOString().slice(0, 10),
    messages: index * 10,
    humanMessages: index * 3,
    agentMessages: index * 7,
  })),
  storage: [
    { category: "messages", rows: 4200, logicalBytes: 900_000, updatedAt: "2026-08-04T12:00:00.000Z" },
  ],
  truncated: { spaces: false, users: false },
};

const USER_DETAIL = {
  generatedAt: "2026-08-04T12:00:00.000Z",
  user: OVERVIEW.users[0],
  sessions: [{
    createdAt: "2026-08-01T09:00:00.000Z", lastActiveAt: "2026-08-04T11:30:00.000Z",
    expiresAt: "2026-08-11T09:00:00.000Z", active: true,
  }],
  spaces: [{
    spaceId: "space:lambda", name: "Lambda Labs", role: "owner", ownerUserId: "user:1",
    joinedAt: "2026-07-01T00:00:00.000Z", members: 4, messages: 800,
    billing: { plan: "pro", status: "active", seats: 4, cancelAtPeriodEnd: false },
  }],
  agents: [{
    spaceId: "space:lambda", machineId: "machine:1", harness: "claude", displayName: "claude-reviewer",
    createdAt: "2026-07-02T00:00:00.000Z", updatedAt: "2026-08-04T10:00:00.000Z",
  }],
  machines: [{
    machineId: "machine:1", status: "online",
    createdAt: "2026-07-02T00:00:00.000Z", updatedAt: "2026-08-04T11:00:00.000Z",
  }],
  connectors: [{
    spaceId: "space:lambda", providerId: "github", providerName: "GitHub", status: "configured",
    createdAt: "2026-07-03T00:00:00.000Z",
  }],
  runs: { total: 30, active: 1, last30d: 12, byStatus: { finished: 29, running: 1 } },
  messages: { total: 800, last7d: 90, last30d: 300, lastMessageAt: "2026-08-04T11:00:00.000Z" },
  pagesCreated: 6,
  activity: Array.from({ length: 30 }, (_, index) => ({
    date: new Date(Date.UTC(2026, 6, 6) + index * 86_400_000).toISOString().slice(0, 10),
    messages: index,
  })),
  truncated: [],
};

const AUDIT = [{
  eventId: "event:1", actorUserId: "user:1", actorEmail: "owner@example.com",
  action: "user.read", targetKind: "user", targetId: "user:1", createdAt: "2026-08-04T11:59:00.000Z",
}];

async function openWorkspaceAs(page: Page, platformAdmin: boolean, overviewStatus = 200) {
  await openWorkspaceWithStubs(page, { spaces: [E2E_SPACE], channels: [E2E_CHANNEL] });
  await fixtureJson(page, "me", /\/api\/xmatrix\/me$/, {
    user: { id: "user:1", email: "owner@example.com" },
    hubUrl: "https://hub.example",
    relayUrl: "wss://hub.example/ws/humans",
    capabilities: { platformAdmin },
  });
  const denied = { error: "Platform admin authority is required" };
  const status = overviewStatus === 200 ? {} : { status: overviewStatus };
  await fixtureJson(page, "admin-overview", /\/api\/xmatrix\/admin\/overview(?:\?.*)?$/,
    overviewStatus === 200 ? { overview: OVERVIEW } : denied, status);
  await fixtureJson(page, "admin-user", /\/api\/xmatrix\/admin\/users\/[^/?]+$/,
    overviewStatus === 200 ? { detail: USER_DETAIL } : denied, status);
  await fixtureJson(page, "admin-audit", /\/api\/xmatrix\/admin\/audit(?:\?.*)?$/,
    overviewStatus === 200 ? { events: AUDIT } : denied, status);
}

test("a platform admin sees platform totals, user access, and activity", async ({ page }) => {
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
});

test("the Spaces table searches and sorts, keeping its state in the address", async ({ page }) => {
  await openWorkspaceAs(page, true);
  await page.goto("/app/personal-sspaceperso/admin?item=spaces");

  const spaces = page.getByRole("region", { name: "Spaces" });
  await expect(spaces.getByText("Lambda Labs")).toBeVisible();
  await expect(spaces.getByText("owner@example.com")).toBeVisible();
  await expect(spaces.getByText("Solo Space")).toBeVisible();

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
