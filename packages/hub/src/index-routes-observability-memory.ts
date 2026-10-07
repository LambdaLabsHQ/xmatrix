import type { Context, Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { HUB_ROUTES , utf8ByteLength } from "@xmatrix/protocol";
import type { Env } from "./types";
import { appOrigin } from "./deployment-origins";
import { escapeHtml } from "./email-delivery";
import { diagnosticsDataPoint } from "./diagnostics";
import { clientNetworkSampleAnalytics, parseClientNetworkSample } from "./client-network-metrics";
import { authorizedTraceChannelIds, traceAuthorizationChecksForChannels } from "./trace-authorization-batch";
import { RELAY_RUNTIME_AGENT_TRACE_PATH } from "./relay-runtime";
import { relayRuntimeCellsForOwners } from "./relay-authority-locator";
import { AGENT_HOST_TRACE_MAX_WAIT_MS, agentHostTraceTimestampEpochNanoseconds, parseAgentHostTraceCursor, type AgentHostTraceReadResult } from "./agent-host-trace";
import { createChannel, createSpace } from "./spaces";
import { postgresMessageAppend } from "./postgres-message-authority";
import {
  CLIENT_METRIC_RATE_LIMIT,
  CLIENT_METRIC_RATE_WINDOW_MS,
  CLIENT_METRIC_RATE_MAX_PRINCIPALS,
  clientMetricRateLimits,
  hubOrigin,
  requireAuth,
  requireHumanAuth,
  getRelayRuntime,
  productCommandId,
  privateResponse,
  jsonErrors,
  requestErrorResponse,
} from "./index-shared";
import { assistantMemoryRepository, sharedMemoryRepository } from "./postgres-memory";
import { ControlError, PostgresSlackOAuthRepository, PostgresTraceAccessRepository, SlackOAuthControlError } from "@xmatrix/db";
import { postgresAuthorityDatabase } from "./postgres-authority-http";

/** Slack grants and their tokens live encrypted on the directory shard. */
function slackOAuthRepository(env: Env): PostgresSlackOAuthRepository {
  const material = env.XMATRIX_SECRET_CATALOG_KEY?.trim();
  if (!env.RELAY_POSTGRES?.connectionString || !env.RELAY_POSTGRES_SHARD_ID?.trim() || !material) {
    throw new SlackOAuthControlError("slack_oauth_unavailable", 503, "Slack authorization requires PostgreSQL");
  }
  return new PostgresSlackOAuthRepository(postgresAuthorityDatabase(env, "compatibility", "xmatrix-hub-compatibility"),
    material);
}

/** One approval step of a Slack grant; 428 asks for the token exchange first. */
async function approveSlackGrant(env: Env, input: Record<string, unknown>): Promise<{ status: number; error?: string }> {
  try {
    await slackOAuthRepository(env).approve(input);
    return { status: 200 };
  } catch (error) {
    if (error instanceof ControlError) return { status: error.status, error: error.message };
    console.error("Slack authorization approval failed", error);
    return { status: 503, error: "Slack authorization is unavailable" };
  }
}

/** Whether a user may see an Instance's trace, and where it is when no Channel was named. */
interface TraceAuthorization {
  allowed?: unknown;
  traceRoute?: { instanceId?: unknown; channelId?: unknown; terminal?: unknown; ownerUserId?: unknown };
}

function traceAccessRepository(env: Env) {
  return new PostgresTraceAccessRepository(postgresAuthorityDatabase(env, "Trace access", "xmatrix-hub-trace-access"));
}

/** A terminal traced Instance answers an empty expired page, not an error. */
function expiredTraceResponse(c: Context<{ Bindings: Env }>): Response {
  return c.json({
    availability: "expired",
    complete: false,
    events: [],
    reason: "host_expired",
    cursor: null,
    nextCursor: null,
  }, 200, { "cache-control": "private, no-store" });
}

/** Who wrote a Slack message, as the export or Web API names them. */
function slackMessageAuthor(message: Record<string, unknown>) {
  const text = (value: unknown) => typeof value === "string" ? value.trim() : "";
  const email = text(message.userEmail).toLowerCase();
  const name = text(message.userName).slice(0, 200) || "Slack";
  const avatarUrl = text(message.avatarUrl);
  return {
    source: "slack" as const, id: text(message.userId) || email || `name:${name}`, name,
    ...(email ? { email } : {}),
    ...(avatarUrl.startsWith("https://") ? { avatarUrl } : {}),
  };
}

/** Slack migration, observable event, trace, context, memory and analytics routes. */
export function registerObservabilityMemoryRoutes(app: Hono<{ Bindings: Env }>): void {
  app.post(HUB_ROUTES.migrations_slack, (c) => jsonErrors(c, async () => {
    const authUser = await requireAuth(c.req.raw, c.env);
    const body = await c.req.json<Record<string, any>>().catch((): Record<string, any> => ({})) as Record<string, any>;
    const channels = Array.isArray(body.channels) ? body.channels : [];
    if (channels.length === 0) return c.json({ error: "Slack migration requires at least one channel" }, 400);
    const spaceName = String(body.spaceName || `${String(body.workspaceName || "Slack").trim() || "Slack"} import`).trim();
    if (!spaceName) return c.json({ error: "spaceName is required" }, 400);
    const requestKey = c.req.header("x-xmatrix-idempotency-key")?.trim() || c.req.header("x-request-id")?.trim() || crypto.randomUUID();
    const jobId = `slack:${requestKey}`.slice(0, 160);
    const spaceId = `slack-space:${requestKey}`.slice(0, 180);
    const principal = { kind: "user" as const, id: authUser.id };
    const importerEmail = authUser.email.trim().toLowerCase();
    const space = await createSpace(c.env, {
      commandId: productCommandId(c.req.raw, "create-space", jobId), spaceId,
      ownerUserId: authUser.id, name: spaceName,
    });
    let channelsCreated = 0;
    let messagesImported = 0;
    let messagesSkipped = 0;
    const historyMode = body.historyMode === "all" ? "all" : "free";
    const cutoffMs = Date.now() - 90 * 24 * 60 * 60_000;
    for (let channelIndex = 0; channelIndex < channels.length; channelIndex++) {
      const source = channels[channelIndex] || {};
      const channelName = typeof source.name === "string" ? source.name.trim() : "";
      const messages = Array.isArray(source.messages) ? source.messages : [];
      if (!channelName) { messagesSkipped += messages.length; continue; }
      const channelId = `slack-channel:${requestKey}:${channelIndex}`.slice(0, 180);
      await createChannel(c.env, {
        commandId: productCommandId(c.req.raw, "create-channel", `${jobId}:${channelIndex}`),
        channelId, spaceId, name: channelName, mode: source.isPrivate ? "closed" : "open", principal,
      });
      channelsCreated++;
      const sorted = [...messages].sort((a, b) => String(a?.slackTs || "").localeCompare(String(b?.slackTs || "")));
      for (let messageIndex = 0; messageIndex < sorted.length; messageIndex++) {
        const message = sorted[messageIndex] || {};
        const text = typeof message.text === "string" ? message.text.trim() : "";
        const slackTs = typeof message.slackTs === "string" ? message.slackTs.trim() : "";
        const seconds = Number(slackTs.split(".")[0]);
        const millis = Number((slackTs.split(".")[1] || "").padEnd(3, "0").slice(0, 3) || "0");
        const sentMs = Number.isSafeInteger(seconds) && seconds > 0 ? seconds * 1000 + millis : NaN;
        if (!text || !Number.isFinite(sentMs) || (historyMode !== "all" && sentMs < cutoffMs)) { messagesSkipped++; continue; }
        const author = slackMessageAuthor(message);
        await postgresMessageAppend(c.env, channelId, {
          commandId: productCommandId(c.req.raw, "append-legacy-message", `${jobId}:${channelIndex}:${messageIndex}`),
          messageId: `slack-message:${requestKey}:${channelIndex}:${messageIndex}`.slice(0, 200),
          channelId, principal, body: text, sentAt: new Date(sentMs).toISOString(),
          // The importer's own Slack messages are theirs; everyone else's keep their Slack identity.
          ...(author.email && author.email === importerEmail ? {} : { importedAuthor: author }),
        }, { spaceId });
        messagesImported++;
      }
    }
    return c.json({ ok: true, space, channelsCreated, messagesImported, messagesSkipped });
  }));
  app.post(HUB_ROUTES.slack_oauth_start, (c) => jsonErrors(c, async () => {
    const authUser = await requireAuth(c.req.raw, c.env);
    if (!c.env.SLACK_CLIENT_ID || !c.env.SLACK_CLIENT_SECRET) return c.json({ error: "Slack OAuth is not configured on this xMatrix" }, 501);
    const grantId = crypto.randomUUID();
    const state = `${grantId}.${crypto.randomUUID().replaceAll("-", "")}${crypto.randomUUID().replaceAll("-", "")}`;
    return c.json(await slackOAuthRepository(c.env).start({
      commandId: productCommandId(c.req.raw, "start-slack-oauth", grantId), ownerUserId: authUser.id,
      grantId, state, clientId: c.env.SLACK_CLIENT_ID,
      redirectUri: new URL(HUB_ROUTES.slack_oauth_callback, hubOrigin(c.req.raw)).toString(), interval: 2, ttlMs: 10 * 60_000,
      principal: { kind: "user", id: authUser.id },
    }), 200, { "cache-control": "private, no-store" });
  }));
  app.post(HUB_ROUTES.slack_oauth_token, (c) => jsonErrors(c, async () => {
    const authUser = await requireAuth(c.req.raw, c.env);
    const body = await c.req.json<{ grantId?: string }>().catch((): { grantId?: string } => ({})) as { grantId?: string };
    if (!body.grantId) return c.json({ error: "userId and grantId are required" }, 400);
    return c.json(await slackOAuthRepository(c.env).consume({
      commandId: productCommandId(c.req.raw, "consume-slack-oauth", body.grantId), ownerUserId: authUser.id, grantId: body.grantId,
      principal: { kind: "user", id: authUser.id },
    }), 200, { "cache-control": "private, no-store" });
  }));
  // Slack's redirect carries no xMatrix session (the app signs in with bearer
  // tokens), so the signed-in app approves the grant as the user who started it.
  app.get(HUB_ROUTES.slack_oauth_callback, async (c) => {
    const error = c.req.query("error") || "";
    if (error) return c.html(`Slack authorization failed: Slack authorization denied: ${escapeHtml(error)}`, 400);
    const url = new URL("/connect/slack", appOrigin(c.env));
    for (const key of ["code", "state"] as const) {
      const value = c.req.query(key);
      if (value) url.searchParams.set(key, value);
    }
    return c.redirect(url.toString(), 302);
  });
  app.post(HUB_ROUTES.slack_oauth_approve, (c) => jsonErrors(c, async () => {
    const authUser = requireHumanAuth(await requireAuth(c.req.raw, c.env));
    const body = await c.req.json().catch(() => null) as Record<string, unknown> | null;
    const code = typeof body?.code === "string" ? body.code : "";
    const state = typeof body?.state === "string" ? body.state : "";
    if (!code || !state) return c.json({ error: "Slack authorization failed: state and code are required" }, 400);
    const grantId = state.slice(0, state.indexOf("."));
    const commandId = productCommandId(c.req.raw, "approve-slack-oauth", grantId);
    const approve = (input: Record<string, unknown> = {}) =>
      approveSlackGrant(c.env, { commandId, state, ownerUserId: authUser.id, ...input });
    const answer = (result: { status: number; error?: string }) => result.status === 200
      ? c.json({ ok: true }) : c.json({ error: `Slack authorization failed: ${result.error}` }, result.status as ContentfulStatusCode);
    // Checks the grant and its owner before the code is spent.
    const resumed = await approve();
    if (resumed.status !== 428) return answer(resumed);
    if (!c.env.SLACK_CLIENT_ID || !c.env.SLACK_CLIENT_SECRET) return c.json({ error: "Slack authorization failed: Slack OAuth is not configured" }, 501);
    const redirectUri = new URL(HUB_ROUTES.slack_oauth_callback, hubOrigin(c.req.raw)).toString();
    const response = await fetch("https://slack.com/api/oauth.v2.access", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: c.env.SLACK_CLIENT_ID, client_secret: c.env.SLACK_CLIENT_SECRET, code, redirect_uri: redirectUri }) });
    const payload = await response.json<Record<string, any>>().catch((): Record<string, any> => ({})) as Record<string, any>;
    const slackToken = payload.authed_user?.access_token || payload.access_token;
    if (!response.ok || !payload.ok || !slackToken) {
      const reconciled = await approve();
      if (reconciled.status !== 428) return answer(reconciled);
      return c.json({ error: `Slack authorization failed: ${payload.error || "token exchange failed"}` }, 400);
    }
    return answer(await approve({ slackToken, team: payload.team?.name }));
  }));
  app.get(HUB_ROUTES.observable_events, async (c) => {
    try {
      await requireAuth(c.req.raw, c.env);
      return c.json({ events: [] }, 200, { "cache-control": "no-store", "x-xmatrix-authority": "ephemeral-runtime" });
    } catch (error) {
      return c.json({ error: (error as Error).message }, 401);
    }
  });
  app.get("/api/trace/instances/:instanceId/events", async (c) => {
    try {
      const authUser = await requireAuth(c.req.raw, c.env);
      const instanceId = c.req.param("instanceId");
      const requestedLimit = c.req.query("limit") ? Number(c.req.query("limit")) : 100;
      const since = c.req.query("since") || undefined;
      // `before` pages older retained history with a previous `nextCursor`.
      // `cursor` stays rejected: responses keep `cursor: null` for older Web.
      const before = c.req.query("before") || undefined;
      // A live `since` delta may wait on the Agent host for a newer event
      // (long-poll). Authorization is still checked before and after the wait.
      const waitMs = c.req.query("waitMs") !== undefined ? Number(c.req.query("waitMs")) : undefined;
      if (!instanceId.trim() || instanceId.length > 160 ||
          !Number.isSafeInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > 500 ||
          c.req.query("cursor") !== undefined ||
          (since !== undefined && agentHostTraceTimestampEpochNanoseconds(since) === undefined) ||
          (before !== undefined && parseAgentHostTraceCursor(before) === undefined) ||
          (waitMs !== undefined && (!Number.isSafeInteger(waitMs) || waitMs < 0 ||
            waitMs > AGENT_HOST_TRACE_MAX_WAIT_MS || since === undefined || before !== undefined))) {
        return c.json({ error: "trace pagination is invalid", code: "invalid_trace_cursor" }, 400);
      }
      const traceAccess = traceAccessRepository(c.env);
      // Without a Channel, the traced Instance's Channel arrives in the authorization.
      const authorization = await traceAccess.authorize({
        instanceId, principal: { kind: "user", id: authUser.id },
      }) as TraceAuthorization;
      if (authorization?.allowed !== true) {
        return c.json({ error: "Agent trace access denied", code: "trace_access_denied" },
          403, { "cache-control": "private, no-store" });
      }
      const channelId = typeof authorization.traceRoute?.channelId === "string"
        ? authorization.traceRoute.channelId
        : "";
      const ownerUserId = typeof authorization.traceRoute?.ownerUserId === "string"
        ? authorization.traceRoute.ownerUserId
        : "";
      if (authorization.traceRoute?.instanceId !== instanceId || !channelId || !ownerUserId) {
        return c.json({ error: "Agent trace scope is unavailable", code: "trace_scope_unavailable" },
          503, { "cache-control": "private, no-store" });
      }
      if (authorization.traceRoute.terminal === true) {
        return expiredTraceResponse(c);
      }
      const internalUrl = new URL(RELAY_RUNTIME_AGENT_TRACE_PATH, c.req.url);
      internalUrl.searchParams.set("instanceId", instanceId);
      internalUrl.searchParams.set("limit", String(requestedLimit));
      if (since) internalUrl.searchParams.set("since", since);
      if (before) internalUrl.searchParams.set("before", before);
      if (waitMs) internalUrl.searchParams.set("waitMs", String(waitMs));
      // The host's socket lives in its owner's cell, or in the single cell
      // for a client predating owner routing; only the cell holding it reads.
      const runtimeResponses = await Promise.all(relayRuntimeCellsForOwners(c.env, [ownerUserId])
        .map((cell) => cell.fetch(new Request(internalUrl, { method: "GET" }))));
      const failed = runtimeResponses.find((response) => !response.ok);
      if (failed) return privateResponse(failed);
      const histories = await Promise.all(runtimeResponses.map((response) =>
        response.json<AgentHostTraceReadResult>()));
      const history = histories.find((read) => read?.reason !== "host_offline") ?? histories[0];
      if (!history || !["available", "unavailable", "expired"].includes(history.availability) ||
          typeof history.complete !== "boolean" || !Array.isArray(history.events)) {
        return c.json({ error: "Agent host returned an invalid trace response", code: "trace_host_invalid" },
          503, { "cache-control": "private, no-store" });
      }
      const postWaitAuthorization = await traceAccess.authorize({
        instanceId, principal: { kind: "user", id: authUser.id },
      }) as TraceAuthorization;
      if (postWaitAuthorization?.allowed !== true ||
          postWaitAuthorization.traceRoute?.instanceId !== instanceId ||
          postWaitAuthorization.traceRoute?.channelId !== channelId) {
        return c.json({ error: "Agent trace access denied", code: "trace_access_denied" },
          403, { "cache-control": "private, no-store" });
      }
      if (postWaitAuthorization.traceRoute.terminal === true) {
        return expiredTraceResponse(c);
      }
      if (history.availability !== "available") {
        return c.json({ ...history, events: [], complete: false, cursor: null, nextCursor: null }, 200,
          { "cache-control": "private, no-store" });
      }
      if (history.events.length > 500 || history.events.some((event) =>
        typeof event.channelId !== "string" || !event.channelId.trim())) {
        return c.json({ error: "Agent host returned an invalid trace scope", code: "trace_host_invalid" },
          503, { "cache-control": "private, no-store" });
      }
      const eventChannelIds = history.events.flatMap((event) =>
        typeof event.channelId === "string" ? [event.channelId] : []);
      const checks = traceAuthorizationChecksForChannels(authUser.id, eventChannelIds);
      if (checks.length === 0) {
        return c.json({ ...history, events: [], cursor: null, nextCursor: history.nextCursor ?? null }, 200,
          { "cache-control": "private, no-store" });
      }
      const batchAuthorization = await traceAccess.authorizeBatch({ instanceId, checks });
      const allowedEventChannelIds = authorizedTraceChannelIds(
        batchAuthorization,
        instanceId,
        authUser.id,
        checks.map((check) => check.channelId),
      );
      if (!allowedEventChannelIds) {
        return c.json({ error: "Agent trace authorization response is invalid", code: "trace_authority_invalid" },
          503, { "cache-control": "private, no-store" });
      }
      const visibleEvents = history.events.filter((event) =>
        typeof event.channelId === "string" && allowedEventChannelIds.has(event.channelId));
      const events = visibleEvents.slice(0, requestedLimit);
      return c.json({
        ...history,
        events,
        complete: history.complete && visibleEvents.length === history.events.length &&
          events.length === history.events.length,
        cursor: null,
        nextCursor: history.nextCursor ?? null,
      }, 200, { "cache-control": "private, no-store" });
    } catch (error) {
      return requestErrorResponse(c, error);
    }
  });
  app.post(HUB_ROUTES.observable_client_metrics, (c) => jsonErrors(c, async () => {
    const authUser = await requireAuth(c.req.raw, c.env);
    const now = Date.now();
    const recent = (clientMetricRateLimits.get(authUser.id) || [])
      .filter((timestamp) => now - timestamp < CLIENT_METRIC_RATE_WINDOW_MS);
    if (recent.length >= CLIENT_METRIC_RATE_LIMIT) {
      clientMetricRateLimits.set(authUser.id, recent);
      return c.json({ error: "client metric rate limit exceeded", code: "rate_limited" }, 429);
    }
    recent.push(now);
    clientMetricRateLimits.delete(authUser.id);
    clientMetricRateLimits.set(authUser.id, recent);
    while (clientMetricRateLimits.size > CLIENT_METRIC_RATE_MAX_PRINCIPALS) {
      const oldest = clientMetricRateLimits.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      clientMetricRateLimits.delete(oldest);
    }
    const rawText = await c.req.text();
    if (utf8ByteLength(rawText) > 8 * 1024) {
      return c.json({ error: "client metric payload exceeds 8 KiB", code: "payload_too_large" }, 413);
    }
    let parsedBody: unknown;
    try {
      parsedBody = JSON.parse(rawText) as unknown;
    } catch {
      return c.json({ error: "Invalid client_network_sample payload", code: "invalid_metric" }, 400);
    }
    const body = parseClientNetworkSample(parsedBody);
    if (!body) {
      return c.json({ error: "Invalid client_network_sample payload", code: "invalid_metric" }, 400);
    }
    if (!c.env.DIAGNOSTICS_AE) {
      return c.json({ error: "telemetry sink unavailable", code: "telemetry_unavailable" }, 503);
    }
    const analytics = clientNetworkSampleAnalytics(body);
    const point = await diagnosticsDataPoint({
      userId: authUser.id,
      channelId: body.channelId,
      hashKey: c.env.DIAGNOSTICS_HASH_SECRET || c.env.BETTER_AUTH_SECRET,
      routeGroup: "observable_client_metrics",
      clientKind: body.clientKind as string,
      eventType: "client_network_sample",
      reason: analytics.reason,
      status: body.result,
      count: analytics.count,
      durationMs: analytics.durationMs,
    });
    // diagnosticsDataPoint owns doubles 0-1 (count, latency); network diagnostics extend
    // that stable prefix with reconnect attempt and last observed server-activity age.
    point.doubles?.push(...analytics.extraDoubles);
    c.env.DIAGNOSTICS_AE.writeDataPoint(point);
    // Room also broadcast client_network_sample to the caller's live Human
    // sockets so e2e/UI can observe metrics without AE scraping.
    const event = {
      id: crypto.randomUUID(),
      type: "client_network_sample" as const,
      workspaceUserId: authUser.id,
      channelId: body.channelId as string,
      metadata: {
        clientKind: body.clientKind,
        mode: body.mode,
        networkState: body.networkState,
        result: body.result,
        latencyMs: body.latencyMs,
        entryCount: body.entryCount,
        truncated: body.truncated,
        afterSequence: body.afterSequence,
        lastSequence: body.lastSequence,
        reconnectAttempt: body.reconnectAttempt,
        lastServerActivityAgeMs: body.lastServerActivityAgeMs,
        reason: body.reason,
      },
      timestamp: new Date().toISOString(),
    };
    try {
      await getRelayRuntime(c.env).fetch(new Request(
        "https://relay-runtime/internal/product-human/observable-event",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ userId: authUser.id, event }),
        },
      ));
    } catch {
      // Best-effort live fanout; AE write already succeeded.
    }
    return c.json({ ok: true, sink: "analytics_engine_only", authorityHostWrites: 0 }, 202);
  }));
  app.get(HUB_ROUTES.shared_memory, (c) => jsonErrors(c, async () => {
    const authUser = await requireAuth(c.req.raw, c.env);
    const limit = c.req.query("limit");
    return c.json(await sharedMemoryRepository(c.env).get({
      requestId: crypto.randomUUID(), ownerUserId: authUser.id,
      key: c.req.query("key"), prefix: c.req.query("prefix"), limit: limit ? Number(limit) : 100,
    }));
  }));
  app.get(HUB_ROUTES.assistant_memory, (c) => jsonErrors(c, async () => {
    const authUser = await requireAuth(c.req.raw, c.env);
    return c.json(await assistantMemoryRepository(c.env).get({
      requestId: crypto.randomUUID(), ownerUserId: authUser.id,
    }));
  }));
  app.post(HUB_ROUTES.assistant_memory, (c) => jsonErrors(c, async () => {
    const authUser = await requireAuth(c.req.raw, c.env);
    const update = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    return c.json(await assistantMemoryRepository(c.env).update({
      commandId: productCommandId(c.req.raw, "update-assistant-memory"),
      ownerUserId: authUser.id, update,
    }));
  }));
  app.post(HUB_ROUTES.shared_memory, (c) => jsonErrors(c, async () => {
    const authUser = await requireAuth(c.req.raw, c.env);
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    return c.json(await sharedMemoryRepository(c.env).put({
      commandId: productCommandId(c.req.raw, "put-shared-memory"),
      ownerUserId: authUser.id, key: body.key, value: body.value, ttlMs: body.ttlMs,
    }));
  }));
  app.delete(HUB_ROUTES.shared_memory, (c) => jsonErrors(c, async () => {
    const authUser = await requireAuth(c.req.raw, c.env);
    const key = c.req.query("key");
    if (!key) return c.json({ error: "key is required" }, 400);
    return c.json(await sharedMemoryRepository(c.env).remove({
      commandId: productCommandId(c.req.raw, "delete-shared-memory"),
      ownerUserId: authUser.id, key,
    }));
  }));
}
