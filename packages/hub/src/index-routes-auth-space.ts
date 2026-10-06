import type { Context, Hono } from "hono";
import { relayResponse } from "./private-response";
import { crossSpaceRetryOwner } from "./cross-space-read";
import { agentRunDelegationDenied } from "./agent-run-channel-delegation";
import {
  relayRuntimeCellNamed,
  relayRuntimeOwnerCellName,
  relayRuntimeSingleCell,
} from "./relay-authority-locator";
import { HUB_ROUTES, REPOSITORY_ACCESS_UNAVAILABLE, deriveHumanConnectionUrl, githubRepositoryReference, repositoryAccessUnavailableDetail, stableMachineDaemonId, withMachineSpawnHarness, hasControlCharacter } from "@xmatrix/protocol";
import { launchTargetRepos } from "./launch-target-repositories";
import type { Env } from "./types";
import { platformAdminForRequest, testEnvironmentForRequest } from "./index-routes-admin";
import { recordAgentLaunchStage } from "./postgres-observability";
import { mintGitHubRepositoryToken } from "./app-connectors";
import { listOwnerWorkspaces, workspaceRepository } from "./postgres-workspace-authority";
import { listOwnerMachineDaemons, machineDaemonCommand, machineDatabase, machineRepository } from "./machines";
import { updateAgentLaunch } from "./runtime";
import { adoptLegacyMachineIds } from "@xmatrix/db";
import { hasBetterAuthConfig, mockAuthUserForToken, readBearerToken, verifyAuthToken, type AuthSession, type AuthUser } from "./auth";
import { betterAuthHandlerErrorResponse, betterAuthRouteErrorStatus, createAuth, createBetterAuthSessionForUser, refreshBetterAuthSession, sendBetterAuthLoginOtp, verifyBetterAuthEmailOtp } from "./better-auth";
import { EMAIL_DELIVERY_CONFIGURATION_ERROR, EmailDeliveryConfigurationError, loginEmailErrorLog } from "./email-delivery";
import { logAuthMetric } from "./auth-observability";
import { SESSION_EXCHANGE_USER_MISMATCH } from "./auth-errors";
import { isTransientBetterAuthStatus } from "./better-auth-error-policy";
import { machineHostnameObservation } from "./machine-hostname-observation";
import { signMachineDaemonCredential } from "./connections/machine-daemon/auth";
import { applyMachineDaemonSpawnLaunchResult, dispatchMachineDaemonRunLifecycleReplica, machineSpawnRegistryEvidenceMatches } from "./index-routes-machine-daemon-admission";
import { RELAY_RUNTIME_MACHINE_DAEMON_WAIT_PATH } from "./runtime-transport/relay-runtime-product-adapter";
import { LOGIN_RATE_LIMIT_PER_EMAIL, LOGIN_RATE_LIMIT_PER_CLIENT, hubOrigin, betterAuthRouteGroup, logBetterAuthHandlerMetrics, authCorsPreflight, withAuthCors, parseCliRedirectUri, requireAuth, requireMachineDaemonAuth, machineRouteIdentityMatches, appendMachinePrincipal, requireHumanAuth, requestErrorStatus, productCommandId, clientKey, internalClientHeaders, isLoginRateLimited, getDeviceAuthBroker, jsonErrors, requestErrorResponse, machineDaemonControl } from "./index-shared";
import { appOrigin } from "./deployment-origins";
import { registerIndexRoutesAuthSpaceInstances } from "./index-routes-auth-space-instances";
import { registerIndexRoutesAuthSpaceManagement } from "./index-routes-auth-space-management";
import { registerMachineExecutionRoutes } from "./index-routes-machine-executions";
import { registerReplyRecoveryRoutes } from "./index-routes-reply-recovery";
import { wakeAgentLaunchCoordinator } from "./agent-launch-coordinator-wake";
import { getAppConnection } from "./apps";
import { getChannel, getSpace } from "./spaces";

/** Records each successful-session metric, then hands the client its session and endpoints. */
async function issuedSessionResponse(
  c: Context<{ Bindings: Env }>,
  session: AuthSession,
  metrics: readonly { routeGroup: string; outcome: string }[],
): Promise<Response> {
  for (const metric of metrics) {
    await logAuthMetric({
      ...metric,
      status: 200,
      authProvider: session.authProvider,
      userId: session.user.id,
    });
  }
  return c.json({
    token: session.token,
    refreshToken: session.refreshToken,
    authProvider: session.authProvider,
    user: session.user,
    hubUrl: hubOrigin(c.req.raw),
    relayUrl: deriveHumanConnectionUrl(c.req.url),
  });
}

/** A daemon poll names its machine; the credential must belong to that machine. */
async function machineDaemonPoll(c: Context<{ Bindings: Env }>, internalPath: string) {
  const principal = await requireMachineDaemonAuth(c.req.raw, c.env);
  const internalUrl = new URL(internalPath, c.req.url);
  const requestUrl = new URL(c.req.url);
  const machineId = requestUrl.searchParams.get("machineId");
  const hostId = requestUrl.searchParams.get("hostId");
  if (!machineRouteIdentityMatches(principal, { machineId, hostId })) {
    return c.json({ error: "Machine Daemon credential does not match requested machine" }, 403);
  }
  appendMachinePrincipal(internalUrl, principal);
  return {
    principal,
    internalUrl,
    requestUrl,
    connectionEpoch: Number(requestUrl.searchParams.get("connectionEpoch")),
  };
}

async function deviceAuthResponse(c: Context<{ Bindings: Env }>, action: "start" | "approve" | "token",
  authorization?: string): Promise<Response> {
  const internalUrl = new URL(`/internal/device-auth/${action}`, c.req.url);
  const response = await getDeviceAuthBroker(c.env).fetch(new Request(internalUrl.toString(), {
    method: "POST", headers: internalClientHeaders(c.req.raw, authorization ? { authorization } : undefined),
    ...(action === "start" ? {} : { body: await c.req.text() }),
  }));
  return relayResponse(response, { "cache-control": "no-store" });
}

function machineObservations(c: Context<{ Bindings: Env }>, body: Parameters<typeof machineHostnameObservation>[0]) {
  try {
    return machineHostnameObservation(body);
  } catch (error) {
    return c.json({ error: (error as Error).message }, 400);
  }
}

export function registerIndexRoutesAuthSpace(app: Hono<{ Bindings: Env }>): void {
  registerMachineExecutionRoutes(app);
  registerReplyRecoveryRoutes(app);
  app.get("/", (c) => {
    const versionId = c.env.CF_VERSION_METADATA?.id?.trim() || null;
    const tag = c.env.CF_VERSION_METADATA?.tag?.trim() || "";
    return c.json({
      status: "ok",
      service: "xmatrix-hub",
      version: "0.6.0",
      deployment: {
        versionId,
        revision: /^[0-9a-f]{40}$/u.test(tag) ? tag : null,
      },
      hubUrl: hubOrigin(c.req.raw),
      relayUrl: deriveHumanConnectionUrl(c.req.url),
    });
  });
  app.get(HUB_ROUTES.login, (c) => {
    const redirectUrl = parseCliRedirectUri(c.req.query("redirect_uri") ?? null);
    if (!redirectUrl) {
      return c.json({ error: "A valid loopback redirect_uri is required" }, 400);
    }

    const state = c.req.query("state") || crypto.randomUUID();
    const loginUrl = new URL("/login", appOrigin(c.env));
    loginUrl.searchParams.set("cli_callback", redirectUrl.toString());
    loginUrl.searchParams.set("cli_state", state);
    loginUrl.searchParams.set("cli_hub", hubOrigin(c.req.raw));

    return c.redirect(loginUrl.toString(), 302);
  });
  app.post(HUB_ROUTES.login, async (c) => {
    const body = (await c.req
      .json<{ email?: string; name?: string }>()
      .catch(() => ({}))) as { email?: string; name?: string };
    const email = body.email?.trim();

    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      await logAuthMetric({ routeGroup: "login_code_send", status: 400, outcome: "bad_email" });
      return c.json({ error: "A valid email is required" }, 400);
    }

    const client = clientKey(c.req.raw);
    if (
      isLoginRateLimited(`login:client:${client}`, LOGIN_RATE_LIMIT_PER_CLIENT) ||
      isLoginRateLimited(`login:email:${email.toLowerCase()}`, LOGIN_RATE_LIMIT_PER_EMAIL)
    ) {
      await logAuthMetric({ routeGroup: "login_code_send", status: 429, outcome: "rate_limited" });
      return c.json({ error: "Too many login attempts. Try again later." }, 429);
    }

    try {
      await sendBetterAuthLoginOtp(c.env, email);
    } catch (error) {
      console.error("Failed to send login code", {
        routeGroup: "login_code_send",
        authProvider: "better-auth",
        error: loginEmailErrorLog(error),
      });
      if (error instanceof EmailDeliveryConfigurationError) {
        await logAuthMetric({
          routeGroup: "login_code_send",
          status: 503,
          outcome: EMAIL_DELIVERY_CONFIGURATION_ERROR,
          authProvider: "better-auth",
        });
        return c.json(
          {
            error: "Email delivery is not configured for login codes.",
            code: EMAIL_DELIVERY_CONFIGURATION_ERROR,
          },
          503
        );
      }
      const status = betterAuthRouteErrorStatus(error);
      await logAuthMetric({
        routeGroup: "login_code_send",
        status,
        outcome: isTransientBetterAuthStatus(status) ? "temporarily_unavailable" : "failed",
        authProvider: "better-auth",
      });
      return c.json(
        {
          error: status >= 500
            ? "Email delivery is temporarily unavailable."
            : "Failed to send login code",
        },
        status,
      );
    }

    await logAuthMetric({
      routeGroup: "login_code_send",
      status: 200,
      outcome: "sent",
      authProvider: "better-auth",
    });
    return c.json({ success: true, message: "Check your email for the verification code" });
  });
  app.post(HUB_ROUTES.device_start, async (c) => deviceAuthResponse(c, "start"));
  app.post(HUB_ROUTES.device_approve, async (c) => {
    const authorization = c.req.header("authorization");
    if (!readBearerToken(authorization)) {
      await logAuthMetric({ routeGroup: "device_approve", status: 401, outcome: "missing_token" });
      return c.json({ error: "Missing bearer token" }, 401);
    }

    return deviceAuthResponse(c, "approve", authorization);
  });
  app.post(HUB_ROUTES.device_token, async (c) => deviceAuthResponse(c, "token"));

  app.post(HUB_ROUTES.exchange_session, async (c) => {
    const token = readBearerToken(c.req.header("authorization"));
    if (!token) {
      await logAuthMetric({ routeGroup: "exchange_session", status: 401, outcome: "missing_token" });
      return c.json({ error: "Missing bearer token" }, 401);
    }

    let authUser: AuthUser;
    try {
      authUser = await verifyAuthToken(token, c.env);
    } catch (error) {
      const status = requestErrorStatus(error);
      await logAuthMetric({ routeGroup: "exchange_session", status, outcome: "invalid_token" });
      return c.json({ error: (error as Error).message }, status);
    }

    if (mockAuthUserForToken(token, c.env)) {
      await logAuthMetric({
        routeGroup: "session_created",
        status: 200,
        outcome: "exchange_session",
        authProvider: "mock",
        userId: authUser.id,
      });
      return c.json({
        token,
        authProvider: "mock",
        user: authUser,
        hubUrl: hubOrigin(c.req.raw),
        relayUrl: deriveHumanConnectionUrl(c.req.url),
      });
    }

    try {
      const session = await createBetterAuthSessionForUser(c.env, authUser);
      return await issuedSessionResponse(c, session, [
        { routeGroup: "session_created", outcome: "exchange_session" },
      ]);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to exchange session";
      console.error("Failed to exchange CLI session", {
        routeGroup: "exchange_session",
        error: message,
      });
      if (message === SESSION_EXCHANGE_USER_MISMATCH) {
        await logAuthMetric({
          routeGroup: "exchange_session",
          status: 409,
          outcome: "session_exchange_user_mismatch",
          userId: authUser.id,
        });
        return c.json({ error: message }, 409);
      }
      await logAuthMetric({
        routeGroup: "exchange_session",
        status: 500,
        outcome: "session_create_failed",
        userId: authUser.id,
      });
      return c.json({ error: "Failed to exchange session" }, 500);
    }
  });
  app.post(HUB_ROUTES.otp_verify, async (c) => {
    const body = (await c.req
      .json<{ email?: string; token?: string }>()
      .catch(() => ({}))) as { email?: string; token?: string };
    const email = body.email?.trim();
    const token = body.token?.trim();

    if (!email || !token) {
      await logAuthMetric({ routeGroup: "otp_verify", status: 400, outcome: "bad_request" });
      return c.json({ error: "Email and OTP token are required" }, 400);
    }

    try {
      const session = await verifyBetterAuthEmailOtp(c.env, email, token);
      return await issuedSessionResponse(c, session, [
        { routeGroup: "session_created", outcome: "otp_verify" },
        { routeGroup: "otp_verify", outcome: "verified" },
      ]);
    } catch (error) {
      const message = (error as Error).message || "";
      const status = betterAuthRouteErrorStatus(error, 401);
      const transient = isTransientBetterAuthStatus(status);
      await logAuthMetric({
        routeGroup: "otp_verify",
        status,
        outcome: transient ? "temporarily_unavailable" : "invalid_code",
        authProvider: "better-auth",
      });
      return c.json(
        {
          error: transient
            ? "Authentication service is temporarily unavailable."
            : message || "Invalid verification code",
        },
        status,
      );
    }
  });
  app.post(HUB_ROUTES.refresh, async (c) => {
    const body = (await c.req
      .json<{ refreshToken?: string }>()
      .catch(() => ({}))) as { refreshToken?: string };
    const refreshToken = body.refreshToken?.trim();

    if (!refreshToken) {
      await logAuthMetric({ routeGroup: "refresh", status: 400, outcome: "bad_request" });
      return c.json({ error: "Refresh token is required" }, 400);
    }

    try {
      const session = await refreshBetterAuthSession(c.env, refreshToken);
      return await issuedSessionResponse(c, session, [
        { routeGroup: "session_reused", outcome: "refresh" },
      ]);
    } catch (error) {
      const status = betterAuthRouteErrorStatus(error, 401);
      const transient = isTransientBetterAuthStatus(status);
      await logAuthMetric({
        routeGroup: "refresh",
        status,
        outcome: transient ? "temporarily_unavailable" : "invalid_refresh",
      });
      return c.json(
        {
          error: transient
            ? "Authentication service is temporarily unavailable."
            : (error as Error).message || "Failed to refresh session",
        },
        status,
      );
    }
  });
  app.get(HUB_ROUTES.me, (c) => jsonErrors(c, async () => {
    const authUser = await requireAuth(c.req.raw, c.env);
    const [platformAdmin, testEnvironment] = await Promise.all([
      platformAdminForRequest(authUser, c.env),
      testEnvironmentForRequest(authUser, c.env),
    ]);

    return c.json({
      user: authUser,
      hubUrl: hubOrigin(c.req.raw),
      relayUrl: deriveHumanConnectionUrl(c.req.url),
      // Clients use these only to decide what to offer. Platform-admin
      // routes re-check authority, and Test remains an isolated deployment.
      capabilities: {
        platformAdmin,
        testEnvironment,
      },
    });
  }));
  app.all("/api/auth/*", async (c) => {
    if (c.req.method === "OPTIONS") {
      return authCorsPreflight(c.req.raw, c.env);
    }

    if (!hasBetterAuthConfig(c.env)) {
      await logAuthMetric({
        routeGroup: betterAuthRouteGroup(c.req.path, 503),
        status: 503,
        outcome: "not_configured",
        authProvider: "better-auth",
      });
      return withAuthCors(c.json({ error: "Better Auth is not configured" }, 503), c.req.raw, c.env);
    }
    let response: Response;
    try {
      response = await createAuth(c.env).handler(c.req.raw);
    } catch (error) {
      console.error("Better Auth request failed", {
        routeGroup: betterAuthRouteGroup(c.req.path),
        error: error instanceof Error ? error.message : String(error),
      });
      response = betterAuthHandlerErrorResponse(error);
    }
    await logBetterAuthHandlerMetrics(c.req.path, response);
    return withAuthCors(response, c.req.raw, c.env);
  });
  // agent_instances lives in index-routes-channel-agent (live presence + Authority catalog).
  /**
   * Everything a Space may launch an Agent with, authorized here rather than
   * assembled by the caller. Repos are the Space's: its GitHub connector is
   * what a Run's repository credential is minted from. Registered directories
   * are local paths on a machine and belong to their owner, so they are
   * returned only for the caller's own machines; another member of the Space
   * gets the Space's repos and nothing about that machine's filesystem.
   *
   * An Agent Run reads the catalog its owner would see. Its own Space needs no
   * more than a live Run; another Space needs its owner's Space-wide read grant
   * (docs/cross-space-read-grants.md).
   */
  app.get("/api/spaces/:spaceId/launch-targets", (c) => jsonErrors(c, async () => {
    const authUser = await requireAuth(c.req.raw, c.env);
    const spaceId = c.req.param("spaceId");
    const run = authUser.agentRun;
    if (run) {
      const denied = await agentRunDelegationDenied(c.env, run, []);
      if (denied) return denied;
      if (spaceId !== run.spaceId) {
        const granted = await crossSpaceRetryOwner(c.env, run, { spaceId },
          c.json({ error: "Space not found" }, 404));
        if (granted instanceof Response) return granted;
      }
    }
    const actingUserId = run ? run.ownerUserId : authUser.id;
    // Reading the Space as the actor is the access check.
    await getSpace(c.env, { spaceId, principal: { kind: "user", id: actingUserId } });
    const workspaces = await listOwnerWorkspaces(workspaceRepository(c.env), actingUserId);
    const repos = await launchTargetRepos(c.env, spaceId, actingUserId);
    return c.json(
      { spaceId, ...repos, workspaces },
      200,
      { "cache-control": "private, no-store" },
    );
  }));
  app.get(HUB_ROUTES.machine_daemons, (c) => jsonErrors(c, async () => {
    const authUser = await requireAuth(c.req.raw, c.env);
    // An Agent Run reads its owner's Machines, as the owner would.
    const ownerUserId = authUser.agentRun?.ownerUserId || authUser.id;
    return c.json({ daemons: await listOwnerMachineDaemons(machineRepository(c.env), ownerUserId) });
  }));
  app.post(HUB_ROUTES.machine_daemon_credentials, (c) => jsonErrors(c, async () => {
    const owner = requireHumanAuth(await requireAuth(c.req.raw, c.env));
    const body = (await c.req.json().catch(() => ({}))) as {
      machineId?: unknown;
      hostId?: unknown;
      hostName?: unknown;
      hostname?: unknown;
      legacyMachineIds?: unknown;
    };
    const field = (value: unknown, maxLength: number): string | undefined => {
      const normalized = typeof value === "string" ? value.trim() : "";
      return normalized && normalized.length <= maxLength && !hasControlCharacter(normalized)
        ? normalized
        : undefined;
    };
    const machineId = field(body.machineId, 160);
    if (!machineId) {
      return c.json({ error: "machineId is required and must be a bounded identifier" }, 400);
    }
    const observations = machineObservations(c, body);
    if (observations instanceof Response) return observations;
    const { hostId, hostName, hostname } = observations;
    let adoptedMachineIds: string[] = [];
    if (Array.isArray(body.legacyMachineIds) && body.legacyMachineIds.length) {
      const adopted = await adoptLegacyMachineIds(machineDatabase(c.env), {
        requestId: crypto.randomUUID(), ownerUserId: owner.id, machineId,
        legacyMachineIds: body.legacyMachineIds, daemonId: stableMachineDaemonId,
      });
      adoptedMachineIds = [...adopted.adopted, ...adopted.reused];
    }
    // Idempotency must cover every field that enters the enroll command body.
    // Mutable observations affect replay payloads, but never authorization
    // or the owner + Machine scope of the resulting credential.
    const enrollKey = [
      "enroll",
      owner.id,
      machineId,
      hostId,
      hostName || "",
      hostname || "",
    ].join(":");
    const enrolled = await machineDaemonCommand(c.env, {
      commandId: productCommandId(c.req.raw, "machine-daemon-control", enrollKey),
      action: "enroll",
      ownerUserId: owner.id,
      ownerEmail: owner.email,
      machineId,
      hostId,
      hostName,
      hostname,
      payload: { source: "credential-issuance" },
      metadata: {},
      capabilities: [],
      principal: { kind: "user", id: owner.id },
    });
    const enrolledDaemon = enrolled.daemon;
    if (!enrolledDaemon || typeof enrolledDaemon !== "object" || Array.isArray(enrolledDaemon)) {
      throw new Error("Authority returned an invalid enrolled Machine Daemon");
    }
    const daemon = {
      ...enrolledDaemon as Record<string, unknown>,
      // Enrolled Authority identities have not opened a socket yet, so Authority
      // correctly omits connectedAt. Keep the credential response compatible
      // with released Machine Daemon clients, whose transport model expects a
      // string while using this identity only to start the reconnect actor.
      connectedAt: typeof (enrolledDaemon as Record<string, unknown>).connectedAt === "string"
        ? (enrolledDaemon as Record<string, unknown>).connectedAt
        : "",
    };
    const credential = await signMachineDaemonCredential(c.env, {
      ownerUserId: owner.id,
      ownerEmail: owner.email,
      machineId,
      hostId,
      hostName,
    });
    // Enrollment is enough for the daemon process and reconnect actor to
    // start. Command claims still require the live epoch returned by the
    // authenticated WebSocket handshake.
    return c.json({ credential, expiresInSeconds: 30 * 60, daemon, adoptedMachineIds });
  }));
  app.post(HUB_ROUTES.machine_daemon_migration_fence, (c) => jsonErrors(c, async () => {
    const owner = requireHumanAuth(await requireAuth(c.req.raw, c.env));
    const body = await c.req.json<Record<string, unknown>>();
    const bounded = (value: unknown, max: number) =>
      typeof value === "string" && value.trim() && value.length <= max ? value.trim() : undefined;
    const machineId = bounded(body.machineId, 160);
    const observations = machineObservations(c, body);
    if (observations instanceof Response) return observations;
    const { hostId, hostname } = observations;
    const artifactSha256 = bounded(body.artifactSha256, 64);
    const transactionId = bounded(body.transactionId, 200);
    const transactionNonce = bounded(body.transactionNonce, 512);
    const fence = body.fence === true;
    const sourceConnectionEpoch = body.sourceConnectionEpoch;
    if (!machineId || !artifactSha256 || !transactionId || !transactionNonce ||
        !/^[0-9a-f]{64}$/u.test(artifactSha256) || transactionNonce.length < 32 ||
        (fence && (!Number.isSafeInteger(sourceConnectionEpoch) || Number(sourceConnectionEpoch) < 1))) {
      return c.json({ error: "Bridge migration request is invalid" }, 400);
    }
    return c.json(await machineDaemonCommand(c.env, {
      commandId: productCommandId(
        c.req.raw,
        "machine-daemon-control",
        `${fence ? "migration-fence" : "migration-preflight"}:${transactionId}`,
      ),
      action: fence ? "migration_fence" : "migration_preflight",
      ownerUserId: owner.id,
      ownerEmail: owner.email,
      machineId,
      hostId,
      hostname,
      payload: {
        artifactSha256,
        transactionId,
        transactionNonce,
        ...(fence ? { sourceConnectionEpoch } : {}),
      },
      metadata: {},
      capabilities: [],
      principal: { kind: "user", id: owner.id },
    }));
  }));
  app.get(HUB_ROUTES.machine_daemon_workspaces, (c) => jsonErrors(c, async () => {
    const principal = await requireMachineDaemonAuth(c.req.raw, c.env);
    return c.json({
      workspaces: await listOwnerWorkspaces(workspaceRepository(c.env), principal.ownerUserId),
    });
  }));
  /**
   * A machine asks for Git credentials the moment it needs them, one repository
   * at a time, instead of holding a login of its own. Two Spaces on the same
   * machine therefore get two different grants, each limited to what that
   * Space's GitHub App installation was given.
   *
   * The caller names a channel, never a Space. The daemon takes that channel
   * from the spawn command it was given, so a run cannot reach past the Space
   * it belongs to even when its machine's owner belongs to several.
   */
  app.post(HUB_ROUTES.machine_daemon_github_repository_token, (c) => jsonErrors(c, async () => {
    const principal = await requireMachineDaemonAuth(c.req.raw, c.env);
    const body = await c.req.json().catch(() => ({})) as {
      channelId?: unknown;
      repository?: unknown;
    };
    const channelId = typeof body.channelId === "string" ? body.channelId.trim() : "";
    const repository = typeof body.repository === "string" ? body.repository.trim() : "";
    if (!channelId) return c.json({ error: "channelId is required" }, 400);
    // One shared reader decides what names a GitHub repository, so a spelling
    // the picker offered cannot be one this mint rejects.
    const target = githubRepositoryReference(repository);
    if (!target) return c.json({ error: "repository must be owner/repo" }, 400);

    // The Space is derived here rather than named by the caller. A machine
    // whose owner belongs to several Spaces could otherwise ask for a Space
    // its run has nothing to do with, which is the confusion this whole path
    // exists to remove.
    const { channel } = await getChannel(c.env, { channelId, principal: { kind: "user", id: principal.ownerUserId } });
    const spaceId = (channel as { spaceId?: unknown }).spaceId;
    if (typeof spaceId !== "string" || !spaceId) {
      return c.json({ error: "channel is not bound to a Space" }, 409);
    }

    // This mint is the only gate on a `repo:` Run's repository: no launch
    // pre-check stands in for it. Its refusal names the repository and a
    // stable code the Run's startup failure carries to the Channel.
    const refuse = (reason: string) => c.json({ code: REPOSITORY_ACCESS_UNAVAILABLE,
      error: repositoryAccessUnavailableDetail(`${target.owner}/${target.repo}`, reason) }, 409, { "cache-control": "no-store" });
    // Resolved on every mint, so losing access or disconnecting the connector
    // takes effect immediately instead of at the end of some earlier grant.
    const { connection } = await getAppConnection(c.env, { connectionId: `${spaceId}:github`,
      actorUserId: principal.ownerUserId, allowMissing: true }) as { connection: { status?: unknown } | null };
    if (!connection) return refuse("github_not_connected");
    if (connection.status !== "configured") return refuse("github_connection_not_configured");

    try {
      const grant = await mintGitHubRepositoryToken(
        c.env, connection as any, target.owner, target.repo,
      );
      return c.json(grant, 200, { "cache-control": "no-store" });
    } catch (error) {
      // A repository outside this Space's installation fails here, not later
      // as a confusing Git error on the machine. GitHub's own outage is not
      // an answer about access.
      const reason = error instanceof Error ? error.message : "github_repository_token_failed";
      if (!/^github_[a-z0-9_]{1,80}$/u.test(reason) || /^github_api_(?:429|5\d\d)$/u.test(reason)) {
        return c.json({ error: /^github_[a-z0-9_]{1,80}$/u.test(reason) ? reason : "github_repository_token_failed" },
          503, { "cache-control": "no-store" });
      }
      return refuse(reason);
    }
  }));
  app.get(HUB_ROUTES.daemon_spawn_intents, (c) => jsonErrors(c, async () => {
    const poll = await machineDaemonPoll(c, "/internal/daemon/spawn-intents");
    if (poll instanceof Response) return poll;
    const { principal, connectionEpoch } = poll;
    const claimed = await machineDaemonControl(c.env, principal, {
      commandId: `daemon-claim-spawn:${principal.ownerUserId}:${principal.machineId}:${crypto.randomUUID()}`,
      action: "claim", connectionEpoch, commandTypes: ["spawn"], payload: {},
    });
    return c.json({ intents: ((claimed.commands as Array<{ payload: unknown }> | undefined) || []).map((item) => item.payload) });
  }));
  app.get(HUB_ROUTES.daemon_control, (c) => jsonErrors(c, async () => {
    const poll = await machineDaemonPoll(c, "/internal/daemon/control");
    if (poll instanceof Response) return poll;
    const { principal, internalUrl, requestUrl, connectionEpoch } = poll;
    const waitMs = requestUrl.searchParams.get("waitMs");
    const waitMode = requestUrl.searchParams.get("waitMode");
    if (waitMs) internalUrl.searchParams.set("waitMs", waitMs);
    if (waitMode) internalUrl.searchParams.set("waitMode", waitMode);
    const claimControl = () => machineDaemonControl(c.env, principal, {
      commandId: `daemon-claim-control:${principal.ownerUserId}:${principal.machineId}:${crypto.randomUUID()}`,
      action: "claim", connectionEpoch,
      commandTypes: ["spawn", "stop", "cleanup", "request_resolve",
        ...(requestUrl.searchParams.get("replyRecovery") === "1" ? ["recover_reply"] : [])],
      payload: {},
    });
    let claimed = await claimControl();
    let commands = ((claimed.commands as Array<{ payload: unknown }> | undefined) || [])
      .map((item) => withMachineSpawnHarness(item.payload));
    const boundedWaitMs = Math.min(25_000, Math.max(1, Number(waitMs) || 25_000));
    if (commands.length === 0 && waitMode === "signal_v1") {
      // Waits in the owner's cell; a wake reaches every cell that may hold it.
      const ownerCell = relayRuntimeOwnerCellName(principal.ownerUserId);
      await (ownerCell ? relayRuntimeCellNamed(c.env, ownerCell) : relayRuntimeSingleCell(c.env)).fetch(new Request(
        `https://relay-runtime${RELAY_RUNTIME_MACHINE_DAEMON_WAIT_PATH}`, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ ownerUserId: principal.ownerUserId,
            machineId: principal.machineId, hostId: principal.hostId, waitMs: boundedWaitMs }),
        })).catch(() => undefined);
      claimed = await claimControl();
      commands = ((claimed.commands as Array<{ payload: unknown }> | undefined) || [])
        .map((item) => withMachineSpawnHarness(item.payload));
    }
    return c.json({ commands });
  }));
  app.post(HUB_ROUTES.daemon_command_lease_renew, async (c) => {
    let admissionStarted: number | undefined;
    try {
      const principal = await requireMachineDaemonAuth(c.req.raw, c.env);
      const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
      const requestId = typeof body.requestId === "string" ? body.requestId.trim() : "";
      if (!requestId) return c.json({ error: "requestId is required" }, 400);
      const launchId = typeof body.launchId === "string" ? body.launchId.trim() : "";
      const channelId = typeof body.channelId === "string" ? body.channelId.trim() : "";
      if ((launchId && !channelId) || (channelId && !launchId)) {
        return c.json({ error: "launchId and channelId must be supplied together" }, 400);
      }
      if (launchId) admissionStarted = performance.now();
      const relayLease = body.relayLease as Record<string, unknown> | undefined;
      const connectionEpoch = Number(relayLease?.daemonEpoch);
      const renewed = await machineDaemonControl(c.env, principal, {
        commandId: `daemon-renew:${crypto.randomUUID()}`,
        action: "renew",
        controlId: requestId,
        leaseMs: 60_000,
        payload: {},
        relayLease,
        connectionEpoch,
      });
      if (launchId && channelId) {
        await updateAgentLaunch(c.env, { launchId, channelId, actorUserId: principal.ownerUserId, state: "admitted" });
        recordAgentLaunchStage({ env: c.env, stage: "daemon_admit", outcome: "ok",
          durationMs: performance.now() - admissionStarted! });
      }
      return c.json({ ok: true, leaseUntil: renewed.leaseUntil });
    } catch (error) {
      if (admissionStarted !== undefined) recordAgentLaunchStage({
        env: c.env, stage: "daemon_admit", outcome: "error",
        durationMs: performance.now() - admissionStarted,
      });
      return requestErrorResponse(c, error);
    }
  });
  app.post(HUB_ROUTES.daemon_spawn_result, async (c) => {
    try {
      const principal = await requireMachineDaemonAuth(c.req.raw, c.env);
      const internalUrl = new URL("/internal/daemon/spawn-result", c.req.url);
      appendMachinePrincipal(internalUrl, principal);
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const requestId = typeof body.requestId === "string" ? body.requestId : "";
    if (!requestId) return c.json({ error: "requestId is required" }, 400);
    const payload = { ...body, type: "machine_spawn_result" };
    const connectionEpoch = Number((body.relayLease as Record<string, unknown> | undefined)?.daemonEpoch);
    if (!machineSpawnRegistryEvidenceMatches(payload, connectionEpoch)) {
      return c.json({ error: "Machine Daemon registry evidence does not match the command lease" }, 400);
    }
    const completed = await machineDaemonControl(c.env, principal, {
      commandId: `daemon-complete-spawn:${requestId}`,
      action: "complete", controlId: requestId, eventType: "machine_spawn_result",
      success: body.ok !== false, payload,
      relayLease: body.relayLease,
      connectionEpoch,
    });
      const lifecycleChannelId = typeof completed.runLifecycleChannelId === "string"
        ? completed.runLifecycleChannelId
        : typeof body.channelId === "string" ? body.channelId : "";
      if (lifecycleChannelId && typeof body.runId === "string" && body.runId) {
        await dispatchMachineDaemonRunLifecycleReplica({
          env: c.env, request: c.req.raw, principal, requestId,
          eventType: "machine_spawn_result", channelId: lifecycleChannelId,
          connectionEpoch, body: payload,
        });
      }
      await applyMachineDaemonSpawnLaunchResult({ env: c.env, principal, body: payload });
      return c.json({ ok: true });
    } catch (error) {
      return requestErrorResponse(c, error);
    }
  });
  app.post(HUB_ROUTES.daemon_control_result, (c) => jsonErrors(c, async () => {
    const principal = await requireMachineDaemonAuth(c.req.raw, c.env);
    const internalUrl = new URL("/internal/daemon/control-result", c.req.url);
    appendMachinePrincipal(internalUrl, principal);
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    if (!machineRouteIdentityMatches(principal, body)) {
      return c.json({ error: "Machine Daemon credential does not match control result machine" }, 403);
    }
    const requestId = typeof body.requestId === "string" ? body.requestId : "";
    if (!requestId) return c.json({ error: "requestId is required" }, 400);
    const eventType = typeof body.type === "string" ? body.type : "";
    const connectionEpoch = Number(
      (body.relayLease as Record<string, unknown> | undefined)?.daemonEpoch,
    );
    if (!machineSpawnRegistryEvidenceMatches(body, connectionEpoch)) {
      return c.json({ error: "Machine Daemon registry evidence does not match the command lease" }, 400);
    }
    const completed = await machineDaemonControl(c.env, principal, {
      commandId: `daemon-complete-control:${requestId}`,
      action: "complete", controlId: requestId,
      eventType: eventType || undefined,
      success: body.ok !== false, payload: body,
      relayLease: body.relayLease,
      connectionEpoch,
    });
    const runLifecycleChannelId = typeof completed.runLifecycleChannelId === "string"
      ? completed.runLifecycleChannelId
      : "";
    const runId = typeof body.runId === "string" ? body.runId : "";
    await applyMachineDaemonSpawnLaunchResult({ env: c.env, principal, body });
    if (runLifecycleChannelId && runId && eventType === "machine_spawn_result") {
      await dispatchMachineDaemonRunLifecycleReplica({
        env: c.env, request: c.req.raw, principal, requestId, eventType,
        channelId: runLifecycleChannelId, connectionEpoch, body,
      });
    }
    // A committed terminal report is finalized by the Agent Launch
    // coordinator, the same as one carried by the reverse socket.
    if (completed.runTerminalReportRecorded === true) {
      // Acknowledge only once its Channel's coordinator owns it; the
      // daemon retries an unacknowledged report.
      const reportChannelId = runLifecycleChannelId ||
        (typeof completed.runLifecycleChannelId === "string" ? completed.runLifecycleChannelId : "");
      if (reportChannelId) {
        try { await wakeAgentLaunchCoordinator(c.env, reportChannelId); }
        catch { return c.json({ error: "Agent Launch Channel coordinator is unavailable" }, 503); }
      }
    } else if (runLifecycleChannelId && runId &&
        (eventType === "machine_run_exited" || eventType === "machine_stop_result")) {
      await dispatchMachineDaemonRunLifecycleReplica({
        env: c.env, request: c.req.raw, principal, requestId, eventType,
        channelId: runLifecycleChannelId, connectionEpoch, body,
        stopPurpose: completed.runLifecycleStopPurpose,
      });
      // The stopped predecessor unblocks its durable reborn successor.
      if (eventType === "machine_stop_result" && completed.runLifecycleStopPurpose === "reborn-predecessor") {
        try { await wakeAgentLaunchCoordinator(c.env, runLifecycleChannelId); }
        catch { return c.json({ error: "Agent Launch Channel coordinator is unavailable" }, 503); }
      }
    }
    return c.json({ ok: true });
  }));
  registerIndexRoutesAuthSpaceInstances(app);
  registerIndexRoutesAuthSpaceManagement(app);
}
