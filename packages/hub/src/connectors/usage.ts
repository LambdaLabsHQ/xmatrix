import { APP_CONNECTOR_PROVIDER_MANIFESTS } from "@xmatrix/protocol";
import { listAppConnections } from "../apps";
import { getChannel } from "../spaces";
import type { Env } from "../types";
import { record } from "./command-support";
import { connectorActionCatalog } from "./action-catalog";
import { connectorProvider } from "./registry";

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
  actions: Array<{
    command: string;
    /** The approval class the connection's permission decides on. */
    effect: "read" | "write";
    /** How an Agent runs it: `xmatrix call` for a read the Hub can answer its caller, `xmatrix send` for every other command. */
    via: "call" | "send";
    description: string;
  }>;
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
    const executable = connectorActionCatalog(manifest.id, connectorProvider(manifest.id)?.actions);
    const actions = manifest.actions.flatMap((action) => {
      if (!action.effect) return [];
      const command = `@${manifest.id}:${action.id}:${action.usage ?? "<target> <text>"}`;
      // Only a read with a call executor returns a result to its caller. A read
      // without one (a GitHub subscription) acts on the Channel it is sent in.
      const executor = executable.get(action.id)?.executor;
      const callable = Boolean(executor) && (action.effect === "read" || executor!.callerOnly === true);
      return [{
        command, effect: action.effect, via: callable ? "call" as const : "send" as const,
        description: action.description + (executor?.callerOnly
          ? ` Run xmatrix call "${command}": the result returns to you alone and is always masked in the Channel; it cannot run as a Channel message.`
          : callable
          ? ` Run xmatrix call "${command}" for a normal Channel result; add --private only to mask the result. Invocation parameters are visible in both modes; private originals are also visible to the calling Agent’s Human owner in the Web for 30 days.`
          : action.effect === "read" ? " It runs only as a Channel message: send it with xmatrix send; xmatrix call cannot run it." : ""),
      }];
    });
    return actions.length > 0 ? [{ provider: manifest.id, name: manifest.name, actions }] : [];
  });
}
