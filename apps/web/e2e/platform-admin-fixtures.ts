import type { Page } from "./fixtures";
import { E2E_CHANNEL, E2E_SPACE, fixtureJson, installWorkspaceStubs } from "./workspace-fixtures";

export const OVERVIEW = {
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

export const USER_DETAIL = {
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
    usage: { requests: 24, requestsLast30d: 17,
      byStatus: { queued: 1, completed: 19, failed: 2, blocked: 1, planned: 1 },
      eventDeliveries: 48, eventDeliveriesLast30d: 31, subscribedChannels: 3, subscriptions: 4,
      lastRequestAt: "2026-08-04T10:00:00.000Z", lastEventAt: "2026-08-04T11:00:00.000Z" },
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

export const SPACE_DETAIL = {
  generatedAt: "2026-08-04T12:00:00.000Z",
  space: {
    spaceId: "space:lambda", name: "Lambda Labs", ownerUserId: "user:1", ownerEmail: "owner@example.com",
    createdAt: "2026-07-01T00:00:00.000Z", lastMessageAt: "2026-08-04T11:00:00.000Z",
  },
  totals: {
    members: 2, channels: 6, agents: 1, messages: 3000, messagesLast7d: 700, messagesLast30d: 2100,
    humanMessages: 900, agentMessages: 2100, pages: 14, storageLogicalBytes: 512 * 1024,
    activeInvites: 1, pendingJoinRequests: 2,
  },
  members: [
    { userId: "user:1", email: "owner@example.com", role: "owner", joinedAt: "2026-07-01T00:00:00.000Z", messages: 800 },
    { userId: "user:3", email: "member@example.com", role: "member", joinedAt: "2026-07-10T00:00:00.000Z", messages: 100 },
  ],
  agents: [{
    machineId: "machine:1", harness: "claude", displayName: "claude-reviewer", ownerUserId: "user:1",
    createdAt: "2026-07-02T00:00:00.000Z", updatedAt: "2026-08-04T10:00:00.000Z",
  }],
  connectors: [{
    providerId: "github", providerName: "GitHub", status: "configured", authMode: "oauth", createdBy: "user:1",
    createdAt: "2026-07-03T00:00:00.000Z", lastCheckedAt: "2026-08-04T09:00:00.000Z",
  }],
  automations: {
    total: 3, enabled: 2, withError: 1, runCount: 40, lastRunAt: "2026-08-04T08:00:00.000Z",
    occurrencesByStatus: { dispatched: 36, failed: 4 },
  },
  runs: { total: 20, byStatus: { completed: 18, failed: 2 }, lastRunAt: "2026-08-04T10:00:00.000Z" },
  billing: {
    plan: "pro", status: "past_due", seats: 4, provider: "stripe", currentPeriodEnd: "2026-08-20T00:00:00.000Z",
    cancelAtPeriodEnd: false, graceUntil: "2026-08-11T00:00:00.000Z", updatedAt: "2026-08-04T07:00:00.000Z",
  },
  freeMessages: 0,
  webhookEvents: [{
    spaceId: "space:lambda", eventType: "customer.subscription.updated", outcome: "processed",
    processedAt: "2026-08-04T07:00:00.000Z",
  }],
  paidCalls: [{ kind: "jev_turn", calls: 120, byOutcome: { ok: 118, rejected: 2 }, units: 120, credits: 2400 }],
  storage: [{ category: "messages", rows: 3000, logicalBytes: 400_000 }],
  activity: Array.from({ length: 30 }, (_, index) => ({
    date: new Date(Date.UTC(2026, 6, 6) + index * 86_400_000).toISOString().slice(0, 10),
    messages: index * 4, humanMessages: index, agentMessages: index * 3,
  })),
  truncated: [],
};

export const OPERATIONS = {
  generatedAt: "2026-08-04T12:00:00.000Z",
  days: 30,
  machines: [
    { machineId: "machine:1", ownerUserId: "user:1", ownerEmail: "owner@example.com", status: "online",
      agents: 3, activeRuns: 1, enrolledAt: "2026-07-02T00:00:00.000Z", lastSeenAt: "2026-08-04T11:00:00.000Z" },
    { machineId: "machine:2", ownerUserId: "user:2", status: "offline",
      agents: 1, activeRuns: 0, enrolledAt: "2026-06-02T00:00:00.000Z", lastSeenAt: "2026-07-20T11:00:00.000Z" },
  ],
  machinesByStatus: { online: 1, offline: 1 },
  harnesses: [{ harness: "claude", agents: 4, spaces: 2, owners: 2 }, { harness: "codex", agents: 2, spaces: 1, owners: 1 }],
  runs: {
    active: 2,
    byStatus: { completed: 50, failed: 5, running: 2 },
    daily: Array.from({ length: 30 }, (_, index) => ({
      date: new Date(Date.UTC(2026, 6, 6) + index * 86_400_000).toISOString().slice(0, 10),
      started: index % 5, failed: index % 7 === 0 ? 1 : 0,
    })),
  },
  automations: { total: 8, enabled: 5, withError: 1, occurrencesByStatus: { dispatched: 90, failed: 10 }, overdue: 0 },
  outbox: { byStatus: { pending: 12, delivered: 4000, failed: 0 }, oldestPendingAt: "2026-08-04T10:00:00.000Z", maxAttempts: 7 },
  billing: {
    subscriptions: [{
      spaceId: "space:lambda", spaceName: "Lambda Labs", plan: "pro", status: "past_due", seats: 4, provider: "stripe",
      currentPeriodEnd: "2026-08-20T00:00:00.000Z", cancelAtPeriodEnd: false, graceUntil: "2026-08-11T00:00:00.000Z",
      updatedAt: "2026-08-04T07:00:00.000Z",
    }],
    byStatus: { past_due: 1 },
    webhookEvents: [{
      spaceId: "space:lambda", eventType: "customer.subscription.updated", outcome: "processed",
      processedAt: "2026-08-04T07:00:00.000Z",
    }],
    webhooksByOutcome: { processed: 1 },
  },
  paidCalls: [{ kind: "jev_turn", calls: 300, byOutcome: { ok: 296, uncertain: 4 }, units: 300, credits: 6000 }],
  truncated: [],
};

const AUDIT = [{
  eventId: "event:1", actorUserId: "user:1", actorEmail: "owner@example.com",
  action: "user.read", targetKind: "user", targetId: "user:1", createdAt: "2026-08-04T11:59:00.000Z",
}];

export async function openWorkspaceAs(page: Page, platformAdmin: boolean, overviewStatus = 200) {
  await installWorkspaceStubs(page, { spaces: [E2E_SPACE], channels: [E2E_CHANNEL] });
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
  await fixtureJson(page, "admin-space", /\/api\/xmatrix\/admin\/spaces\/[^/?]+$/,
    overviewStatus === 200 ? { detail: SPACE_DETAIL } : denied, status);
  await fixtureJson(page, "admin-operations", /\/api\/xmatrix\/admin\/operations(?:\?.*)?$/,
    overviewStatus === 200 ? { operations: OPERATIONS } : denied, status);
  await fixtureJson(page, "admin-audit", /\/api\/xmatrix\/admin\/audit(?:\?.*)?$/,
    overviewStatus === 200 ? { events: AUDIT } : denied, status);
  // Install the operator capability before the first /me read; otherwise More
  // can retain the default non-operator bootstrap depending on fetch timing.
  await page.goto("/app", { waitUntil: "domcontentloaded" });
}
