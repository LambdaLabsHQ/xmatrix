// Runtime transport stand-ins: hibernatable WebSockets, the attachment an
// Agent Instance socket carries across hibernation, and the product port.
import { AgentInstanceRuntimeTransport } from "../../src/runtime-transport/agent-instance-port.ts";
import {
  createProductionRelayRuntimeProductPortFactory,
} from "../../src/runtime-transport/production-product-port-factory.ts";

/** A socket that records what a transport sends and how it closes it. */
export class FakeSocket {
  readyState = 1;
  sent = [];
  closed = [];

  send(frame) { this.sent.push(JSON.parse(frame)); }

  close(code, reason) {
    this.closed.push({ code, reason });
    this.readyState = 3;
  }
}

/** A socket that also keeps the attachment a transport serializes onto it. */
export class AttachedSocket extends FakeSocket {
  constructor(attachment) {
    super();
    this.attachment = attachment;
  }

  serializeAttachment(value) { this.attachment = value; }
  deserializeAttachment() { return this.attachment; }
}

/**
 * The hibernation attachment of a live Agent Instance: agent-1's Instance
 * instance-1 running run-1 in channel-1 on machine-1, unless the principal,
 * run or session fields say otherwise.
 */
export function agentInstanceAttachment({ principal: identity = {}, run = {}, session = {} } = {}) {
  const now = new Date().toISOString();
  const principal = {
    ownerUserId: "user-1",
    agentId: "agent-1",
    agentName: "Agent",
    spaceId: "space-1",
    runId: "run-1",
    executionKey: "execution-1",
    channelId: "channel-1",
    machineId: "machine-1",
    hostId: "host-1",
    ...identity,
  };
  return {
    version: 1,
    domain: "agent_instance",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    session: {
      principal,
      run: {
        runId: principal.runId,
        agentId: principal.agentId,
        instanceId: "instance-1",
        executionKey: principal.executionKey,
        channelId: principal.channelId,
        machineId: principal.machineId,
        hostId: principal.hostId,
        status: "running",
        instanceStatus: "busy",
        ...run,
      },
      connectedAt: now,
      lastSeenAt: now,
      clientVersion: "0.16.698",
      clientProtocolVersion: 2,
      ...session,
    },
  };
}

/**
 * A live Agent Instance transport of the production product port over, when
 * given, a stub `runtime`; no Channel reads as any Human, and history is never read.
 */
export function productionAgentInstanceTransport(runtime) {
  const factory = createProductionRelayRuntimeProductPortFactory({}, {
    readChannel: async () => undefined,
    ...(runtime ? { runtime } : {}),
    analytics: { writeDataPoint() {} },
    readHistory: async () => { throw Error("unexpected history"); },
  });
  return { factory, transport: new AgentInstanceRuntimeTransport(factory.agentInstance()) };
}
