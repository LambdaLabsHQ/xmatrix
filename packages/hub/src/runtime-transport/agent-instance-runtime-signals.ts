import type { AgentInstanceClientMessage } from "@xmatrix/protocol/connections/agent-instance";
import type { LiveAgentStatus } from "@xmatrix/protocol";

import type { AgentInstanceRuntimeSession } from "./agent-instance-port";
import { agentRuntimePresentation } from "./agent-instance-presentation";

type Message<Type extends AgentInstanceClientMessage["type"]> = Extract<
  AgentInstanceClientMessage,
  { type: Type }
>;

export type AgentInstanceRuntimeSignal =
  | Message<"client_network_sample">
  | Message<"presence_update">
  | Message<"agent_model_switch_result">
  | Message<"agent_effort_switch_result">
  | Message<"agent_lifecycle">
  | Message<"event_publish">;

export interface RuntimeAnalyticsSink {
  writeDataPoint(event: {
    blobs?: string[];
    doubles?: number[];
    indexes?: string[];
  }): void;
}

export interface AgentInstanceRuntimeFanout {
  publish(
    session: Readonly<AgentInstanceRuntimeSession>,
    message: Message<"presence_update"> | Message<"agent_lifecycle"> | Message<"event_publish">,
  ): void | Promise<void>;
}

export interface AgentInstanceControlResultBinding {
  kind: "model" | "effort";
  ownerUserId: string;
  agentId: string;
  runId: string;
  instanceId: string;
  requestId: string;
}

export interface AgentInstanceControlResult extends AgentInstanceControlResultBinding {
  value?: string;
  error?: string;
}

export class AgentInstanceControlWaiterError extends Error {
  constructor(readonly code: "duplicate" | "binding_mismatch" | "unknown_or_expired" | "timeout" | "runtime_crash") {
    super(`Agent Instance control waiter failed: ${code}`);
    this.name = "AgentInstanceControlWaiterError";
  }
}

interface PendingControlWaiter {
  binding: AgentInstanceControlResultBinding;
  resolve(result: AgentInstanceControlResult): void;
  reject(error: AgentInstanceControlWaiterError): void;
  timer: ReturnType<typeof setTimeout>;
}

/** Process-memory rendezvous for a live switch request and its exact Instance result. */
export class AgentInstanceControlResultWaiterRegistry {
  private readonly pending = new Map<string, PendingControlWaiter>();

  register(binding: AgentInstanceControlResultBinding, timeoutMs: number): Promise<AgentInstanceControlResult> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 5 * 60_000) {
      throw new Error("Agent Instance control waiter timeout is invalid");
    }
    const key = waiterKey(binding);
    if (this.pending.has(key)) throw new AgentInstanceControlWaiterError("duplicate");
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(key);
        reject(new AgentInstanceControlWaiterError("timeout"));
      }, timeoutMs);
      this.pending.set(key, { binding: { ...binding }, resolve, reject, timer });
    });
  }

  complete(result: AgentInstanceControlResult): void {
    const key = waiterKey(result);
    const waiter = this.pending.get(key);
    if (!waiter) {
      const sameRequest = [...this.pending.values()].some(({ binding }) =>
        binding.kind === result.kind && binding.requestId === result.requestId
      );
      throw new AgentInstanceControlWaiterError(sameRequest ? "binding_mismatch" : "unknown_or_expired");
    }
    if ((!result.value || !result.value.trim()) && (!result.error || !result.error.trim())) {
      throw new Error(`${result.kind} switch result requires a value or error`);
    }
    clearTimeout(waiter.timer);
    this.pending.delete(key);
    waiter.resolve({ ...result });
  }

  get size(): number {
    return this.pending.size;
  }
}

export interface AgentInstanceEphemeralPresence {
  status: LiveAgentStatus;
  updatedAt: string;
  payload: Readonly<Message<"presence_update">>;
}

/**
 * Zero-Authority-storage router for live Agent Instance signals.
 *
 * Network samples go only to Analytics Engine, presence is process-memory
 * state, and lifecycle/event messages are live fanout. Model/effort results
 * complete an exact process-memory waiter; this router never treats an
 * observability ledger as current-state authority.
 */
export class AgentInstanceRuntimeSignalRouter {
  private readonly presence = new Map<string, AgentInstanceEphemeralPresence>();

  constructor(
    private readonly analytics: RuntimeAnalyticsSink,
    private readonly fanout: AgentInstanceRuntimeFanout,
    private readonly controlWaiters: AgentInstanceControlResultWaiterRegistry,
  ) {}

  async route(
    session: Readonly<AgentInstanceRuntimeSession>,
    message: AgentInstanceRuntimeSignal,
  ): Promise<void> {
    switch (message.type) {
      case "client_network_sample":
        this.assertChannel(session, message.channelId);
        this.analytics.writeDataPoint({
          indexes: [session.principal.ownerUserId],
          blobs: ["agent_instance_network", message.clientKind, message.mode, message.networkState,
            message.result, session.principal.runId, session.run.instanceId, message.channelId],
          doubles: [message.latencyMs ?? -1, message.entryCount ?? -1, message.reconnectAttempt ?? -1],
        });
        // Human fan-out is done in AgentInstanceRuntimeTransport after execute
        // (needs the shared Human transport owned by product composition).
        return;
      case "presence_update": {
        const status = message.status ?? "online";
        this.presence.set(session.run.instanceId, {
          status,
          updatedAt: new Date().toISOString(),
          payload: Object.freeze({ ...message }),
        });
        // Per-message execution sources require publication/Run validation on
        // the dedicated read path; generic presence must not expose their hashes.
        await this.fanout.publish(session, { ...message,
          ...(message.runtimeState ? { runtimeState: agentRuntimePresentation(message.runtimeState) } : {}) });
        return;
      }
      case "agent_model_switch_result":
        await this.completeControl(session, "model", message.requestId, message.model, message.error);
        return;
      case "agent_effort_switch_result":
        await this.completeControl(session, "effort", message.requestId, message.effort, message.error);
        return;
      case "agent_lifecycle":
        if (message.channelId) this.assertChannel(session, message.channelId);
        await this.fanout.publish(session, message);
        return;
      case "event_publish":
        this.assertChannel(session, message.channelId);
        await this.fanout.publish(session, message);
        return;
    }
  }

  disconnected(instanceId: string): void {
    this.presence.delete(instanceId);
  }

  private assertChannel(session: Readonly<AgentInstanceRuntimeSession>, channelId: string): void {
    if (channelId !== session.principal.channelId || channelId !== session.run.channelId) {
      throw new Error("Agent Instance runtime signal does not match the run-bound channel");
    }
  }

  private async completeControl(
    session: Readonly<AgentInstanceRuntimeSession>,
    kind: "model" | "effort",
    requestId: string,
    value: string | undefined,
    error: string | undefined,
  ): Promise<void> {
    if ((!value || !value.trim()) && (!error || !error.trim())) {
      throw new Error(`${kind} switch result requires a value or error`);
    }
    this.controlWaiters.complete({
      kind,
      ownerUserId: session.principal.ownerUserId,
      agentId: session.principal.agentId,
      runId: session.principal.runId,
      instanceId: session.run.instanceId,
      requestId,
      ...(value ? { value } : {}),
      ...(error ? { error } : {}),
    });
  }
}

function waiterKey(binding: AgentInstanceControlResultBinding): string {
  return JSON.stringify([
    binding.kind,
    binding.ownerUserId,
    binding.agentId,
    binding.runId,
    binding.instanceId,
    binding.requestId,
  ]);
}
