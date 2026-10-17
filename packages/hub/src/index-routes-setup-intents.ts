import type { Context, Hono } from "hono";
import {
  HUB_ROUTES, parseHarnessInventory, sha256Hex, type AgentRegistrationSummary, type SetupIntentHarness, type SetupIntentStatus,
} from "@xmatrix/protocol";
import type { Env } from "./types";
import type { SetupIntentRead } from "./device-auth";
import { readBearerToken } from "./auth";
import { admitAttempt } from "./auth-attempt-limit";
import { appOrigin } from "./deployment-origins";
import { EMAIL_DELIVERY_CONFIGURATION_ERROR, EmailDeliveryConfigurationError, sendEmail } from "./email-delivery";
import { setupLinkEmail } from "./setup-link-email";
import { getDeviceAuthBroker, internalClientHeaders, jsonErrors, requireAuth, requireHumanAuth } from "./index-shared";
import { listAgentRegistrations } from "./agent-registrations";
import { listOwnerMachineDaemons, machineRepository } from "./machines";
import { getSpace } from "./spaces";

const NO_STORE = { "cache-control": "private, no-store" };
/** Setup links one person may mail to themselves per minute: a second tap, not a stream. */
const SETUP_LINK_EMAILS_PER_MINUTE = 2;

/**
 * Connecting a machine from the Web (docs/design/onboarding-connect-machine.md).
 * The broker keeps the intent and its terminal; this route adds what the
 * Machine and the Space say, so the page reads one derived status.
 */
export function registerSetupIntentRoutes(app: Hono<{ Bindings: Env }>): void {
  app.post(HUB_ROUTES.setup_intents, (c) => jsonErrors(c, async () => {
    const owner = requireHumanAuth(await requireAuth(c.req.raw, c.env));
    const body = (await c.req.json().catch(() => ({}))) as { spaceId?: unknown };
    if (typeof body.spaceId !== "string" || !body.spaceId) return c.json({ error: "spaceId is required" }, 400);
    // Membership only: adding an Agent later is decided by the Space's own policy.
    await getSpace(c.env, { spaceId: body.spaceId, principal: { kind: "user", id: owner.id } });
    const response = await broker(c, "create", { ownerUserId: owner.id, spaceId: body.spaceId });
    if (!response.ok) return relay(response);
    const { intent } = await response.json() as { intent: SetupIntentRead["intent"] };
    return c.json(await setupIntentStatus(c.env, owner.id, { intent }), 200, NO_STORE);
  }));

  app.get("/api/setup-intents/:intentId", (c) => jsonErrors(c, async () => {
    const owner = requireHumanAuth(await requireAuth(c.req.raw, c.env));
    const response = await broker(c, "read", { ownerUserId: owner.id, intentId: c.req.param("intentId") });
    if (!response.ok) return relay(response);
    return c.json(await setupIntentStatus(c.env, owner.id, await response.json() as SetupIntentRead), 200, NO_STORE);
  }));

  app.post("/api/setup-intents/:intentId/approve", (c) => jsonErrors(c, async () => {
    const authorization = c.req.header("authorization");
    const owner = requireHumanAuth(await requireAuth(c.req.raw, c.env));
    const body = (await c.req.json().catch(() => ({}))) as { userCode?: unknown };
    return relay(await broker(c, "approve", {
      ownerUserId: owner.id, intentId: c.req.param("intentId"), userCode: body.userCode,
    }, readBearerToken(authorization) ? authorization : undefined));
  }));

  app.post("/api/setup-intents/:intentId/decline", (c) => jsonErrors(c, async () => {
    const owner = requireHumanAuth(await requireAuth(c.req.raw, c.env));
    return relay(await broker(c, "decline", { ownerUserId: owner.id, intentId: c.req.param("intentId") }));
  }));

  /* Someone on a phone cannot run the setup command, so they mail the link to
     their own address and pick it up on the computer their agents use. */
  app.post(HUB_ROUTES.setup_link_email, (c) => jsonErrors(c, async () => {
    const owner = requireHumanAuth(await requireAuth(c.req.raw, c.env));
    if (!await admitAttempt(c.env, [
      { key: `setup-link-email:${await sha256Hex(owner.id)}`, max: SETUP_LINK_EMAILS_PER_MINUTE },
    ])) {
      return c.json({ error: "The link was just sent. Check your inbox." }, 429, NO_STORE);
    }
    try {
      await sendEmail(c.env, owner.email, setupLinkEmail(appOrigin(c.env)));
    } catch (error) {
      if (!(error instanceof EmailDeliveryConfigurationError)) throw error;
      console.error("Setup link email is not configured", { providerMessage: error.providerMessage });
      return c.json({ error: "Email delivery is not configured.", code: EMAIL_DELIVERY_CONFIGURATION_ERROR }, 503, NO_STORE);
    }
    return c.json({ sentTo: owner.email }, 202, NO_STORE);
  }));

  /* The terminal, now signed in as the owner, says which Machine it became. */
  app.post("/api/setup-intents/:intentId/machine", (c) => jsonErrors(c, async () => {
    const owner = requireHumanAuth(await requireAuth(c.req.raw, c.env));
    const body = (await c.req.json().catch(() => ({}))) as { machineId?: unknown };
    return relay(await broker(c, "machine", {
      ownerUserId: owner.id, intentId: c.req.param("intentId"), machineId: body.machineId,
    }));
  }));
}

async function broker(c: Context<{ Bindings: Env }>, action: string, body: Record<string, unknown>,
  authorization?: string): Promise<Response> {
  const internalUrl = new URL(`/internal/setup-intent/${action}`, c.req.url);
  return getDeviceAuthBroker(c.env).fetch(new Request(internalUrl.toString(), {
    method: "POST",
    headers: internalClientHeaders(c.req.raw, {
      "content-type": "application/json", ...(authorization ? { authorization } : {}),
    }),
    body: JSON.stringify(body),
  }));
}

function relay(response: Response): Response {
  return new Response(response.body, {
    status: response.status,
    headers: { "content-type": "application/json", ...NO_STORE },
  });
}

/** What the page shows, from the broker's read plus the Machine and the Space. */
export async function setupIntentStatus(env: Env, ownerUserId: string, read: SetupIntentRead): Promise<SetupIntentStatus> {
  const { intent, terminal } = read;
  const base = { intentId: intent.intentId, spaceId: intent.spaceId, expiresAt: intent.expiresAt };
  const shownTerminal = terminal ? {
    terminal: {
      userCode: terminal.userCode,
      ...(terminal.hostname ? { hostname: terminal.hostname } : {}),
      ...(terminal.platform ? { platform: terminal.platform } : {}),
    },
  } : {};
  if (!intent.machineId) {
    const phase = !terminal ? "waiting" : terminal.approved ? "connecting" : "approval";
    return { ...base, phase, ...shownTerminal, registeredHarnesses: [] };
  }
  const machineId = intent.machineId;
  const [daemons, registrations] = await Promise.all([
    listOwnerMachineDaemons(machineRepository(env), ownerUserId),
    registrationsOnMachine(env, ownerUserId, intent.spaceId, machineId),
  ]);
  const daemon = daemons.find((candidate) => candidate.machineId === machineId);
  const inventory = parseHarnessInventory((daemon?.metadata as Record<string, unknown> | undefined)?.harnesses);
  const harnesses: SetupIntentHarness[] | undefined = inventory?.items.map((item) => ({
    id: item.id, installed: item.installed, ...(item.login ? { login: item.login } : {}),
  }));
  return {
    ...base,
    phase: daemon ? "connected" : "connecting",
    ...shownTerminal,
    ...(daemon ? {
      machine: {
        machineId,
        name: String(daemon.machineName || daemon.hostname || daemon.name || "This machine"),
        online: daemon.status !== "offline",
        ...(harnesses ? { harnesses } : {}),
      },
    } : {}),
    registeredHarnesses: registrations,
  };
}

async function registrationsOnMachine(env: Env, ownerUserId: string, spaceId: string, machineId: string): Promise<string[]> {
  const harnesses = new Set<string>();
  let cursor: string | null = null;
  // Bounded: one owner's registrations on one Machine in one Space.
  for (let page = 0; page < 5; page += 1) {
    const result = await listAgentRegistrations(env, { actorUserId: ownerUserId, spaceId, cursor, limit: 200 });
    for (const registration of result.registrations as AgentRegistrationSummary[]) {
      if (registration.key.machineId === machineId && registration.key.ownerUserId === ownerUserId) {
        harnesses.add(registration.key.harness);
      }
    }
    cursor = result.cursor ?? null;
    if (!cursor) break;
  }
  return [...harnesses].sort();
}
