import { ControlError, PostgresSpaceSecretRepository, SECRET_USE_ADMISSION, SpaceSecretError, type RunSecretCaller } from "@xmatrix/db";
import { HUB_ROUTES, parseSecretAccessRequestCard, parseSecretRequestCard, parseSettingAddress } from "@xmatrix/protocol";
import type { Context, Hono } from "hono";
import type { AgentRunPrincipal, AuthUser } from "./auth";
import { admit } from "./admission-policy";
import { markCardAnswered } from "./channel-messages";
import { readBoundedRequestBody, requireAuth, requestErrorResponse } from "./index-shared";
import { createPostgresAuthorityDatabase } from "./postgres-authority-fleet";
import { secretAccessRequestAppend, secretRequestAppend } from "./secret-request-card";
import { appendHubCard } from "./settings-card";
import { admissionSettingsDomain } from "./settings-domain-admission";
import { SettingWriteRefused } from "./settings-registry";
import type { Env } from "./types";

/**
 * Secrets belong to a Space. Its admins save them and choose, per secret,
 * whether any live Run in the Space reads it when it asks (`auto`) or a Run
 * asks first, on a card in its Channel (`ask`). A Run starts with none and
 * reads a secret at the moment it needs it. A Run may also ask, on a card,
 * that secrets become `auto`; only a Space admin's answer changes them. A Run
 * whose owner is a Space admin makes a secret `ask` itself.
 */

const NO_STORE = { "cache-control": "private, no-store" };

/**
 * A waiting CLI keeps polling while a refusal says either of these
 * (`secret_request_still_open`). A policy's own words must not hold one there.
 */
const CLI_WAITS_ON = ["is not saved", "not configured for this Agent"];

/** Why the Space's policy refuses a secret, in words no waiting CLI takes for "still open". */
export function admissionRefusal(secretRef: string, why: string): string {
  const reason = why.trim().slice(0, 500);
  const said = reason && !CLI_WAITS_ON.some((phrase) => reason.includes(phrase)) ? reason : "its adopted policy refuses this request";
  const subject = CLI_WAITS_ON.some((phrase) => secretRef.includes(phrase)) ? "this secret" : secretRef;
  return `This Space refuses ${subject}: ${said}`;
}

/**
 * Puts a Run's request for a saved secret that asks first to the Space's
 * adopted admission policy (docs/design/admission-policy.md). `Allow`
 * approves that Run with no card; `Deny` refuses; anything else, and a Space
 * with no policy, leaves the request to its card. Evaluating is pure
 * computation between two transactions, and the second reads again
 * everything the answer rested on.
 */
export async function admitSecretUse(secrets: PostgresSpaceSecretRepository, run: RunSecretCaller, secretRef: string): Promise<"readable" | "card"> {
  const { policy, work } = await secrets.runAdmission(run);
  if (!policy) return "card";
  const answer = admit(policy.sourceText, { what: SECRET_USE_ADMISSION, target: secretRef, place: run.channelId,
    owner: run.ownerUserId, ...(work ? { work } : {}) });
  if (answer.answer === "deny") {
    throw new SpaceSecretError("secret_request_refused", 403, admissionRefusal(secretRef, answer.reason));
  }
  if (answer.answer === "card") {
    if (!answer.why.startsWith("the policy answers AlsoAsk")) {
      console.warn("Admission policy decided nothing; the request gets its card", { spaceId: run.spaceId, why: answer.why.slice(0, 300) });
    }
    return "card";
  }
  const approved = await secrets.runAdmit(run, { secretRef, sourceSha256: policy.sourceSha256, ...(work ? { work } : {}) });
  return approved.readable ? "readable" : "card";
}

/** The Space secret store, which checks every caller's role itself. */
export function spaceSecretRepository(env: Env): PostgresSpaceSecretRepository {
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
      return requestErrorResponse(c, error);
    }
  };
}

export function registerSecretRoutes(app: Hono<{ Bindings: Env }>): void {
  const spaceSecrets = "/api/spaces/:spaceId/secrets";
  app.get(spaceSecrets, route("human", (c, user) =>
    spaceSecretRepository(c.env).list({ spaceId: c.req.param("spaceId")!, userId: user.id })));
  app.put(spaceSecrets, route("human", async (c, user) => {
    const input = await body(c);
    return spaceSecretRepository(c.env).put({ spaceId: c.req.param("spaceId")!, userId: user.id,
      secretRef: String(input.secretRef ?? ""), ...change(input) });
  }));
  app.delete(`${spaceSecrets}/:secretRef`, route("human", (c, user) =>
    spaceSecretRepository(c.env).remove({ spaceId: c.req.param("spaceId")!, userId: user.id, secretRef: c.req.param("secretRef")! })));

  // The Space's admission policy, where a person reads, adopts and withdraws it without a card. Adopting goes
  // through the same domain a settings card writes through, so one rule says what can be adopted and by whom.
  const admissionPolicy = "/api/spaces/:spaceId/admission-policy";
  const admissionReader = (c: Context<{ Bindings: Env }>, user: AuthUser) => ({ env: c.env, spaceId: c.req.param("spaceId")!, userId: user.id });
  app.get(admissionPolicy, route("human", async (c, user) => {
    const reader = admissionReader(c, user);
    const adopted = await spaceSecretRepository(c.env).admissionPolicy({ spaceId: reader.spaceId, userId: user.id });
    const address = parseSettingAddress(c.req.query("address") ??
      (adopted.policy ? `admission:${adopted.policy.pageId}/${adopted.policy.libraryName}` : ""));
    if (!address || address.domain !== "admission") return adopted;
    const described = await admissionSettingsDomain().describe(reader, [address]);
    return { ...adopted, ...(typeof described === "string" ? {} : { setting: described[0] }) };
  }));
  app.put(admissionPolicy, route("human", async (c, user) => {
    const input = await body(c);
    const address = parseSettingAddress(input.address);
    if (!address || address.domain !== "admission" || typeof input.value !== "string") {
      throw new SettingWriteRefused("Name the library as admission:<page id>/<library>, with the text you read");
    }
    const reader = admissionReader(c, user);
    await admissionSettingsDomain().write!(reader, address, input.value);
    return spaceSecretRepository(c.env).admissionPolicy({ spaceId: reader.spaceId, userId: user.id });
  }));
  app.delete(admissionPolicy, route("human", (c, user) =>
    spaceSecretRepository(c.env).withdrawAdmissionPolicy({ spaceId: c.req.param("spaceId")!, userId: user.id })));

  // An Agent saves a credential it already holds into its Space, or, naming
  // only `access: ask`, makes a held secret ask first.
  app.post(HUB_ROUTES.secrets, route("agent", async (c, _user, run) => {
    const input = await body(c);
    if (input.access === "ask" && input.value === undefined && input.envName === undefined && input.description === undefined) {
      return spaceSecretRepository(c.env).runAsk(caller(run), String(input.secretRef ?? ""));
    }
    return spaceSecretRepository(c.env).runCreate(caller(run), { secretRef: String(input.secretRef ?? ""), ...change(input) });
  }));

  // The secrets a Run may read now, or their values.
  app.post(HUB_ROUTES.run_secrets, route("agent", async (c, _user, run) => {
    const input = await body(c);
    return input.valuesOmitted === true ? spaceSecretRepository(c.env).runList(caller(run))
      : spaceSecretRepository(c.env).runRead(caller(run), input.secretRefs);
  }));

  // A Run posts a card in its own Channel for a secret it may not read yet.
  app.post(HUB_ROUTES.secret_requests, route("agent", async (c, user, run) => {
    const input = await body(c);
    const secrets = spaceSecretRepository(c.env);
    const post = async <T extends { messageId: string }>(append: T) => {
      await appendHubCard(c.env, run.channelId, append).catch((error: unknown) => {
        if (error instanceof ControlError) {
          throw new SpaceSecretError("secret_request_failed", error.status, error.message, error.retryable);
        }
        throw error;
      });
      return append.messageId;
    };
    // It asks that secrets be read without asking: the card names those that still ask.
    if (input.access === "auto") {
      const held = new Map((await secrets.runList(caller(run))).secrets.map((secret) => [secret.secretRef, secret]));
      const asked = parseSecretAccessRequestCard({ secretRefs: input.secretRefs, reason: input.reason,
        agentName: run.agentName, runId: run.runId, channelId: run.channelId });
      if (!asked) throw new SpaceSecretError("invalid_request", 400, "Name the secrets to read without asking");
      const missing = asked.secretRefs.find((ref) => !held.has(ref));
      if (missing) throw new SpaceSecretError("secret_not_found", 404, `Secret ${missing} is not saved in this Space`);
      const secretRefs = asked.secretRefs.filter((ref) => held.get(ref)!.access !== "auto");
      if (!secretRefs.length) return { automatic: true, secretRefs: asked.secretRefs };
      const request = { ...asked, secretRefs };
      return { automatic: false, request,
        messageId: await post(await secretAccessRequestAppend(request, { id: run.ownerUserId, email: user.email })) };
    }
    const current = (await secrets.runList(caller(run))).secrets.find((secret) => secret.secretRef === input.secretRef);
    if (current?.readable) return { readable: true, secretRef: current.secretRef, envName: current.envName };
    if (current) {
      // The policy can spare the card or refuse outright. A failure to consult it is not a refusal: the card is posted.
      const admitted = await admitSecretUse(secrets, caller(run), current.secretRef).catch((error: unknown) => {
        if (error instanceof SpaceSecretError && error.code === "secret_request_refused") throw error;
        console.warn("Admission policy could not be consulted; the request gets its card", { spaceId: run.spaceId,
          error: error instanceof Error ? error.message : String(error) });
        return "card" as const;
      });
      if (admitted === "readable") return { readable: true, secretRef: current.secretRef, envName: current.envName };
    }
    const card = parseSecretRequestCard({ ...input, envName: current?.envName ?? input.envName,
      agentName: run.agentName, runId: run.runId, channelId: run.channelId });
    if (!card || (!current && !card.envName) || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/u.test(card.secretRef)) {
      throw new SpaceSecretError("invalid_request", 400, "Name the secret's alias and environment variable");
    }
    const messageId = await post(await secretRequestAppend(card, !!current,
      { id: run.ownerUserId, email: user.email }));
    return { readable: false, messageId, request: card };
  }));

  // A Space admin answers the card: saves the value if needed and lets that Run read it.
  app.post(HUB_ROUTES.secret_request_fulfill, route("human", async (c, user) => {
    const input = await body(c);
    // The secrets the admin chose on a secret access card become `auto`.
    const access = parseSecretAccessRequestCard(input);
    if (access) {
      const changed = await spaceSecretRepository(c.env).makeAutomatic({ userId: user.id, ...access });
      if (typeof input.messageId === "string" && input.messageId.startsWith("secret-access-request:")) {
        await markCardAnswered(c.env, access.channelId, input.messageId, user.id);
      }
      return changed;
    }
    const card = parseSecretRequestCard(input);
    if (!card) throw new SpaceSecretError("invalid_request", 400, "Invalid secret request");
    const approved = await spaceSecretRepository(c.env).approve({ userId: user.id, runId: card.runId, channelId: card.channelId,
      secretRef: card.secretRef, ...change({ ...input, envName: input.envName ?? card.envName }) });
    // The card names its own message; an approval from elsewhere leaves the wait to Done.
    if (typeof input.messageId === "string" && input.messageId.startsWith("secret-request:")) {
      await markCardAnswered(c.env, card.channelId, input.messageId, user.id);
    }
    return approved;
  }));

  app.post(HUB_ROUTES.secret_request_status, route("human", async (c, user) => {
    const input = await body(c);
    const access = parseSecretAccessRequestCard(input);
    if (access) return spaceSecretRepository(c.env).accessStatus({ userId: user.id, ...access });
    const card = parseSecretRequestCard(input);
    if (!card) throw new SpaceSecretError("invalid_request", 400, "Invalid secret request");
    return spaceSecretRepository(c.env).requestStatus({ userId: user.id, runId: card.runId, channelId: card.channelId,
      secretRef: card.secretRef });
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
