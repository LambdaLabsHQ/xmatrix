export interface AgentInstancePresenceRoute {
  ownerUserId: string;
  spaceId: string;
  channelId: string;
}

/** Build the exact routed mutation used by both PostgreSQL atomic connect and
 * the legacy transition fallback. Signed Space and Channel coordinates are
 * authority inputs, so neither branch may omit them. */
export function agentInstancePresenceCommand(input: {
  atomicInstanceConnect: boolean;
  commandId: string;
  principal: AgentInstancePresenceRoute;
  instanceId: string;
  expectedVersion: number;
  at: string;
  status?: "online" | "offline";
}): Record<string, unknown> {
  return {
    commandId: input.commandId,
    actorUserId: input.principal.ownerUserId,
    at: input.at,
    kind: input.atomicInstanceConnect ? "instance_connect" : "instance_transition",
    spaceId: input.principal.spaceId,
    channelId: input.principal.channelId,
    instanceId: input.instanceId,
    expectedVersion: input.expectedVersion,
    ...(input.atomicInstanceConnect ? {} : {
      status: input.status ?? "online",
    }),
  };
}
