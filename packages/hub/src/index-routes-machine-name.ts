import type { Context, Hono } from "hono";
import { getMachineName, nameMachine, renameMachine, setMachineAutoAssign, type AuthorityDatabase } from "@xmatrix/db";
import type { Env } from "./types";
import { privateRouteResponse } from "./private-route-response";
import { readBoundedRequestBody, requireAuth, requireHumanAuth } from "./index-shared";
import { machineDatabase } from "./machines";

const NO_STORE = { "cache-control": "private, no-store" };

export function registerMachineNameRoutes(app: Hono<{ Bindings: Env }>, dependencies: {
  authenticate?: typeof requireAuth; database?: AuthorityDatabase;
} = {}): void {
  const authenticate = dependencies.authenticate ?? requireAuth;
  /** One owner-only write: its JSON body's `field`, handed to `write`. */
  const ownerWrite = (refusal: string, field: string,
    write: (database: AuthorityDatabase, input: { requestId: string; ownerUserId: string; machineId: string; value: unknown }) => Promise<unknown>,
  ) => async (c: Context<{ Bindings: Env }>) => privateRouteResponse(async () => {
    const authenticated = await authenticate(c.req.raw, c.env);
    if (authenticated.agentRun) return Response.json({ error: refusal }, { status: 403 });
    const user = requireHumanAuth(authenticated);
    const bytes = await readBoundedRequestBody(c.req.raw, 1_024);
    if (!bytes) return Response.json({ error: "Machine request too large" }, { status: 413 });
    let value: unknown;
    try { value = (JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>)[field]; } catch {
      return Response.json({ error: "Invalid Machine request" }, { status: 400 });
    }
    return Response.json(await write(machineDatabase(c.env, dependencies.database), {
      requestId: crypto.randomUUID(), ownerUserId: user.id, machineId: c.req.param("machineId") ?? "", value,
    }), { headers: NO_STORE });
  });
  const writeName = (create: boolean) => ownerWrite("Renaming a Machine requires its owner", "name",
    (database, { value, ...input }) => (create ? nameMachine : renameMachine)(database, { ...input, name: value }));
  app.put("/api/machines/:machineId/name", writeName(false));
  app.post("/api/machines/:machineId/name", writeName(true));
  app.put("/api/machines/:machineId/auto-assign", ownerWrite("Changing automatic assignment requires the Machine's owner",
    "autoAssign", (database, { value, ...input }) => setMachineAutoAssign(database, { ...input, autoAssign: value })));
  app.get("/api/machines/:machineId/name", (c) => privateRouteResponse(async () => {
    const authenticated = await authenticate(c.req.raw, c.env);
    if (authenticated.agentRun) return Response.json({ error: "Reading a Machine name requires its owner" }, { status: 403 });
    const user = requireHumanAuth(authenticated);
    return Response.json(await getMachineName(machineDatabase(c.env, dependencies.database), {
      requestId: crypto.randomUUID(), ownerUserId: user.id, machineId: c.req.param("machineId") ?? "",
    }), { headers: NO_STORE });
  }));
}
