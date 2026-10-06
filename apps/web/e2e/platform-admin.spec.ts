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

async function openWorkspaceAs(page: Page, platformAdmin: boolean, overviewStatus = 200) {
  await openWorkspaceWithStubs(page, { spaces: [E2E_SPACE], channels: [E2E_CHANNEL] });
  await fixtureJson(page, "me", /\/api\/xmatrix\/me$/, {
    user: { id: "user:1", email: "owner@example.com" },
    hubUrl: "https://hub.example",
    relayUrl: "wss://hub.example/ws/humans",
    capabilities: { platformAdmin },
  });
  await fixtureJson(
    page,
    "admin-overview",
    /\/api\/xmatrix\/admin\/overview(?:\?.*)?$/,
    overviewStatus === 200
      ? { overview: OVERVIEW }
      : { error: "Platform admin authority is required" },
    overviewStatus === 200 ? {} : { status: overviewStatus }
  );
}

test("a platform admin sees the operator view with totals, spaces, and users", async ({ page }) => {
  await openWorkspaceAs(page, true);
  await page.goto("/app/personal-sspaceperso/admin");

  const totals = page.getByRole("region", { name: "Platform totals" });
  await expect(totals.getByText("12", { exact: true })).toBeVisible();
  await expect(totals.getByText("4.2k", { exact: true })).toBeVisible();
  await expect(totals.getByText("9 spaces", { exact: true })).toBeVisible();

  const spaces = page.getByRole("region", { name: "Spaces" });
  await expect(spaces.getByText("Lambda Labs")).toBeVisible();
  await expect(spaces.getByText("owner@example.com")).toBeVisible();
  await expect(spaces.getByText("Solo Space")).toBeVisible();

  // Search narrows the table without reloading the overview.
  await spaces.getByPlaceholder("Search space or owner").fill("solo");
  await expect(spaces.getByText("Lambda Labs")).toHaveCount(0);
  await expect(spaces.getByText("Solo Space")).toBeVisible();

  await expect(page.getByRole("region", { name: "Users" }).getByText("owner@example.com")).toBeVisible();
  const access = page.getByRole("region", { name: "Registered user access" });
  await expect(access.getByText("Active 7d")).toBeVisible();
  await expect(access.getByText("58% of users")).toBeVisible();
  await expect(page.getByRole("img", { name: /Daily message volume/ })).toBeVisible();

  // The rail offers the operator entry only for an allowlisted account.
  await expect(page.getByRole("button", { name: "Platform admin" })).toBeVisible();
});

test("a non-admin account is offered no operator entry and the view fails closed", async ({ page }) => {
  await openWorkspaceAs(page, false, 403);
  await page.goto("/app/personal-sspaceperso/admin");

  await expect(page.getByRole("button", { name: "Platform admin" })).toHaveCount(0);
  await expect(page.getByText("Platform admin only")).toBeVisible();
  await expect(page.getByRole("region", { name: "Platform totals" })).toHaveCount(0);
});
