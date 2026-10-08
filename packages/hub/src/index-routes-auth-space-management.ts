import { Hono, type Context } from "hono";
import { type AppConnectorCompletionDynamicSource, type UpsertAppConnectorConnectionRequest } from "@xmatrix/protocol";
import { deliveryProven, GITHUB_SIGNATURE } from "./connectors/delivery-proof";
import type { Env } from "./types";
import { daemonStopTargets, issueDaemonStopsForArchivedChannelTree } from "./product-agent-intervention-authority-adapter";
import { armSpaceDeletionClock } from "./space-deletion-clock";
import { checkAppConnection } from "./app-connection-check";
import { appCommand, findAppConnection, listAppConnections, listAppExecutions, upsertAppConnection } from "./apps";
import { schedulerRepository } from "./automations";
import { changeMembership, createSpaceInvite, deleteSpace, getSpace, listSpaceDeletions, restoreSpace } from "./spaces";
import { SpaceControlError } from "@xmatrix/db";
import { buildGitHubAppInstallUrl, describeGitHubInstallation, githubConnectionInstallationIds, resolveAppConnectorCompletionOptions, type AppConnectorConnectionView } from "./app-connectors";
import { githubConnectAuthorizeUrl, githubConnectReturnUrl, githubGrantInstallationIds } from "./github-connect-authorization";
import { dispatchProductChannelAbout } from "./product-agent-mention-authority-adapter";
import { dispatchProductGitHubWebhook } from "./product-github-webhook-authority-adapter";
import { fireGitHubAutomationTriggers } from "./automation-triggers";
import { checkPullRequestClaims } from "./github-claim-check";
import { MAX_INVITE_EMAILS_PER_REQUEST, InviteEmailRequest, AdminInviteEmailRequest, normalizeInviteEmails, signGitHubAppState, verifyGitHubAppState, sendSpaceInviteEmails, requireAuth, requireHumanAuth, requireAdmin, productCommandId, jsonErrors, spaceResponse } from "./index-shared";
import { appOrigin } from "./deployment-origins";

/* The emails and role an invite-email request asks for, or why it is refused. */
function inviteEmailTargets(body: InviteEmailRequest): { emails: string[]; role: string } | { error: string } {
  const emails = normalizeInviteEmails(body.emails);
  if (emails.length === 0) return { error: "At least one valid email is required" };
  if (emails.length > MAX_INVITE_EMAILS_PER_REQUEST) {
    return { error: `At most ${MAX_INVITE_EMAILS_PER_REQUEST} invite emails can be sent per request` };
  }
  const role = body.role && ["admin", "member", "viewer"].includes(body.role) ? body.role : "member";
  return { emails, role };
}

/* Emails the invite an Authority just created, or relays why it was not created. */
/** An invite role the request names, `member` when it names none; anything else is refused. */
function inviteRole(value: unknown): "admin" | "member" | "viewer" {
  const role = value === undefined ? "member" : value;
  if (role !== "admin" && role !== "member" && role !== "viewer") {
    throw new SpaceControlError("invalid_invite_role", 400, "invite role is invalid");
  }
  return role;
}

async function emailCreatedInvite(
  c: Context<{ Bindings: Env }>,
  created: Record<string, unknown>,
  emails: string[],
  body: InviteEmailRequest,
): Promise<Response> {
  if (!created.invite) return c.json({ error: "Failed to create invite" }, 500);
  const invite = created.invite as { token: string; spaceName: string; role: string };
  const inviteUrl = `${appOrigin(c.env)}/spaces/invite/${encodeURIComponent(invite.token)}`;
  const result = await sendSpaceInviteEmails(c.env, emails, {
    inviteUrl,
    spaceName: invite.spaceName,
    role: invite.role,
    workspaceName: body.workspaceName,
    channelCount: body.channelCount,
    messageCount: body.messageCount,
    historyMode: body.historyMode,
  });
  return c.json({ invite: { ...invite, url: inviteUrl }, sent: result.sent, failed: result.failed });
}

/** Spaces the deployment configuration names cannot be deleted from the product. */
function deploymentPinnedSpace(env: Env, spaceId: string): boolean {
  return [env.PLATFORM_ADMIN_SPACE_ID, env.TEST_ENVIRONMENT_ACCESS_SPACE_ID]
    .some((pinned) => typeof pinned === "string" && pinned.trim() === spaceId);
}

/** The Channel and request id a Channel About refresh names; undefined when either is missing or too long. */
async function readLaunchRequest(c: Context): Promise<{ channelId: string; requestId: string } | undefined> {
  const body = (await c.req.json().catch(() => ({}))) as { channelId?: unknown; requestId?: unknown };
  const channelId = typeof body.channelId === "string" ? body.channelId.trim() : "";
  const requestId = typeof body.requestId === "string" ? body.requestId.trim() : "";
  return channelId && channelId.length <= 180 && requestId && requestId.length <= 180
    ? { channelId, requestId }
    : undefined;
}


export function registerIndexRoutesAuthSpaceManagement(app: Hono<{ Bindings: Env }>): void {
  app.post("/api/spaces/:spaceId/channel-about", (c) => jsonErrors(c, async () => {
    const authUser = await requireAuth(c.req.raw, c.env);
    const spaceId = c.req.param("spaceId");
    const launch = await readLaunchRequest(c);
    if (!spaceId || !launch) {
      return c.json({ error: "Channel About requires valid Space, Channel, and request ids" }, 400);
    }
    const { channelId, requestId } = launch;
    const result = await dispatchProductChannelAbout({
      env: c.env,
      spaceId,
      channelId,
      requestId,
      actorUserId: authUser.id,
    });
    // A session already serving the Channel takes the request as its pending refresh.
    if (result.spawned !== 1 && result.coalesced !== 1) {
      return c.json({
        error: result.notices[0] || "Could not start Channel About",
        code: "channel_about_not_started",
      }, 409);
    }
    return c.json({ accepted: true, coalesced: result.coalesced === 1 });
  }));
  app.post("/api/spaces/:spaceId/claims", (c) => jsonErrors(c, async () => {
    const authUser = await requireAuth(c.req.raw, c.env);
    const spaceId = c.req.param("spaceId");
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    const result = await schedulerRepository(c.env).acquireClaim({
      commandId: productCommandId(c.req.raw, "acquire-space-action-claim"),
      spaceId, actorUserId: authUser.id, ...body,
    });
    return c.json(result, result.reused ? 200 : 201);
  }));
  // DELETE releases a claim and PATCH renews it; both name the claim the same way.
  app.on(["DELETE", "PATCH"], "/api/spaces/:spaceId/claims/:claimId", (c) => jsonErrors(c, async () => {
    const authUser = await requireAuth(c.req.raw, c.env);
    const renew = c.req.method === "PATCH";
    const spaceId = c.req.param("spaceId");
    const claimId = c.req.param("claimId");
    const body = renew ? await c.req.json().catch(() => ({})) as Record<string, unknown> : {};
    return c.json(await schedulerRepository(c.env).mutateClaim({
      commandId: productCommandId(c.req.raw, renew ? "renew-space-action-claim" : "release-space-action-claim"),
      spaceId, claimId, actorUserId: authUser.id, ...body,
    }, renew ? "renew" : "release"));
  }));
  app.delete("/api/spaces/:spaceId", (c) => jsonErrors(c, async () => {
    const authUser = requireHumanAuth(await requireAuth(c.req.raw, c.env));
    const spaceId = c.req.param("spaceId");
    if (deploymentPinnedSpace(c.env, spaceId)) {
      return c.json({ error: "This Space is pinned by the deployment and cannot be deleted",
        code: "space_pinned" }, 403);
    }
    const result = await deleteSpace(c.env, {
      commandId: productCommandId(c.req.raw, "domain"),
      actorUserId: authUser.id, at: new Date().toISOString(), spaceId,
    });
    const deletion = result.deletion as { purgeAfter?: unknown } | undefined;
    if (typeof deletion?.purgeAfter !== "string") {
      return c.json({ error: "Space deletion result is invalid" }, 503);
    }
    const stopTargets = daemonStopTargets(result.stopTargets);
    if (stopTargets.length > 0) {
      // PostgreSQL already stopped these Runs; the daemon kills are best-effort.
      c.executionCtx.waitUntil(issueDaemonStopsForArchivedChannelTree({
        env: c.env, actorUserId: authUser.id, rootChannelId: `space-delete:${spaceId}`,
        reason: "The Space was deleted", targets: stopTargets,
      }));
    }
    // Repeating the request returns the scheduled deletion and arms the clock again.
    try {
      await armSpaceDeletionClock(c.env, spaceId, deletion.purgeAfter);
    } catch (error) {
      console.error("Space deletion clock was not armed", {
        spaceId, error: error instanceof Error ? error.message : String(error),
      });
      return c.json({ error: "Space deletion was recorded but its purge is not scheduled yet; retry",
        code: "space_deletion_clock_unavailable", retryable: true }, 503);
    }
    return c.json({ ok: true, deletion });
  }));
  app.post("/api/spaces/:spaceId/restore", (c) => jsonErrors(c, async () => {
    const authUser = requireHumanAuth(await requireAuth(c.req.raw, c.env));
    const spaceId = c.req.param("spaceId");
    await restoreSpace(c.env, {
      commandId: productCommandId(c.req.raw, "domain"),
      actorUserId: authUser.id, at: new Date().toISOString(), spaceId,
    });
    return c.json({ ok: true, spaceId });
  }));
  app.get("/api/space-deletions", (c) => jsonErrors(c, async () => {
    const authUser = requireHumanAuth(await requireAuth(c.req.raw, c.env));
    return c.json({ deletions: await listSpaceDeletions(c.env, authUser.id) },
      200, { "cache-control": "private, no-store" });
  }));
  app.get("/api/spaces/:spaceId/app-connections", (c) => jsonErrors(c, async () => {
    const authUser = await requireAuth(c.req.raw, c.env);
    const channelId = c.req.query("channelId")?.trim();
    return c.json({ connections: await listAppConnections(c.env, { spaceId: c.req.param("spaceId"),
      actorUserId: authUser.id, ...(channelId ? { channelId } : {}) }) });
  }));
  app.get("/api/spaces/:spaceId/app-connections/:providerId/completion", (c) => jsonErrors(c, async () => {
    const authUser = await requireAuth(c.req.raw, c.env);
    const source = c.req.query("source")?.trim() as AppConnectorCompletionDynamicSource | undefined;
    if (source !== "github-organizations" && source !== "github-repositories") {
      return c.json({ error: "Unsupported connector completion source" }, 400);
    }
    const spaceId = c.req.param("spaceId");
    const providerId = c.req.param("providerId").trim().toLowerCase();
    const listed = await listAppConnections(c.env, { spaceId, actorUserId: authUser.id });
    const connection = (listed as unknown as AppConnectorConnectionView[])
      .find((candidate) => candidate.providerId === providerId);
    if (!connection) return c.json({ error: "App connection not found" }, 404);
    try {
      const options = await resolveAppConnectorCompletionOptions(
        c.env, connection, source, c.req.query("parent")?.trim(),
      );
      return c.json({ source, options });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : "Connector completion failed" }, 409);
    }
  }));
  app.get("/api/spaces/:spaceId/app-executions", (c) => jsonErrors(c, async () => {
    const authUser = await requireAuth(c.req.raw, c.env);
    return c.json({ executions: await listAppExecutions(c.env, { spaceId: c.req.param("spaceId"),
      actorUserId: authUser.id }) });
  }));
  app.get("/api/apps/github/install", (c) => jsonErrors(c, async () => {
    const authUser = await requireAuth(c.req.raw, c.env);
    const spaceId = c.req.query("spaceId")?.trim();
    const modeQuery = c.req.query("mode")?.trim();
    const requestedInstallationId = c.req.query("installationId")?.trim();
    if (!spaceId) {
      return c.json({ error: "spaceId is required" }, 400);
    }
    // Connect needs the App's whole identity; a partial one is a deployment
    // error named here, never one worked around.
    const missing = (["GITHUB_APP_ID", "GITHUB_APP_CLIENT_ID", "GITHUB_APP_CLIENT_SECRET",
      "GITHUB_APP_PRIVATE_KEY", "GITHUB_APP_SLUG"] as const).filter((key) => !c.env[key]?.trim());
    if (missing.length > 0) {
      return c.json({ error: `GitHub App is not configured: ${missing.join(", ")} unset` }, 503);
    }
    const clientSecret = c.env.GITHUB_APP_CLIENT_SECRET!.trim();
    const appSlug = c.env.GITHUB_APP_SLUG!.trim();

    await getSpace(c.env, { spaceId, principal: { kind: "user", id: authUser.id } });

    // install/add authorize on GitHub, which shows which installations the
    // person reaches; mode=account opens GitHub's install page for a new
    // account; mode=manage opens one linked installation's settings.
    let mode: "add" | "manage" | "install" | "account" =
      modeQuery === "add" || modeQuery === "manage" || modeQuery === "install" || modeQuery === "account"
        ? modeQuery : "install";
    let installationId: string | undefined = requestedInstallationId || undefined;

    const listedConnections = await listAppConnections(c.env, { spaceId, actorUserId: authUser.id })
      .catch(() => null);
    if (listedConnections) {
      const connections = listedConnections as Array<
        { providerId?: string; status?: string; metadata?: Record<string, unknown> }
      >;
      const githubConnection = connections.find(
        (connection) => connection.providerId === "github"
      );
      // A disconnected connection has nothing to manage: Connect installs anew.
      const retainedIds = githubConnection && githubConnection.status !== "disconnected"
        ? githubConnectionInstallationIds(githubConnection)
        : [];
      if (!modeQuery) {
        mode = retainedIds.length > 0 ? "manage" : "install";
      }
      if (mode === "manage") {
        if (installationId && !retainedIds.includes(installationId)) {
          return c.json({ error: "installationId is not linked to this space" }, 400);
        }
        if (!installationId) {
          installationId = retainedIds[0];
        }
      }
      if (mode !== "manage") {
        installationId = undefined;
      }
    } else if (mode === "manage" && !installationId) {
      return c.json({ error: "No GitHub installation is available to manage" }, 409);
    }
    if (mode === "install" || mode === "add") {
      return c.json({ url: await githubConnectAuthorizeUrl(c.env, { spaceId, userId: authUser.id }), mode });
    }

    const state = await signGitHubAppState(
      {
        spaceId,
        userId: authUser.id,
        nonce: crypto.randomUUID(),
        expiresAt: Date.now() + 10 * 60_000,
      },
      clientSecret
    );
    const install = await buildGitHubAppInstallUrl(c.env, {
      appSlug,
      state,
      mode: mode === "account" ? "add" : mode,
      installationId,
    });
    return c.json({ url: install.url, mode });
  }));
  app.get("/api/apps/github/setup", async (c) => {
    const clientSecret = c.env.GITHUB_APP_CLIENT_SECRET?.trim();
    if (!clientSecret) {
      return c.json({ error: "GitHub App callback is not configured" }, 503);
    }
    try {
      const state = c.req.query("state") || "";
      const installationId = c.req.query("installation_id") || "";
      const setupAction = c.req.query("setup_action") || "";
      const payload = await verifyGitHubAppState(state, clientSecret);
      // Only an install state: a connect state or a grant is never one.
      if (payload && "purpose" in payload) return c.redirect(githubConnectReturnUrl(c.env, "failed"), 302);
      const spaceId = typeof payload?.spaceId === "string" ? payload.spaceId : "";
      const userId = typeof payload?.userId === "string" ? payload.userId : "";
      if (!spaceId || !userId) {
        return c.redirect(githubConnectReturnUrl(c.env, "failed"), 302);
      }
      const appsRedirect = (status: "failed" | "cancelled" | "pending") =>
        githubConnectReturnUrl(c.env, status, { spaceId });
      if (setupAction === "request") {
        return c.redirect(appsRedirect("pending"), 302);
      }
      if (setupAction !== "install" && setupAction !== "update") {
        return c.redirect(appsRedirect("cancelled"), 302);
      }
      if (!installationId) {
        return c.redirect(appsRedirect("failed"), 302);
      }
      // installation_id arrives unsigned and can name anyone's installation:
      // the person who installed it proves on GitHub that they reach it.
      return c.redirect(await githubConnectAuthorizeUrl(c.env, { spaceId, userId,
        installation: { id: installationId, setupAction } }), 302);
    } catch {
      return c.redirect(githubConnectReturnUrl(c.env, "failed"), 302);
    }
  });
  app.post("/api/apps/github/webhook", async (c) => {
    const secret = c.env.GITHUB_WEBHOOK_SECRET?.trim();
    if (!secret) {
      return c.json({ error: "GitHub webhook is not configured" }, 503);
    }
    const body = await c.req.text();
    if (!await deliveryProven(GITHUB_SIGNATURE, c.req.raw.headers, body, secret)) {
      return c.json({ error: "Invalid GitHub webhook signature" }, 401);
    }
    const event = c.req.header("x-github-event") || "unknown";
    const delivery = c.req.header("x-github-delivery") || crypto.randomUUID();
    let payload: unknown;
    try {
      payload = JSON.parse(body || "{}");
    } catch {
      return c.json({ error: "Invalid GitHub webhook JSON" }, 400);
    }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return c.json({ error: "Invalid GitHub webhook payload" }, 400);
    }
    if (event === "pull_request") {
      // The claim check is the Space's own verdict on its pull requests; a
      // failure here must not lose the delivery to subscribed conversations.
      await checkPullRequestClaims(c.env, payload as Record<string, unknown>)
        .catch((error: unknown) => console.error("claim check failed", error));
    }
    // Page Automations this event fires (pages-live-document.md §6.2); like the
    // claim check, a failure must not lose the delivery to conversations.
    await fireGitHubAutomationTriggers(c.env, event, payload as Record<string, unknown>)
      .catch((error: unknown) => console.error("Automation triggers failed", error));
    return c.json(await dispatchProductGitHubWebhook({
      env: c.env,
      event,
      delivery,
      payload: payload as Record<string, unknown>,
    }));
  });
  app.patch("/api/spaces/:spaceId/app-connections/:providerId", (c) => jsonErrors(c, async () => {
    const authUser = await requireAuth(c.req.raw, c.env);
    const body = (await c.req.json().catch(() => ({}))) as UpsertAppConnectorConnectionRequest;
    // Only a passed check makes a connection Connected (app-connection-check.ts);
    // GitHub's is set by its own install callback, which alone may link an
    // installation, after proving the installing admin can reach it.
    const providerId = c.req.param("providerId").trim().toLowerCase();
    if (body && typeof body === "object" && "metadataAppend" in body) {
      // Appending installations belongs to the install callback alone.
      return c.json({ error: "metadataAppend is not accepted here" }, 400);
    }
    if (providerId !== "github" && body.status !== "disconnected" && body.status !== "error") {
      return c.json({ error: "Save the app's credentials and check it to connect" }, 400);
    }
    if (providerId === "github" && body.status === "disconnected") {
      // Disconnect forgets the linked installations, so the next Connect
      // authorizes on GitHub again instead of reviving the old ones by a check.
      const stored = await findAppConnection(c.env, { spaceId: c.req.param("spaceId"), providerId: "github",
        actorUserId: authUser.id });
      const { installationId: _installationId, installationIds: _installationIds, ...kept } =
        (stored?.metadata ?? {}) as Record<string, unknown>;
      body.metadata = kept;
    } else if (providerId === "github" && body.metadata !== undefined) {
      // Configure may send the stored installations back, never different ones.
      const stored = await findAppConnection(c.env, { spaceId: c.req.param("spaceId"), providerId: "github",
        actorUserId: authUser.id });
      const storedIds = new Set(stored ? githubConnectionInstallationIds(stored) : []);
      const sentIds = new Set(githubConnectionInstallationIds({ metadata: body.metadata as Record<string, unknown> }));
      if (sentIds.size !== storedIds.size || [...sentIds].some((id) => !storedIds.has(id))) {
        return c.json({ error: "GitHub installations are linked only by installing the GitHub App" }, 400);
      }
    }
    return c.json(await upsertAppConnection(c.env, {
      commandId: productCommandId(c.req.raw, "upsert-app-connection"),
      spaceId: c.req.param("spaceId"), providerId: c.req.param("providerId"), actorUserId: authUser.id,
      body: body as unknown as Record<string, unknown>,
    }));
  }));
  // The GitHub accounts list: the installations this Space links, and, after
  // Connect authorized on GitHub, the ones that person reaches and may link.
  app.get("/api/spaces/:spaceId/app-connections/github/installations", (c) => jsonErrors(c, async () => {
    const authUser = await requireAuth(c.req.raw, c.env);
    const spaceId = c.req.param("spaceId");
    const stored = await findAppConnection(c.env, { spaceId, providerId: "github", actorUserId: authUser.id });
    const linkedIds = stored && stored.status !== "disconnected" ? githubConnectionInstallationIds(stored) : [];
    const describe = async (installationId: string) =>
      await describeGitHubInstallation(c.env, installationId).catch(() => undefined);
    const linked = await Promise.all(linkedIds.map(async (installationId) => await describe(installationId)
      ?? { installationId, login: `Installation ${installationId}`, type: "Unavailable" }));
    const granted = await githubGrantInstallationIds(c.env, c.req.query("grant")?.trim(),
      { spaceId, userId: authUser.id });
    const available = (await Promise.all((granted ?? [])
      .filter((installationId) => !linkedIds.includes(installationId))
      .map(describe))).filter((account) => account !== undefined);
    return c.json({ linked, available, authorized: granted !== undefined },
      200, { "cache-control": "private, no-store" });
  }));
  app.post("/api/spaces/:spaceId/app-connections/github/installations", (c) => jsonErrors(c, async () => {
    const authUser = await requireAuth(c.req.raw, c.env);
    const spaceId = c.req.param("spaceId");
    const body = await c.req.json().catch(() => ({})) as { installationId?: unknown; grant?: unknown };
    const installationId = typeof body.installationId === "string" ? body.installationId.trim() : "";
    if (!/^[1-9][0-9]{0,19}$/u.test(installationId)) {
      return c.json({ error: "installationId is invalid" }, 400);
    }
    // The grant is this person's own authorization on GitHub for this Space:
    // only an installation it names is linked.
    const granted = await githubGrantInstallationIds(c.env,
      typeof body.grant === "string" ? body.grant.trim() : undefined, { spaceId, userId: authUser.id });
    if (!granted) return c.json({ error: "Connect GitHub again to choose accounts" }, 409);
    if (!granted.includes(installationId)) {
      return c.json({ error: "Your GitHub account cannot reach this installation" }, 403);
    }
    if (!await linkGitHubInstallation(c.env, spaceId, authUser.id, installationId)) {
      return c.json({ error: "GitHub installation could not be linked" }, 409);
    }
    return c.json({ connection: await findAppConnection(c.env, { spaceId, providerId: "github",
      actorUserId: authUser.id }) });
  }));
  app.delete("/api/spaces/:spaceId/app-connections/github/installations/:installationId", (c) =>
    jsonErrors(c, async () => {
      const authUser = await requireAuth(c.req.raw, c.env);
      const spaceId = c.req.param("spaceId");
      const installationId = c.req.param("installationId").trim();
      const stored = await findAppConnection(c.env, { spaceId, providerId: "github", actorUserId: authUser.id });
      const linkedIds = stored ? githubConnectionInstallationIds(stored) : [];
      if (!stored || !linkedIds.includes(installationId)) {
        return c.json({ error: "installationId is not linked to this space" }, 404);
      }
      // Unlinking only forgets the installation here; it stays installed on GitHub.
      const remaining = linkedIds.filter((id) => id !== installationId);
      const { installationId: _installationId, installationIds: _installationIds, ...kept } =
        (stored.metadata ?? {}) as Record<string, unknown>;
      return c.json(await upsertAppConnection(c.env, {
        commandId: productCommandId(c.req.raw, "unlink-github-installation"),
        spaceId, providerId: "github", actorUserId: authUser.id,
        body: {
          providerId: "github",
          metadata: remaining.length > 0 ? { ...kept, installationIds: remaining } : kept,
          ...(remaining.length > 0 ? {} : { status: "disconnected" }),
        },
      }));
    }));
  app.post("/api/spaces/:spaceId/app-connections/:providerId/check", (c) => jsonErrors(c, async () => {
    const authUser = await requireAuth(c.req.raw, c.env);
    return c.json(await checkAppConnection(c.env, { spaceId: c.req.param("spaceId"),
      providerId: c.req.param("providerId"), userId: authUser.id,
      commandId: productCommandId(c.req.raw, "finalize-app-connection-check") }));
  }));
  app.delete("/api/spaces/:spaceId/app-connections/:providerId", (c) => jsonErrors(c, async () => {
    const authUser = await requireAuth(c.req.raw, c.env);
    return c.json(await appCommand(c.env, "delete", {
      commandId: productCommandId(c.req.raw, "delete-app-connection"),
      spaceId: c.req.param("spaceId"), providerId: c.req.param("providerId"),
      principal: { kind: "user", id: authUser.id },
    }));
  }));
  app.post("/api/spaces/:spaceId/members", (c) => jsonErrors(c, async () => {
    const authUser = await requireAuth(c.req.raw, c.env);
    const body = await c.req.json().catch(() => ({})) as { userId?: unknown; role?: unknown; email?: unknown; name?: unknown; avatarUrl?: unknown };
    if (typeof body.userId !== "string" || !body.userId.trim()) {
      return c.json({ error: "userId is required" }, 400);
    }
    const role = body.role ?? "member";
    if (role !== "admin" && role !== "member" && role !== "viewer" && role !== "participant") {
      return c.json({ error: "role is invalid", code: "invalid_command" }, 400);
    }
    await changeMembership(c.env, {
      commandId: productCommandId(c.req.raw, "domain", `space-member-put:${c.req.param("spaceId")}:${body.userId}`),
      actorUserId: authUser.id, at: new Date().toISOString(), kind: "space_member_put",
      spaceId: c.req.param("spaceId"), userId: body.userId.trim(), role,
      ...(typeof body.email === "string" ? { email: body.email } : {}),
      ...(typeof body.name === "string" ? { name: body.name } : {}),
      ...(typeof body.avatarUrl === "string" ? { avatarUrl: body.avatarUrl } : {}),
    });
    return spaceResponse(c, c.req.param("spaceId"), authUser.id);
  }));
  app.delete("/api/spaces/:spaceId/members/:userId", (c) => jsonErrors(c, async () => {
    const authUser = await requireAuth(c.req.raw, c.env);
    await changeMembership(c.env, {
      commandId: productCommandId(c.req.raw, "domain",
        `space-member-remove:${c.req.param("spaceId")}:${c.req.param("userId")}`),
      actorUserId: authUser.id, at: new Date().toISOString(), kind: "space_member_remove",
      spaceId: c.req.param("spaceId"), userId: c.req.param("userId"),
    });
    return spaceResponse(c, c.req.param("spaceId"), authUser.id);
  }));
  app.post("/api/spaces/:spaceId/invites", (c) => jsonErrors(c, async () => {
    const authUser = await requireAuth(c.req.raw, c.env);
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    return c.json(await createSpaceInvite(c.env, {
      commandId: productCommandId(c.req.raw, "create-space-invite"),
      spaceId: c.req.param("spaceId"), actorUserId: authUser.id, role: inviteRole(body.role), admin: false,
      ...(body.expiresInHours === undefined ? {} : { expiresInHours: Number(body.expiresInHours) }),
      maxUses: body.maxUses === undefined || body.maxUses === null ? 1
        : body.maxUses === "unlimited" ? null : Number(body.maxUses),
      requiresApproval: body.requiresApproval === true,
    }));
  }));
  app.post("/api/spaces/:spaceId/invite-emails", (c) => jsonErrors(c, async () => {
    const authUser = await requireAuth(c.req.raw, c.env);
    const body = (await c.req.json().catch(() => ({}))) as InviteEmailRequest;
    const targets = inviteEmailTargets(body);
    if ("error" in targets) return c.json({ error: targets.error }, 400);
    const { emails, role } = targets;
    const created = await createSpaceInvite(c.env, {
      commandId: productCommandId(c.req.raw, "create-space-invite"),
      spaceId: c.req.param("spaceId"), actorUserId: authUser.id, role: inviteRole(role), admin: false,
      maxUses: 1, requiresApproval: false,
    });
    return await emailCreatedInvite(c, created, emails, body);
  }));
  app.post("/api/admin/space-invite-emails", (c) => jsonErrors(c, async () => {
    requireAdmin(c.req.raw, c.env);
    const body = (await c.req.json().catch(() => ({}))) as AdminInviteEmailRequest;
    const targets = inviteEmailTargets(body);
    if ("error" in targets) return c.json({ error: targets.error }, 400);
    const { emails, role } = targets;
    if (!body.spaceId) {
      return c.json({ error: "spaceId is required after Relay authority activation" }, 400);
    }
    const created = await createSpaceInvite(c.env, {
      commandId: productCommandId(c.req.raw, "create-space-invite"),
      spaceId: body.spaceId, actorUserId: `admin:${body.spaceId}`, role: inviteRole(role), admin: true,
      maxUses: 1, requiresApproval: false,
    });
    return await emailCreatedInvite(c, created, emails, body);
  }));
}

/**
 * Links one installation the user has already proven they can reach. Shared by
 * the install callback and Configure's Link, so both keep the same contract.
 */
export async function linkGitHubInstallation(
  env: Env, spaceId: string, userId: string, installationId: string
): Promise<boolean> {
  // Merge, never replace: the installation is appended to the stored list under
  // the connection's row lock, so a second org or "Manage access" keeps the
  // other installations, default repository and channel/write config. Only set
  // baseline scopes on the first successful connection.
  let hasExistingConnection = false;
  let reconnectMetadata: Record<string, unknown> | undefined;
  const listedExisting = await listAppConnections(env, { spaceId, actorUserId: userId })
    .catch(() => null);
  if (listedExisting) {
    const existingConnections = listedExisting as Array<
      { providerId?: string; status?: string; scopes?: string[]; metadata?: Record<string, unknown> }
    >;
    const existingGithub = existingConnections.find(
      (connection) => connection.providerId === "github"
    );
    // A reconnect after Disconnect keeps the scopes chosen before it.
    hasExistingConnection = Boolean(
      existingGithub && (githubConnectionInstallationIds(existingGithub).length > 0 ||
        (existingGithub.scopes?.length ?? 0) > 0)
    );
    if (existingGithub?.status === "disconnected") {
      // Reconnecting replaces the installations a disconnect left behind
      // rather than appending to them.
      const { installationId: _installationId, installationIds: _installationIds, ...kept } =
        existingGithub.metadata ?? {};
      reconnectMetadata = kept;
    }
  }

  const body: UpsertAppConnectorConnectionRequest = {
    providerId: "github",
    providerName: "GitHub",
    status: "configured",
    authMode: "oauth",
    secretRefs: [
      "GITHUB_APP_ID",
      "GITHUB_APP_CLIENT_ID",
      "GITHUB_APP_CLIENT_SECRET",
      "GITHUB_APP_PRIVATE_KEY",
      "GITHUB_WEBHOOK_SECRET",
    ],
  };
  if (!hasExistingConnection) {
    body.scopes = ["metadata:read", "issues:read"];
    body.capabilities = ["github.metadata.read", "github.issues.read"];
  }
  if (reconnectMetadata) body.metadata = reconnectMetadata;

  return upsertAppConnection(env, {
    // The append is idempotent itself; a fresh command id keeps a repeated
    // link (whose body differs once a connection exists) from a replay mismatch.
    commandId: `github-setup:${crypto.randomUUID()}`,
    spaceId, providerId: "github", actorUserId: userId,
    body: { ...body, metadataAppend: { installationIds: installationId } } as unknown as Record<string, unknown>,
  }).then(() => true, () => false);
}
