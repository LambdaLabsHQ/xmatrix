import type { SerializedAgent } from "@xmatrix/protocol";
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
  private readonly pending = new Map<WebSocket, { agents: Map<string, SerializedAgent>; timer: ReturnType<typeof setTimeout> }>();

  constructor(
    private readonly send: (socket: WebSocket, message: HumanPresenceDigestMessage) => void,
    private readonly intervalMs = HUMAN_PRESENCE_DIGEST_INTERVAL_MS,
  ) {}

  add(socket: WebSocket, agent: SerializedAgent): void {
    let entry = this.pending.get(socket);
    if (!entry) {
      entry = { agents: new Map(), timer: setTimeout(() => this.flush(socket), this.intervalMs) };
      this.pending.set(socket, entry);
    }
    const key = presenceDigestKey(agent);
    entry.agents.delete(key);
    entry.agents.set(key, agent);
  }

  flush(socket: WebSocket): void {
    const entry = this.pending.get(socket);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.pending.delete(socket);
    if (entry.agents.size) this.send(socket, { type: "presence_digest", agents: [...entry.agents.values()] });
  }
}

function presenceDigestKey(agent: SerializedAgent): string {
  const instanceIds = (agent.instances ?? []).map((instance) => instance.id).sort().join(",");
  return `${agent.id}\u0000${instanceIds}`;
}
