import type { Env } from "../types";
import { connectorAppRepository, connectorCredentialRepository, connectorStripeAccountRepository } from "./credentials";
import { CONNECTOR_DELIVERY_EFFECTS, readSignedProviderDelivery } from "./event-ingress";
import { parseJsonObject } from "./event-format";
import { ProviderRequestError, providerJson } from "./http";
import { oauthClient } from "./oauth";
import { connectorProvider } from "./registry";
import { stripeAccountCredentials } from "./stripe-accounts";
import { deliverStripeAccountEvents, type StripeIngressDependencies } from "./stripe-app-ingress";
import { STRIPE_ACCOUNT_ID } from "./stripe-oauth";
import { trimmedConnectorEnv } from "./connector-env";
import { stripeEvent } from "./wave2-events";

type PublisherDependencies = StripeIngressDependencies & { grant: typeof stripeAccountCredentials };
const DEPENDENCIES: PublisherDependencies = {
  apps: connectorAppRepository, credentials: connectorCredentialRepository, accounts: connectorStripeAccountRepository,
  ...CONNECTOR_DELIVERY_EFFECTS, grant: stripeAccountCredentials,
};

/** Stripe does not emit Connect webhooks when the installer is the App's publisher. */
export async function handleStripePublisherDelivery(input: { env: Env; request: Request },
  dependencies: PublisherDependencies = DEPENDENCIES): Promise<Response> {
  const { env, request } = input;
  const client = oauthClient(env, "stripe");
  const receiver = connectorProvider("stripe")?.events;
  // This operator binding comes from the publishing account's Dashboard, never the request.
  const accountId = trimmedConnectorEnv(env, "CONNECTOR_STRIPE_PUBLISHER_ACCOUNT_ID");
  const secret = trimmedConnectorEnv(env, "CONNECTOR_STRIPE_PUBLISHER_SIGNING_SECRET");
  if (!client || !receiver || !STRIPE_ACCOUNT_ID.test(accountId) || !/^whsec_[A-Za-z0-9]+$/u.test(secret) ||
      ["CONNECTOR_STRIPE_SIGNING_SECRET", "STRIPE_WEBHOOK_SECRET"].some(key => secret === trimmedConnectorEnv(env, key))) {
    return Response.json({ error: "Connector ingress not found" }, { status: 404 });
  }
  const signed = await readSignedProviderDelivery(request, delivery => receiver.receive(delivery), { signingSecret: secret });
  if ("response" in signed) return signed.response;
  const payload = parseJsonObject(signed.rawBody)!;
  // Own-account webhooks omit account. A connected-account delivery cannot be reinterpreted here.
  if (payload.account !== undefined || typeof payload.id !== "string" ||
      !/^evt_[A-Za-z0-9]{1,128}$/u.test(payload.id) || typeof payload.type !== "string" ||
      payload.livemode !== true || !Number.isSafeInteger(payload.created) || Number(payload.created) <= 0) {
    return Response.json({ error: "Invalid Stripe publisher event" }, { status: 400 });
  }
  const deadline = Date.now() + 30_000;
  const delivered = await deliverStripeAccountEvents(env, dependencies, client.clientId, accountId, [], async connection => {
    if (Date.now() >= deadline) throw new ProviderRequestError(503, "Stripe event confirmation timed out");
    try {
      const grant = await dependencies.grant(env, connection.spaceId, accountId);
      if (grant.accountId !== accountId || grant.appClientId !== client.clientId || grant.generation !== connection.grantGeneration) return [];
      const confirmed = await providerJson(`https://api.stripe.com/v1/events/${encodeURIComponent(payload.id as string)}`, {
        headers: { authorization: `Basic ${btoa(`${grant.accessToken}:`)}` }, timeoutMs: Math.max(1, deadline - Date.now()),
        describeError: () => "Stripe refused this event",
      });
      // Use Stripe's content, not the signed sender's copy. Another account, event or mode proves nothing.
      if (confirmed.object !== "event" || confirmed.id !== payload.id || confirmed.type !== payload.type ||
          confirmed.created !== payload.created || confirmed.livemode !== true ||
          confirmed.account !== undefined && confirmed.account !== null) return [];
      return [stripeEvent({ ...confirmed, account: accountId })];
    } catch (error) {
      // Only an authoritative refusal proves this grant cannot read the event.
      // Lease contention, storage/transport failures and rate limits must retry.
      if (error instanceof ProviderRequestError && [401, 403, 404].includes(error.status)) return [];
      throw error;
    }
  });
  return Response.json({ ok: true, events: delivered > 0 ? 1 : 0, delivered });
}
