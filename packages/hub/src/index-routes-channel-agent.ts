import { registerChannelMetadataRoutes } from "./index-routes-channel-metadata.js";
import { ControlError, PostgresAgentChannelAccessRepository } from "@xmatrix/db";
import { stopChannelAboutSessions } from "./channel-about-session-stop";
import { channelAboutTextRefusal } from "./channel-about-text";
import { acceptSpaceInvite, changeMembership, configureChannel, createChannel, getChannel, getSpaceInvite, listSpaces, readVisibleLiveAgentPresence } from "./spaces";
import { readChannelViewPreference, readLocalePreference, updateChannelViewPreference,
  updateLocalePreference } from "./user-preference-postgres-authority";
import { createPostgresAuthorityDatabase } from "./postgres-authority-fleet";
import { registerSummonDecisionRoutes } from "./index-routes-summon-decision";
import type { Context, Hono } from "hono";
import { registerAgentLaunchRoutes } from "./index-routes-agent-launch";
import { registerMessageReceiptRoutes } from "./index-routes-message-receipt";
import { relayRuntimeCellNamed, relayRuntimeOwnerCellName } from "./relay-authority-locator";
import { RELAY_RUNTIME_CELL_HEADER } from "./runtime-transport/runtime-cell-locator";
import {
  HUB_ROUTES,
  sha256Hex,
} from "@xmatrix/protocol";
import type { Env } from "./types";
import { authorizeMachineDaemonAgentRun } from "./machine-daemon-agent-run-authorization";
import { crossSpaceRetryOwner, retryDeniedAgentReadAcrossSpaces } from "./cross-space-read";
import { loadLiveHumanPresenceFromRuntime, overlayChannelsWithLiveHumanPresence } from "./runtime-transport/human-presence-fanout";
import {
  beginLiveHumanPresenceRead,
  channelWithLiveHumanPresence,
  committedChannelWithLiveHumanPresence,
} from "./channel-response-human-presence";
import { serializedAgentsFromPresence } from "./live-agent-instance-read";
import { PUBLIC_DOMAIN_SOCKET_PATHS, routeDomainSocket } from "./runtime-transport/domain-socket-route";
import { stopAgentRunLeavingChannel } from "./product-agent-intervention-authority-adapter";
import { requireAuth, requireMachineDaemonAuth, actorUserId, getRelayRuntime, productCommandId, privateResponse, hasMeaningfulProductField, deterministicChannelCreateId, jsonErrors, requestErrorResponse } from "./index-shared";
import { spaceInviteAuthorityScope } from "./space-invite-token";
import {
  acknowledgeChannelMessage,
  channelMessageAnnotations,
  channelMessageCommand,
  channelMessageHistory,
  channelMessageResponse,
  channelMessageResult,
  publishChannelMemberRead,
} from "./channel-messages";
import {
  agentRunCreatedByMetadata,
  agentRunDelegationDenied,
} from "./agent-run-channel-delegation";
import { channelCatalogPrincipal, readChannelCatalogForPrincipal, readChannelForPrincipal } from "./channel-catalog-read";
import { controlErrorResponse } from "./postgres-authority-http";
import { readSyncedChannelCatalogForUser } from "./channel-catalog-sync";
import { createChannelCatalogReadMetrics, recordChannelCatalogObservation, type ChannelCatalogOutcome } from "./channel-catalog-observability";
import { channelCatalogTimeoutResponse, createChannelCatalogDeadline, isChannelCatalogTimeoutError } from "./channel-catalog-deadline";
import { registerChannelCatalogPagingRoutes } from "./channel-catalog-paging-routes";
import { registerRelayStorageRoutes } from "./index-routes-relay-storage";
import { registerChannelMessageRoutes } from "./index-routes-channel-messages";
import { registerObservabilityMemoryRoutes } from "./index-routes-observability-memory";

/** Conversations are flat and never archived; pages say how work is organized. */
const CHANNEL_HIERARCHY_RETIRED = {
  error: "Channels no longer nest or archive. Organize work on a page, and move a conversation between Spaces with a transfer proposal.",
  code: "channel_hierarchy_retired",
};

type ChannelAgentContext = Context<{ Bindings: Env }>;

const ANNOTATION_API_HUMAN_ONLY = {
  error: "Agent runs cannot call the generic annotation API",
  code: "forbidden",
};
const CHANNEL_VIEW_PREFERENCE_HUMAN_ONLY = {
  error: "channel view preferences are personal to a Human user",
};

/** Authenticates a route only a Human may call; an Agent Run receives `refusal`. */
async function requireHumanCaller(c: ChannelAgentContext, refusal: Record<string, string>) {
  const authUser = await requireAuth(c.req.raw, c.env);
  return authUser.agentRun ? c.json(refusal, 403) : authUser;
}

/** The raw PATCH body; an empty one is refused as `missing`. */
async function requiredTextBody(c: ChannelAgentContext, missing: string): Promise<string | Response> {
  const body = await c.req.text();
  return body.trim() ? body : c.json({ error: missing }, 400);
}

const NO_STORE = { "cache-control": "private, no-store" };

/** A well-formed invite token's hash; a malformed token names no invite. */
async function inviteTokenHash(c: ChannelAgentContext): Promise<string | null> {
  const token = c.req.param("token")!;
  return spaceInviteAuthorityScope(token) ? sha256Hex(token) : null;
}

export function registerIndexRoutesChannelAgent(app: Hono<{ Bindings: Env }>): void {
  registerAgentLaunchRoutes(app);
  registerMessageReceiptRoutes(app);
  registerSummonDecisionRoutes(app);
  registerChannelCatalogPagingRoutes(app);
  registerRelayStorageRoutes(app);
  registerChannelMessageRoutes(app);
  registerObservabilityMemoryRoutes(app);
  app.get("/api/space-invites/:token", (c) => jsonErrors(c, async () => {
    const tokenHash = await inviteTokenHash(c);
    if (!tokenHash) return c.json({ error: "Space invite token is invalid" }, 404);
    return c.json(await getSpaceInvite(c.env, tokenHash));
  }));
  app.post("/api/space-invites/:token/accept", (c) => jsonErrors(c, async () => {
    const authUser = await requireAuth(c.req.raw, c.env);
    const tokenHash = await inviteTokenHash(c);
    if (!tokenHash) return c.json({ error: "Space invite token is invalid" }, 404);
    return c.json(await acceptSpaceInvite(c.env, {
      commandId: productCommandId(c.req.raw, "accept-space-invite", `${authUser.id}:${tokenHash}`),
      tokenHash, actorUserId: authUser.id,
      ...(authUser.email ? { email: authUser.email } : {}),
      ...(authUser.name ? { name: authUser.name } : {}),
      ...(authUser.avatarUrl ? { avatarUrl: authUser.avatarUrl } : {}),
    }));
  }));
  app.post(HUB_ROUTES.machine_daemon_agent_run_token, (c) => jsonErrors(c, async () => {
    const principal = await requireMachineDaemonAuth(c.req.raw, c.env);
    const body = (await c.req.json().catch(() => ({}))) as {
      runId?: string;
      executionKey?: string;
      agentId?: string;
      spaceId?: string;
      channelId?: string;
      instanceId?: string;
    };
    const authorized = await authorizeMachineDaemonAgentRun(c.env, principal, body);
    return authorized instanceof Response ? authorized : c.json(authorized);
  }));
  app.get(HUB_ROUTES.agent_instances, (c) => jsonErrors(c, async () => {
    const authUser = await requireAuth(c.req.raw, c.env);
    const principal = channelCatalogPrincipal(authUser);
    // First paint is the Postgres projection. A presence frame fills activity
    // and the other fields that exist only in a Runtime cell.
    try {
      const spaceIds = principal.kind === "agent"
        ? (principal.spaceId ? [principal.spaceId] : [])
        : (await listSpaces(c.env, principal)).flatMap((space) =>
            typeof space.id === "string" && space.id.trim() ? [space.id] : []);
      const presence = await readVisibleLiveAgentPresence(c.env, principal, spaceIds);
      return c.json(
        { instances: serializedAgentsFromPresence(presence) },
        200,
        { "cache-control": "private, no-store" },
      );
    } catch (error) {
      return controlErrorResponse(error);
    }
  }));
  app.get("/api/spaces/:spaceId/locale-preference", (c) => jsonErrors(c, async () => {
    const authUser = await requireAuth(c.req.raw, c.env);
    return c.json(await readLocalePreference(c.env, { spaceId: c.req.param("spaceId"),
      userId: authUser.agentRun?.ownerUserId || authUser.id }), 200, NO_STORE);
  }));
  app.patch("/api/spaces/:spaceId/locale-preference", (c) => jsonErrors(c, async () => {
    const authUser = await requireAuth(c.req.raw, c.env);
    const body = await c.req.json().catch(() => null) as Record<string, unknown> | null;
    if (!body || Object.keys(body).some((key) => key !== "expectedVersion" && key !== "displayLocale" && key !== "editingLocale")
      || !Number.isSafeInteger(body.expectedVersion)
      || (body.displayLocale !== undefined && body.displayLocale !== null && typeof body.displayLocale !== "string")
      || (body.editingLocale !== undefined && body.editingLocale !== null && typeof body.editingLocale !== "string")) {
      return c.json({ error: "A version and one or more locale preferences are required" }, 400);
    }
    if (body.displayLocale === undefined && body.editingLocale === undefined) {
      return c.json({ error: "One or more locale preferences are required" }, 400);
    }
    return c.json(await updateLocalePreference(c.env, { spaceId: c.req.param("spaceId"),
      userId: authUser.agentRun?.ownerUserId || authUser.id, update: {
        commandId: productCommandId(c.req.raw, "domain"), at: new Date().toISOString(),
        expectedVersion: Number(body.expectedVersion),
        ...(body.displayLocale === undefined ? {} : { displayLocale: body.displayLocale as string | null }),
        ...(body.editingLocale === undefined ? {} : { editingLocale: body.editingLocale as string | null }),
      } }));
  }));
  app.get("/api/spaces/:spaceId/channel-view-preference", (c) => jsonErrors(c, async () => {
    const authUser = await requireHumanCaller(c, CHANNEL_VIEW_PREFERENCE_HUMAN_ONLY);
    if (authUser instanceof Response) return authUser;
    return c.json(await readChannelViewPreference(c.env, { spaceId: c.req.param("spaceId"), userId: authUser.id }),
      200, NO_STORE);
  }));
  app.patch("/api/spaces/:spaceId/channel-view-preference", (c) => jsonErrors(c, async () => {
    const authUser = await requireHumanCaller(c, CHANNEL_VIEW_PREFERENCE_HUMAN_ONLY);
    if (authUser instanceof Response) return authUser;
    const body = await c.req.json().catch(() => null) as Record<string, unknown> | null;
    if (!body || Object.keys(body).some((key) => key !== "expectedVersion" && key !== "followUpReviewSchedule" && key !== "pinnedChannelIds")
      || !Number.isSafeInteger(body.expectedVersion)
      || (body.followUpReviewSchedule !== undefined && typeof body.followUpReviewSchedule !== "string")
      || (body.pinnedChannelIds !== undefined && !Array.isArray(body.pinnedChannelIds))
      || (body.followUpReviewSchedule === undefined && body.pinnedChannelIds === undefined)) {
      return c.json({ error: "A version and one or more channel view preferences are required" }, 400);
    }
    return c.json(await updateChannelViewPreference(c.env, { spaceId: c.req.param("spaceId"), userId: authUser.id,
      update: {
        commandId: productCommandId(c.req.raw, "domain"), at: new Date().toISOString(),
        expectedVersion: Number(body.expectedVersion),
        ...(body.followUpReviewSchedule === undefined ? {}
          : { followUpReviewSchedule: body.followUpReviewSchedule as "off" | "daily" | "weekdays" | "weekly" }),
        ...(body.pinnedChannelIds === undefined ? {} : { pinnedChannelIds: body.pinnedChannelIds as string[] }),
      } }));
  }));
  app.get(HUB_ROUTES.channels, (c) => jsonErrors(c, async () => {
    const authUser = await requireAuth(c.req.raw, c.env);
    // About has a single Channel capability. Do not read the Space catalog and
    // filter afterwards: manifests, attention and pagination also carry inputs.
    if (authUser.agentRun?.runKind === "channel-about-session") {
      const run = authUser.agentRun;
      if ((c.req.query("spaceId") && c.req.query("spaceId") !== run.spaceId) ||
          (c.req.query("familyOfChannelId") && c.req.query("familyOfChannelId") !== run.channelId)) {
        return c.json({ error: "About context is limited to its own Channel", code: "channel_about_scope_invalid" }, 403);
      }
      const result = await getChannel(c.env, { channelId: run.channelId, principal: { kind: "user", id: run.ownerUserId } });
      return c.json({ channels: [result.channel] }, 200, NO_STORE);
    }
    const spaceId = c.req.query("spaceId");
    // `familyOfChannelId` narrows the read to one Channel and its direct children.
    const familyOfChannelId = c.req.query("familyOfChannelId")?.trim() || undefined;
    const observationStartedAt = Date.now();
    const metrics = createChannelCatalogReadMetrics();
    const deadline = createChannelCatalogDeadline({
      onTimeout: (boundary) => { metrics.timeoutBoundary = boundary; },
    });
    let observationOutcome: ChannelCatalogOutcome = "server_error";
    let observedChannelCount = 0;
    const principal = channelCatalogPrincipal(authUser);
    const presenceStartedAt = Date.now();
    // Agent rows already come from Postgres on this read. Only Human sockets
    // still need the runtime overlay.
    const presencePromise = loadLiveHumanPresenceFromRuntime(getRelayRuntime(c.env), c.req.url)
      .finally(() => {
        metrics.runtimePresenceWallMs += Date.now() - presenceStartedAt;
      });
    // The pre-Authority listing returned the complete catalog in one
    // response, and web clients never paginate. Restore that contract by
    // following the Authority cursor here instead of silently truncating at the
    // first page.
    try {
      // Runtime presence is independent of the durable catalog. Starting
      // both together removes one serial wait from every list request.
      const readCatalog = async (reader: typeof principal | { kind: "user"; id: string },
        readerSpaceId = spaceId) =>
        familyOfChannelId
          ? await readChannelForPrincipal(
              c.env, reader, familyOfChannelId, readerSpaceId, metrics, deadline,
            )
          : reader.kind === "user" && !readerSpaceId
          ? await readSyncedChannelCatalogForUser(
              c.env, reader, c.req.query("catalogSyncToken"), metrics, deadline,
            )
          : await readChannelCatalogForPrincipal(
              c.env, reader, readerSpaceId, metrics, deadline,
            );
      let catalog = await readCatalog(principal);
      if (!catalog.ok && authUser.agentRun && (familyOfChannelId || spaceId)) {
        // Outside its own Space an Agent lists only what its owner's grant
        // covers, as its owner: one granted Channel family, or a granted Space.
        const granted = await crossSpaceRetryOwner(c.env, authUser.agentRun,
          familyOfChannelId ? { channelId: familyOfChannelId } : { spaceId: spaceId! }, catalog.response);
        catalog = granted instanceof Response ? { ok: false, response: granted }
          : await readCatalog(granted.owner, granted.spaceId);
      }
      if (!catalog.ok) {
        observationOutcome = catalog.response.status >= 500
          ? "server_error"
          : "client_error";
        void presencePromise.catch(() => undefined);
        return catalog.response;
      }
      const liveHumanSessions = await deadline.wait(
        "runtime_presence",
        presencePromise,
      );
      const visibleChannels = catalog.channels;
      observedChannelCount = visibleChannels.length;
      observationOutcome = "ok";
      // Scoped-authority channel serialization is durable membership only. Overlay
      // live Human sessions from RelayRuntime so member surfaces show
      // online status for authenticated product sockets.
      return c.json({
        channels: overlayChannelsWithLiveHumanPresence(
          visibleChannels,
          liveHumanSessions,
          catalog.openChannelHumanMemberIdsBySpace,
        ),
        ...(catalog.projectionCacheManifest
          ? { projectionCacheManifest: catalog.projectionCacheManifest }
          : {}),
        ...(catalog.catalogSync ? { catalogSync: catalog.catalogSync } : {}),
        ...(catalog.attentionSnapshot ? { attentionSnapshot: catalog.attentionSnapshot } : {}),
      });
    } catch (error) {
      if (isChannelCatalogTimeoutError(error)) {
        observationOutcome = "server_error";
        void presencePromise.catch(() => undefined);
        return channelCatalogTimeoutResponse(error);
      }
      throw error;
    } finally {
      recordChannelCatalogObservation(c.env, {
        outcome: observationOutcome,
        totalWallMs: Date.now() - observationStartedAt,
        channelCount: observedChannelCount,
        metrics,
      });
    }
  }));
  app.post(HUB_ROUTES.channels, (c) => jsonErrors(c, async () => {
    const authUser = await requireAuth(c.req.raw, c.env);
    const run = authUser.agentRun;
    // An Agent Run creates as its owner, once both are proven in the parent.
    const actingUserId = run ? run.ownerUserId : authUser.id;
    const bodyText = await c.req.text();
    if (!bodyText.trim()) {
      return c.json({ error: "Channel create body is required" }, 400);
    }
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(bodyText) as Record<string, unknown>;
    } catch {
      return c.json({ error: "Channel create body must be valid JSON" }, 400);
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return c.json({ error: "Channel create body must be a JSON object" }, 400);
    }
    const requestedMetadata = body.metadata && typeof body.metadata === "object" && !Array.isArray(body.metadata)
      ? body.metadata as Record<string, unknown>
      : undefined;
    if (
      Object.prototype.hasOwnProperty.call(body, "summary") ||
      (requestedMetadata && Object.prototype.hasOwnProperty.call(requestedMetadata, "summary"))
    ) {
      return c.json({
        error: "Channel Summary is maintained by xMatrix",
        code: "channel_summary_ai_managed",
      }, 403);
    }
    let spaceId = typeof body.spaceId === "string" ? body.spaceId.trim() : "";
    if (run) {
      // A Run belongs to one Space; it never creates elsewhere.
      if (spaceId && spaceId !== run.spaceId) {
        return c.json({ error: "An Agent Run creates Channels only in its own Space", code: "agent_run_space_mismatch" }, 403);
      }
      spaceId = run.spaceId;
    }
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!spaceId || !name) {
      return c.json({ error: "spaceId and name are required" }, 400);
    }
    const unsupportedFields = [
      "members",
      "senderAgentId", "senderAgentName", "senderAgentInstanceId", "senderRunId",
      "senderExecutionKey",
    ].filter((field) => hasMeaningfulProductField(body, field));
    if (unsupportedFields.length > 0) {
      return c.json({ error: `Legacy channel creation fields retired at Authority cutover: ${unsupportedFields.join(", ")}`, code: "legacy_channel_fields_retired" }, 410);
    }
    // Room-era fixtures pass `memberName` (creator display, dropped) and an
    // empty `access`. Authority create grants the creating human, and an
    // Agent's live Instance with its owner when it creates a closed Channel.
    let mode = body.mode === undefined ? "open" : body.mode;
    if (mode !== "open" && mode !== "closed") {
      return c.json({ error: "channel mode must be open or closed" }, 400);
    }
    if (Array.isArray(body.access) && body.access.some((entry) => typeof entry === "string" && entry.trim())) {
      return c.json({ error: "Channel access is granted after the Channel is created" }, 400);
    }
    const metadata: Record<string, unknown> = {
      ...(body.metadata && typeof body.metadata === "object" && !Array.isArray(body.metadata)
        ? body.metadata as Record<string, unknown>
        : {}),
      ...(typeof body.topic === "string" && body.topic.trim() ? { topic: body.topic.trim() } : {}),
      ...(run ? agentRunCreatedByMetadata(run) : {}),
    };
    if (body.parentChannelId !== undefined || metadata.kind === "thread") return c.json(CHANNEL_HIERARCHY_RETIRED, 410);
    if (run) {
      // Proves this Run is still live and delegated by its owner before it acts as them.
      const denied = await agentRunDelegationDenied(c.env, run, []);
      if (denied) return denied;
    }
    const requestKey = c.req.header("x-xmatrix-idempotency-key")?.trim()
      || c.req.header("x-request-id")?.trim();
    const channelId = requestKey
      ? await deterministicChannelCreateId(actingUserId, requestKey)
      : crypto.randomUUID();
    const commandId = productCommandId(c.req.raw, "create-channel", channelId);
    const sessions = beginLiveHumanPresenceRead(c.env, c.req.url);
    const created = await createChannel(c.env, {
      commandId, channelId, spaceId, name, mode, metadata,
      principal: { kind: "user", id: actingUserId },
      ...(run?.instanceId && mode === "closed" ? { creatorAgentInstanceId: run.instanceId } : {}),
    });
    if (created.channel && typeof created.channel === "object") {
      const committedId = (created.channel as { id?: unknown }).id;
      return c.json({
        channel: await committedChannelWithLiveHumanPresence({
          env: c.env,
          channelId: typeof committedId === "string" && committedId ? committedId : channelId,
          principal: { kind: "user", id: actingUserId },
          committed: created.channel,
          sessions,
        }),
        created: created.reused !== true,
      });
    }
    return c.json({
      error: "Channel authority returned no committed Channel",
      code: "channel_create_result_invalid",
    }, 502);
  }));
  registerChannelMetadataRoutes(app);
  app.patch("/api/channels/:channelId", (c) => jsonErrors(c, async () => {
    const authUser = await requireAuth(c.req.raw, c.env);
    const channelId = c.req.param("channelId");
    const body = await requiredTextBody(c, "Channel update body is required");
    if (body instanceof Response) return body;
    let patch: Record<string, unknown>;
    try { patch = JSON.parse(body) as Record<string, unknown>; }
    catch { return c.json({ error: "Invalid JSON body" }, 400); }
    if (["parentChannelId", "archived", "archiveReason"].some((field) =>
      Object.prototype.hasOwnProperty.call(patch, field))) return c.json(CHANNEL_HIERARCHY_RETIRED, 410);
    const run = authUser.agentRun;
    // Only the Channel's own About session writes its summary, and through the
    // same request may name a Channel nobody has named yet.
    const about = run?.runKind === "channel-about-session" ? run : undefined;
    if (about && (about.channelId !== channelId || typeof patch.summary !== "string" ||
        Object.keys(patch).some((field) => !["summary", "name", "throughMessageId", "expectedRevision"].includes(field)))) {
      return c.json({
        error: "A Channel About session may only replace its Channel's summary and automatic name",
        code: "channel_about_operation_forbidden",
      }, 403);
    }
    if (!about && Object.prototype.hasOwnProperty.call(patch, "summary")) {
      return c.json({
        error: "Channel Summary is maintained by xMatrix",
        code: "channel_summary_ai_managed",
      }, 403);
    }
    const summary = about ? String(patch.summary).trim().slice(0, 4_000) : undefined;
    // Text a code-page shell already turned into `?` is refused, not saved;
    // the session stays open to write it again.
    const mangled = about ? channelAboutTextRefusal({ summary, name: patch.name }) : undefined;
    if (mangled) return c.json(mangled, 422);
    const throughMessageId = typeof patch.throughMessageId === "string" && patch.throughMessageId.trim()
      ? patch.throughMessageId.trim().slice(0, 200) : undefined;
    if (patch.expectedRevision !== undefined && (!Number.isSafeInteger(patch.expectedRevision) || Number(patch.expectedRevision) < 0)) {
      return c.json({ error: "expectedRevision must be a non-negative safe integer" }, 400);
    }
    const actingUserId = run ? run.ownerUserId : authUser.id;
    // The About session is scoped to this Channel already; it is not a delegate.
    if (run && !about) {
      // Cross-Space moves go through transfer proposals, which a Run may file
      // but only a human acknowledges.
      if (Object.prototype.hasOwnProperty.call(patch, "spaceId")) {
        return c.json({ error: "An Agent Run moves Channels between Spaces by transfer proposal", code: "agent_run_space_mismatch" }, 403);
      }
      const denied = await agentRunDelegationDenied(c.env, run, [channelId]);
      if (denied) return denied;
    }
    if (Object.prototype.hasOwnProperty.call(patch, "spaceId") && typeof patch.spaceId !== "string") {
      return c.json({ error: "Target workspace is invalid" }, 400);
    }
    const sessions = beginLiveHumanPresenceRead(c.env, c.req.url);
    const result = await configureChannel(c.env, {
      commandId: productCommandId(c.req.raw, "domain"),
      actorUserId: actingUserId, at: new Date().toISOString(), channelId,
      ...(run ? { actorRunId: run.runId } : {}),
      ...(typeof patch.expectedRevision === "number" ? { expectedRevision: patch.expectedRevision } : {}),
      ...(typeof patch.name === "string" ? { name: patch.name } : {}),
      ...(about && typeof patch.name === "string" ? { automaticName: true } : {}),
      ...(about ? { summary, summaryAuthor: {
        runId: about.runId, agentName: about.agentName, ...(throughMessageId ? { throughMessageId } : {}),
      } } : {}),
      ...(patch.mode === "open" || patch.mode === "closed" ? { mode: patch.mode } : {}),
      ...(typeof patch.spaceId === "string" ? { spaceId: patch.spaceId } : {}),
    });
    // An About session's one job is done once its summary is saved. Ending it
    // lets the refresh it was handed meanwhile start as its successor.
    if (about) {
      await stopChannelAboutSessions(c.env, [{
        runId: about.runId, channelId: about.channelId, sessionId: about.agentId,
        machineOwnerUserId: about.ownerUserId, machineId: about.machineId, hostId: about.hostId,
        ...(about.executionKey ? { executionKey: about.executionKey } : {}),
      }], "Channel About summary saved", "summary");
    }
    const migratedChannels = (result as { migratedChannels?: unknown }).migratedChannels;
    return c.json({
      channel: await committedChannelWithLiveHumanPresence({
        env: c.env, channelId, principal: { kind: "user", id: actingUserId },
        committed: result.channel, sessions,
      }),
      ...(Array.isArray(migratedChannels) ? { migratedChannels } : {}),
    });
  }));
  app.patch("/api/channels/:channelId/worktree", (c) => jsonErrors(c, async () => {
    const authUser = await requireAuth(c.req.raw, c.env);
    const channelId = c.req.param("channelId");
    const body = await requiredTextBody(c, "Channel worktree update body is required");
    if (body instanceof Response) return body;
    const sessions = beginLiveHumanPresenceRead(c.env, c.req.url);
    const current = await getChannel(c.env, { channelId, principal: { kind: "user", id: authUser.id } });
    return c.json({ channel: await channelWithLiveHumanPresence(current, sessions), ignored: true });
  }));
  app.get("/api/channels/:channelId/history", (c) => jsonErrors(c, async () => {
    const authUser = await requireAuth(c.req.raw, c.env);
    const channelId = c.req.param("channelId");
    const principal = authUser.agentRun;
    // The authoritative Channel-family query checks access and reads the
    // bounded window in one Durable Object turn.
    const input: Record<string, unknown> = {
      channelId,
      principal: principal
        ? {
            kind: "agent",
            id: principal.agentId,
            agentSpaceId: principal.spaceId,
          }
        : { kind: "user", id: authUser.id },
    };
    const queryLimit = c.req.query("limit");
    if (queryLimit) input.limit = Number(queryLimit);
    const queryBefore = c.req.query("before");
    if (queryBefore) input.before = queryBefore;
    const queryBeforeSequence = c.req.query("beforeSequence");
    if (queryBeforeSequence) input.beforeSequence = Number(queryBeforeSequence);
    const queryAfterSequence = c.req.query("afterSequence");
    if (queryAfterSequence) input.afterSequence = Number(queryAfterSequence);
    type HistoryInput = {
      channelId: string;
      before?: string;
      beforeSequence?: number;
      afterSequence?: number;
      limit?: number;
      principal: { kind: "user" | "agent"; id: string };
    };
    let familyHistory = await channelMessageResponse(() => channelMessageHistory(c.env, input as HistoryInput));
    if (principal) {
      // Outside its own Space an Agent reads only through its owner's grant, as its owner.
      const denied = familyHistory;
      familyHistory = await retryDeniedAgentReadAcrossSpaces(c.env, principal, { channelId }, denied,
        (owner) => channelMessageResponse(() => channelMessageHistory(c.env, { ...input, principal: owner } as HistoryInput)));
    }
    if (c.req.query("before")) {
      return c.json({
        error: "Channel family history pages by sequence; use beforeSequence",
        code: "invalid_request",
      }, 400);
    }
    return privateResponse(familyHistory);
  }));
  app.post("/api/channels/:channelId/annotations", (c) => jsonErrors(c, async () => {
    const authUser = await requireHumanCaller(c, ANNOTATION_API_HUMAN_ONLY);
    if (authUser instanceof Response) return authUser;
    const channelId = c.req.param("channelId");
    const body = await requiredTextBody(c, "Annotation body is required");
    if (body instanceof Response) return body;
    let annotation: Record<string, any>;
    try { annotation = JSON.parse(body) as Record<string, any>; } catch { return c.json({ error: "Annotation body must be valid JSON" }, 400); }
    if (!annotation.namespace || typeof annotation.namespace !== "string") return c.json({ error: "namespace required" }, 400);
    if (annotation.target?.kind !== "message" || typeof annotation.target?.messageId !== "string") {
      return c.json({ error: "Channel and message-range annotations retired at Authority cutover; use a message target", code: "legacy_annotation_target_retired" }, 410);
    }
    const annotationId = typeof annotation.id === "string" && annotation.id.trim() ? annotation.id.trim() : crypto.randomUUID();
    const principal = { kind: "user" as const, id: authUser.id };
    const command = {
      commandId: productCommandId(c.req.raw, "message-annotation", annotationId), channelId,
      messageId: annotation.target.messageId, annotationId, namespace: annotation.namespace,
      payload: Object.prototype.hasOwnProperty.call(annotation, "payload") ? annotation.payload : {},
      authorLabel: authUser.name || authUser.email,
      actorUserId: actorUserId(authUser), principal,
    };
    return channelMessageResponse(() => channelMessageCommand(c.env, channelId, "message-annotation", command), 201);
  }));
  app.post("/api/channels/:channelId/read", (c) => jsonErrors(c, async () => {
    const authUser = await requireAuth(c.req.raw, c.env);
    const channelId = c.req.param("channelId");
    // `responded`: the reader has dealt with the mentions waiting on them here without replying.
    const body = (await c.req.json().catch(() => ({}))) as { sequence?: number; responded?: boolean };
    if (body.sequence !== undefined && (!Number.isSafeInteger(body.sequence) || body.sequence < 0)) {
      return c.json({ error: "sequence must be a non-negative safe integer" }, 400);
    }
    const acknowledgeCommand = {
        commandId: productCommandId(
          c.req.raw,
          "acknowledge-message",
          body.responded === true
            ? `${channelId}:${authUser.id}:responded:${crypto.randomUUID()}`
            : `${channelId}:${authUser.id}:${body.sequence ?? "tail"}`,
        ),
        channelId,
        sequence: body.sequence,
        principal: { kind: "user", id: authUser.id },
        ...(body.responded === true ? { responded: true } : {}),
      };
    const result = await channelMessageResult(() => acknowledgeChannelMessage(c.env, channelId, acknowledgeCommand));
    if (!result.ok) return result.response;
    const ackedSequence = Number(result.payload.ackedSequence);
    // Only an advancing cursor changes what the other members see, so a
    // repeated viewport ack costs nothing beyond the durable command.
    const attention = result.payload.attention && typeof result.payload.attention === "object" &&
        !Array.isArray(result.payload.attention)
      ? result.payload.attention as import("@xmatrix/protocol").ChannelAttentionSummary
      : undefined;
    if (result.payload.advanced === true || result.payload.responded === true) {
      const memberRead = {
        channelId,
        subjectId: `user:${authUser.id}`,
        readSequence: ackedSequence,
        actorUserId: authUser.id,
        ...(attention ? { attention } : {}),
      };
      c.executionCtx.waitUntil(publishChannelMemberRead(
        c.env,
        (task) => c.executionCtx.waitUntil(task),
        memberRead,
      ).catch((error: unknown) => {
        console.error("Channel family member-read delivery failed", {
          channelId,
          error: error instanceof Error ? error.message : String(error),
        });
      }));
    }
    return c.json({
      ok: true,
      readSequence: ackedSequence,
      ...(attention ? { attention } : {}),
    });
  }));
  app.get("/api/channels/:channelId/annotations", (c) => jsonErrors(c, async () => {
    const authUser = await requireHumanCaller(c, ANNOTATION_API_HUMAN_ONLY);
    if (authUser instanceof Response) return authUser;
    const channelId = c.req.param("channelId");
    const targetKind = c.req.query("targetKind");
    const query = {
      channelId, namespace: c.req.query("namespace"), messageId: c.req.query("messageId"), targetKind,
      afterCreatedAt: c.req.query("afterCreatedAt"),
      principal: { kind: "user" as const, id: authUser.id },
    };
    return channelMessageResponse(() => channelMessageAnnotations(c.env, query));
  }));
  app.delete("/api/channels/:channelId/annotations/:annotationId", (c) => jsonErrors(c, async () => {
    const authUser = await requireHumanCaller(c, ANNOTATION_API_HUMAN_ONLY);
    if (authUser instanceof Response) return authUser;
    const channelId = c.req.param("channelId");
    const annotationId = c.req.param("annotationId");
    const command = {
      commandId: productCommandId(c.req.raw, "message-annotation", `remove:${annotationId}`), channelId,
      annotationId, action: "remove", actorUserId: authUser.id, principal: { kind: "user", id: authUser.id },
    };
    return channelMessageResponse(() => channelMessageCommand(c.env, channelId, "message-annotation", command));
  }));
  app.post("/api/channels/:channelId/join", async (c) => {
    try {
      const authUser = await requireAuth(c.req.raw, c.env);
      const channelId = c.req.param("channelId");
      if (authUser.agentRun) {
        const run = authUser.agentRun;
        await new PostgresAgentChannelAccessRepository(createPostgresAuthorityDatabase(c.env, {
          applicationName: "xmatrix-agent-channel-access", statementTimeoutMs: 5_000,
          transactionTimeoutMs: 10_000, lockTimeoutMs: 2_000,
        })).check({ requestId: crypto.randomUUID(), channelId, agentId: run.agentId,
          runProof: { runId: run.runId, instanceId: run.instanceId ?? "", executionKey: run.executionKey } });
      }
      const principal = authUser.agentRun
        ? { kind: "agent" as const, id: authUser.agentRun.agentId }
        : { kind: "user" as const, id: authUser.id };
      const sessions = beginLiveHumanPresenceRead(c.env, c.req.url);
      const current = await getChannel(c.env, { channelId, principal });
      return c.json({ ok: true, channel: await channelWithLiveHumanPresence(current, sessions) });
    } catch (error) {
      return requestErrorResponse(c, error);
    }
  });
  app.post("/api/channels/:channelId/leave", async (c) => {
    const channelId = c.req.param("channelId");
    try {
      const authUser = await requireAuth(c.req.raw, c.env);
      if (authUser.agentRun) {
        const left = await stopAgentRunLeavingChannel(c.env, authUser.agentRun, channelId);
        return c.json(left.body, left.status);
      }
      const read = await getChannel(c.env, { channelId, principal: { kind: "user", id: authUser.id } });
      if ((read.channel as Record<string, unknown>).mode === "closed") {
        await changeMembership(c.env, {
          commandId: productCommandId(c.req.raw, "domain", `channel-leave:${channelId}:${authUser.id}`),
          actorUserId: authUser.id, at: new Date().toISOString(), kind: "channel_access_remove", channelId,
          subjectKind: "user", subjectId: authUser.id,
        }).catch((error: unknown) => {
          if (!(error instanceof ControlError && error.status === 404)) throw error;
        });
      }
      return c.json({ ok: true });
    } catch (error) {
      return requestErrorResponse(c, error);
    }
  });
  for (const connectionPath of PUBLIC_DOMAIN_SOCKET_PATHS) {
    app.get(connectionPath, async (c) => {
      const upgradeHeader = c.req.header("Upgrade");
      if (upgradeHeader !== "websocket") {
        return c.text("Expected WebSocket upgrade", 426);
      }
      // A client names its owner so its socket lands in that user's cell.
      // The name is only a routing hint: the socket still authenticates on
      // its first frame, and every delivery is addressed by principal.
      const ownerCell = relayRuntimeOwnerCellName(new URL(c.req.url).searchParams.get("owner") ?? "");
      // Only this Worker names the cell; a client cannot claim one.
      const upgrade = new Request(c.req.raw);
      upgrade.headers.delete(RELAY_RUNTIME_CELL_HEADER);
      if (ownerCell) upgrade.headers.set(RELAY_RUNTIME_CELL_HEADER, ownerCell);
      return routeDomainSocket(
        upgrade,
        connectionPath,
        ownerCell ? relayRuntimeCellNamed(c.env, ownerCell) : getRelayRuntime(c.env),
      );
    });
  }
}
