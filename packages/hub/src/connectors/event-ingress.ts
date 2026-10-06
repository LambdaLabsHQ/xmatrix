import type { PostgresTeamsRoomRepository } from "@xmatrix/db";
import { getAppConnectorProvider } from "../app-connectors";
import { readBoundedRequestBody } from "../index-shared";
import { fireConnectorAutomationTriggers } from "../automation-triggers";
import { dispatchProductMessageAppend } from "../product-message-append";
import type { Env } from "../types";
import { connectorAppRepository, connectorCredentialRepository, INGRESS_KEY_FIELD } from "./credentials";
import { timingSafeEqual } from "@xmatrix/protocol";
import type { ConnectorEvent, ConnectorProvider } from "./provider";
import { oauthClient } from "./oauth";
import { parseJsonObject } from "./event-format";

/*
 * Per-connection event ingress (docs/design/connector-platform.md §3.3):
 * `POST /api/connectors/:providerId/events/:spaceId/:ingressKey`. The ingress
 * key authenticates the sender to one connection; the provider module then
 * verifies its own signature and normalizes the delivery. Every event is
 * posted, as the provider, to each Channel subscribed to its source and
 * feature, with a message id derived from the event so a redelivery is a no-op.
 */

const MAX_DELIVERY_BYTES = 256 * 1024;
const MAX_EVENTS_PER_DELIVERY = 20;
const MAX_ROUTES_PER_EVENT = 1_000;
const APPEND_BATCH = 8;
const MAX_OAUTH_CONNECTIONS = 50;

export interface ConnectorIngressDependencies {
  credentials: typeof connectorCredentialRepository;
  apps: typeof connectorAppRepository;
  append: typeof dispatchProductMessageAppend;
  automations?: typeof fireConnectorAutomationTriggers;
}

/** Shared Channel append and Automation effects; provider authentication stays separate. */
export const CONNECTOR_DELIVERY_EFFECTS = { append: dispatchProductMessageAppend, automations: fireConnectorAutomationTriggers };

const DEFAULT_DEPENDENCIES: ConnectorIngressDependencies = {
  credentials: connectorCredentialRepository,
  apps: connectorAppRepository,
  ...CONNECTOR_DELIVERY_EFFECTS,
};

/* An unknown provider, connection or key all look the same to the caller. */
const NOT_FOUND = () => Response.json({ error: "Connector ingress not found" }, { status: 404 });

/** The shared application callback. No caller-supplied Space id or per-Space secret. */
export async function handleAppConnectorDelivery(input: { env: Env; request: Request;
  provider: ConnectorProvider | undefined }, dependencies: ConnectorIngressDependencies = DEFAULT_DEPENDENCIES): Promise<Response> {
  const { env, request, provider } = input;
  if (!provider?.events || !["slack", "linear"].includes(provider.id)) return NOT_FOUND();
  const client = oauthClient(env, provider.id);
  const envSecret = (env as unknown as Record<string, unknown>)[`CONNECTOR_${provider.id.toUpperCase()}_SIGNING_SECRET`];
  const signingSecret = typeof envSecret === "string" ? envSecret.trim() : "";
  if (!client || !signingSecret) return NOT_FOUND();
  const bytes = await readBoundedRequestBody(request, MAX_DELIVERY_BYTES);
  if (!bytes) return Response.json({ error: "Connector delivery is too large" }, { status: 413 });
  const rawBody = new TextDecoder().decode(bytes);
  // The provider verifies signature and freshness before any workspace is trusted.
  const result = await provider.events.receive({ rawBody, headers: request.headers,
    url: new URL(request.url), credentials: { signingSecret } });
  if (result.ok === "respond") return result.response;
  if (!result.ok) return Response.json({ error: result.error }, { status: result.status });
  if (result.events.length === 0) return Response.json({ ok: true, events: 0, delivered: 0 });
  if (result.events.length > MAX_EVENTS_PER_DELIVERY) return Response.json({ error: "Too many connector events" }, { status: 413 });
  const payload = parseJsonObject(rawBody)!;
  const installationId = provider.id === "slack" ? payload.team_id : payload.organizationId;
  if (typeof installationId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/u.test(installationId)) {
    return Response.json({ error: "Missing provider workspace" }, { status: 400 });
  }
  const apps = dependencies.apps(env);
  const binding = { providerId: provider.id, appClientId: client.clientId, installationId };
  const query = () => apps.oauthEventConnections({ requestId: crypto.randomUUID(), ...binding, limit: MAX_OAUTH_CONNECTIONS });
  const connections = await query();
  let delivered = 0;
  for (const connection of connections) {
    for (const event of result.events) {
      delivered += await deliverEvent(env, apps, dependencies.append, provider.id, connection.connectionId, event, binding);
      // Reauthorization can change the workspace between the first lookup and dispatch.
      if (dependencies.automations && (await query()).some(current => current.connectionId === connection.connectionId)) {
        await dependencies.automations(env, { spaceId: connection.spaceId, provider: provider.id, event })
          .catch(() => console.error("Connector Automation triggers failed", provider.id));
      }
    }
  }
  return Response.json({ ok: true, events: result.events.length, delivered });
}

export async function handleConnectorDelivery(input: {
  env: Env;
  request: Request;
  provider: ConnectorProvider | undefined;
  spaceId: string;
  ingressKey: string;
}, dependencies: ConnectorIngressDependencies = DEFAULT_DEPENDENCIES): Promise<Response> {
  const { env, request, provider } = input;
  const manifest = provider ? getAppConnectorProvider(provider.id) : undefined;
  if (!provider?.events || !manifest || manifest.status !== "available") return NOT_FOUND();
  const bytes = await readBoundedRequestBody(request, MAX_DELIVERY_BYTES);
  if (!bytes) return Response.json({ error: "Connector delivery is too large" }, { status: 413 });
  const resolved = await dependencies.credentials(env).resolve({ requestId: crypto.randomUUID(),
    spaceId: input.spaceId, providerId: provider.id });
  const expected = resolved?.values[INGRESS_KEY_FIELD];
  if (!resolved || resolved.status !== "configured" || !expected || !timingSafeEqual(expected, input.ingressKey)) {
    return NOT_FOUND();
  }
  const result = await provider.events.receive({
    rawBody: new TextDecoder().decode(bytes),
    headers: request.headers,
    url: new URL(request.url),
    credentials: resolved.values,
  });
  if (result.ok === "respond") return result.response;
  if (!result.ok) return Response.json({ error: result.error }, { status: result.status });
  const apps = dependencies.apps(env);
  let delivered = 0;
  for (const event of result.events.slice(0, MAX_EVENTS_PER_DELIVERY)) {
    delivered += await deliverEvent(env, apps, dependencies.append, provider.id, resolved.connectionId, event);
    /* Page Automations this event fires (§3.4); a failure must not lose the Channel delivery. */
    await dependencies.automations?.(env, { spaceId: resolved.spaceId, provider: provider.id, event })
      .catch((error: unknown) => console.error("Connector Automation triggers failed",
        error instanceof Error ? error.message : "unknown"));
  }
  return Response.json({ ok: true, events: result.events.length, delivered });
}

export async function deliverEvent(
  env: Env,
  apps: ReturnType<typeof connectorAppRepository>,
  append: typeof dispatchProductMessageAppend,
  providerId: string,
  connectionId: string,
  event: ConnectorEvent,
  oauthBinding?: { providerId: string; appClientId: string; installationId: string; credentialVersion?: number; grantGeneration?: string },
  googleChatBinding?: { appIdentity: string; chatSpace: string; grantGeneration: string },
  feishuBinding?: { appIdentity: string; chatSpace: string; grantGeneration: string },
  telegramBinding?: { appIdentity: string; chatSpace: string; grantGeneration: string },
  wecomBinding?: { appIdentity: string; companyDigest: string; grantGeneration: string },
  teamsBinding?: { appIdentity: string; chatSpace: string; grantGeneration: string },
): Promise<number> {
  const roomBinding = teamsBinding || googleChatBinding || feishuBinding || telegramBinding || wecomBinding;
  /* A Channel subscribed to the source and to `*` still gets the event once. */
  const routes = new Map<string, Awaited<ReturnType<typeof apps.connectorEventRoutes>>[number]>();
  const routeGroups = await Promise.all([event.sourceRef, `${providerId}:*`].map(sourceRef =>
    apps.connectorEventRoutes({ requestId: crypto.randomUUID(), connectionId,
      sourceRef, limit: roomBinding ? 32 : providerId === "sentry" ? 128 : MAX_ROUTES_PER_EVENT,
      ...(oauthBinding ? { oauthBinding } : {}), ...(googleChatBinding ? { googleChatBinding } : {}), ...(feishuBinding ? { feishuBinding } : {}), ...(telegramBinding ? { telegramBinding } : {}), ...(wecomBinding ? { wecomBinding } : {}), ...(teamsBinding ? { teamsBinding } : {}) })));
  for (const group of routeGroups) {
    for (const route of group) {
      if (route.features.includes(event.feature) && !routes.has(route.channelId)) routes.set(route.channelId, route);
    }
  }
  if (roomBinding && routes.size > 32) throw new Error("Google Chat delivery exceeds its route bound");
  return appendToRoutes(env, append, providerId, event, [...routes.values()]);
}

async function appendToRoutes(
  env: Env,
  append: typeof dispatchProductMessageAppend,
  providerId: string,
  event: ConnectorEvent,
  routes: { channelId: string; authorityRootUserId: string }[],
): Promise<number> {
  let delivered = 0;
  for (let offset = 0; offset < routes.length; offset += APPEND_BATCH) {
    const results = await Promise.all(routes.slice(offset, offset + APPEND_BATCH).map(async (route) => {
      const key = `${providerId}:${event.eventId}:${route.channelId}`;
      const response = await append(env, route.channelId, {
        commandId: `product:connector-event:${key}`.slice(0, 200),
        messageId: `app:${key}`.slice(0, 200),
        channelId: route.channelId,
        body: event.body,
        principal: { kind: "user", id: route.authorityRootUserId },
        appAuthorId: providerId,
      }).catch(() => undefined);
      return response?.ok ? 1 : 0;
    }));
    delivered += results.reduce<number>((sum, value) => sum + value, 0);
    if (results.some(value => value === 0)) {
      throw new Error("Connector Channel delivery failed");
    }
  }
  return delivered;
}

/** Native app effects use the same current-grant fence at the last local append boundary. */
export function currentConnectorAppend(append: typeof dispatchProductMessageAppend, current: () => Promise<boolean>): typeof dispatchProductMessageAppend {
  return async (...args) => await current() ? append(...args) : new Response(null, { status: 503 });
}

/** Both app endpoints share primary-grant fences, durable append and Automation ordering. */
export async function deliverConnectorRoom(env: Env, rooms: Pick<PostgresTeamsRoomRepository, "route" | "current">,
  input: Parameters<PostgresTeamsRoomRepository["route"]>[0], event: ConnectorEvent,
  scope: { provider: "teams" | "googlechat"; appIdentity: string },
  effects: typeof CONNECTOR_DELIVERY_EFFECTS & { apps: typeof connectorAppRepository; deliver: typeof deliverEvent }) {
  const binding = await rooms.route(input);
  if (!binding) return;
  const current = () => rooms.current({ requestId: crypto.randomUUID(), app: input.app, binding });
  if (!await current()) return;
  const grant = { appIdentity: scope.appIdentity, chatSpace: binding.chatSpace, grantGeneration: binding.grantGeneration };
  await effects.deliver(env, effects.apps(env), currentConnectorAppend(effects.append, current), scope.provider,
    binding.connectionId, event, undefined, scope.provider === "googlechat" ? grant : undefined,
    undefined, undefined, undefined, scope.provider === "teams" ? grant : undefined);
  if (await current()) await effects.automations(env, { spaceId: binding.spaceId, provider: scope.provider, event });
}
