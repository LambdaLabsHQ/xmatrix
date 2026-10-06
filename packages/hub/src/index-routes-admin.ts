/**
 * Platform admin routes.
 *
 * Bounded operator surface for cross-Space reads and explicitly staged
 * migrations. Authority is the deployment-owned allowlist in
 * `admin-platform-access.ts`, re-checked here on every request; Relay authority
 * additionally fails closed unless this Worker vouches for the caller.
 */

import type { Hono } from "hono";
import {
  ADMIN_HUMAN_HANDLE_BACKFILL_HUB_ROUTE,
  ADMIN_OVERVIEW_HUB_ROUTE,
  adminHandleBackfillLimit,
  adminOverviewActivityDays,
  adminOverviewRowLimit,
  adminOverviewUserLimit,
  type AdminPlatformOverview,
} from "@xmatrix/protocol";

import { PLATFORM_ADMIN_REQUIRED_MESSAGE, resolvePlatformAdmin } from "./admin-platform-access";
import { operatorTokenAuthorizes } from "./admin-operator-token";
import { RelayPostgresAgentLaunchCoordinatorService } from "./postgres-agent-launch-coordinator";
import { wakeAgentLaunchChannel } from "./agent-launch-coordinator-wake";
import { handOverAutomationChannels } from "./channel-automation-work";
import { resolveTestEnvironmentAccess } from "./test-environment-access";
import { backfillHumanHandles } from "./human-handle-mint";
import {
  PermissionFailure,
  requireAuth,
  jsonErrors,
} from "./index-shared";
import type { Env } from "./types";
import { authDirectoryAdminUsers, authDirectoryEmails } from "./auth-authority";
import {
  channelMessageResponse,
  repairAgentSenderSnapshots,
} from "./channel-messages";
import { getSpace } from "./spaces";
import { readPostgresAdminOverview } from "./postgres-admin-overview";

/** Bounded label lookup so one operator read cannot scan the whole directory. */
const MAX_DIRECTORY_LOOKUPS = 200;

/**
 * Resolve platform-admin authority for one request: the deployment allowlist,
 * or membership of the deployment-pinned admin Space.
 *
 * Membership uses the ordinary Space read authority — Relay authority answers 404
 * for a non-member — so this introduces no second authorization rule, and any
 * non-success (including an Authority failure) fails closed.
 */
export async function platformAdminForRequest(
  authUser: Parameters<typeof resolvePlatformAdmin>[0],
  env: Env,
): Promise<boolean> {
  return resolvePlatformAdmin(authUser, env, (spaceId, userId) =>
    deploymentSpaceMemberForRequest(env, spaceId, userId));
}

/** Resolve Test-app access through the deployment-pinned founding-team Space. */
export async function testEnvironmentForRequest(
  authUser: Parameters<typeof resolveTestEnvironmentAccess>[0],
  env: Env,
): Promise<boolean> {
  return resolveTestEnvironmentAccess(authUser, env, (spaceId, userId) =>
    deploymentSpaceMemberForRequest(env, spaceId, userId));
}

async function deploymentSpaceMemberForRequest(
  env: Env,
  spaceId: string,
  userId: string,
): Promise<boolean> {
  return getSpace(env, { spaceId, principal: { kind: "user", id: userId } }).then(() => true, () => false);
}

/**
 * The caller, once proven to be a platform operator.
 *
 * Every route on this surface makes the same two calls in the same order, and
 * stating them once is what keeps a later route from proving only half of it —
 * an authenticated caller who is not an operator is exactly the case a
 * hand-copied guard drops.
 */
async function requirePlatformAdmin(
  request: Request,
  env: Env,
): Promise<Awaited<ReturnType<typeof requireAuth>>> {
  const authUser = await requireAuth(request, env);
  if (!(await platformAdminForRequest(authUser, env))) {
    throw new PermissionFailure(PLATFORM_ADMIN_REQUIRED_MESSAGE);
  }
  return authUser;
}

async function requirePartitionOperator(request: Request, env: Env): Promise<void> {
  if (await operatorTokenAuthorizes(request, env)) return;
  await requirePlatformAdmin(request, env);
}

export function registerIndexRoutesAdmin(app: Hono<{ Bindings: Env }>): void {
  /* The one-time handover to per-Channel coordination: wake every Channel
     with open launch work, due now or later, so each keeps its own alarm.
     Idempotent. Pass the returned `next` back until it is null. */
  app.post("/api/admin/agent-launch/handover", (c) => jsonErrors(c, async () => {
    await requirePartitionOperator(c.req.raw, c.env);
    const input = await c.req.json().catch(() => ({})) as { next?: { shard?: unknown; after?: unknown } | null };
    const cursor = input.next && Number.isSafeInteger(input.next.shard) && typeof input.next.after === "string"
      ? { shard: Number(input.next.shard), after: input.next.after } : undefined;
    const page = await new RelayPostgresAgentLaunchCoordinatorService(c.env).channelsWithWorkPage(cursor);
    const woken = await Promise.allSettled(page.channels.map(channel =>
      wakeAgentLaunchChannel(c.env.RELAY_POSTGRES_AGENT_LAUNCH_CHANNEL, channel)));
    const failed = woken.filter(result => result.status === "rejected" || !result.value.ok).length;
    // A failed page is retried with the same cursor.
    return c.json({ channels: page.channels.length, failed, next: failed ? cursor ?? { shard: 0, after: "" } : page.next },
      failed ? 503 : 200);
  }));
  /* The one-time cutover to per-Channel Automation timing: wake every Channel
     with Automation work, a page at a time. Post `next` back until it is null. */
  app.post("/api/admin/automation/handover", (c) => jsonErrors(c, async () => {
    await requirePartitionOperator(c.req.raw, c.env);
    const body: { shardId?: unknown; afterChannelId?: unknown } = await c.req.json<Record<string, unknown>>().catch(() => ({}));
    const page = await handOverAutomationChannels(c.env, {
      ...(typeof body.shardId === "string" && body.shardId ? { shardId: body.shardId } : {}),
      ...(typeof body.afterChannelId === "string" && body.afterChannelId
        ? { afterChannelId: body.afterChannelId } : {}),
    });
    return c.json(page, page.failed ? 503 : 200);
  }));

  app.post("/api/admin/channel-family-partitions/:channelId/repair-agent-senders", (c) => jsonErrors(c, async () => {
    const authUser = await requirePlatformAdmin(c.req.raw, c.env);
    const channelId = c.req.param("channelId");
    const body = await c.req.json<Record<string, unknown>>();
    return channelMessageResponse(() => repairAgentSenderSnapshots(c.env, {
      ...body,
      channelId,
      principal: { kind: "user", id: authUser.id },
    }));
  }));

  app.get(ADMIN_OVERVIEW_HUB_ROUTE, (c) => jsonErrors(c, async () => {
    await requirePlatformAdmin(c.req.raw, c.env);
    const input = {
      now: new Date().toISOString(),
      spaceLimit: adminOverviewRowLimit(c.req.query("spaceLimit")),
      userLimit: adminOverviewUserLimit(c.req.query("userLimit")),
      activityDays: adminOverviewActivityDays(c.req.query("activityDays")),
    };
    const overview = await readPostgresAdminOverview(c.env, input);
    if (!overview) {
      return c.json({ error: "Platform overview is unavailable" }, 502);
    }

    return c.json(
      { overview: await withDirectoryUsers(overview, c.env, input.userLimit) },
      200,
      { "cache-control": "private, no-store" },
    );
  }));

  app.post(ADMIN_HUMAN_HANDLE_BACKFILL_HUB_ROUTE, (c) => jsonErrors(c, async () => {
    await requirePlatformAdmin(c.req.raw, c.env);
    const report = await backfillHumanHandles(
      c.env,
      adminHandleBackfillLimit(c.req.query("limit")),
    );
    return c.json({ report }, 200, { "cache-control": "private, no-store" });
  }));
}

async function withDirectoryLabels(
  overview: AdminPlatformOverview,
  env: Env,
): Promise<AdminPlatformOverview> {
  const missing = new Set<string>();
  for (const space of overview.spaces) {
    if (!space.ownerEmail && space.ownerUserId) missing.add(space.ownerUserId);
  }
  for (const user of overview.users) {
    if (!user.email && user.userId) missing.add(user.userId);
  }
  if (missing.size === 0) return overview;

  const emails = await directoryEmails([...missing].slice(0, MAX_DIRECTORY_LOOKUPS), env);
  if (emails.size === 0) return overview;

  return {
    ...overview,
    spaces: overview.spaces.map((space) => space.ownerEmail
      ? space
      : { ...space, ownerEmail: emails.get(space.ownerUserId) }),
    users: overview.users.map((user) => user.email
      ? user
      : { ...user, email: emails.get(user.userId) }),
  };
}

async function withDirectoryUsers(
  overview: AdminPlatformOverview,
  env: Env,
  userLimit: number,
): Promise<AdminPlatformOverview> {
  const directory = await authDirectoryAdminUsers(
    env,
    overview.generatedAt,
    userLimit,
  ).catch(() => null);
  if (!directory ||
      (directory.access.registeredUsers === 0 && overview.totals.users > 0)) {
    return withDirectoryLabels(overview, env);
  }

  const productUsers = new Map(overview.users.map((user) => [user.userId, user]));
  const registeredUsers = directory.users.map((user) => {
    const product = productUsers.get(user.userId);
    productUsers.delete(user.userId);
    return {
      ...user,
      spaces: product?.spaces ?? 0,
      ownedSpaces: product?.ownedSpaces ?? 0,
      agentRegistrations: product?.agentRegistrations ?? 0,
      machines: product?.machines ?? 0,
      messages: product?.messages ?? 0,
      ...(product?.firstSeenAt ? { firstSeenAt: product.firstSeenAt } : {}),
      ...(product?.lastMessageAt ? { lastMessageAt: product.lastMessageAt } : {}),
    };
  });
  return {
    ...overview,
    totals: { ...overview.totals, users: directory.access.registeredUsers },
    users: [...registeredUsers, ...productUsers.values()],
    userAccess: directory.access,
    truncated: {
      ...overview.truncated,
      users: directory.access.registeredUsers > registeredUsers.length,
    },
  };
}

async function directoryEmails(userIds: string[], env: Env): Promise<Map<string, string>> {
  try {
    return await authDirectoryEmails(env, userIds);
  } catch {
    // A directory that is absent or mid-migration must not fail the operator
    // read; the overview still carries every id-keyed metric.
    return new Map();
  }
}
