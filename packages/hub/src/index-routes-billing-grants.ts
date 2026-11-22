/**
 * Complimentary Pro for feedback.
 *
 * An operator, or a live Agent Run its operator owns (or a caller holding the
 * grant credential), looks up who sent a
 * piece of feedback and gives their Space one month of Pro. The rules a caller
 * cannot argue with — one grant per person and per piece of feedback, a daily
 * cap, a fixed length, owners only, never over a live subscription — are kept
 * by the ledger in `@xmatrix/db`, not by whoever judges the feedback.
 */

import type { Hono } from "hono";
import { BILLING_GRANT_DAILY_LIMIT, BILLING_GRANT_DAYS, PostgresBillingGrantRepository, PostgresBillingRepository } from "@xmatrix/db";
import type { AdminAuditAction } from "@xmatrix/protocol";

import { bearerMatchesSecret } from "./admin-operator-token";
import { recordAdminAudit } from "./admin-audit";
import { authDirectoryEmails, authDirectoryUserIdBy } from "./auth-authority";
import { internalAddress, listedInternalAddresses } from "./internal-accounts";
import { platformAdminForRequest } from "./index-routes-admin";
import { PermissionFailure, jsonErrors, readBoundedRequestBody, requireAuth, requireLiveAgentRun } from "./index-shared";
import { createPostgresAuthorityDatabase } from "./postgres-authority-fleet";
import { POSTGRES_AUTHORITY_TIMEOUTS, controlErrorResponse, postgresAuthorityShardId } from "./postgres-authority-http";
import { readPostgresAdminUserDetail } from "./postgres-admin-user-detail";
import type { Env } from "./types";

export const BILLING_GRANT_CANDIDATE_ROUTE = "/api/admin/billing-grants/candidate";
export const BILLING_GRANTS_ROUTE = "/api/admin/billing-grants";
/** The audit actor recorded when the grant credential, not a person, makes the call. */
export const BILLING_GRANT_TOKEN_ACTOR = "operator-token:billing-grant";
const MAX_GRANT_REQUEST_BYTES = 4_096;
const PRIVATE = { "cache-control": "private, no-store" };

function repositories(env: Env) {
  const database = createPostgresAuthorityDatabase(env, {
    applicationName: "xmatrix-hub-billing-grants", ...POSTGRES_AUTHORITY_TIMEOUTS,
  });
  const billing = new PostgresBillingRepository(database, postgresAuthorityShardId(env, "billing"));
  return { grants: new PostgresBillingGrantRepository(database, billing) };
}

/** The grant credential, or a signed-in platform operator; recorded before anything is read or given. */
export async function grantOperator(
  request: Request, env: Env, action: AdminAuditAction, target: { kind: string; id: string },
): Promise<string> {
  let actor: { actorUserId: string; actorEmail?: string };
  if (await bearerMatchesSecret(request, env.BILLING_GRANT_OPERATOR_TOKEN)) {
    actor = { actorUserId: BILLING_GRANT_TOKEN_ACTOR };
  } else {
    const user = await requireAuth(request, env);
    if (user.agentRun) {
      // The one place an Agent Run acts on operator authority: a live Run whose
      // owner is a platform operator may judge feedback and grant, so the
      // operator is not asked to hand it a credential. The ledger's caps bind
      // it exactly as they bind the operator.
      const run = await requireLiveAgentRun(env, user);
      const owner = run.ownerUserId;
      const ownerEmail = (await authDirectoryEmails(env, [owner]).catch(() => new Map<string, string>())).get(owner);
      if (!(await platformAdminForRequest({ id: owner, email: ownerEmail ?? "" }, env))) {
        throw new PermissionFailure("Only an Agent Run owned by a platform admin can give complimentary Pro");
      }
      actor = { actorUserId: `agent-run:${run.runId}`, ...(ownerEmail ? { actorEmail: ownerEmail } : {}) };
    } else {
      if (!(await platformAdminForRequest(user, env))) throw new PermissionFailure("Platform admin permission is required");
      actor = { actorUserId: user.id, ...(user.email ? { actorEmail: user.email } : {}) };
    }
  }
  await recordAdminAudit(env, { ...actor, action, targetKind: target.kind, targetId: target.id.slice(0, 300) });
  return actor.actorEmail ? `${actor.actorUserId} <${actor.actorEmail}>` : actor.actorUserId;
}

export function registerIndexRoutesBillingGrants(app: Hono<{ Bindings: Env }>): void {
  /* Who a piece of feedback belongs to, by email or xMatrix handle: their user id, the Spaces they own with
     plan and activity, and any grant they already received. */
  app.get(BILLING_GRANT_CANDIDATE_ROUTE, (c) => jsonErrors(c, async () => {
    const email = c.req.query("email")?.trim() ?? "";
    const handle = c.req.query("handle")?.trim() ?? "";
    const userIdQuery = c.req.query("userId")?.trim() ?? "";
    if ((!email && !handle && !userIdQuery) || email.length > 320 || handle.length > 320 || userIdQuery.length > 300) {
      return c.json({ error: "Pass email, handle or userId", code: "invalid_billing_grant" }, 400, PRIVATE);
    }
    await grantOperator(c.req.raw, c.env, "billing-grant.read", userIdQuery ? { kind: "user", id: userIdQuery }
      : email ? { kind: "email", id: email } : { kind: "handle", id: handle });
    const userId = userIdQuery ||
      await authDirectoryUserIdBy(c.env, email ? "email" : "handle", email || handle);
    if (!userId) return c.json({ error: "No registered user", code: "billing_grant_user_not_found" }, 404, PRIVATE);
    const now = new Date().toISOString();
    const [detail, grant, emails] = await Promise.all([
      readPostgresAdminUserDetail(c.env, userId, now),
      repositories(c.env).grants.read(crypto.randomUUID(), userId),
      authDirectoryEmails(c.env, [userId]).catch(() => new Map<string, string>()),
    ]);
    return c.json({
      userId,
      internal: internalAddress(c.env, emails.get(userId) ?? email, await listedInternalAddresses(c.env)),
      email: emails.get(userId) ?? (email || undefined),
      grant,
      rules: { days: BILLING_GRANT_DAYS, perPerson: 1, perUtcDay: BILLING_GRANT_DAILY_LIMIT },
      ownedSpaces: detail.spaces.filter((space) => space.role === "owner").map((space) => ({
        spaceId: space.spaceId, name: space.name, members: space.members, messages: space.messages,
        ...(space.billing ? { billing: space.billing } : {}),
      })),
    }, 200, PRIVATE);
  }));

  /* Give one Space one month of Pro for one piece of feedback. `reference`
     names the feedback (an issue URL, or the email's Message-ID); repeating
     the same call returns the same grant. */
  app.post(BILLING_GRANTS_ROUTE, (c) => jsonErrors(c, async () => {
    const buffer = await readBoundedRequestBody(c.req.raw, MAX_GRANT_REQUEST_BYTES);
    if (buffer === null) return c.json({ error: "Request body is too large", code: "invalid_billing_grant" }, 413, PRIVATE);
    let body: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(new TextDecoder().decode(buffer));
      body = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
    } catch {
      body = {};
    }
    const spaceId = typeof body.spaceId === "string" ? body.spaceId : "";
    const actor = await grantOperator(c.req.raw, c.env, "billing-grant.give", { kind: "space", id: spaceId || "-" });
    // Operator and QA accounts never receive complimentary Pro.
    if (typeof body.userId === "string" && body.userId) {
      const email = (await authDirectoryEmails(c.env, [body.userId])).get(body.userId);
      if (internalAddress(c.env, email, await listedInternalAddresses(c.env))) {
        return c.json({ error: "This is an operator or QA account, not a customer", code: "billing_grant_internal_account" }, 409, PRIVATE);
      }
    }
    try {
      const result = await repositories(c.env).grants.grant({
        requestId: crypto.randomUUID(), userId: body.userId, spaceId: body.spaceId,
        reference: body.reference, reason: body.reason, actor,
      });
      return c.json(result, result.replayed ? 200 : 201, PRIVATE);
    } catch (error) {
      return controlErrorResponse(error);
    }
  }));
}
