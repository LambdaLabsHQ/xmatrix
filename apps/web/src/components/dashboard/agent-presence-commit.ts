import type { SerializedAgent } from "@xmatrix/protocol";
import type { RealtimeCollectionCommit } from "./realtime-collection";

/** Agent cards are complete replacements. Index the reduction once and hand
 * it to the collection, keeping existing order unless a final name changes or
 * an Agent is added. Repeated ids retain their last card in socket order. */
export function createAgentPresenceCommit(
  agents: SerializedAgent[],
  incoming: readonly SerializedAgent[],
): RealtimeCollectionCommit<SerializedAgent> {
  const byId = new Map(agents.map(agent => [agent.id, agent]));
  if (!incoming.length) return { items: agents, byId, changedKeys: [] };
  const previous = new Map<string, SerializedAgent | undefined>();
  for (const agent of incoming) {
    if (!previous.has(agent.id)) previous.set(agent.id, byId.get(agent.id));
    byId.set(agent.id, agent);
  }
  const changedKeys: string[] = [];
  let needsSort = byId.size !== agents.length;
  for (const [id, before] of previous) {
    const after = byId.get(id)!;
    if (before !== after) changedKeys.push(id);
    if (before && before.name !== after.name) needsSort = true;
  }
  const items = [...byId.values()];
  if (needsSort) items.sort((left, right) => left.name.localeCompare(right.name));
  return { items, byId, changedKeys };
}
