import {
  CrossSpaceReadError,
  PostgresCrossSpaceReadRepository,
  type CrossSpaceReadGrant,
  type CrossSpaceRunProof,
} from "@xmatrix/db";
import { HUB_ROUTES } from "@xmatrix/protocol";
import type { Context, Hono } from "hono";

import type { AgentRunPrincipal } from "./auth";
import { appendChannelMessage } from "./channel-messages";
import { requireAuth, requestErrorResponse } from "./index-shared";
import { createPostgresAuthorityDatabase } from "./postgres-authority-fleet";
import { notifyWorkspaceResource } from "./workspace-resource-notification";
import { XMATRIX_MANAGEMENT_AVATAR_URL } from "./management-identity";
import type { Env } from "./types";

/**
 * Cross-Space read grants (docs/cross-space-read-grants.md): an Agent Run asks
 * its owner, the owner approves on a card in the Run's own Channel, and each
 * read outside the Run's Space is then made as the owner. The repository owns
 * every authorization decision; these routes name principals and post the card.
 */

export const CROSS_SPACE_READ_MESSAGE_KIND = "xmatrix.system.cross-space-read";

function repository(env: Env): PostgresCrossSpaceReadRepository {
  return new PostgresCrossSpaceReadRepository(createPostgresAuthorityDatabase(env, {
    applicationName: "xmatrix-cross-space-read", statementTimeoutMs: 5_000,
    transactionTimeoutMs: 10_000, lockTimeoutMs: 2_000,
  }));
}

function runProof(run: AgentRunPrincipal): CrossSpaceRunProof {
  if (!run.instanceId) throw new CrossSpaceReadError("agent_run_forbidden", 403,
    "This Run credential names no Instance; reads outside its Space need an exact Run");
  return { agentId: run.agentId, runId: run.runId, instanceId: run.instanceId,
    executionKey: run.executionKey, channelId: run.channelId, spaceId: run.spaceId };
}

/** A typed failure from the grant authority, as the route's HTTP answer. */
export function crossSpaceReadErrorResponse(error: unknown): Response | null {
  if (!(error instanceof CrossSpaceReadError)) return null;
  return Response.json({ error: error.message, code: error.code, retryable: error.retryable },
    { status: error.status, headers: { "cache-control": "private, no-store" } });
}

/** A read outside the Run's Space, granted: made as `owner`, in `spaceId`. */
export interface CrossSpaceOwnerRead {
  owner: { kind: "user"; id: string };
  spaceId: string;
}

/**
 * Who an Agent Run reads a target as. `null` means the ordinary path applies:
 * a Human, or an Agent reading inside its own Space. Otherwise the target is
 * in another Space and an approved grant covers it, so the read is made as the
 * Run's owner; with no grant this throws a 403 that names the way to ask.
 */
export async function crossSpaceReadOwner(env: Env, run: AgentRunPrincipal | undefined,
  target: { channelId: string } | { spaceId: string }): Promise<CrossSpaceOwnerRead | null> {
  if (!run) return null;
  const proof = runProof(run);
  const authorization = await repository(env).authorizeRead({ requestId: crypto.randomUUID(),
    proof, ...target });
  return authorization
    ? { owner: { kind: "user", id: authorization.ownerUserId }, spaceId: authorization.spaceId }
    : null;
}

export function crossSpaceReadGrantRef(grant: Pick<CrossSpaceReadGrant, "spaceId" | "id">): string {
  return `${grant.spaceId}/${grant.id}`;
}

/**
 * Everyone in the Run's Channel sees the card, and the target is in another
 * Space they may not belong to. So the card carries only the opaque grant
 * reference; the owner's card reads the target and reason as the owner.
 */
function noticeBody(grant: CrossSpaceReadGrant): string {
  return [
    `**${grant.agentName || "An Agent"}** asks its owner for read-only access outside this Space, ` +
      "for this Run only and for at most 24 hours.",
    `Only the Run's owner sees what it asks for and decides: on this card, or with ` +
      `\`xmatrix access status ${crossSpaceReadGrantRef(grant)}\` then ` +
      `\`xmatrix access approve ${crossSpaceReadGrantRef(grant)}\`.`,
  ].join("\n\n");
}

/** The approval card, posted by the owner's system identity into the Run's Channel. */
async function appendNotice(env: Env, grant: CrossSpaceReadGrant, ownerEmail: string): Promise<string> {
  const messageId = `cross-space-read:${grant.id}`.slice(0, 200);
  await appendChannelMessage(env, grant.sourceChannelId, {
    commandId: `cross-space-read-append:${grant.id}`.slice(0, 200), messageId,
    channelId: grant.sourceChannelId, body: noticeBody(grant),
    principal: { kind: "user", id: grant.ownerUserId },
    messageKind: CROSS_SPACE_READ_MESSAGE_KIND,
    senderSnapshot: { identityId: `user:${grant.ownerUserId}`, kind: "user", userId: grant.ownerUserId,
      email: ownerEmail, label: "xMatrix access request", name: "xMatrix access request",
      avatarUrl: XMATRIX_MANAGEMENT_AVATAR_URL },
    residual: { appMetadata: { xmatrixProvenance: "system_fact", xmatrixSystemNotice: true,
      crossSpaceRead: { grantId: grant.id, spaceId: grant.spaceId, ownerUserId: grant.ownerUserId,
        ...(grant.agentName ? { agentName: grant.agentName } : {}) } } },
  });
  return messageId;
}

function failure(c: Context<{ Bindings: Env }>, error: unknown): Response {
  return crossSpaceReadErrorResponse(error) ??
    requestErrorResponse(c, error);
}

function publicGrant(grant: CrossSpaceReadGrant): Record<string, unknown> {
  return { ...grant, ref: crossSpaceReadGrantRef(grant) };
}

async function grantResponse(c: Context<{ Bindings: Env }>,
  work: () => Promise<CrossSpaceReadGrant | Response>): Promise<Response> {
  try {
    const grant = await work();
    return grant instanceof Response ? grant
      : c.json({ grant: publicGrant(grant) }, 200, { "cache-control": "private, no-store" });
  } catch (error) {
    return failure(c, error);
  }
}

export function registerCrossSpaceReadRoutes(app: Hono<{ Bindings: Env }>): void {
  app.post(HUB_ROUTES.cross_space_read_requests, async (c) => {
    try {
      const authUser = await requireAuth(c.req.raw, c.env);
      const run = authUser.agentRun;
      if (!run) return c.json({ error: "Only an Agent Run requests a cross-Space read grant",
        code: "agent_run_required" }, 403);
      const body = await c.req.json<Record<string, unknown>>().catch(() => null);
      if (!body || typeof body.channelId !== "string" ||
          (body.scope !== undefined && body.scope !== "channel" && body.scope !== "space") ||
          (body.reason !== undefined && body.reason !== null && typeof body.reason !== "string")) {
        return c.json({ error: "Name channelId, and optionally scope and reason", code: "invalid_request" }, 400);
      }
      const grants = repository(c.env);
      const { grant, created } = await grants.request({ requestId: crypto.randomUUID(), proof: runProof(run),
        channelId: body.channelId, scope: (body.scope as "channel" | "space" | undefined) ?? "channel",
        reason: (body.reason as string | null | undefined) ?? null });
      let noticeError: string | undefined;
      if (grant.status === "pending" && !grant.noticeMessageId) {
        try {
          const messageId = await appendNotice(c.env, grant, authUser.email);
          await grants.attachNotice({ requestId: crypto.randomUUID(), spaceId: grant.spaceId,
            grantId: grant.id, messageId });
          grant.noticeMessageId = messageId;
        } catch (error) {
          // The request stands; the owner can still decide from the CLI.
          noticeError = (error as Error).message;
        }
      }
      await notifyCrossSpaceRead(c.env, grant);
      return c.json({ grant: publicGrant(grant), created, ...(noticeError ? { noticeError } : {}) },
        created ? 201 : 200, { "cache-control": "private, no-store" });
    } catch (error) {
      return failure(c, error);
    }
  });

  // The owner's Pending approvals dock: requests made from this Channel that wait for them.
  app.get("/api/channels/:channelId/cross-space-read-grants/pending", async (c) => {
    try {
      const authUser = await requireAuth(c.req.raw, c.env);
      if (authUser.agentRun) return c.json({ grants: [] }, 200, { "cache-control": "private, no-store" });
      const grants = await repository(c.env).pendingForChannel({ requestId: crypto.randomUUID(),
        channelId: c.req.param("channelId"), viewerUserId: authUser.id });
      return c.json({ grants: grants.map(publicGrant) }, 200, { "cache-control": "private, no-store" });
    } catch (error) {
      return failure(c, error);
    }
  });

  app.get("/api/spaces/:spaceId/cross-space-read-grants/:grantId", async (c) => grantResponse(c, async () => {
    const authUser = await requireAuth(c.req.raw, c.env);
    return repository(c.env).read({ requestId: crypto.randomUUID(),
      spaceId: c.req.param("spaceId"), grantId: c.req.param("grantId"),
      principal: authUser.agentRun ? { kind: "agent", proof: runProof(authUser.agentRun) }
        : { kind: "user", id: authUser.id } });
  }));

  app.post("/api/spaces/:spaceId/cross-space-read-grants/:grantId/decision", async (c) => grantResponse(c, async () => {
    const authUser = await requireAuth(c.req.raw, c.env);
    if (authUser.agentRun) return c.json({ error: "Only the Run's owner decides a grant",
      code: "forbidden" }, 403);
    const body = await c.req.json<Record<string, unknown>>().catch(() => null);
    if (!body || !["approve", "deny", "revoke"].includes(String(body.action)) ||
        (body.scope !== undefined && body.scope !== "channel" && body.scope !== "space")) {
      return c.json({ error: "action must be approve, deny, or revoke", code: "invalid_request" }, 400);
    }
    const grant = await repository(c.env).decide({ requestId: crypto.randomUUID(),
      spaceId: c.req.param("spaceId"), grantId: c.req.param("grantId"), ownerUserId: authUser.id,
      action: body.action as "approve" | "deny" | "revoke",
      ...(body.scope ? { scope: body.scope as "channel" | "space" } : {}) });
    if (!(grant instanceof Response)) await notifyCrossSpaceRead(c.env, grant);
    return grant;
  }));
}

function notifyCrossSpaceRead(env: Env, grant: CrossSpaceReadGrant): Promise<void> {
  return notifyWorkspaceResource(env, {
    spaceId: grant.spaceId, resource: "cross_space_reads", channelId: grant.sourceChannelId,
    recipientUserIds: [grant.ownerUserId],
  });
}

/**
 * The ordinary Agent read runs first, so a read inside the Run's own Space
 * costs nothing extra. Only when it is refused (403/404) does the grant
 * authority decide whether the target is elsewhere and granted; then the read
 * is retried as the owner. A target with no grant keeps an actionable 403;
 * anything the owner cannot see keeps the original refusal.
 */
export async function crossSpaceRetryOwner(env: Env, run: AgentRunPrincipal | undefined,
  target: { channelId: string } | { spaceId: string }, denied: Response,
): Promise<CrossSpaceOwnerRead | Response> {
  if (!run || (denied.status !== 403 && denied.status !== 404)) return denied;
  // Grants live only in PostgreSQL; without it there is no grant to find, and
  // the ordinary refusal stands rather than becoming an availability error.
  if (!env.RELAY_POSTGRES?.connectionString || !env.RELAY_POSTGRES_SHARD_ID) return denied;
  try {
    return await crossSpaceReadOwner(env, run, target) ?? denied;
  } catch (error) {
    if (error instanceof CrossSpaceReadError && error.code === "cross_space_read_grant_required") {
      return crossSpaceReadErrorResponse(error)!;
    }
    if (error instanceof CrossSpaceReadError && error.status === 404) return denied;
    throw error;
  }
}

/** {@link crossSpaceRetryOwner} for a read that answers with a Response. */
export async function retryDeniedAgentReadAcrossSpaces(env: Env, run: AgentRunPrincipal | undefined,
  target: { channelId: string } | { spaceId: string }, denied: Response,
  retry: (owner: { kind: "user"; id: string }) => Promise<Response>): Promise<Response> {
  const granted = await crossSpaceRetryOwner(env, run, target, denied);
  return granted instanceof Response ? granted : retry(granted.owner);
}
