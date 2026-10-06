import { hmacBytes } from "@xmatrix/protocol";
import { base64UrlEncodeBytes } from "../relay-v2-primitives";
import { verifyGitHubAppState } from "../index-shared";
import { ProviderRequestError } from "./http";
import type { OAuthClient } from "./oauth";

/** The proof is secret-derived; neither the verifier nor client secret enters browser state. */
export function validPkceClaims(client: OAuthClient, claims: Record<string, unknown>): boolean {
  return claims.providerId === client.manifest.id && claims.clientId === client.clientId &&
    typeof claims.spaceId === "string" && typeof claims.userId === "string" &&
    typeof claims.nonce === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(claims.nonce) &&
    typeof claims.redirectUri === "string" && claims.redirectUri.length <= 2_048;
}

async function verifier(client: OAuthClient, claims: Record<string, unknown>): Promise<string> {
  const message = JSON.stringify(["xmatrix:connector-pkce:v1", client.manifest.id, client.clientId,
    claims.nonce, claims.redirectUri, claims.spaceId, claims.userId]);
  return base64UrlEncodeBytes(await hmacBytes("SHA-256", client.clientSecret, message));
}

export async function pkceChallenge(client: OAuthClient, claims: Record<string, unknown>): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(await verifier(client, claims)));
  return base64UrlEncodeBytes(new Uint8Array(digest));
}

/** Reverify the signed state at the token boundary before revealing the proof to the provider. */
export async function oauthGrantState(client: OAuthClient, state: string | undefined, redirectUri: string) {
  const claims = state && state.length <= 4_096
    ? await verifyGitHubAppState(state, client.clientSecret).catch(() => undefined) : undefined;
  if (!claims || !validPkceClaims(client, claims) || claims.redirectUri !== redirectUri) {
    throw new ProviderRequestError(400, "Invalid or expired OAuth proof; restart Connect");
  }
  return claims;
}

export async function pkceGrantProof(client: OAuthClient, state: string | undefined, redirectUri: string): Promise<string> {
  return verifier(client, await oauthGrantState(client, state, redirectUri));
}
