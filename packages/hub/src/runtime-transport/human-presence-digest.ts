import { mergeInstanceActivity, type InstanceActivity, type SerializedAgent } from "@xmatrix/protocol";
import type { HumanPresenceDigestMessage } from "@xmatrix/protocol/connections/human";

export const HUMAN_PRESENCE_DIGEST_INTERVAL_MS = 1_000;

/**
 * Per-socket batches of Agent presence for conversations the socket is not
 * showing. The first card starts a one-second window; within it a newer card
 * for the same Agent and Instance set replaces the older one, and the window
 * ends in one `presence_digest` frame. Nothing here is durable: a lost window
 * is repaired by the Agent's next report. A closed socket's window just
 * ends unsent.
 */
export class HumanPresenceDigests {
  private readonly pending = new Map<WebSocket, { agents: Map<string, SerializedAgent>; activities: Map<string, InstanceActivity>;
    timer: ReturnType<typeof setTimeout> }>();

  constructor(
    private readonly send: (socket: WebSocket, message: HumanPresenceDigestMessage | { type: "instance_activity"; activities: InstanceActivity[] }) => void,
    private readonly intervalMs = HUMAN_PRESENCE_DIGEST_INTERVAL_MS,
  ) {}

  add(socket: WebSocket, agent: SerializedAgent): void {
    const entry = this.window(socket);
    const key = presenceDigestKey(agent);
    entry.agents.delete(key);
    entry.agents.set(key, agent);
  }

  addActivity(socket: WebSocket, activity: InstanceActivity): void {
    const entry = this.window(socket);
    const held = entry.activities.get(activity.instanceId);
    entry.activities.set(activity.instanceId, mergeInstanceActivity(held, activity));
  }

  private window(socket: WebSocket) {
    if ((this.pending.get(socket)?.agents.size ?? 0) + (this.pending.get(socket)?.activities.size ?? 0) >= 512) this.flush(socket);
    let entry = this.pending.get(socket);
    if (!entry) {
      entry = { agents: new Map(), activities: new Map(), timer: setTimeout(() => this.flush(socket), this.intervalMs) };
      this.pending.set(socket, entry);
    }
    return entry;
  }

  flush(socket: WebSocket): void {
    const entry = this.pending.get(socket);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.pending.delete(socket);
    if (entry.agents.size) this.send(socket, { type: "presence_digest", agents: [...entry.agents.values()] });
    if (entry.activities.size) this.send(socket, { type: "instance_activity", activities: [...entry.activities.values()] });
  }
}

function presenceDigestKey(agent: SerializedAgent): string {
  const instanceIds = (agent.instances ?? []).map((instance) => instance.id).sort().join(",");
  return `${agent.id}\u0000${instanceIds}`;
}
