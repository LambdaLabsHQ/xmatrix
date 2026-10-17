import type { Env } from "../types";
import { connectionCredentials } from "./connection-credentials";
import { connectorCredentialRepository } from "./credentials";
import { ProviderRequestError, providerJson } from "./http";
import type { ConnectorEvent } from "./provider";

/** The Linear objects an event can be about, each read by its GraphQL field of the same name. */
const LINEAR_SUBJECTS = new Set(["issue", "comment", "project", "projectUpdate", "cycle"]);

/**
 * Whether the person who connected this Space's Linear can read what an event
 * is about, asked with that Space's own grant. Linear sends an organization's
 * app webhooks once, for every Space that connected the organization,
 * including private teams' issues; each Space takes only what its grant reads.
 * Something it cannot read now (a private team's issue, or one already
 * deleted) is not delivered. An outage is thrown, so Linear retries.
 *
 * Answers which grant read it (its credential version and binding
 * generation, fixed before the read), or undefined: the answer speaks only for
 * that grant, so the caller delivers only while exactly it is still current.
 */
export async function linearEventVisible(env: Env, spaceId: string, event: ConnectorEvent):
  Promise<{ credentialVersion: number; grantGeneration: string | null } | undefined> {
  const subject = event.subject;
  if (!subject || !LINEAR_SUBJECTS.has(subject.entity) || !/^[A-Za-z0-9-]{1,64}$/u.test(subject.id)) return undefined;
  // Refreshed first if due; then the proof names the stored grant whose token reads.
  const token = (await connectionCredentials(env, spaceId, "linear")).oauthToken;
  const grant = await connectorCredentialRepository(env).resolve({ requestId: crypto.randomUUID(), spaceId,
    providerId: "linear" });
  if (!token || grant?.status !== "configured" || !grant.oauthGrant || grant.values.oauthToken !== token) return undefined;
  let payload: Record<string, unknown>;
  try {
    payload = await providerJson("https://api.linear.app/graphql", { method: "POST",
      headers: { authorization: `Bearer ${token}` },
      json: { query: `query($id: String!) { ${subject.entity}(id: $id) { id } }`, variables: { id: subject.id } } });
  } catch (error) {
    if (error instanceof ProviderRequestError && error.status >= 400 && error.status < 500) return undefined;
    throw error;
  }
  const data = (payload.data ?? {}) as Record<string, { id?: unknown } | null | undefined>;
  return data[subject.entity]?.id === subject.id
    ? { credentialVersion: grant.version, grantGeneration: grant.oauthGrant.grantGeneration } : undefined;
}
