import { APP_CONNECTOR_PROVIDER_MANIFESTS } from "@xmatrix/protocol";
import { listAppConnections } from "../apps";
import { getChannel } from "../spaces";
import type { Env } from "../types";
import { record } from "./command-support";

/*
 * What an Agent Run may act on in its Channel's connected apps
 * (docs/design/connector-platform.md §3.5): each configured provider and the
 * Channel commands its manifest declares. The Run acts by sending one of them with
 * `xmatrix send`, where the message is parsed like anyone's; this listing
 * grants nothing, and execution checks access and live policy again.
 */

export interface ConnectorUsage {
  provider: string;
  name: string;
  actions: Array<{ command: string; effect: "read" | "write"; description: string }>;
}

export async function connectorUsage(env: Env, caller: { ownerUserId: string; channelId: string }):
  Promise<ConnectorUsage[]> {
  const principal = { kind: "user" as const, id: caller.ownerUserId };
  const { channel } = await getChannel(env, { channelId: caller.channelId, principal });
  const spaceId = record(channel).spaceId;
  if (typeof spaceId !== "string" || !spaceId) throw new Error("The Run's Channel has no Space");
  const listed = await listAppConnections(env, { spaceId, channelId: caller.channelId, actorUserId: caller.ownerUserId });
  return usageOf(new Set(listed.map(record).flatMap((connection) =>
    connection.status === "configured" && typeof connection.providerId === "string" ? [connection.providerId] : [])));
}

/** The connected providers' declared actions, in catalog order; one with none is left out. */
export function usageOf(connected: ReadonlySet<string>): ConnectorUsage[] {
  return APP_CONNECTOR_PROVIDER_MANIFESTS.filter((manifest) => connected.has(manifest.id)).flatMap((manifest) => {
    const actions = manifest.actions.flatMap((action) => action.effect ? [{
      command: `@${manifest.id}:${action.id}:${action.usage ?? "<target> <text>"}`,
      effect: action.effect, description: action.description,
    }] : []);
    return actions.length > 0 ? [{ provider: manifest.id, name: manifest.name, actions }] : [];
  });
}
