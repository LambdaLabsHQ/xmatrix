import assert from "node:assert/strict";
import test from "node:test";

import {
  channelAgentPresenceDeliveryBody,
  parseChannelAgentPresenceDelivery,
} from "../src/runtime-transport/channel-agent-presence-delivery.ts";
import { AgentInstanceRuntimeTransport } from "../src/runtime-transport/agent-instance-port.ts";
import { agentInstanceAttachment, AttachedSocket, FakeSocket, productionAgentInstanceTransport } from "./support/runtime-transport.mjs";

const channelId = "channel-1";
const instanceId = "channel-1:1";

/** The record the database answers for a written report at `sequence`. */
function record(sequence, status = "busy") {
  return {
    id: instanceId, channelId, channelInstanceId: "1", label: "Agent:1", agentName: "Agent",
    registration: { ownerUserId: "user-1", machineId: "machine-1", harness: "codex" },
    connectedAt: "2026-11-06T19:00:00.000Z", lastSeenAt: "2026-11-06T19:00:00.000Z", status,
    revision: { version: 3, sequence },
  };
}

/** A runtime that answers each ordered presentation write with its record. */
function recordingRuntime() {
  const writes = [];
  return { writes, runtime: {
    async getRun() { throw Error("unexpected Run read"); },
    async transition(command) {
      if (command.kind !== "instance_presentation") throw Error("unexpected Instance transition");
      writes.push(command);
      return { instanceId: command.instanceId, recorded: true,
        ...(command.ordering ? { record: record(command.ordering.presenceSequence, command.status) } : {}) };
    },
    async holdUsageLimit() { throw Error("unexpected usage-limit hold"); },
  } };
}

function connection(run = {}) {
  const authority = recordingRuntime();
  const { factory, transport } = productionAgentInstanceTransport(authority.runtime);
  const socket = new FakeSocket();
  assert.equal(transport.rehydrate(socket, agentInstanceAttachment({
    run: { instanceId, connectionVersion: 3, ...run },
  })), true);
  return { factory, transport, socket, writes: authority.writes };
}

const report = (fields) => JSON.stringify({ type: "presence_update", ...fields });

test("each report is the connection's next: it is written in order and the count survives hibernation", async () => {
  const { transport, socket, writes } = connection({ presenceSequence: 7 });
  await transport.handleFrame(socket, report({ status: "busy", model: "gpt" }));
  await transport.handleFrame(socket, report({ status: "idle", model: "gpt" }));
  assert.deepEqual(writes.map((write) => write.ordering), [
    { expectedVersion: 3, runId: "run-1", presenceSequence: 8 },
    { expectedVersion: 3, runId: "run-1", presenceSequence: 9 },
  ]);
  const saved = transport.hibernationAttachment(socket);
  assert.equal(saved.session.run.presenceSequence, 9);
  // A restored connection continues the count instead of repeating it.
  const { transport: restored } = productionAgentInstanceTransport(recordingRuntime().runtime);
  const again = new FakeSocket();
  assert.equal(restored.rehydrate(again, saved), true);
  assert.equal(restored.hibernationAttachment(again).session.run.presenceSequence, 9);
  for (const presenceSequence of [0, -1, 1.5]) {
    const invalid = structuredClone(saved);
    invalid.session.run.presenceSequence = presenceSequence;
    assert.equal(restored.rehydrate(new FakeSocket(), invalid), false);
  }
});

test("a report shows the record the database answered, then its work, ahead of the legacy card", async () => {
  const { factory, transport, socket } = connection();
  await transport.handleFrame(socket, report({ status: "busy", model: "gpt", activity: "Running tests" }));
  const [session] = transport.liveSessions();
  const sent = [];
  await factory.onAgentPresenceChange({
    reason: "update", session, status: "busy",
    deliver: (userId, frame) => { sent.push([userId, frame]); return true; },
    deliverAgentPresence: (userId, _channel, card) => { if (card) sent.push([userId, card]); return true; },
    deliverPresenceChannel: () => true,
  });
  assert.deepEqual(sent.map(([userId, frame]) => [userId, frame.type]), [
    ["user-1", "instance_records"], ["user-1", "instance_activity"], ["user-1", "enhanced_presence"],
  ]);
  assert.deepEqual(sent[0][1].records, [record(1)], "the record is the database's answer, not composed here");
  assert.deepEqual(sent[1][1].activities, [{ instanceId, channelId, revision: { version: 3, sequence: 1 },
    activity: "Running tests" }]);
});

test("a cross-cell presence body carries records and work for its own Channel only", () => {
  const activity = { instanceId, channelId, revision: { version: 3, sequence: 2 }, intent: "fix" };
  const recipients = [{ userId: "user-2", digest: false, card: false, channel: false, immediate: [] }];
  const body = channelAgentPresenceDeliveryBody({ channelId, reason: "update", records: [record(2)],
    activities: [activity], recipients });
  const parsed = parseChannelAgentPresenceDelivery(JSON.parse(body));
  assert.deepEqual(parsed.records, [record(2)]);
  assert.deepEqual(parsed.activities, [activity]);
  assert.equal(parseChannelAgentPresenceDelivery({ ...JSON.parse(body),
    records: [{ ...record(2), channelId: "channel-2" }] }), undefined);
  assert.equal(parseChannelAgentPresenceDelivery({ ...JSON.parse(body), records: [{ id: instanceId }] }), undefined);
  // Temporary work never carries durable status.
  const { status: _status, ...withoutStatus } = record(2);
  assert.equal(parseChannelAgentPresenceDelivery({ ...JSON.parse(body), records: [withoutStatus] }), undefined);
});

test("a machine that becomes unreachable, or returns, is the connection's next checkpoint, in its socket's order", async () => {
  const authority = recordingRuntime();
  const { factory } = productionAgentInstanceTransport(authority.runtime);
  const backend = factory.agentInstance();
  let reachable = true;
  backend.observeMachineReachability(() => reachable);
  const shown = [];
  const transport = new AgentInstanceRuntimeTransport(backend, undefined,
    async ({ reason, session }) => { shown.push([reason, session.run.presenceSequence]); });
  const attachment = agentInstanceAttachment({ run: { instanceId, connectionVersion: 3 } });
  const socket = new AttachedSocket(attachment);
  assert.equal(transport.rehydrate(socket, attachment), true);
  await transport.handleFrame(socket, report({ status: "busy", model: "gpt" }));
  // Anything after it on the socket runs after the checkpoint.
  const settled = () => transport.handleFrame(socket, JSON.stringify({ type: "ping", requestId: "settle" }));
  reachable = false;
  transport.reprojectMachine(() => true);
  await settled();
  reachable = true;
  transport.reprojectMachine(() => true);
  await settled();
  assert.deepEqual(authority.writes.map((write) => [write.ordering.presenceSequence, write.presentation.offlineReason,
    write.status]), [[1, undefined, "busy"], [2, "machine_offline", "busy"], [3, undefined, "busy"]],
  "its own status stays live; only what it is shown as changes");
  assert.deepEqual(shown, [["update", 1], ["update", 2], ["update", 3]]);
  assert.equal(socket.attachment.session.run.presenceSequence, 3, "the count survives hibernation");
  // A connection on another machine is not touched.
  transport.reprojectMachine(() => false);
  await settled();
  assert.equal(authority.writes.length, 3);
});
