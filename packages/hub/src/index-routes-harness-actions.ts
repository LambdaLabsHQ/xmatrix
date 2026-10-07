import type { Hono } from "hono";
import { HARNESS_ACTIONS, HUB_ROUTES, hasControlCharacter, validHarnessLoginCode, type HarnessAction,
  type HarnessActionStatus, type SerializedMachineDaemon } from "@xmatrix/protocol";
import type { Env } from "./types";
import { readHarnessActionStatus, readRecentHarnessActions } from "@xmatrix/db";
import { privateRouteResponse } from "./private-route-response";
import { readBoundedRequestBody, requireAuth, requireHumanAuth } from "./index-shared";
import { listOwnerMachineDaemons, machineDaemonCommand, machineDatabase, machineRepository } from "./machines";

function isMachineField(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && [...value].length <= 160 && !hasControlCharacter(value);
}

const NO_STORE = { "cache-control": "private, no-store" };

function refuse(error: string, status: number): Response {
  return Response.json({ error }, { status, headers: NO_STORE });
}

/**
 * Only a Machine's owner, signed in as a Human, asks it to act on a harness.
 * The request names a preset and an action; the daemon runs the official
 * recipe compiled into it. An Agent Run is refused here: an Agent asks the
 * owner through the request broker on its own Machine instead.
 */
export interface HarnessActionPort {
  authenticate: typeof requireAuth;
  daemons(env: Env, ownerUserId: string): Promise<SerializedMachineDaemon[]>;
  issue(env: Env, command: Record<string, unknown>): Promise<unknown>;
  status(env: Env, ownerUserId: string, controlId: string): Promise<Record<string, unknown>>;
  /** The latest owner-requested action per preset on one of the owner's Machines. */
  recent(env: Env, ownerUserId: string, machineId: string): Promise<HarnessActionStatus[]>;
}

const HARNESS_ACTION_PORT: HarnessActionPort = {
  authenticate: requireAuth,
  daemons: async (env, ownerUserId) =>
    await listOwnerMachineDaemons(machineRepository(env), ownerUserId) as unknown as SerializedMachineDaemon[],
  issue: machineDaemonCommand,
  status: async (env, ownerUserId, controlId) => ({ ...await readHarnessActionStatus(machineDatabase(env), {
    requestId: crypto.randomUUID(), ownerUserId, controlId }) }),
  recent: (env, ownerUserId, machineId) => readRecentHarnessActions(machineDatabase(env), {
    requestId: crypto.randomUUID(), ownerUserId, machineId }),
};

export function registerHarnessActionRoutes(app: Hono<{ Bindings: Env }>,
  dependencies: Partial<HarnessActionPort> = {}): void {
  const port = { ...HARNESS_ACTION_PORT, ...dependencies };
  app.post(HUB_ROUTES.machine_harness_actions, (c) => privateRouteResponse(async () => {
    const authenticated = await port.authenticate(c.req.raw, c.env);
    if (authenticated.agentRun) return refuse("Harness actions require the Machine's owner", 403);
    const user = requireHumanAuth(authenticated);
    const bytes = await readBoundedRequestBody(c.req.raw, 4_096);
    if (!bytes) return refuse("Harness action request too large", 413);
    let body: Record<string, unknown>;
    try { body = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>; } catch {
      return refuse("Invalid harness action request", 400);
    }
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
    const daemons = await port.daemons(c.env, user.id);
    const online = daemons.filter(daemon => daemon.machineId === machineId && daemon.status === "online");
    if (online.length !== 1) {
      return refuse(online.length ? "The Machine has conflicting active daemons" : "The Machine is offline", 409);
    }
    const daemon = online[0]!;
    const requestId = `harness:${crypto.randomUUID()}`;
    await port.issue(c.env, {
      ownerUserId: user.id, ownerEmail: daemon.email, machineId, hostId: daemon.hostId, daemonId: daemon.id,
      commandId: `issue:${requestId}`, action: "issue", controlId: requestId, commandType: "harness_action",
      principal: { kind: "user", id: user.id },
      payload: { type: "machine_harness_action", requestId, presetId, action, ...(code ? { code } : {}) },
    });
    return Response.json({ controlId: requestId, presetId, action, status: "queued" }, { status: 202, headers: NO_STORE });
  }));

  // What became of the owner's recent actions on one Machine, so a page opened later still shows it.
  app.get(HUB_ROUTES.machine_harness_actions, (c) => privateRouteResponse(async () => {
    const authenticated = await port.authenticate(c.req.raw, c.env);
    if (authenticated.agentRun) return refuse("Harness actions require the Machine's owner", 403);
    const user = requireHumanAuth(authenticated);
    const machineId = c.req.query("machineId");
    if (!isMachineField(machineId)) return refuse("Invalid harness action request", 400);
    return Response.json({ actions: await port.recent(c.env, user.id, machineId) }, { headers: NO_STORE });
  }));

  app.get(`${HUB_ROUTES.machine_harness_actions}/:controlId`, (c) => privateRouteResponse(async () => {
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
