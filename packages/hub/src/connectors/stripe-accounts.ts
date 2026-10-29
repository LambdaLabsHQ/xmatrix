import type { StripeAccountSnapshot, StripeAccountGrant } from "@xmatrix/db";
import type { Env } from "../types";
import { connectorStripeAccountRepository } from "./credentials";
import { oauthClient, refreshOAuthFields } from "./oauth";
import { verifyStripe, STRIPE_ACCOUNT_ID } from "./stripe-oauth";
import { ProviderRequestError } from "./http";

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
  do {
    const ids = await repository.activeAccounts(spaceId, after);
    for (const id of ids) {
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
