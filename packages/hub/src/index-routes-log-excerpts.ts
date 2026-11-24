import type { Hono } from "hono";
import { isMachineField, issueToOnlineDaemon, MACHINE_ACTION_DELIVERY, NO_STORE, readActionBody, refuse,
  type MachineActionDelivery } from "./machine-action-routes";
import { readLogExcerptStatus } from "@xmatrix/db";
import { HUB_ROUTES, type LogExcerptStatus } from "@xmatrix/protocol";
import { requireAuth, requireHumanAuth } from "./index-shared";
import { machineDatabase } from "./machines";
import { privateRouteResponse } from "./private-route-response";
import type { Env } from "./types";

const OWNER_ONLY = "Only the Machine's owner can read its daemon logs";
const NOT_FOUND = "Log excerpt not found";

/**
 * A person handing a conversation to support previews their daemon's recent
 * log first (docs/cross-space-read-grants.md#support-handoffs). Only the
 * Machine's owner, signed in as a Human, asks for it or reads it; Agent Runs
 * are refused on every route. The daemon reads and redacts its own log on the
 * machine; the Hub keeps only the command's result, which only the owner reads.
 */
export interface LogExcerptPort extends MachineActionDelivery {
  authenticate: typeof requireAuth;
  status(env: Env, ownerUserId: string, controlId: string): Promise<LogExcerptStatus | { status: "missing" }>;
}

const LOG_EXCERPT_PORT: LogExcerptPort = {
  ...MACHINE_ACTION_DELIVERY,
  authenticate: requireAuth,
  status: (env, ownerUserId, controlId) => readLogExcerptStatus(machineDatabase(env), {
    requestId: crypto.randomUUID(), ownerUserId, controlId }),
};

export function registerLogExcerptRoutes(app: Hono<{ Bindings: Env }>,
  dependencies: Partial<LogExcerptPort> = {}): void {
  const port = { ...LOG_EXCERPT_PORT, ...dependencies };
  const owner = async (request: Request, env: Env) => {
    const authenticated = await port.authenticate(request, env);
    return authenticated.agentRun ? undefined : requireHumanAuth(authenticated);
  };

  app.post(HUB_ROUTES.machine_log_excerpts, (c) => privateRouteResponse(c, async () => {
    const user = await owner(c.req.raw, c.env);
    if (!user) return refuse(OWNER_ONLY, 403);
    const body = await readActionBody(c.req.raw, 4_096, "Log excerpt");
    if (body instanceof Response) return body;
    if (!isMachineField(body.machineId) || Object.keys(body).some((key) => key !== "machineId")) {
      return refuse("Invalid log excerpt request", 400);
    }
    const requestId = `logs:${crypto.randomUUID()}`;
    const refused = await issueToOnlineDaemon(port, c.env, { ownerUserId: user.id, machineId: body.machineId, requestId,
      commandType: "log_excerpt", payload: { type: "machine_log_excerpt", requestId } });
    if (refused) return refused;
    return Response.json({ controlId: requestId, status: "queued" }, { status: 202, headers: NO_STORE });
  }));

  app.get(`${HUB_ROUTES.machine_log_excerpts}/:controlId`, (c) => privateRouteResponse(c, async () => {
    const user = await owner(c.req.raw, c.env);
    if (!user) return refuse(OWNER_ONLY, 403);
    const controlId = c.req.param("controlId") ?? "";
    if (!/^logs:[0-9a-f-]{36}$/u.test(controlId)) return refuse(NOT_FOUND, 404);
    const status = await port.status(c.env, user.id, controlId);
    return status.status === "missing" ? refuse(NOT_FOUND, 404) : Response.json(status, { headers: NO_STORE });
  }));
}
