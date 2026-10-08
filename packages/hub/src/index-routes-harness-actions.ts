import type { Hono } from "hono";
import { HARNESS_ACTIONS, HUB_ROUTES, validHarnessLoginCode, type HarnessAction,
  type HarnessActionStatus } from "@xmatrix/protocol";
import type { Env } from "./types";
import { readHarnessActionStatus, readRecentHarnessActions } from "@xmatrix/db";
import { privateRouteResponse } from "./private-route-response";
import { requireAuth, requireHumanAuth } from "./index-shared";
import { machineDatabase } from "./machines";
import { isMachineField, issueToOnlineDaemon, MACHINE_ACTION_DELIVERY, NO_STORE, readActionBody, refuse,
  type MachineActionDelivery } from "./machine-action-routes";

/**
 * Only a Machine's owner, signed in as a Human, asks it to act on a harness.
 * The request names a preset and an action; the daemon runs the official
 * recipe compiled into it. An Agent Run is refused here: an Agent asks the
 * owner through the request broker on its own Machine instead.
 */
export interface HarnessActionPort extends MachineActionDelivery {
  authenticate: typeof requireAuth;
  status(env: Env, ownerUserId: string, controlId: string): Promise<Record<string, unknown>>;
  /** The latest owner-requested action per preset on one of the owner's Machines. */
  recent(env: Env, ownerUserId: string, machineId: string): Promise<HarnessActionStatus[]>;
}

const HARNESS_ACTION_PORT: HarnessActionPort = {
  ...MACHINE_ACTION_DELIVERY,
  authenticate: requireAuth,
  status: async (env, ownerUserId, controlId) => ({ ...await readHarnessActionStatus(machineDatabase(env), {
    requestId: crypto.randomUUID(), ownerUserId, controlId }) }),
  recent: (env, ownerUserId, machineId) => readRecentHarnessActions(machineDatabase(env), {
    requestId: crypto.randomUUID(), ownerUserId, machineId }),
};

export function registerHarnessActionRoutes(app: Hono<{ Bindings: Env }>,
  dependencies: Partial<HarnessActionPort> = {}): void {
  const port = { ...HARNESS_ACTION_PORT, ...dependencies };
  app.post(HUB_ROUTES.machine_harness_actions, (c) => privateRouteResponse(c, async () => {
    const authenticated = await port.authenticate(c.req.raw, c.env);
    if (authenticated.agentRun) return refuse("Harness actions require the Machine's owner", 403);
    const user = requireHumanAuth(authenticated);
    const body = await readActionBody(c.req.raw, 4_096, "Harness action");
    if (body instanceof Response) return body;
    const machineId = isMachineField(body.machineId) ? body.machineId : undefined;
    const hostId = body.hostId === undefined ? undefined
      : isMachineField(body.hostId) ? body.hostId : null;
    const presetId = typeof body.presetId === "string" && /^[a-z][a-z0-9-]{0,63}$/u.test(body.presetId) ? body.presetId : undefined;
    const action = (HARNESS_ACTIONS as readonly string[]).includes(body.action as string) ? body.action as HarnessAction : undefined;
    // Only `login_finish` carries the code the harness's sign-in page showed the owner.
    const code = body.code === undefined ? undefined
      : action === "login_finish" && validHarnessLoginCode(body.code) ? body.code.trim() : null;
    if (!machineId || hostId === null || !presetId || !action || code === null) {
      return refuse("Invalid harness action request", 400);
    }
    const requestId = `harness:${crypto.randomUUID()}`;
    const refused = await issueToOnlineDaemon(port, c.env, { ownerUserId: user.id, machineId, requestId,
      commandType: "harness_action",
      payload: { type: "machine_harness_action", requestId, presetId, action, ...(code ? { code } : {}) } });
    if (refused) return refused;
    return Response.json({ controlId: requestId, presetId, action, status: "queued" }, { status: 202, headers: NO_STORE });
  }));

  // What became of the owner's recent actions on one Machine, so a page opened later still shows it.
  app.get(HUB_ROUTES.machine_harness_actions, (c) => privateRouteResponse(c, async () => {
    const authenticated = await port.authenticate(c.req.raw, c.env);
    if (authenticated.agentRun) return refuse("Harness actions require the Machine's owner", 403);
    const user = requireHumanAuth(authenticated);
    const machineId = c.req.query("machineId");
    if (!isMachineField(machineId)) return refuse("Invalid harness action request", 400);
    return Response.json({ actions: await port.recent(c.env, user.id, machineId) }, { headers: NO_STORE });
  }));

  app.get(`${HUB_ROUTES.machine_harness_actions}/:controlId`, (c) => privateRouteResponse(c, async () => {
    const authenticated = await port.authenticate(c.req.raw, c.env);
    // An Agent Run follows its owner's harness actions, as the owner would.
    const user = { id: authenticated.agentRun?.ownerUserId || authenticated.id };
    const controlId = c.req.param("controlId") ?? "";
    if (!/^harness:[0-9a-f-]{36}$/u.test(controlId)) return refuse("Harness action not found", 404);
    const status = await port.status(c.env, user.id, controlId);
    return status.status === "missing" ? refuse("Harness action not found", 404)
      : Response.json(status, { headers: NO_STORE });
  }));
}
