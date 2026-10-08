import type { Hono } from "hono";
import { rejoinMachine, type AuthorityDatabase } from "@xmatrix/db";
import type { Env } from "./types";
import { privateRouteResponse } from "./private-route-response";
import { requireAuth, requireHumanAuth } from "./index-shared";
import { machineDatabase, retireOwnerMachine } from "./machines";
import { wakeRegistrationChannels } from "./registration-authority-wake";

const NO_STORE = { "cache-control": "private, no-store" };

export function registerMachineRetirementRoutes(app: Hono<{ Bindings: Env }>, dependencies: {
  authenticate?: typeof requireAuth; database?: AuthorityDatabase;
  wakeRegistrationChannels?: typeof wakeRegistrationChannels;
} = {}): void {
  for (const [method, path, rejoin] of [
    ["delete", "/api/machines/:machineId", false],
    ["post", "/api/machines/:machineId/rejoin", true],
  ] as const) {
    app[method](path, (c) => privateRouteResponse(c, async () => {
      const authenticated = await (dependencies.authenticate ?? requireAuth)(c.req.raw, c.env);
      if (authenticated.agentRun) return Response.json({ error: "Removing a Machine requires its owner" }, { status: 403 });
      const user = requireHumanAuth(authenticated);
      const database = machineDatabase(c.env, dependencies.database);
      const scope = { ownerUserId: user.id, machineId: c.req.param("machineId") ?? "" };
      return Response.json(rejoin
        ? await rejoinMachine(database, { requestId: crypto.randomUUID(), ...scope })
        : await retireOwnerMachine(c.env, database, scope, dependencies.wakeRegistrationChannels),
      { headers: NO_STORE });
    }));
  }
}
