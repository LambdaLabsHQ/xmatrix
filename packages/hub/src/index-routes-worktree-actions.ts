import type { Hono } from "hono";
import { HUB_ROUTES, hasControlCharacter, parseWorktreeActionRequest, type SerializedMachineDaemon,
  type WorktreeActionStatus } from "@xmatrix/protocol";
import type { Env } from "./types";
import { readLatestWorktreeListing, readWorktreeActionStatus } from "@xmatrix/db";
import { privateRouteResponse } from "./private-route-response";
import { readBoundedRequestBody, requireAuth, requireHumanAuth } from "./index-shared";
import { listOwnerMachineDaemons, machineDaemonCommand, machineDatabase, machineRepository } from "./machines";

function isMachineField(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && [...value].length <= 160 && !hasControlCharacter(value);
}

const NO_STORE = { "cache-control": "private, no-store" };
const OWNER_ONLY = "Worktree management requires the Machine's owner";

function refuse(error: string, status: number): Response {
  return Response.json({ error }, { status, headers: NO_STORE });
}

/**
 * Only a Machine's owner, signed in as a Human, lists or reclaims its git
 * worktrees. Paths name trees from a listing; the daemon reclaims only trees
 * it finds registered with git itself, behind its own gates.
 */
export interface WorktreeActionPort {
  authenticate: typeof requireAuth;
  daemons(env: Env, ownerUserId: string): Promise<SerializedMachineDaemon[]>;
  issue(env: Env, command: Record<string, unknown>): Promise<unknown>;
  status(env: Env, ownerUserId: string, controlId: string): Promise<Record<string, unknown>>;
  latest(env: Env, ownerUserId: string, machineId: string): Promise<WorktreeActionStatus | undefined>;
}

const WORKTREE_ACTION_PORT: WorktreeActionPort = {
  authenticate: requireAuth,
  daemons: async (env, ownerUserId) =>
    await listOwnerMachineDaemons(machineRepository(env), ownerUserId) as unknown as SerializedMachineDaemon[],
  issue: machineDaemonCommand,
  status: async (env, ownerUserId, controlId) => ({ ...await readWorktreeActionStatus(machineDatabase(env), {
    requestId: crypto.randomUUID(), ownerUserId, controlId }) }),
  latest: (env, ownerUserId, machineId) => readLatestWorktreeListing(machineDatabase(env), {
    requestId: crypto.randomUUID(), ownerUserId, machineId }),
};

export function registerWorktreeActionRoutes(app: Hono<{ Bindings: Env }>,
  dependencies: Partial<WorktreeActionPort> = {}): void {
  const port = { ...WORKTREE_ACTION_PORT, ...dependencies };
  app.post(HUB_ROUTES.machine_worktree_actions, (c) => privateRouteResponse(c, async () => {
    const authenticated = await port.authenticate(c.req.raw, c.env);
    if (authenticated.agentRun) return refuse(OWNER_ONLY, 403);
    const user = requireHumanAuth(authenticated);
    const bytes = await readBoundedRequestBody(c.req.raw, 512_000);
    if (!bytes) return refuse("Worktree action request too large", 413);
    let body: Record<string, unknown>;
    try { body = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>; } catch {
      return refuse("Invalid worktree action request", 400);
    }
    const machineId = isMachineField(body.machineId) ? body.machineId : undefined;
    const requestId = `worktree:${crypto.randomUUID()}`;
    let request;
    try {
      request = parseWorktreeActionRequest({ requestId, action: body.action, paths: body.paths });
    } catch {
      return refuse("Invalid worktree action request", 400);
    }
    if (!machineId) return refuse("Invalid worktree action request", 400);
    const daemons = await port.daemons(c.env, user.id);
    const online = daemons.filter(daemon => daemon.machineId === machineId && daemon.status === "online");
    if (online.length !== 1) {
      return refuse(online.length ? "The Machine has conflicting active daemons" : "The Machine is offline", 409);
    }
    const daemon = online[0]!;
    await port.issue(c.env, {
      ownerUserId: user.id, ownerEmail: daemon.email, machineId, hostId: daemon.hostId, daemonId: daemon.id,
      commandId: `issue:${requestId}`, action: "issue", controlId: requestId, commandType: "worktree_action",
      principal: { kind: "user", id: user.id },
      payload: { type: "machine_worktree_action", requestId, action: request.action,
        ...(request.paths ? { paths: request.paths } : {}) },
    });
    return Response.json({ controlId: requestId, action: request.action, status: "queued" },
      { status: 202, headers: NO_STORE });
  }));

  // The latest listing the owner asked for on one Machine, so the page shows it before a new one finishes.
  app.get(HUB_ROUTES.machine_worktree_actions, (c) => privateRouteResponse(c, async () => {
    const authenticated = await port.authenticate(c.req.raw, c.env);
    if (authenticated.agentRun) return refuse(OWNER_ONLY, 403);
    const user = requireHumanAuth(authenticated);
    const machineId = c.req.query("machineId");
    if (!isMachineField(machineId)) return refuse("Invalid worktree action request", 400);
    return Response.json({ listing: await port.latest(c.env, user.id, machineId) ?? null }, { headers: NO_STORE });
  }));

  app.get(`${HUB_ROUTES.machine_worktree_actions}/:controlId`, (c) => privateRouteResponse(c, async () => {
    const authenticated = await port.authenticate(c.req.raw, c.env);
    if (authenticated.agentRun) return refuse(OWNER_ONLY, 403);
    const user = requireHumanAuth(authenticated);
    const controlId = c.req.param("controlId") ?? "";
    if (!/^worktree:[0-9a-f-]{36}$/u.test(controlId)) return refuse("Worktree action not found", 404);
    const status = await port.status(c.env, user.id, controlId);
    return status.status === "missing" ? refuse("Worktree action not found", 404)
      : Response.json(status, { headers: NO_STORE });
  }));
}
