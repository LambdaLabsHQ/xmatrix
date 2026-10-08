import type { Hono } from "hono";
import { ControlError } from "@xmatrix/db";
import { parseAgentRegistrationCommand, parseSpaceAgentRegistrationKey, groupAgentRegistrationCatalog,
  parseAgentEnvironmentCommand, parseAgentRegistrationKey, type AgentRegistrationSummary } from "@xmatrix/protocol";
import type { Env } from "./types";
import { readBoundedRequestBody, requireAuth, requireHumanAuth, requestFailure } from "./index-shared";
import { failureResponse } from "./error-contract";
import { changeAgentEnvironment, controlAgentRegistration, getAgentEnvironment, getAgentRegistration,
  listAgentRegistrations, refreshAgentRegistrationQuota } from "./agent-registrations";

const NO_STORE = { "cache-control": "private, no-store" };
/** The catalog the Agents page groups; a Space past it is refused rather than truncated. */
const CATALOG_LIMIT = 500;

const REGISTRATIONS = { list: listAgentRegistrations, refreshQuota: refreshAgentRegistrationQuota,
  get: getAgentRegistration, control: controlAgentRegistration,
  getEnvironment: getAgentEnvironment, changeEnvironment: changeAgentEnvironment };

/**
 * A registration rejection under its own status and code, and an outage as a
 * retryable 503; anything else is the route's own failure.
 */
function registrationFailure(error: unknown, fallback: string): Response {
  const failure = requestFailure(error);
  if (error instanceof ControlError || failure.body.retryable) return failureResponse(failure, NO_STORE);
  return failureResponse({ ...failure, body: { ...failure.body, error: fallback } }, NO_STORE);
}

export function registerAgentRegistrationRoutes(app: Hono<{ Bindings: Env }>, dependencies: Partial<
  typeof REGISTRATIONS & { authenticate: typeof requireAuth }> = {}): void {
  const authenticate = dependencies.authenticate ?? requireAuth;
  const port = { ...REGISTRATIONS, ...dependencies };
  app.get("/api/spaces/:spaceId/agent-registrations", async c => {
    try {
      const authenticated = await authenticate(c.req.raw, c.env);
      const spaceId = c.req.param("spaceId");
      // An Agent Run reads its own Space's Agents as its owner.
      if (authenticated.agentRun && authenticated.agentRun.spaceId !== spaceId) {
        return c.json({ error: "Registration not found" }, 404);
      }
      const user = authenticated.agentRun ? { id: authenticated.agentRun.ownerUserId } : requireHumanAuth(authenticated);
      const registrations: AgentRegistrationSummary[] = [];
      let cursor: string | null = null;
      do {
        const page = await port.list(c.env, { actorUserId: user.id, spaceId, cursor, limit: 200 });
        registrations.push(...page.registrations as AgentRegistrationSummary[]);
        cursor = page.cursor ?? null;
      } while (cursor && registrations.length <= CATALOG_LIMIT);
      if (registrations.length > CATALOG_LIMIT) {
        return c.json({ error: `Registration catalog exceeds ${CATALOG_LIMIT} locations` }, 409);
      }
      if (c.req.query("quota") === "refresh") {
        // The Agents page is open: ask the Space's daemons to read quota again
        // after answering. Each daemon is probed at most once a minute.
        const refresh = port.refreshQuota(c.env, { actorUserId: user.id, spaceId })
          .catch((error: unknown) => console.warn("Registration quota refresh failed", {
            error: error instanceof Error ? error.message : String(error) }));
        try { c.executionCtx.waitUntil(refresh); } catch { /* no ExecutionContext outside Workers */ }
      }
      return c.json({ registrations, capabilities: groupAgentRegistrationCatalog(spaceId, registrations) }, 200, NO_STORE);
    } catch (error) {
      return registrationFailure(error, "Registration catalog unavailable");
    }
  });
  for (const scope of ["space", "physical"] as const) for (const action of ["commands", "query"] as const) {
    const prefix = scope === "space" ? "/api/spaces/:spaceId/agent-registrations" : "/api/agent-environments";
    app.post(`${prefix}/${action}`, async c => {
      try {
        const authenticated = await authenticate(c.req.raw, c.env);
        const run = authenticated.agentRun;
        // An Agent Run adds an Agent for its owner on its own Machine in its
        // own Space, as the owner's `xmatrix agent add` would; the rest of
        // registration management stays with people.
        if (run && (scope !== "space" || action !== "commands")) {
          return c.json({ error: "Registration management requires a Human" }, 403);
        }
        const user = run ? { id: run.ownerUserId } : requireHumanAuth(authenticated);
        const bytes = await readBoundedRequestBody(c.req.raw, 32_768);
        if (!bytes) return c.json({ error: "Registration input too large" }, 413);
        let command, key;
        try {
          const body = JSON.parse(new TextDecoder().decode(bytes));
          command = action === "commands" ? scope === "space" ? parseAgentRegistrationCommand(body) : parseAgentEnvironmentCommand(body) : undefined;
          key = command?.key ?? (scope === "space" ? parseSpaceAgentRegistrationKey(body) : parseAgentRegistrationKey(body));
        } catch { return c.json({ error: "Invalid registration request" }, 400); }
        const spaceId = c.req.param("spaceId");
        if (scope === "space" && (!("spaceId" in key) || key.spaceId !== spaceId)) return c.json({ error: "Registration not found" }, 404);
        if (run && (!command || !("action" in command) || command.action !== "create" || spaceId !== run.spaceId || key.ownerUserId !== run.ownerUserId ||
            key.machineId !== run.machineId)) {
          return c.json({ error: "An Agent Run adds Agents only for its owner, on its own Machine, in its own Space" }, 403);
        }
        if (scope === "physical" && key.ownerUserId !== user.id) return c.json({ error: "Registration not found" }, 404);
        // An Agent Run adds an Agent as its owner, without an admin's creation exception.
        const actorUserId = user.id;
        const result = scope === "space"
          ? command ? await port.control(c.env, { actorUserId,
            command: command as ReturnType<typeof parseAgentRegistrationCommand>, byAgent: run !== undefined })
            : await port.get(c.env, { actorUserId, key: key as ReturnType<typeof parseSpaceAgentRegistrationKey> })
          : command ? await port.changeEnvironment(c.env, { actorUserId,
            command: command as ReturnType<typeof parseAgentEnvironmentCommand> })
            : await port.getEnvironment(c.env, { actorUserId, key });
        return c.json(result as Record<string, unknown>, 200, NO_STORE);
      } catch (error) {
        return registrationFailure(error, "Registration request unavailable");
      }
    });
  }
}
