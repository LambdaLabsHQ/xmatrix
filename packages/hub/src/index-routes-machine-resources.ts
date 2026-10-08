import type { Hono } from "hono";
import { maintainMachineResourceHistory, parseMachineResourceHistoryRange, readMachineResourceHistory,
  type AuthorityDatabase } from "@xmatrix/db";
import type { Env } from "./types";
import { privateRouteResponse } from "./private-route-response";
import { requireAuth, requireHumanAuth } from "./index-shared";
import { machineDatabase } from "./machines";

const NO_STORE = { "cache-control": "private, no-store" };

/** The owner reads one of their Machines' load over a range; an Agent Run is refused. */
export function registerMachineResourceRoutes(app: Hono<{ Bindings: Env }>, dependencies: {
  authenticate?: typeof requireAuth; database?: AuthorityDatabase; now?: () => number;
} = {}): void {
  const authenticate = dependencies.authenticate ?? requireAuth;
  app.get("/api/machines/:machineId/resource-history", (c) => privateRouteResponse(c, async () => {
    const authenticated = await authenticate(c.req.raw, c.env);
    if (authenticated.agentRun) {
      return Response.json({ error: "Reading Machine load history requires its owner" }, { status: 403, headers: NO_STORE });
    }
    const user = requireHumanAuth(authenticated);
    const range = parseMachineResourceHistoryRange(c.req.query("range"));
    return Response.json(await readMachineResourceHistory(machineDatabase(c.env, dependencies.database), {
      requestId: crypto.randomUUID(), ownerUserId: user.id, machineId: c.req.param("machineId") ?? "", range,
      ...(dependencies.now ? { now: dependencies.now() } : {}),
    }), { headers: NO_STORE });
  }));
}

/** The minute of each hour when the scheduled tick rolls up and prunes load history. */
const MAINTENANCE_MINUTE = 7;

/** Called on every scheduled tick; does its work once an hour. */
export async function maintainMachineResourceHistoryOnSchedule(env: Env, scheduledTime: number,
  database?: AuthorityDatabase): Promise<void> {
  if (new Date(scheduledTime).getUTCMinutes() !== MAINTENANCE_MINUTE) return;
  await maintainMachineResourceHistory(machineDatabase(env, database), {
    requestId: `machine-resource-history:${scheduledTime}`, now: scheduledTime,
  });
}
