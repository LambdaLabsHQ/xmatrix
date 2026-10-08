import { Hono } from "hono";

import { DURABLE_OBJECT_RETRY_AFTER_SECONDS } from "./durable-object-failure";
import type { Env } from "./types";
import { registerAgentRebornRoutes } from "./index-routes-agent-reborn";
import { registerAgentRegistrationRoutes } from "./index-routes-agent-registration";
import { registerAgentRoutingRoutes } from "./index-routes-agent-routing";
import { actorUserId, requireAuth, requireHumanAuth, jsonErrors } from "./index-shared";
import { claimFirstMessageLaunch, dispatchRegistrationLaunchAnyway, showFirstMessageLaunch } from "./registration-launch-dispatch";
import { runtimePlacement, runtimeRepository } from "./runtime";
import { summonFirstMessageHarness } from "./product-message-post-commit";
import { wakeAgentLaunchChannel } from "./agent-launch-coordinator-wake";

const NO_STORE = { "cache-control": "private, no-store" };

export function registerAgentLaunchRoutes(app: Hono<{ Bindings: Env }>): void {
  registerAgentRegistrationRoutes(app);
  registerAgentRoutingRoutes(app);
  registerAgentRebornRoutes(app);
  app.post("/api/invocations/diagnostics", (c) => jsonErrors(c, async () => {
    const user = await requireAuth(c.req.raw, c.env);
    const body = await c.req.json().catch(() => null) as Record<string, unknown> | null;
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some((key) =>
        !["channelId", "runId", "sourceMessageIds", "limit", "cursor"].includes(key))) {
      return c.json({ error: "Invalid diagnostic selection" }, 400);
    }
    if ((body.channelId !== undefined && typeof body.channelId !== "string") ||
        (body.runId !== undefined && typeof body.runId !== "string") ||
        (body.sourceMessageIds !== undefined && (!Array.isArray(body.sourceMessageIds) ||
          body.sourceMessageIds.length > 100 || body.sourceMessageIds.some((id) => typeof id !== "string"))) ||
        (body.limit !== undefined && (!Number.isSafeInteger(body.limit) || Number(body.limit) < 1 || Number(body.limit) > 100)) ||
        (body.cursor !== undefined && body.cursor !== null && (typeof body.cursor !== "string" || body.cursor.length > 2000))) {
      return c.json({ error: "Invalid diagnostic selection" }, 400);
    }
    // An Agent reads diagnostics as its owner, proving the Channel Instance it runs as.
    const agent = user.agentRun;
    if (agent && agent.runKind !== "channel-instance") return c.json({ error: "Diagnostic principal is not allowed" }, 403);
    const reader = agent ? { actorUserId: agent.ownerUserId, agentProof: { agentId: agent.agentId, runId: agent.runId,
      instanceId: agent.instanceId ?? "", executionKey: agent.executionKey, channelId: agent.channelId, spaceId: agent.spaceId } }
      : { actorUserId: user.id };
    const report = await runtimeRepository(c.env).invocationDiagnostics({ requestId: crypto.randomUUID(), ...reader,
      ...(typeof body.channelId === "string" ? { channelId: body.channelId } : {}),
      ...(typeof body.runId === "string" ? { runId: body.runId } : {}),
      ...(body.sourceMessageIds === undefined ? {} : { sourceMessageIds: body.sourceMessageIds as string[] }),
      ...(body.limit === undefined ? {} : { limit: Number(body.limit) }),
      ...(body.cursor === undefined ? {} : { cursor: body.cursor as string | null }) });
    const version = c.env.CF_VERSION_METADATA;
    return c.json({ ...report, ...(typeof version?.id === "string" && /^[a-zA-Z0-9-]{1,100}$/u.test(version.id)
      ? { serverVersion: { id: version.id,
        ...(typeof version.tag === "string" && /^[a-zA-Z0-9._+-]{1,100}$/u.test(version.tag) ? { tag: version.tag } : {}) } } : {}) },
    200, { "cache-control": "private, no-store" });
  }));

  app.post("/api/channels/:channelId/agent-launches/query", (c) => jsonErrors(c, async () => {
    const authUser = await requireAuth(c.req.raw, c.env);
    const channelId = c.req.param("channelId");
    const body = await c.req.json().catch(() => ({})) as { sourceMessageIds?: unknown; cursor?: unknown; pageSize?: unknown };
    if (!Array.isArray(body.sourceMessageIds) || body.sourceMessageIds.length > 100 ||
        body.sourceMessageIds.some((value) => typeof value !== "string")) {
      return c.json({ error: "sourceMessageIds must contain at most 100 ids" }, 400);
    }
    if ((body.cursor !== undefined && body.cursor !== null &&
        (typeof body.cursor !== "string" || body.cursor.length > 2_000)) ||
        (body.pageSize !== undefined && (!Number.isSafeInteger(body.pageSize) ||
          Number(body.pageSize) < 1 || Number(body.pageSize) > 100))) {
      return c.json({ error: "Invalid invocation pagination" }, 400);
    }
    return c.json(await runtimeRepository(c.env).queryAgentLaunches({ requestId: crypto.randomUUID(),
      channelId, sourceMessageIds: body.sourceMessageIds as string[],
      ...(body.cursor === undefined ? {} : { cursor: body.cursor as string | null }),
      ...(body.pageSize === undefined ? {} : { pageSize: Number(body.pageSize) }),
      actorUserId: actorUserId(authUser) }), 200, NO_STORE);
  }));

  /* "Launch anyway": the author overrides Jev's reading of one summon. The
     body is only a claim; dispatch rechecks it against the stored body hash
     and requires the caller to be the message's author (or its Agent's owner). */
  app.post("/api/channels/:channelId/messages/:messageId/launch-anyway", (c) => jsonErrors(c, async () => {
    const authUser = requireHumanAuth(await requireAuth(c.req.raw, c.env));
    const input = await c.req.json().catch(() => null) as { body?: unknown; sourceMention?: unknown } | null;
    if (!input || typeof input.body !== "string" || typeof input.sourceMention !== "string" ||
        !input.sourceMention.trim() || input.sourceMention.length > 8_000 || input.body.length > 200_000) {
      return c.json({ error: "body and sourceMention are required" }, 400);
    }
    const result = await dispatchRegistrationLaunchAnyway({ env: c.env, channelId: c.req.param("channelId"),
      messageId: c.req.param("messageId"), body: input.body, sourceMention: input.sourceMention,
      actorUserId: actorUserId(authUser) });
    if (!result.prepared.length) return c.json({ error: result.rejected[0]?.code ?? "launch_anyway_rejected" }, 409);
    return c.json({ launchIds: result.prepared.map(item => item.launchId) }, 200, { "cache-control": "private, no-store" });
  }));

  /* A new conversation's first message: its author picks the harness that
     starts, or `none`, before Jev's reading decides. `shown` says the author
     now sees the choice, which restarts the window within its hold limit. The pick is written as the
     message's one decision first, so Jev's reading can never summon a second Agent. */
  app.post("/api/channels/:channelId/messages/:messageId/launch-choice", (c) => jsonErrors(c, async () => {
    const authUser = requireHumanAuth(await requireAuth(c.req.raw, c.env));
    const input = await c.req.json().catch(() => null) as { body?: unknown; harness?: unknown; shown?: unknown } | null;
    if (!input || typeof input.body !== "string" || !input.body.trim() || input.body.length > 200_000 ||
        (input.shown !== undefined && (input.shown !== true || input.harness !== undefined)) ||
        (input.harness !== undefined && (typeof input.harness !== "string" || !/^[a-z0-9][a-z0-9._-]{0,63}$/u.test(input.harness)))) {
      return c.json({ error: "body is required and harness must name one harness" }, 400);
    }
    const channelId = c.req.param("channelId"), messageId = c.req.param("messageId");
    const actor = actorUserId(authUser), harness = input.harness as string | undefined, body = input.body;
    if (input.shown) {
      // The author sees the choice now: the window restarts from here.
      return c.json(await showFirstMessageLaunch({ ...runtimePlacement(c.env),
        commandId: `first-message-shown:${messageId}`.slice(0, 200), channelId, messageId, body, actorUserId: actor,
      }), 200, NO_STORE);
    }
    const { claimed: won } = await claimFirstMessageLaunch({ ...runtimePlacement(c.env),
      commandId: `first-message-choice:${messageId}`.slice(0, 200), channelId, messageId, body,
      ...(harness ? { harness } : {}), actorUserId: actor });
    if (!won) return c.json({ error: "launch_choice_taken" }, 409);
    if (harness) {
      // The pick is summoned like any other: an `@<harness>` reply to the message.
      const summon = summonFirstMessageHarness({ env: c.env, channelId, messageId, actorUserId: actor, harness })
        .catch(error => console.error("First message summon failed", { channelId, messageId,
          error: error instanceof Error ? error.message : String(error) }));
      try { c.executionCtx.waitUntil(summon); } catch { await summon; }
    }
    return c.json({ claimed: true }, 202, { "cache-control": "private, no-store" });
  }));

  app.post("/api/agent-launches/:launchId/retry", (c) => jsonErrors(c, async () => {
    const authUser = await requireAuth(c.req.raw, c.env);
    const body = await c.req.json().catch(() => ({})) as { channelId?: unknown };
    if (typeof body.channelId !== "string" || !body.channelId.trim()) {
      return c.json({ error: "channelId is required" }, 400);
    }
    const channelId = body.channelId.trim();
    const retried = await runtimeRepository(c.env).retryAgentLaunch({ requestId: crypto.randomUUID(),
      launchId: c.req.param("launchId"), channelId, actorUserId: actorUserId(authUser), at: new Date().toISOString() });
    const wake = await wakeAgentLaunchChannel(c.env.RELAY_POSTGRES_AGENT_LAUNCH_CHANNEL,
      { channelId, launchIds: [c.req.param("launchId")] }).catch(() => undefined);
    if (!wake?.ok) {
      return c.json({ error: "Agent Launch coordinator is unavailable", retryable: true }, 503,
        { "retry-after": String(DURABLE_OBJECT_RETRY_AFTER_SECONDS) });
    }
    return c.json(retried, 200, NO_STORE);
  }));
}
