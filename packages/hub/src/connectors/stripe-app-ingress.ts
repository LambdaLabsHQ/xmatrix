import type { Env } from "../types";
import { dispatchProductMessageAppend } from "../product-message-append";
import { fireConnectorAutomationTriggers } from "../automation-triggers";
import { connectorAppRepository, connectorCredentialRepository, connectorStripeAccountRepository } from "./credentials";
import type { PostgresStripeAccountRepository } from "@xmatrix/db";
import { trimmedConnectorEnv } from "./connector-env";
import { currentConnectorAppend, deliverEvent, readSignedProviderDelivery, type ConnectorIngressDependencies } from "./event-ingress";
import { parseJsonObject } from "./event-format";
import { oauthClient } from "./oauth";
import { connectorProvider } from "./registry";
import { STRIPE_ACCOUNT_ID } from "./stripe-oauth";
import type { ConnectorEvent } from "./provider";

export type StripeIngressDependencies = ConnectorIngressDependencies & {
  accounts: (env: Env) => Pick<PostgresStripeAccountRepository, "eventConnections" | "retireAccount">;
};
const DEPENDENCIES: StripeIngressDependencies = {
  apps: connectorAppRepository, credentials: connectorCredentialRepository,
  append: dispatchProductMessageAppend, automations: fireConnectorAutomationTriggers,
  accounts: connectorStripeAccountRepository,
};
const MAX_CONNECTIONS = 50;
const NOT_FOUND = () => Response.json({ error: "Connector ingress not found" }, { status: 404 });

/**
 * The company Stripe App webhook. One endpoint receives every installed
 * account; the signed `account` field selects the Space. A per-Space ingress
 * remains for a webhook the Space created itself.
 */
export async function handleStripeAppDelivery(input: { env: Env; request: Request },
  dependencies: StripeIngressDependencies = DEPENDENCIES): Promise<Response> {
  const { env, request } = input;
  const client = oauthClient(env, "stripe");
  const provider = connectorProvider("stripe");
  const secret = trimmedConnectorEnv(env, "CONNECTOR_STRIPE_SIGNING_SECRET");
  if (!client || !provider?.events || !secret) return NOT_FOUND();
  const events = provider.events;
  const signed = await readSignedProviderDelivery(request, (delivery) => events.receive(delivery), { signingSecret: secret });
  if ("response" in signed) return signed.response;
  const { rawBody, received } = signed;
  const payload = parseJsonObject(rawBody)!;
  const account = payload.account;
  if (account === undefined || account === null || account === "") {
    return Response.json({ ok: true, events: 0, delivered: 0 });
  }
  if (typeof account !== "string" || !STRIPE_ACCOUNT_ID.test(account)) {
    return Response.json({ error: "Missing Stripe account" }, { status: 400 });
  }
  const accounts = dependencies.accounts(env);
  if (payload.type === "account.application.deauthorized") {
    const created = payload.created;
    if (typeof created !== "number" || !Number.isSafeInteger(created) || created <= 0) {
      return Response.json({ error: "Missing Stripe event time" }, { status: 400 });
    }
    const retired = await accounts.retireAccount({ appClientId: client.clientId,
      accountId: account, eventAt: new Date(created * 1_000).toISOString(),
      limit: MAX_CONNECTIONS });
    return Response.json({ ok: true, events: 0, delivered: 0, retired });
  }
  if (received.events.length === 0) return Response.json({ ok: true, events: 0, delivered: 0 });
  const delivered = await deliverStripeAccountEvents(env, dependencies, client.clientId, account, received.events);
  return Response.json({ ok: true, events: received.events.length, delivered });
}

type StripeEventConnection = Awaited<ReturnType<PostgresStripeAccountRepository["eventConnections"]>>[number];

/** Both Stripe endpoints fence lookup, append and Automations to the same retained grant. */
export async function deliverStripeAccountEvents(env: Env, dependencies: StripeIngressDependencies,
  appClientId: string, accountId: string, events: ConnectorEvent[],
  confirm?: (connection: StripeEventConnection) => Promise<ConnectorEvent[]>): Promise<number> {
  const apps = dependencies.apps(env);
  const accounts = dependencies.accounts(env);
  const binding = { providerId: "stripe", appClientId, installationId: accountId };
  const query = () => accounts.eventConnections({ appClientId, accountId, limit: MAX_CONNECTIONS });
  const connections = await query();
  let delivered = 0;
  for (const connection of connections) {
    const confirmed = confirm ? await confirm(connection) : events;
    const current = async () => (await query()).some(candidate => candidate.connectionId === connection.connectionId &&
      candidate.grantGeneration === connection.grantGeneration);
    for (const event of confirmed) {
      if (!await current()) continue;
      delivered += await deliverEvent(env, apps, currentConnectorAppend(dependencies.append, current), "stripe", connection.connectionId, event,
        { ...binding, grantGeneration: connection.grantGeneration });
      if (dependencies.automations && await current()) {
        await dependencies.automations(env, { spaceId: connection.spaceId, provider: "stripe", event })
          .catch(() => console.error("Connector Automation triggers failed", "stripe"));
      }
    }
  }
  return delivered;
}
