import { getAppConnectorProvider } from "../app-connectors";
import type { Env } from "../types";
import { connectorCredentialRepository, INGRESS_KEY_FIELD, mintConnectorSecret } from "./credentials";

/**
 * Which of a connector's credential fields a Space admin writes, which the
 * Hub mints, and which are plain enough to read back
 * (docs/design/connector-platform.md §3.2). The Apps page and a settings card
 * both write through `saveConnectorCredentials`.
 */
export function credentialPolicy(providerId: string) {
  const manifest = getAppConnectorProvider(providerId);
  if (!manifest || manifest.status !== "available") return undefined;
  const declared = manifest.credentials ?? [];
  const generated = [...declared.filter((field) => field.generated && !field.managed).map((field) => field.id),
    ...(manifest.events && manifest.events.ingress !== false && !["googlechat", "wecom", "teams"].includes(providerId) ? [INGRESS_KEY_FIELD] : [])];
  const writable = declared.filter((field) => !field.generated && !field.managed).map((field) => field.id);
  // Plain values (an account or vendor number) are read back like generated ones; secrets never are.
  const plain = declared.filter((field) => field.plain && !field.generated && !field.managed).map((field) => field.id);
  if (generated.length === 0 && writable.length === 0) return undefined;
  return { manifest, generated, writable, plain, allowed: [...writable, ...generated] };
}

export type CredentialPolicy = NonNullable<ReturnType<typeof credentialPolicy>>;

/** The generated and plain values a Space admin may read back; the store refuses anyone else. */
export function readConnectorReadback(env: Env, input: { spaceId: string; policy: CredentialPolicy; actorUserId: string }) {
  return connectorCredentialRepository(env).readGenerated({ requestId: crypto.randomUUID(), spaceId: input.spaceId,
    providerId: input.policy.manifest.id, actorUserId: input.actorUserId,
    generated: [...input.policy.generated, ...input.policy.plain] });
}

/**
 * Saves the fields a Space admin wrote, minting each generated value that is
 * missing or asked to be made again. Undefined when there is nothing to write.
 */
export async function saveConnectorCredentials(env: Env, input: { spaceId: string; policy: CredentialPolicy;
  actorUserId: string; fields: Record<string, string | null>; regenerate?: readonly string[] }) {
  const existing = await readConnectorReadback(env, input);
  const fields = { ...input.fields };
  for (const name of input.policy.generated) {
    if (!existing[name] || input.regenerate?.includes(name)) fields[name] = mintConnectorSecret();
  }
  if (Object.keys(fields).length === 0) return undefined;
  return connectorCredentialRepository(env).put({ requestId: crypto.randomUUID(), spaceId: input.spaceId,
    providerId: input.policy.manifest.id, actorUserId: input.actorUserId, fields,
    policy: { allowed: input.policy.allowed, generated: input.policy.generated }, at: new Date().toISOString() });
}
