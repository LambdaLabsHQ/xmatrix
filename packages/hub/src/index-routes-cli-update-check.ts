import type { Hono } from "hono";
import { isMachineField, NO_STORE, readActionBody, refuse } from "./machine-action-routes";
import { requireAuth, requireHumanAuth } from "./index-shared";
import { machineDatabase } from "./machines";
import { privateRouteResponse } from "./private-route-response";
import { HUB_ROUTES, type MachineCliUpdateCheckResponse, type MachineCliUpdateStatus } from "@xmatrix/protocol";
import { failMachineCliUpdateCheck, requestMachineCliUpdateCheck, type MachineCliUpdateCheckDecision } from "@xmatrix/db";
import type { Env } from "./types";
import { relayRuntimeCellsForOwners } from "./relay-authority-locator";
import { RELAY_RUNTIME_CLI_UPDATE_CHECK_PATH } from "./runtime-transport/relay-runtime-product-adapter";

/**
 * The owner's view shows a Machine's CLI behind its channel and asks its
 * daemon to check for an update now, instead of waiting for a release push
 * that may have missed a dropped connection. Storms are bounded at each
 * layer: the Hub joins any request within a minute of the last one (one row,
 * no other Machine is touched), the daemon folds requests into a check that
 * is already running, and a view asks once per Machine and newest version.
 */
export interface CliUpdateCheckPort {
  authenticate: typeof requireAuth;
  decide(env: Env, input: { requestId: string; ownerUserId: string; machineId: string; at: string }):
    Promise<MachineCliUpdateCheckDecision>;
  /** Asks the owner's Runtime cell to send the check; whether the daemon's socket took it. */
  ask(env: Env, input: { ownerUserId: string; machineId: string; hostId: string; requestId: string }): Promise<boolean>;
  fail(env: Env, input: { requestId: string; daemonId: string; requestedAt: string; error: string }):
    Promise<MachineCliUpdateStatus>;
}

const CLI_UPDATE_CHECK_PORT: CliUpdateCheckPort = {
  authenticate: requireAuth,
  decide: (env, input) => requestMachineCliUpdateCheck(machineDatabase(env), input),
  ask: async (env, input) => {
    const [cell] = relayRuntimeCellsForOwners(env, [input.ownerUserId]);
    if (!cell) throw new Error("No Runtime cell holds this owner's Machines");
    const response = await cell.fetch(new Request(`https://relay-runtime${RELAY_RUNTIME_CLI_UPDATE_CHECK_PATH}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) }));
    const body = await response.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
    if (!response.ok || typeof body.asked !== "boolean") {
      throw new Error(`Runtime cell answered the CLI update check with ${response.status}`);
    }
    return body.asked;
  },
  fail: (env, input) => failMachineCliUpdateCheck(machineDatabase(env), input),
};

export function registerCliUpdateCheckRoutes(app: Hono<{ Bindings: Env }>,
  dependencies: Partial<CliUpdateCheckPort> = {}): void {
  const port = { ...CLI_UPDATE_CHECK_PORT, ...dependencies };
  app.post(HUB_ROUTES.machine_cli_update_check, (c) => privateRouteResponse(c, async () => {
    const authenticated = await port.authenticate(c.req.raw, c.env);
    if (authenticated.agentRun) return refuse("CLI update checks require the Machine's owner", 403);
    const user = requireHumanAuth(authenticated);
    const body = await readActionBody(c.req.raw, 1_024, "CLI update check");
    if (body instanceof Response) return body;
    if (!isMachineField(body.machineId)) return refuse("Invalid CLI update check request", 400);
    const requestId = `cli-update:${crypto.randomUUID()}`;
    const decision = await port.decide(c.env, { requestId, ownerUserId: user.id, machineId: body.machineId,
      at: new Date().toISOString() });
    if (decision.outcome === "conflict") return refuse("The Machine has conflicting active daemons", 409);
    if (decision.outcome !== "checking") {
      return Response.json(decision satisfies MachineCliUpdateCheckResponse, { headers: NO_STORE });
    }
    const { route, ...answer } = decision;
    if (!route) return Response.json(answer satisfies MachineCliUpdateCheckResponse, { headers: NO_STORE });
    const asked = await port.ask(c.env, { ownerUserId: user.id, machineId: body.machineId, hostId: route.hostId,
      requestId });
    if (asked) return Response.json(answer satisfies MachineCliUpdateCheckResponse, { headers: NO_STORE });
    // Listed online, but its connection was not there to take the check: say so instead of waiting on it.
    const cliUpdate = await port.fail(c.env, { requestId, daemonId: route.daemonId, requestedAt: answer.cliUpdate.at,
      error: "The daemon was not connected to xMatrix to take the check. It is asked again once it is back online." });
    return Response.json({ outcome: "offline", ...(answer.daemonVersion ? { daemonVersion: answer.daemonVersion } : {}),
      cliUpdate } satisfies MachineCliUpdateCheckResponse, { headers: NO_STORE });
  }));
}
