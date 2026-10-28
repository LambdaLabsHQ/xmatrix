import { readBoundedRequestBody } from "../index-shared";
import type { Env } from "../types";
import { dispatchProductMessageAppend } from "../product-message-append";
import { fireConnectorAutomationTriggers } from "../automation-triggers";
import { connectorAppRepository, connectorCredentialRepository } from "./credentials";
import { deliverEvent, type ConnectorIngressDependencies } from "./event-ingress";
import { parseJsonObject } from "./event-format";
import { oauthClient } from "./oauth";
import { connectorProvider } from "./registry";
import { STRIPE_ACCOUNT_ID } from "./stripe-oauth";

const DEPENDENCIES: ConnectorIngressDependencies = {
  apps: connectorAppRepository, credentials: connectorCredentialRepository,
  append: dispatchProductMessageAppend, automations: fireConnectorAutomationTriggers,
};
const MAX_CONNECTIONS = 50;
const NOT_FOUND = () => Response.json({ error: "Connector ingress not found" }, { status: 404 });

function signingSecret(env: Env): string {
  const value = (env as unknown as Record<string, unknown>).CONNECTOR_STRIPE_SIGNING_SECRET;
  return typeof value === "string" ? value.trim() : "";
}

/**
 * The company Stripe App webhook. One endpoint receives every installed
 * account; the signed `account` field selects the Space. A per-Space ingress
 * remains for a webhook the Space created itself.
 */
export async function handleStripeAppDelivery(input: { env: Env; request: Request },
  dependencies: ConnectorIngressDependencies = DEPENDENCIES): Promise<Response> {
  const { env, request } = input;
  const client = oauthClient(env, "stripe");
  const provider = connectorProvider("stripe");
  const secret = signingSecret(env);
  if (!client || !provider?.events || !secret) return NOT_FOUND();
  const bytes = await readBoundedRequestBody(request, 256 * 1024);
  if (!bytes) return Response.json({ error: "Connector delivery is too large" }, { status: 413 });
  const rawBody = new TextDecoder().decode(bytes);
  const received = await provider.events.receive({ rawBody, headers: request.headers, url: new URL(request.url),
    credentials: { signingSecret: secret } });
  if (received.ok === "respond") return received.response;
  if (!received.ok) return Response.json({ error: received.error }, { status: received.status });
  const payload = parseJsonObject(rawBody)!;
  const account = payload.account;
  if (account === undefined || account === null || account === "") {
    return Response.json({ ok: true, events: 0, delivered: 0 });
  }
  if (typeof account !== "string" || !STRIPE_ACCOUNT_ID.test(account)) {
    return Response.json({ error: "Missing Stripe account" }, { status: 400 });
  }
  const apps = dependencies.apps(env);
  if (payload.type === "account.application.deauthorized") {
    const created = payload.created;
    if (typeof created !== "number" || !Number.isSafeInteger(created) || created <= 0) {
      return Response.json({ error: "Missing Stripe event time" }, { status: 400 });
    }
    const retired = await apps.retireStripeAccount({ requestId: crypto.randomUUID(), appClientId: client.clientId,
      installationId: account, at: new Date().toISOString(), eventAt: new Date(created * 1_000).toISOString(),
      limit: MAX_CONNECTIONS });
    return Response.json({ ok: true, events: 0, delivered: 0, retired });
  }
  if (received.events.length === 0) return Response.json({ ok: true, events: 0, delivered: 0 });
  const binding = { providerId: "stripe", appClientId: client.clientId, installationId: account };
  const query = () => apps.oauthEventConnections({ requestId: crypto.randomUUID(), ...binding, limit: MAX_CONNECTIONS });
  const connections = await query();
  let delivered = 0;
  for (const connection of connections) {
    for (const event of received.events) {
      delivered += await deliverEvent(env, apps, dependencies.append, "stripe", connection.connectionId, event, binding);
      if (dependencies.automations && (await query()).some(candidate => candidate.connectionId === connection.connectionId)) {
        await dependencies.automations(env, { spaceId: connection.spaceId, provider: "stripe", event })
          .catch(() => console.error("Connector Automation triggers failed", "stripe"));
      }
    }
  }
  return Response.json({ ok: true, events: received.events.length, delivered });
}
