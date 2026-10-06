import { ControlError, PostgresSpaceSecretRepository, SpaceSecretError, type RunSecretCaller } from "@xmatrix/db";
import { HUB_ROUTES, parseSecretRequestCard } from "@xmatrix/protocol";
import type { Context, Hono } from "hono";
import type { AgentRunPrincipal, AuthUser } from "./auth";
import { appendChannelMessage } from "./channel-messages";
import { readBoundedRequestBody, requireAuth, requestErrorResponse } from "./index-shared";
import { createPostgresAuthorityDatabase } from "./postgres-authority-fleet";
import { secretRequestAppend } from "./secret-request-card";
import type { Env } from "./types";

/**
 * Secrets belong to a Space. Its admins save them and choose, per secret,
 * whether any live Run in the Space reads it when it asks (`auto`) or a Run
 * asks first, on a card in its Channel (`ask`). A Run starts with none and
 * reads a secret at the moment it needs it.
 */

const NO_STORE = { "cache-control": "private, no-store" };

function repository(env: Env): PostgresSpaceSecretRepository {
  return new PostgresSpaceSecretRepository(createPostgresAuthorityDatabase(env, {
    applicationName: "xmatrix-space-secrets", statementTimeoutMs: 5_000,
    transactionTimeoutMs: 10_000, lockTimeoutMs: 2_000,
  }), env.XMATRIX_SECRET_CATALOG_KEY?.trim() ?? "");
}

function caller(run: AgentRunPrincipal): RunSecretCaller {
  return { runId: run.runId, ownerUserId: run.ownerUserId, spaceId: run.spaceId, channelId: run.channelId,
    instanceId: run.instanceId ?? "", executionKey: run.executionKey };
}

async function body(c: Context<{ Bindings: Env }>): Promise<Record<string, unknown>> {
  const bytes = await readBoundedRequestBody(c.req.raw, 512 * 1024);
  if (!bytes) throw new SpaceSecretError("invalid_request", 413, "Secret request is too large");
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch { /* answered below */ }
  throw new SpaceSecretError("invalid_request", 400, "Invalid secret request");
}

/** Answers a route as the signed-in person (`human`) or the live Agent Run (`agent`). */
function route(kind: "human" | "agent", handler: (c: Context<{ Bindings: Env }>, user: AuthUser,
  run: AgentRunPrincipal) => Promise<unknown>) {
  return async (c: Context<{ Bindings: Env }>) => {
    try {
      const user = await requireAuth(c.req.raw, c.env);
      if (kind === "agent" && !user.agentRun) return c.json({ error: "An Agent Run reads its Space's secrets",
        code: "agent_run_required" }, 403);
      if (kind === "human" && user.agentRun) return c.json({ error: "A person manages a Space's secrets",
        code: "human_required" }, 403);
      return c.json(await handler(c, user, user.agentRun!), 200, NO_STORE);
    } catch (error) {
      if (error instanceof SpaceSecretError) {
        return c.json({ error: error.message, code: error.code }, error.status as 400, NO_STORE);
      }
      return requestErrorResponse(c, error);
    }
  };
}

export function registerSecretRoutes(app: Hono<{ Bindings: Env }>): void {
  const spaceSecrets = "/api/spaces/:spaceId/secrets";
  app.get(spaceSecrets, route("human", (c, user) =>
    repository(c.env).list({ spaceId: c.req.param("spaceId")!, userId: user.id })));
  app.put(spaceSecrets, route("human", async (c, user) => {
    const input = await body(c);
    return repository(c.env).put({ spaceId: c.req.param("spaceId")!, userId: user.id,
      secretRef: String(input.secretRef ?? ""), ...change(input) });
  }));
  app.delete(`${spaceSecrets}/:secretRef`, route("human", (c, user) =>
    repository(c.env).remove({ spaceId: c.req.param("spaceId")!, userId: user.id, secretRef: c.req.param("secretRef")! })));

  // An Agent saves a credential it already holds into its Space.
  app.post(HUB_ROUTES.secrets, route("agent", async (c, _user, run) => {
    const input = await body(c);
    return repository(c.env).runCreate(caller(run), { secretRef: String(input.secretRef ?? ""), ...change(input) });
  }));

  // The secrets a Run may read now, or their values.
  app.post(HUB_ROUTES.run_secrets, route("agent", async (c, _user, run) => {
    const input = await body(c);
    return input.valuesOmitted === true ? repository(c.env).runList(caller(run))
      : repository(c.env).runRead(caller(run), input.secretRefs);
  }));

  // A Run posts a card in its own Channel for a secret it may not read yet.
  app.post(HUB_ROUTES.secret_requests, route("agent", async (c, user, run) => {
    const input = await body(c);
    const secrets = repository(c.env);
    const current = (await secrets.runList(caller(run))).secrets.find((secret) => secret.secretRef === input.secretRef);
    if (current?.readable) return { readable: true, secretRef: current.secretRef, envName: current.envName };
    const card = parseSecretRequestCard({ ...input, envName: current?.envName ?? input.envName,
      agentName: run.agentName, runId: run.runId, channelId: run.channelId });
    if (!card || (!current && !card.envName) || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/u.test(card.secretRef)) {
      throw new SpaceSecretError("invalid_request", 400, "Name the secret's alias and environment variable");
    }
    const append = await secretRequestAppend(card, !!current, { id: run.ownerUserId, email: user.email });
    const { messageId } = append;
    await appendChannelMessage(c.env, run.channelId, append).catch((error: unknown) => {
      if (error instanceof ControlError) throw new SpaceSecretError("secret_request_failed", error.status, error.message);
      throw error;
    });
    return { readable: false, messageId, request: card };
  }));

  // A Space admin answers the card: saves the value if needed and lets that Run read it.
  app.post(HUB_ROUTES.secret_request_fulfill, route("human", async (c, user) => {
    const input = await body(c);
    const card = parseSecretRequestCard(input);
    if (!card) throw new SpaceSecretError("invalid_request", 400, "Invalid secret request");
    return repository(c.env).approve({ userId: user.id, runId: card.runId, channelId: card.channelId,
      secretRef: card.secretRef, ...change({ ...input, envName: input.envName ?? card.envName }) });
  }));

  app.post(HUB_ROUTES.secret_request_status, route("human", async (c, user) => {
    const input = await body(c);
    return repository(c.env).requestStatus({ userId: user.id, runId: String(input.runId ?? ""),
      channelId: String(input.channelId ?? ""), secretRef: String(input.secretRef ?? "") });
  }));
}

/** The fields of a secret a request may set; absent ones stay as they are. */
function change(input: Record<string, unknown>) {
  return {
    ...(typeof input.value === "string" && input.value.trim() ? { value: input.value } : {}),
    ...(input.envName === undefined ? {} : { envName: input.envName as string }),
    ...(input.description === undefined ? {} : { description: input.description as string | null }),
    ...(input.access === undefined ? {} : { access: input.access as "auto" | "ask" }),
  };
}
