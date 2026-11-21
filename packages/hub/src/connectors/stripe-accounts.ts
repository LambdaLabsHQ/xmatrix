import { AppControlError, type StripeAccountSnapshot, type StripeAccountGrant } from "@xmatrix/db";
import type { Env } from "../types";
import { getChannel } from "../spaces";
import { record } from "./command-support";
import { connectorStripeAccountRepository } from "./credentials";
import { oauthClient, refreshOAuthFields } from "./oauth";
import { verifyStripe, STRIPE_ACCOUNT_ID } from "./stripe-oauth";
import { ConnectorRemedy, ProviderRequestError, providerJson } from "./http";

const MAX_ACCOUNT_PAGES = 20;
const ALLOWED_STRIPE_READ_PATH = /^\/v1\/(?:events(?:\/evt_[A-Za-z0-9_]{1,128})?|payment_intents(?:\/pi_[A-Za-z0-9_]{1,128})?|invoices(?:\/in_[A-Za-z0-9_]{1,128})?|subscriptions(?:\/sub_[A-Za-z0-9_]{1,128})?|disputes(?:\/(?:dp|du)_[A-Za-z0-9_]{1,128})?)$/u;

/** Hub-scoped read capability over a Space's native Stripe OAuth grants; tokens stay inside the Hub. */
export interface StripeActionCapability {
  accounts(): Promise<string[]>;
  request(accountId: string, path: string): Promise<Record<string, unknown>>;
}

function isAllowedStripeReadPath(path: string): boolean {
  const [pathname, query = "", extra] = path.split("?");
  if (extra !== undefined || !pathname || !ALLOWED_STRIPE_READ_PATH.test(pathname)) return false;
  if (!query) return true;
  // Never expand resources outside the Stripe App's five granted read permissions.
  for (const key of new URLSearchParams(query).keys()) {
    if (key === "expand" || key.startsWith("expand[")) return false;
  }
  return true;
}

function stripeErrorMessage(payload: Record<string, unknown>): string | undefined {
  const error = record(payload.error);
  const parts = [typeof error.code === "string" ? error.code : "", typeof error.message === "string" ? error.message : ""].filter(Boolean);
  return parts.length ? parts.join(": ").slice(0, 240) : undefined;
}

/** Exposes read-only Stripe API calls scoped to the Channel's Space and its retained OAuth grants. */
export function stripeActionCapability(env: Env, input: { spaceId: string; channelId: string; actorUserId: string }): StripeActionCapability {
  const verifyChannel = async () => {
    const { channel } = await getChannel(env, { channelId: input.channelId, principal: { kind: "user", id: input.actorUserId } });
    if (record(channel).spaceId !== input.spaceId) throw new ProviderRequestError(403, "The Stripe Channel access changed");
  };
  return {
    accounts: async () => {
      await verifyChannel();
      const repository = connectorStripeAccountRepository(env);
      if (!await repository.hasAccounts(input.spaceId)) return [];
      const ids: string[] = [];
      let after: string | undefined;
      for (let page = 0; page < MAX_ACCOUNT_PAGES; page++) {
        const batch = await repository.activeAccounts(input.spaceId, after);
        ids.push(...batch);
        if (batch.length < 50) return ids;
        after = batch[batch.length - 1];
      }
      return ids;
    },
    request: async (accountId, path) => {
      if (!STRIPE_ACCOUNT_ID.test(accountId)) throw new ProviderRequestError(400, "Name a valid Stripe account ID (acct_…)");
      if (!isAllowedStripeReadPath(path)) throw new ProviderRequestError(403, "This Stripe API endpoint is unavailable");
      await verifyChannel();
      let grant: StripeAccountGrant;
      try {
        grant = await stripeAccountCredentials(env, input.spaceId, accountId);
      } catch (error) {
        if (error instanceof AppControlError) {
          if (error.code === "credential_changed") {
            throw new ConnectorRemedy(401, `Stripe account ${accountId} is not connected or needs reconnection in Apps → Stripe`, { kind: "reconnect" });
          }
          if (error.code === "stripe_refresh_in_progress") throw new ProviderRequestError(503, error.message);
        }
        throw error;
      }
      try {
        return await providerJson(`https://api.stripe.com${path}`, {
          headers: { authorization: `Basic ${btoa(`${grant.accessToken}:`)}` },
          describeError: stripeErrorMessage,
        });
      } catch (error) {
        if (error instanceof ProviderRequestError && error.status === 401) {
          await connectorStripeAccountRepository(env).rejectGrant({ spaceId: input.spaceId, accountId, generation: grant.generation });
          throw new ConnectorRemedy(401, `Stripe refused account ${accountId}; reconnect it in Apps → Stripe`, { kind: "reconnect" });
        }
        throw error;
      }
    },
  };
}

/** The account identity comes only from Stripe's authenticated token response. */
export async function connectStripeAccount(env: Env, input: { spaceId: string; actorUserId: string;
  fields: Record<string, string | null>; appClientId: string; authorizedAt: number; snapshot: StripeAccountSnapshot }) {
  const fields = input.fields;
  const id = fields.stripeUserId;
  if (!id || !STRIPE_ACCOUNT_ID.test(id) || !Number.isSafeInteger(input.authorizedAt) ||
      input.authorizedAt > Date.now() || input.authorizedAt < Date.now() - 15 * 60_000) {
    throw new ProviderRequestError(400, "Restart Stripe Connect");
  }
  const values = Object.fromEntries(Object.entries(fields).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  await verifyStripe(values);
  await connectorStripeAccountRepository(env).connect({ spaceId: input.spaceId, actorUserId: input.actorUserId,
    snapshot: input.snapshot, grant: { accountId: id, appClientId: input.appClientId, generation: crypto.randomUUID(),
      // event_read does not grant business-profile access. Never invent a merchant name.
      name: id, authorizedAt: new Date(input.authorizedAt).toISOString(), accessToken: values.oauthToken!,
      refreshToken: values.oauthRefreshToken!, expiresAt: Number(values.oauthExpiresAt) } });
}

/** Rotation is leased per merchant across all Worker instances, outside the database transaction. */
export async function stripeAccountCredentials(env: Env, spaceId: string, id: string): Promise<StripeAccountGrant> {
  const client = oauthClient(env, "stripe");
  if (!client) throw new ProviderRequestError(503, "Stripe application is unavailable; reconnect later");
  const repository = connectorStripeAccountRepository(env);
  const claim = await repository.claimRefresh({ spaceId, accountId: id, appClientId: client.clientId });
  if (!claim.lease) return claim.grant;
  let next: StripeAccountGrant;
  try {
    const fields = await refreshOAuthFields(env, "stripe", { oauthToken: claim.grant.accessToken,
      oauthRefreshToken: claim.grant.refreshToken, oauthExpiresAt: String(claim.grant.expiresAt), stripeUserId: id });
    if (!fields?.oauthToken || !fields.oauthRefreshToken) throw new ProviderRequestError(502, "Stripe did not renew this account");
    next = { ...claim.grant, accessToken: fields.oauthToken, refreshToken: fields.oauthRefreshToken,
      expiresAt: Number(fields.oauthExpiresAt) };
  } catch (error) {
    await repository.finishRefresh({ spaceId, claim });
    throw error;
  }
  // A persistence failure never repeats the upstream token rotation.
  await repository.finishRefresh({ spaceId, claim, grant: next });
  return next;
}

/** Like a multi-installation GitHub connection, one working retained grant keeps the connection usable. */
export async function verifyStripeAccounts(env: Env, spaceId: string): Promise<boolean> {
  const repository = connectorStripeAccountRepository(env);
  if (!await repository.hasAccounts(spaceId)) return false;
  let after: string | undefined, lastError: unknown;
  const deadline = Date.now() + 30_000;
  do {
    const ids = await repository.activeAccounts(spaceId, after);
    for (const id of ids) {
      if (Date.now() >= deadline) throw new ProviderRequestError(503, "Stripe account checks timed out; try Check again");
      let grant: StripeAccountGrant | undefined;
      try {
        grant = await stripeAccountCredentials(env, spaceId, id);
        await verifyStripe({ oauthToken: grant.accessToken, stripeUserId: id });
        return true;
      } catch (error) {
        lastError = error;
        if (grant && error instanceof ProviderRequestError && (error.status === 401 || error.status === 403)) {
          await repository.rejectGrant({ spaceId, accountId: id, generation: grant.generation });
        }
      }
    }
    after = ids.length === 50 ? ids[ids.length - 1] : undefined;
  } while (after);
  throw lastError ?? new ProviderRequestError(401, "Reconnect a Stripe account");
}
