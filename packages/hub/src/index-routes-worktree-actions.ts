import type { Hono } from "hono";
import { HUB_ROUTES, parseWorktreeActionRequest, type WorktreeActionRequest, type WorktreeActionStatus } from "@xmatrix/protocol";
import type { Env } from "./types";
import { readLatestWorktreeListing, readWorktreeActionStatus } from "@xmatrix/db";
import { privateRouteResponse } from "./private-route-response";
import { requireAuth, requireHumanAuth } from "./index-shared";
import { machineDatabase } from "./machines";
import { isMachineField, issueToOnlineDaemon, MACHINE_ACTION_DELIVERY, NO_STORE, readActionBody, refuse,
  type MachineActionDelivery } from "./machine-action-routes";

const OWNER_ONLY = "Worktree management requires the Machine's owner";
const INVALID = "Invalid worktree action request";

/**
 * Only a Machine's owner, signed in as a Human, lists or reclaims its git
 * worktrees; Agent Runs are refused on every route. Paths name trees from a
 * listing; the daemon reclaims only trees it finds registered with git itself,
 * behind its own gates.
 */
export interface WorktreeActionPort extends MachineActionDelivery {
  authenticate: typeof requireAuth;
  status(env: Env, ownerUserId: string, controlId: string): Promise<Record<string, unknown>>;
  /** The owner's latest completed listing of one Machine in the last day. */
  latest(env: Env, ownerUserId: string, machineId: string): Promise<WorktreeActionStatus | undefined>;
}

const WORKTREE_ACTION_PORT: WorktreeActionPort = {
  ...MACHINE_ACTION_DELIVERY,
  authenticate: requireAuth,
  status: async (env, ownerUserId, controlId) => ({ ...await readWorktreeActionStatus(machineDatabase(env), {
    requestId: crypto.randomUUID(), ownerUserId, controlId }) }),
  latest: (env, ownerUserId, machineId) => readLatestWorktreeListing(machineDatabase(env), {
    requestId: crypto.randomUUID(), ownerUserId, machineId }),
};

export function registerWorktreeActionRoutes(app: Hono<{ Bindings: Env }>,
  dependencies: Partial<WorktreeActionPort> = {}): void {
  const port = { ...WORKTREE_ACTION_PORT, ...dependencies };
  const owner = async (request: Request, env: Env) => {
    const authenticated = await port.authenticate(request, env);
    return authenticated.agentRun ? undefined : requireHumanAuth(authenticated);
  };

  app.post(HUB_ROUTES.machine_worktree_actions, (c) => privateRouteResponse(c, async () => {
    const user = await owner(c.req.raw, c.env);
    if (!user) return refuse(OWNER_ONLY, 403);
    // Up to 500 chosen paths of a listing.
    const body = await readActionBody(c.req.raw, 512_000, "Worktree action");
    if (body instanceof Response) return body;
    const requestId = `worktree:${crypto.randomUUID()}`;
    let request: WorktreeActionRequest;
    try {
      request = parseWorktreeActionRequest({ requestId, action: body.action, paths: body.paths });
    } catch {
      return refuse(INVALID, 400);
    }
    if (!isMachineField(body.machineId)) return refuse(INVALID, 400);
    const refused = await issueToOnlineDaemon(port, c.env, { ownerUserId: user.id, machineId: body.machineId, requestId,
      commandType: "worktree_action", payload: { type: "machine_worktree_action", requestId, action: request.action,
        ...(request.paths ? { paths: request.paths } : {}) } });
    if (refused) return refused;
    return Response.json({ controlId: requestId, action: request.action, status: "queued" },
      { status: 202, headers: NO_STORE });
  }));

  // The latest listing, so the page shows it before a new one finishes sizing every tree.
  app.get(HUB_ROUTES.machine_worktree_actions, (c) => privateRouteResponse(c, async () => {
    const user = await owner(c.req.raw, c.env);
    if (!user) return refuse(OWNER_ONLY, 403);
    const machineId = c.req.query("machineId");
    if (!isMachineField(machineId)) return refuse(INVALID, 400);
    return Response.json({ listing: await port.latest(c.env, user.id, machineId) ?? null }, { headers: NO_STORE });
  }));

  app.get(`${HUB_ROUTES.machine_worktree_actions}/:controlId`, (c) => privateRouteResponse(c, async () => {
    const user = await owner(c.req.raw, c.env);
    if (!user) return refuse(OWNER_ONLY, 403);
    const controlId = c.req.param("controlId") ?? "";
    if (!/^worktree:[0-9a-f-]{36}$/u.test(controlId)) return refuse("Worktree action not found", 404);
    const status = await port.status(c.env, user.id, controlId);
    return status.status === "missing" ? refuse("Worktree action not found", 404)
      : Response.json(status, { headers: NO_STORE });
  }));
}
