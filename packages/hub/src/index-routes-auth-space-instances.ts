import { Hono, type Context } from "hono";
import { HUB_ROUTES, isAgentStatus, isTerminalRunStatus, sha256Hex, hasControlCharacter } from "@xmatrix/protocol";
import type { Env } from "./types";
import type { AuthUser } from "./auth";
import { awaitAuthorityProbeBackoff } from "./authority-probe-backoff";
import { RELAY_RUNTIME_AGENT_TRACE_TERMINATE_PATH } from "./runtime-transport/relay-runtime-product-adapter";
import { INSTANCE_ABANDON_RESULT_TIMEOUT_MS, requireAuth, requireHumanAuth, productCommandId, jsonErrors, spaceResponse } from "./index-shared";
import { relayRuntimeCellsForOwners } from "./relay-authority-locator";
import { deterministicConversationId } from "./system-conversation";
import { listOwnerWorkspaces, workspaceRepository } from "./postgres-workspace-authority";
import { machineCommandStatus, machineDaemonCommand, machineRepository } from "./machines";
import { runtimeRepository } from "./runtime";
import { ControlError } from "@xmatrix/db";
import { createSpace, getSpace, listSpaces, updateSpace, updateSpaceMemberCreationPolicy } from "./spaces";

/** One status read of a daemon control; a status the authority leaves out counts as failed. */
async function readDaemonControlStatus(
  env: Env,
  kind: "spawn" | "stop",
  input: Record<string, unknown> & { ownerUserId: string; controlId: string },
): Promise<string> {
  const body = await machineCommandStatus(machineRepository(env), kind, input);
  return typeof body.status === "string" ? body.status : "failed";
}

const INSTANCE_ROUTE = "/api/spaces/:spaceId/channels/:channelId/agent-instances/:instanceId";

/** The caller's own membership row carries their current profile, not the stored copy. */
/** "Ada Lovelace's Space"; the email's name part when the account has none. */
export function personalSpaceName(user: Pick<AuthUser, "name" | "email">): string {
  const owner = user.name?.trim() || user.email.split("@")[0]?.trim() || "My";
  return owner === "My" ? "My Space" : `${owner.slice(0, 60)}'s Space`;
}

function withCallerMemberProfile(space: Record<string, unknown>, authUser: AuthUser): Record<string, unknown> {
  return {
    ...space,
    members: Array.isArray(space.members)
      ? (space.members as Array<Record<string, unknown>>).map((member) =>
          member.userId === authUser.id
            ? { ...member, email: authUser.email, name: authUser.name, avatarUrl: authUser.avatarUrl }
            : member
        )
      : [],
  };
}

/**
 * Commits a Space domain update, then answers the Space as the actor sees it.
 * The stable command id digests the change itself: keyed on the Space alone, a
 * second edit inside the idempotency window would replay the first.
 */
async function commitSpaceUpdate(
  c: Context<{ Bindings: Env }>,
  actorUserId: string,
  spaceId: string,
  update: { stableId: string; changes: unknown[] },
  commit: (command: { commandId: string; actorUserId: string; at: string; spaceId: string }) => Promise<unknown>,
): Promise<Response> {
  const updateDigest = (await sha256Hex(JSON.stringify(update.changes))).slice(0, 32);
  await commit({
    commandId: productCommandId(c.req.raw, "domain", `${update.stableId}:${spaceId}:${updateDigest}`),
    actorUserId, at: new Date().toISOString(), spaceId,
  });
  return spaceResponse(c, spaceId, actorUserId);
}

export function registerIndexRoutesAuthSpaceInstances(app: Hono<{ Bindings: Env }>): void {
  app.delete(INSTANCE_ROUTE, (c) => jsonErrors(c, async () => {
    const authUser = requireHumanAuth(await requireAuth(c.req.raw, c.env));
    const { instanceId } = c.req.param();
    const runtime = runtimeRepository(c.env);
    const readCurrentInstance = async () => (await runtime.getInstance({ requestId: crypto.randomUUID(),
      instanceId, actorUserId: authUser.id })).instance as Record<string, unknown>;
    let currentInstance = await readCurrentInstance();
    let runMetadata = currentInstance.runMetadata &&
        typeof currentInstance.runMetadata === "object" &&
        !Array.isArray(currentInstance.runMetadata)
      ? currentInstance.runMetadata as Record<string, unknown>
      : {};
    const exactMetadataString = (
      value: unknown,
      maxLength: number,
    ): string | undefined => {
      const normalized = typeof value === "string" ? value.trim() : "";
      if (!normalized || normalized.length > maxLength || hasControlCharacter(normalized)) {
        return undefined;
      }
      return normalized;
    };
    const runId = exactMetadataString(currentInstance.runId, 200);
    const instanceStatus = exactMetadataString(currentInstance.status, 32);
    const instanceVersion = Number(currentInstance.version);
    if (!runId || !instanceStatus || !isAgentStatus(instanceStatus) ||
        !Number.isSafeInteger(instanceVersion) || instanceVersion < 1) {
      return c.json({
        error: "Agent Instance is missing exact Authority delete authority",
        code: "missing_instance_delete_authority",
      }, 409, { "cache-control": "no-store" });
    }
    const rawDeletion = runMetadata.instanceDeletion;
    const deletion = rawDeletion && typeof rawDeletion === "object" && !Array.isArray(rawDeletion)
      ? rawDeletion as Record<string, unknown>
      : undefined;
    const deletionControlId = exactMetadataString(deletion?.controlId, 200);
    const controlDigest = await sha256Hex(JSON.stringify([
      authUser.id,
      instanceId,
      runId,
      "instance-delete",
    ]));
    const controlId = deletionControlId || `instance-delete:${controlDigest}`;
    const purgeTerminalTrace = async (controlId: string): Promise<Response> => {
      const terminalUrl = new URL(RELAY_RUNTIME_AGENT_TRACE_TERMINATE_PATH, c.req.url);
      terminalUrl.searchParams.set("instanceId", instanceId);
      // get-instance answers only the owner's Instances: the caller owns it.
      const terminalResponses = await Promise.all(relayRuntimeCellsForOwners(c.env, [authUser.id])
        .map((cell) => cell.fetch(new Request(terminalUrl, { method: "POST" }))));
      if (terminalResponses.some((response) => !response.ok)) {
        return c.json({ error: "Agent Instance stopped, but host trace purge notification failed" },
          503, { "cache-control": "no-store" });
      }
      return c.json({ ok: true, instanceId, status: "offline", controlId });
    };
    const prepareDeletionFence = async (
      controlId: string,
    ): Promise<
      { ok: true; version: number; deleted: boolean } |
      { ok: false; response: Response }
    > => {
      if (rawDeletion !== undefined) {
        if (!deletion || deletion.schemaVersion !== 1 ||
            (deletion.state !== "pending" && deletion.state !== "deleted") ||
            deletion.instanceId !== instanceId || deletion.runId !== runId ||
            deletion.controlId !== controlId) {
          return {
            ok: false,
            response: c.json({
              error: "Agent Instance has a conflicting delete fence",
              code: "instance_delete_fence_conflict",
            }, 409, { "cache-control": "no-store" }),
          };
        }
        return { ok: true, version: instanceVersion, deleted: deletion.state === "deleted" };
      }
      const prepared = await runtime.mutate({
        commandId: productCommandId(c.req.raw, "domain", `instance-delete-prepare:${controlId}`),
        actorUserId: authUser.id,
        at: new Date().toISOString(),
        kind: "instance_transition",
        instanceId,
        expectedVersion: instanceVersion,
        status: instanceStatus,
        deletePhase: "prepare",
        expectedRunId: runId,
        deleteControlId: controlId,
      });
      const nextVersion = Number(prepared.entityVersion);
      if (!Number.isSafeInteger(nextVersion) || nextVersion !== instanceVersion + 1) {
        return {
          ok: false,
          response: c.json({
            error: "Authority returned invalid Agent Instance delete fence authority",
            code: "invalid_instance_delete_fence_result",
          }, 502, { "cache-control": "no-store" }),
        };
      }
      return { ok: true, version: nextVersion, deleted: false };
    };
    const terminalizeInstance = async (
      controlId: string,
      fencedVersion: number,
    ): Promise<Response> => {
      await runtime.mutate({
        commandId: productCommandId(c.req.raw, "domain", `instance-delete:${controlId}`),
        actorUserId: authUser.id,
        at: new Date().toISOString(),
        kind: "instance_transition",
        instanceId,
        expectedVersion: fencedVersion,
        status: "offline",
        terminal: true,
        deletePhase: "commit",
        expectedRunId: runId,
        deleteControlId: controlId,
      });
      return purgeTerminalTrace(controlId);
    };
    const executionKey = exactMetadataString(runMetadata.executionKey, 200);
    // A Run's actor is its Instance.
    const agentId = instanceId;
    const machineId = exactMetadataString(runMetadata.machineId, 160);
    const hostId = exactMetadataString(runMetadata.hostname ?? runMetadata.hostId, 160) || "";
    const resumeSessionKey = exactMetadataString(
      runMetadata.resumeSessionKey,
      240,
    );
    if (!runId || !executionKey || !agentId || !machineId || !resumeSessionKey) {
      return c.json({
        error: "Agent Instance is missing exact daemon authority for abandon",
        code: "missing_instance_abandon_authority",
      }, 409, { "cache-control": "no-store" });
    }
    let deletionFence: { version: number; deleted: boolean } | undefined;
    const ensureDeletionFence = async (): Promise<
      { ok: true; version: number; deleted: boolean } |
      { ok: false; response: Response }
    > => {
      if (deletionFence) return { ok: true, ...deletionFence };
      const prepared = await prepareDeletionFence(controlId);
      if (prepared.ok) {
        deletionFence = { version: prepared.version, deleted: prepared.deleted };
      }
      return prepared;
    };

    let runStatus = exactMetadataString(currentInstance.runStatus, 32);
    if (runStatus === "starting" && runMetadata.repoPool === undefined) {
      const spawnControlId = exactMetadataString(runMetadata.spawnControlId, 200);
      if (!spawnControlId) {
        return c.json({
          error: "Starting Agent Instance is missing exact spawn authority",
          code: "missing_instance_spawn_authority",
        }, 409, { "cache-control": "no-store" });
      }
      const fence = await ensureDeletionFence();
      if (!fence.ok) return fence.response;
      if (fence.deleted) return purgeTerminalTrace(controlId);
      const spawnStatusQuery = {
        controlId: spawnControlId,
        runId,
        executionKey,
        instanceId,
        ownerUserId: authUser.id,
        machineId,
        hostId,
      };
      const readSpawnStatus = () => readDaemonControlStatus(c.env, "spawn", spawnStatusQuery);
      let spawnStatus = await readSpawnStatus();
      const deadline = Date.now() + INSTANCE_ABANDON_RESULT_TIMEOUT_MS;
      for (let attempt = 1;
        spawnStatus !== "completed" && spawnStatus !== "failed";
        attempt += 1) {
        if (!await awaitAuthorityProbeBackoff(attempt, deadline)) break;
        spawnStatus = await readSpawnStatus();
      }
      if (spawnStatus !== "completed" && spawnStatus !== "failed") {
        return c.json({
          ok: true,
          pending: true,
          instanceId,
          controlId,
          status: `spawn_${spawnStatus}`,
        }, 202, { "cache-control": "no-store" });
      }
      // A failed spawn acknowledgement does not prove the child tree was
      // never admitted: daemon registry persistence and child termination
      // can both fail after a pooled lease exists. Re-read any authority the
      // result did persist, then require the same exact stop/abandon path as
      // a successful spawn rather than terminalizing from `ok: false`.
      // The command completes before the Run records that result (its
      // pooled slot among it), so wait for the Run's own spawn marker.
      const readInstance = async () => {
        currentInstance = await readCurrentInstance();
        runMetadata = currentInstance.runMetadata && typeof currentInstance.runMetadata === "object" &&
            !Array.isArray(currentInstance.runMetadata)
          ? currentInstance.runMetadata as Record<string, unknown>
          : {};
        const applied = runMetadata.spawnResult as Record<string, unknown> | undefined;
        return applied?.controlId === spawnControlId;
      };
      let applied = await readInstance();
      for (let attempt = 1; !applied; attempt += 1) {
        if (!await awaitAuthorityProbeBackoff(attempt, deadline)) break;
        applied = await readInstance();
      }
      if (!applied) {
        return c.json({
          ok: true,
          pending: true,
          instanceId,
          controlId,
          status: "spawn_result_pending",
        }, 202, { "cache-control": "no-store" });
      }
      if (exactMetadataString(currentInstance.runId, 200) !== runId ||
          exactMetadataString(runMetadata.executionKey, 200) !== executionKey ||
          exactMetadataString(runMetadata.machineId, 160) !== machineId ||
          exactMetadataString(runMetadata.resumeSessionKey, 240) !== resumeSessionKey) {
        return c.json({
          error: "Agent Instance daemon authority changed while delete waited for spawn",
          code: "instance_spawn_delete_authority_changed",
        }, 409, { "cache-control": "no-store" });
      }
      runStatus = exactMetadataString(currentInstance.runStatus, 32);
    }

    const rawTerminalEvidence = runMetadata.daemonTerminalEvidence;
    const terminalEvidence = rawTerminalEvidence && typeof rawTerminalEvidence === "object" &&
        !Array.isArray(rawTerminalEvidence)
      ? rawTerminalEvidence as Record<string, unknown>
      : undefined;
    const exactTerminalEvidence = terminalEvidence?.schemaVersion === 1 &&
      terminalEvidence.runId === runId && terminalEvidence.executionKey === executionKey &&
      terminalEvidence.machineId === machineId &&
      ["run_exited", "stop_succeeded"].includes(String(terminalEvidence.kind));
    if (runMetadata.repoPool === undefined && exactTerminalEvidence &&
        isTerminalRunStatus(runStatus)) {
      // Only authenticated daemon evidence may bypass a second stop for an
      // already terminal historical non-pooled Run. A domain transition such
      // as channel archive is not process-tree evidence.
      const fence = await ensureDeletionFence();
      if (!fence.ok) return fence.response;
      if (fence.deleted) return purgeTerminalTrace(controlId);
      return terminalizeInstance(controlId, fence.version);
    }

    const rawRepoPool = runMetadata.repoPool;
    let repoPool: {
      repoIdentity: string;
      repoKeyId: string;
      slotId: string;
    } | undefined;
    if (rawRepoPool !== undefined) {
      if (!rawRepoPool || typeof rawRepoPool !== "object" || Array.isArray(rawRepoPool)) {
        return c.json({
          error: "Agent Instance repo pool authority is invalid",
          code: "invalid_repo_pool_authority",
        }, 409, { "cache-control": "no-store" });
      }
      const value = rawRepoPool as Record<string, unknown>;
      const repoIdentity = exactMetadataString(value.repoIdentity, 1_000);
      const repoKeyId = exactMetadataString(value.repoKeyId, 64);
      const slotId = exactMetadataString(value.slotId, 32);
      if (!repoIdentity || !repoKeyId || !slotId ||
          !/^[0-9a-f]{64}$/u.test(repoKeyId) ||
          !/^[0-9a-f]{32}$/u.test(slotId)) {
        return c.json({
          error: "Agent Instance repo pool authority is invalid",
          code: "invalid_repo_pool_authority",
        }, 409, { "cache-control": "no-store" });
      }
      repoPool = { repoIdentity, repoKeyId, slotId };
    }
    // Establish the durable Authority fence before issuing typed abandon. A
    // concurrent/stale reborn can therefore never rebind this Instance after
    // its retained slot has been returned to the repo pool.
    const fence = await ensureDeletionFence();
    if (!fence.ok) return fence.response;
    if (fence.deleted) return purgeTerminalTrace(controlId);
    const statusQuery = {
      controlId,
      runId,
      executionKey,
      agentId,
      instanceId,
      ownerUserId: authUser.id,
      machineId,
      hostId,
      ...(repoPool
        ? { resumeSessionKey, worktreeDisposition: "abandon", ...repoPool }
        : {}),
    };
    const readStopStatus = () => readDaemonControlStatus(c.env, "stop", statusQuery);

    let stopStatus = await readStopStatus();
    if (stopStatus === "missing") {
      const stop = {
        commandId: productCommandId(
          c.req.raw,
          "machine-daemon-control",
          `instance-abandon:${controlId}`,
        ),
        action: "issue",
        controlId,
        commandType: "stop",
        ownerUserId: authUser.id,
        ownerEmail: authUser.email,
        machineId,
        hostId,
        payload: {
          type: "machine_stop_agent",
          requestId: controlId,
          runId,
          executionKey,
          agentId,
          instanceId,
          reason: "Owner deleted Agent Instance",
          ...(repoPool
            ? { resumeSessionKey, worktreeDisposition: "abandon", ...repoPool }
            : {}),
        },
        metadata: {},
        capabilities: [],
        principal: { kind: "user", id: authUser.id },
      };
      try {
        await machineDaemonCommand(c.env, stop);
        stopStatus = "queued";
      } catch (error) {
        // A concurrent idempotent DELETE may have committed the same exact
        // intent after our initial read. Only the exact status query may
        // recover that race; a different command remains forbidden.
        if (!(error instanceof ControlError) || error.status !== 409) throw error;
        stopStatus = await readStopStatus();
        if (stopStatus === "missing") throw error;
      }
    }

    if (stopStatus !== "completed" && stopStatus !== "failed") {
      const deadline = Date.now() + INSTANCE_ABANDON_RESULT_TIMEOUT_MS;
      for (let attempt = 1; ; attempt += 1) {
        if (!await awaitAuthorityProbeBackoff(attempt, deadline)) break;
        stopStatus = await readStopStatus();
        if (stopStatus === "completed" || stopStatus === "failed") break;
      }
    }
    if (stopStatus === "failed") {
      return c.json({
        error: "Machine Daemon could not abandon the Agent Instance worktree",
        code: "instance_abandon_failed",
        controlId,
      }, 409, { "cache-control": "no-store" });
    }
    if (stopStatus !== "completed") {
      return c.json({
        ok: true,
        pending: true,
        instanceId,
        controlId,
        status: stopStatus,
      }, 202, { "cache-control": "no-store" });
    }

    return terminalizeInstance(controlId, fence.version);
  }));
  app.patch(INSTANCE_ROUTE, (c) => jsonErrors(c, async () => {
    const authUser = await requireAuth(c.req.raw, c.env);
    const { spaceId, channelId, instanceId } = c.req.param();
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    const currentInstance = (await runtimeRepository(c.env).getInstance({ requestId: crypto.randomUUID(),
      instanceId, actorUserId: authUser.id })).instance as Record<string, unknown>;
    const explicitStatus = typeof body.status === "string" && body.status.trim()
      ? body.status.trim()
      : undefined;
    if (!explicitStatus) {
      // Retired pause/resume payloads (`paused`, `action`) land here: an
      // Instance is live or it is not, so there is nothing to toggle.
      return c.json({ error: "instance status is invalid" }, 400);
    }
    const expectedVersion = Number(currentInstance.version);
    await runtimeRepository(c.env).mutate({
      commandId: productCommandId(c.req.raw, "domain", `instance-patch:${instanceId}:${explicitStatus}`),
      actorUserId: authUser.id,
      at: new Date().toISOString(),
      kind: "instance_transition",
      spaceId,
      channelId,
      instanceId,
      status: explicitStatus,
      ...(Number.isSafeInteger(expectedVersion) ? { expectedVersion } : {}),
    });
    const liveStatus = String(currentInstance.status || "online");
    const rawOrdinal = currentInstance.channelInstanceId ?? currentInstance.channel_instance_id;
    const channelInstanceId = rawOrdinal !== undefined && rawOrdinal !== null && String(rawOrdinal).trim()
      ? String(rawOrdinal).trim()
      : "1";
    const agentId = instanceId;
    return c.json({
      instance: { id: instanceId, status: explicitStatus || liveStatus },
      agent: {
        id: agentId,
        instances: [{
          id: instanceId,
          channelInstanceId,
          label: `${agentId}:${channelInstanceId}`,
          status: explicitStatus || liveStatus,
        }],
      },
    });
  }));
  app.get(HUB_ROUTES.workspaces, (c) => jsonErrors(c, async () => {
    const authUser = await requireAuth(c.req.raw, c.env);
    const ownerUserId = authUser.agentRun?.ownerUserId || authUser.id;
    return c.json({ workspaces: await listOwnerWorkspaces(workspaceRepository(c.env), ownerUserId) });
  }));
  app.post(HUB_ROUTES.workspaces, (c) => jsonErrors(c, async () => {
    const authUser = await requireAuth(c.req.raw, c.env);
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    const machineId = typeof body.machineId === "string" ? body.machineId.trim() : "";
    const canonicalCwd = typeof (body.canonicalCwd ?? body.cwd) === "string"
      ? String(body.canonicalCwd ?? body.cwd).trim()
      : "";
    if (!machineId || !canonicalCwd) {
      return c.json({ error: "machineId and canonicalCwd are required" }, 400);
    }
    // An Agent Run registers its owner's directories on its own Machine.
    const ownerUserId = authUser.agentRun?.ownerUserId || authUser.id;
    if (authUser.agentRun && machineId !== authUser.agentRun.machineId) {
      return c.json({ error: "An Agent Run registers Workspaces only on its own Machine" }, 403);
    }
    const metadata = body.metadata && typeof body.metadata === "object" && !Array.isArray(body.metadata)
      ? { ...(body.metadata as Record<string, unknown>) }
      : {};
    for (const key of [
      "hostId", "hostName", "hostname", "displayName", "repoRoot", "gitRemote", "gitBranch",
      "runtimesSeen", "boundChannelIds", "visibility", "lastSeenAt",
    ]) {
      if (body[key] !== undefined) metadata[key] = body[key];
    }
    const workspaces = workspaceRepository(c.env);
    await workspaces.mutate({
      commandId: productCommandId(c.req.raw, "domain"), actorUserId: ownerUserId,
      at: new Date().toISOString(), kind: "workspace_put", machineId,
      canonicalCwd, metadata,
    });
    const { workspace } = await workspaces.getExact({
      requestId: crypto.randomUUID(), ownerUserId, machineId, canonicalCwd,
    });
    return c.json({ workspace }, 201);
  }));
  app.delete(HUB_ROUTES.workspaces, (c) => jsonErrors(c, async () => {
    const authUser = await requireAuth(c.req.raw, c.env);
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    const machineId = typeof body.machineId === "string" ? body.machineId.trim() : "";
    const canonicalCwd = typeof body.canonicalCwd === "string" ? body.canonicalCwd.trim() : "";
    if (!machineId || !canonicalCwd) {
      return c.json({ error: "machineId and canonicalCwd are required" }, 400);
    }
    await workspaceRepository(c.env).mutate({
      commandId: productCommandId(c.req.raw, "domain"), actorUserId: authUser.id,
      at: new Date().toISOString(), kind: "workspace_remove", machineId, canonicalCwd,
    });
    return c.json({ ok: true, workspace: { machineId, canonicalCwd } });
  }));
  app.get(HUB_ROUTES.status, async (c) => {
    // Public reachability probe (`xmatrix status`, onboarding, /console). Live
    // presence belongs to the Runtime and a global count is not public, so the
    // authority host answers reachability only.
    return c.json({ status: "ok" }, 200, { "cache-control": "no-store" });
  });
  app.get(HUB_ROUTES.spaces, (c) => jsonErrors(c, async () => {
    const authUser = await requireAuth(c.req.raw, c.env);
    if (authUser.agentRun) {
      // Match the Agent catalog's Profile Space scope. Never enumerate the
      // owner's memberships.
      const { agentId, spaceId } = authUser.agentRun;
      if (!spaceId) return c.json({ error: "Agent Profile Space is unavailable" }, 403);
      return c.json({ spaces: [await getSpace(c.env, { spaceId, principal: { kind: "agent", id: agentId } })] });
    }
    const spaces = await listSpaces(c.env, { kind: "user", id: authUser.id });
    return c.json({
      spaces: spaces.map((space) => withCallerMemberProfile(space, authUser)),
    });
  }));
  app.post(HUB_ROUTES.spaces, (c) => jsonErrors(c, async () => {
    const authUser = await requireAuth(c.req.raw, c.env);
    const bodyText = await c.req.text();
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(bodyText || "{}") as Record<string, unknown>;
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    const spaceName = typeof body.name === "string" ? body.name.trim() : "";
    if (!spaceName) return c.json({ error: "Space name is required" }, 400);
    const spaceId = crypto.randomUUID();
    if (body.metadata !== undefined &&
        (!body.metadata || typeof body.metadata !== "object" || Array.isArray(body.metadata))) {
      return c.json({ error: "request body must be an object", code: "invalid_command" }, 400);
    }
    const space = await createSpace(c.env, {
      commandId: productCommandId(c.req.raw, "create-space", spaceId),
      spaceId, ownerUserId: authUser.id, name: spaceName,
      ...(body.metadata === undefined ? {} : { metadata: body.metadata as Record<string, unknown> }),
    });
    return c.json({
      space: {
        id: space.id,
        name: space.name,
        ownerId: authUser.id,
        memberPermissions: {
          agentCreation: "members",
          automationCreation: "members",
        },
        members: [{
          userId: authUser.id,
          email: authUser.email,
          name: authUser.name,
          avatarUrl: authUser.avatarUrl,
          role: "owner",
          joinedAt: space.createdAt,
        }],
        createdAt: space.createdAt,
        updatedAt: space.updatedAt,
        ...(body.metadata && typeof body.metadata === "object" ? { metadata: body.metadata } : {}),
      },
    });
  }));
  /* The Space a person lands in the first time they open xMatrix, so a new
     account never starts on an empty app it cannot act in. It exists only
     for someone with no Space at all: an invite or join link gives them one
     first, so they are never handed a second, empty one. The id derives from
     the account, so a retry or a second tab replays the same command, and a
     personal Space that was later deleted is not created again. */
  app.post(HUB_ROUTES.personal_space, (c) => jsonErrors(c, async () => {
    const authUser = await requireAuth(c.req.raw, c.env);
    const principal = { kind: "user" as const, id: authUser.id };
    if ((await listSpaces(c.env, principal)).length > 0) return c.json({ space: null });
    const spaceId = await deterministicConversationId("personal-space", authUser.id);
    try {
      await createSpace(c.env, {
        commandId: `personal-space:${authUser.id}`,
        spaceId, ownerUserId: authUser.id, name: personalSpaceName(authUser),
      });
    } catch (error) {
      if (error instanceof ControlError && error.status === 409) return c.json({ space: null });
      throw error;
    }
    const space = (await listSpaces(c.env, principal)).find((candidate) => candidate.id === spaceId);
    return c.json({ space: space ? withCallerMemberProfile(space, authUser) : null });
  }));
  app.get("/api/spaces/:spaceId", (c) => jsonErrors(c, async () => {
    const authUser = await requireAuth(c.req.raw, c.env);
    const space = await getSpace(c.env, { spaceId: c.req.param("spaceId"), principal: { kind: "user", id: authUser.id } });
    return c.json({ space: withCallerMemberProfile(space, authUser) });
  }));
  app.patch("/api/spaces/:spaceId", (c) => jsonErrors(c, async () => {
    const authUser = await requireAuth(c.req.raw, c.env);
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    const spaceId = c.req.param("spaceId");
    /* The stable id has to describe *this* update, not merely the Space.
       Keyed on the Space alone, a second edit inside the idempotency window
       is treated as a replay of the first and refused — so renaming a Space
       twice in a day, or adding a setting to one configured this morning,
       failed with an error that named none of that. */
    return commitSpaceUpdate(c, authUser.id, spaceId, {
      stableId: "space-update", changes: [body.name ?? null, body.metadata ?? null],
    }, (command) => updateSpace(c.env, {
      ...command,
      ...(typeof body.name === "string" ? { name: body.name } : {}),
      ...(body.metadata && typeof body.metadata === "object"
        ? { metadata: body.metadata as Record<string, unknown> } : {}),
    }));
  }));
  app.patch("/api/spaces/:spaceId/member-permissions", (c) => jsonErrors(c, async () => {
    const authUser = requireHumanAuth(await requireAuth(c.req.raw, c.env));
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    const allowedFields = new Set(["agentCreation", "automationCreation"]);
    const unsupported = Object.keys(body).filter((field) => !allowedFields.has(field));
    if (unsupported.length > 0) {
      return c.json({ error: `unsupported fields are not accepted: ${unsupported.join(", ")}` }, 400);
    }
    if (body.agentCreation === undefined && body.automationCreation === undefined) {
      return c.json({ error: "at least one member permission is required" }, 400);
    }
    for (const [field, value] of [
      ["agentCreation", body.agentCreation],
      ["automationCreation", body.automationCreation],
    ] as const) {
      if (value !== undefined && value !== "members" && value !== "admins") {
        return c.json({ error: `${field} must be members or admins` }, 400);
      }
    }
    const spaceId = c.req.param("spaceId");
    return commitSpaceUpdate(c, authUser.id, spaceId, {
      stableId: "space-member-permissions", changes: [body.agentCreation ?? null, body.automationCreation ?? null],
    }, (command) => updateSpaceMemberCreationPolicy(c.env, {
      ...command,
      ...(body.agentCreation !== undefined ? { agentCreation: body.agentCreation as "members" | "admins" } : {}),
      ...(body.automationCreation !== undefined
        ? { automationCreation: body.automationCreation as "members" | "admins" } : {}),
    }));
  }));
}
