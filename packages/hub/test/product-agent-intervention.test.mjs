import assert from "node:assert/strict";

import { test } from "node:test";

import {
  AgentStopPendingError,
  orchestrateProductAgentIntervention,
  parseProductAgentStopCommand,
} from "../src/product-agent-intervention.ts";

function target(overrides = {}) {
  return {
    instanceId: "instance-1",
    runId: "run-1",
    agentId: "agent-1",
    mentionTarget: "codex:1",
    ownerUserId: "owner-1",
    machineOwnerUserId: "machine-owner-1",
    machineId: "machine-1",
    hostId: "host-1",
    executionKey: "execution-1",
    ...overrides,
  };
}

test("same-name stop is rejected while a stable Profile address stops only its Instance", async () => {
  const port = portWithTargets([target(), target({ instanceId: "instance-2", runId: "run-2", agentId: "agent-2" })]);
  const input = { channelId: "channel", sourceMessageId: "stop-source", port };
  assert.equal((await orchestrateProductAgentIntervention({ ...input, body: "@codex:1:stop" })).stopped, 0);
  assert.equal(port.stops.length, 0);
  assert.equal((await orchestrateProductAgentIntervention({ ...input, body: "@agent-2:1:stop" })).stopped, 1);
  assert.equal(port.stops.length, 1);
});

function portWithTargets(targets) {
  const stops = [];
  const notices = [];
  return {
    stops,
    notices,
    async listKillTargets() {
      return targets;
    },
    async issueStop(stopTarget, controlId, reason) {
      stops.push({ target: stopTarget, controlId, reason });
    },
    async publishSystemNotice(_channelId, body, key) {
      notices.push(key ? `${key}: ${body}` : body);
    },
  };
}

test("single-instance stop syntax retains the exact channel address", () => {
  assert.deepEqual(parseProductAgentStopCommand("@codex:12:stop"), {
    target: "codex:12",
    all: false,
  });
  assert.deepEqual(parseProductAgentStopCommand("@xMatrix:stop"), {
    target: "xMatrix",
    all: false,
  });
  assert.deepEqual(parseProductAgentStopCommand("/kill @codex:2 investigate"), {
    target: "codex:2",
    all: false,
    reason: "investigate",
  });
  assert.deepEqual(parseProductAgentStopCommand("/kill all"), {
    target: "all",
    all: true,
  });
  assert.equal(parseProductAgentStopCommand("please stop codex"), undefined);
});

test("a visible stop message controls only its exact live instance", async () => {
  const first = target();
  const second = target({
    instanceId: "instance-2",
    runId: "run-2",
    mentionTarget: "codex:2",
  });
  const port = portWithTargets([first, second]);

  const result = await orchestrateProductAgentIntervention({
    channelId: "channel-1",
    sourceMessageId: "message-1",
    body: "@codex:2:stop",
    port,
  });

  assert.deepEqual(result, { considered: 1, stopped: 1, failures: [] });
  assert.equal(port.stops.length, 1);
  assert.equal(port.stops[0].target.instanceId, "instance-2");
  assert.equal(port.stops[0].reason, "Stopped from xMatrix web");
  assert.deepEqual(port.notices, []);
});

test("@xMatrix:stop names no Run now that the management agent is retired, and never broadens", async () => {
  // No live Run is presented as xMatrix any more; every target is its registration's Instance.
  const port = portWithTargets([target(), target({ instanceId: "instance-2", runId: "run-2", mentionTarget: "codex:2" })]);

  const result = await orchestrateProductAgentIntervention({
    channelId: "channel-1",
    sourceMessageId: "message-2",
    body: "@xMatrix:stop",
    port,
  });

  assert.equal(result.stopped, 0);
  assert.deepEqual(port.stops, []);
  assert.deepEqual(port.notices, ["xMatrix could not find a live instance for `@xMatrix`."]);
});

test("an unknown exact target remains visible and does not broaden to all instances", async () => {
  const port = portWithTargets([target()]);

  const result = await orchestrateProductAgentIntervention({
    channelId: "channel-1",
    sourceMessageId: "message-3",
    body: "@codex:9:stop",
    port,
  });

  assert.deepEqual(result, { considered: 1, stopped: 0, failures: [] });
  assert.equal(port.stops.length, 0);
  assert.deepEqual(port.notices, ["xMatrix could not find a live instance for `@codex:9`."]);
});

test("a target-authority failure is visible and never claims a stop was issued", async () => {
  const notices = [];
  const failure = new Error("control_plane_target_identity_mismatch");
  await assert.rejects(orchestrateProductAgentIntervention({
    channelId: "channel-1",
    sourceMessageId: "message-4",
    body: "@codex:1:stop",
    port: {
      async listKillTargets() { throw failure; },
      async issueStop() { assert.fail("stop must not be issued without an authoritative target"); },
      async publishSystemNotice(_channelId, body) { notices.push(body); },
    },
  }), failure);
  assert.deepEqual(notices, [
    "xMatrix could not resolve live Agent Instances. No stop request was issued.",
  ]);
});

test("kill-all reports queued host stops as pending rather than failed", async () => {
  const port = portWithTargets([target()]);
  port.issueStop = async () => { throw new AgentStopPendingError("host is offline"); };
  const result = await orchestrateProductAgentIntervention({
    channelId: "channel-1", sourceMessageId: "message-pending", body: "/kill all", port,
  });
  assert.deepEqual(result, { considered: 1, stopped: 0, failures: [], pending: 1 });
  assert.deepEqual(port.notices, ["Waiting for host confirmation for 1 agent instance."]);
});

test("a fenced kill-all reports the stop before host cleanup finishes", async () => {
  const port = fencedKillAllPort();
  let releaseHost;
  const hostDone = new Promise((resolve) => { releaseHost = resolve; });
  const waits = [];
  port.issueStop = async (_target, _controlId, _reason, _channelId, waitForTermination) => {
    waits.push(waitForTermination);
    await hostDone;
  };
  const running = orchestrateProductAgentIntervention({
    channelId: "channel-1", sourceMessageId: "message-fenced", body: "/kill all", port,
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(port.notices, []);
  releaseHost();
  assert.deepEqual(await running, { considered: 2, stopped: 2, failures: [] });
  assert.deepEqual(port.notices, []);
  // The stop is in effect; its host result finalizes each Run, so the
  // command is only queued, never awaited to termination.
  assert.deepEqual(waits, [false, false]);
});

test("a fenced kill-all reports unfinished host cleanup separately", async () => {
  const port = fencedKillAllPort();
  port.issueStop = async (stopTarget) => {
    if (stopTarget.instanceId === "instance-1") throw new AgentStopPendingError("host is offline");
    throw new Error("daemon stop issue failed (500)");
  };
  const result = await orchestrateProductAgentIntervention({
    channelId: "channel-1", sourceMessageId: "message-fenced", body: "/kill all", port,
  });
  assert.deepEqual(result, { considered: 2, stopped: 0, failures: ["instance-2: daemon stop issue failed (500)"],
    pending: 1 });
  assert.deepEqual(port.notices, [
    "host-cleanup: Host cleanup is still pending for codex:1. " +
      "Host cleanup failed for 1: instance-2: daemon stop issue failed (500).",
  ]);
});

test("kill-all waits for host confirmation when any target was not fenced", async () => {
  const port = portWithTargets([
    target({ stopRequestSourceMessageId: "message-mixed" }),
    target({ instanceId: "instance-2", runId: "run-2", mentionTarget: "codex:2" }),
  ]);
  const result = await orchestrateProductAgentIntervention({
    channelId: "channel-1", sourceMessageId: "message-mixed", body: "/kill all", port,
  });
  assert.deepEqual(result, { considered: 2, stopped: 2, failures: [] });
  assert.deepEqual(port.notices, []);
  assert.equal(port.stops.length, 2);
});

test("a fenced exact stop reports the stop without waiting for the host", async () => {
  const port = portWithTargets([
    target({ stopRequestSourceMessageId: "message-exact" }),
    target({ instanceId: "instance-2", runId: "run-2", mentionTarget: "codex:2" }),
  ]);
  const waits = [];
  port.issueStop = async (stopTarget, _controlId, _reason, _channelId, wait) => {
    waits.push([stopTarget.instanceId, wait]);
    throw new Error("daemon stop issue failed (500)");
  };
  const result = await orchestrateProductAgentIntervention({
    channelId: "channel-1", sourceMessageId: "message-exact", body: "@codex:1:stop", port,
  });
  assert.deepEqual(waits, [["instance-1", false]]);
  assert.deepEqual(result, { considered: 1, stopped: 0, failures: ["instance-1: daemon stop issue failed (500)"] });
  assert.deepEqual(port.notices, [
    "host-cleanup: Host cleanup failed for 1: instance-1: daemon stop issue failed (500).",
  ]);
});

test("a fenced exact stop to an offline daemon says it is queued, not stopped", async () => {
  const port = portWithTargets([target({ mentionTarget: "claude:1", stopRequestSourceMessageId: "message-offline" })]);
  const reads = [];
  port.daemonOnline = async (stopTarget) => { reads.push(stopTarget.hostId); return false; };
  const result = await orchestrateProductAgentIntervention({
    channelId: "channel-1", sourceMessageId: "message-offline", body: "@claude:1:stop", port,
  });
  assert.deepEqual(result, { considered: 1, stopped: 1, failures: [] });
  // The command is still queued for the daemon to apply when it reconnects.
  assert.equal(port.stops.length, 1);
  assert.deepEqual(reads, ["host-1"]);
  assert.deepEqual(port.notices, ["Stop queued for @claude:1. Its machine's daemon is offline, so the process " +
    "keeps running until the daemon reconnects and applies the stop."]);
  assert.ok(!port.notices.some((notice) => notice.startsWith("Stopped")));
});

test("an exact unfenced stop to an offline daemon says it is queued", async () => {
  const port = portWithTargets([target({ mentionTarget: "claude:1" })]);
  port.daemonOnline = async () => false;
  await orchestrateProductAgentIntervention({
    channelId: "channel-1", sourceMessageId: "message-offline", body: "@claude:1:stop", port,
  });
  assert.equal(port.stops.length, 1);
  assert.match(port.notices[0], /^Stop queued for @claude:1\. Its machine's daemon is offline/u);
});

test("a fenced kill-all requests online stops and queues offline stops, reading each daemon once", async () => {
  const port = portWithTargets([
    target({ stopRequestSourceMessageId: "message-mixed" }),
    target({ instanceId: "instance-2", runId: "run-2", mentionTarget: "codex:2", machineId: "machine-2", hostId: "host-2",
      stopRequestSourceMessageId: "message-mixed" }),
    target({ instanceId: "instance-3", runId: "run-3", mentionTarget: "codex:3", machineId: "machine-2", hostId: "host-2",
      stopRequestSourceMessageId: "message-mixed" }),
  ]);
  const reads = [];
  port.daemonOnline = async (stopTarget) => { reads.push(stopTarget.hostId); return stopTarget.hostId === "host-1"; };
  await orchestrateProductAgentIntervention({
    channelId: "channel-1", sourceMessageId: "message-mixed", body: "/kill all", port,
  });
  assert.deepEqual(reads.sort(), ["host-1", "host-2"]);
  assert.equal(port.stops.length, 3);
  assert.deepEqual(port.notices, ["Stop queued for @codex:2, @codex:3. Their machines' " +
    "daemons are offline, so those processes keep running until the daemons reconnect and apply the stop."]);
});

test("an online daemon is not termination evidence for a fenced stop", async () => {
  const port = portWithTargets([target({ stopRequestSourceMessageId: "message-online" })]);
  port.daemonOnline = async () => true;
  let releaseHost;
  port.issueStop = () => new Promise((resolve) => { releaseHost = resolve; });
  const running = orchestrateProductAgentIntervention({
    channelId: "channel-1", sourceMessageId: "message-online", body: "@codex:1:stop", port,
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(port.notices, []);
  releaseHost();
  await running;
  assert.ok(!port.notices.some((notice) => notice.startsWith("Stopped")));
});

test("an unreadable daemon status never claims termination", async () => {
  const port = portWithTargets([target({ stopRequestSourceMessageId: "message-unknown" })]);
  port.daemonOnline = async () => { throw new Error("authority unavailable"); };
  await orchestrateProductAgentIntervention({
    channelId: "channel-1", sourceMessageId: "message-unknown", body: "@codex:1:stop", port,
  });
  assert.deepEqual(port.notices, []);
});

function portWithResting(targets, resting) {
  const port = portWithTargets(targets);
  port.restingStops = [];
  port.stopResting = async (_channelId, request) => {
    port.restingStops.push(request);
    return resting.filter((item) => (!request.mention || item.mentionTarget.toLowerCase() === request.mention.toLowerCase()) &&
      !request.exclude.includes(item.instanceId));
  };
  return port;
}

test("stopping a resting Instance ends its rest without a host stop", async () => {
  const port = portWithResting([target()], [{ instanceId: "instance-9", mentionTarget: "codex:9" }]);
  const result = await orchestrateProductAgentIntervention({
    channelId: "channel-1", sourceMessageId: "message-rest", body: "@codex:9:stop", port,
  });
  assert.deepEqual(result, { considered: 1, stopped: 1, failures: [] });
  assert.equal(port.stops.length, 0, "a resting Instance has no process for the daemon to stop");
  assert.deepEqual(port.restingStops, [{ mention: "codex:9", exclude: [] }]);
  assert.deepEqual(port.notices, ["Stopped @codex:9. It was resting and will no longer wake for new messages."]);
});

test("kill-all also ends every resting Instance's rest, leaving live ones to their daemon", async () => {
  const port = portWithResting([target()], [
    { instanceId: "instance-1", mentionTarget: "codex:1" },
    { instanceId: "instance-8", mentionTarget: "codex:8" },
    { instanceId: "instance-9", mentionTarget: "codex:9" },
  ]);
  const result = await orchestrateProductAgentIntervention({
    channelId: "channel-1", sourceMessageId: "message-kill", body: "/kill all", port,
  });
  assert.equal(result.stopped, 1);
  assert.equal(port.stops.length, 1);
  assert.deepEqual(port.restingStops, [{ exclude: ["instance-1"] }], "a waking live target is stopped by its daemon");
  assert.deepEqual(port.notices, ["Stopped 2 resting agent instances."]);
});

test("kill-all with only resting Instances reports them instead of an empty Channel", async () => {
  const port = portWithResting([], [{ instanceId: "instance-9", mentionTarget: "codex:9" }]);
  await orchestrateProductAgentIntervention({
    channelId: "channel-1", sourceMessageId: "message-kill-resting", body: "/kill all", port,
  });
  assert.deepEqual(port.notices, ["Stopped 1 resting agent instance."]);
});

test("daemon stop obligations retain exact Machine scope without a hostname", async () => {
  const { daemonStopTargets } = await import("../src/product-agent-intervention-authority-adapter.ts");
  const valid = { instanceId: "instance", runId: "run", agentId: "instance", ownerUserId: "owner",
    machineOwnerUserId: "machine-owner", machineId: "machine", executionKey: "execution" };
  assert.deepEqual(daemonStopTargets([valid]), [{ ...valid, hostId: "" }]);
  assert.deepEqual(daemonStopTargets([{ ...valid, machineId: undefined, hostname: "same-name" }]), []);
});

test("a renamed Machine remains one daemon status read for multiple Runs", async () => {
  const port = portWithTargets([
    target({ stopRequestSourceMessageId: "rename" }),
    target({ instanceId: "instance-2", runId: "run-2", mentionTarget: "codex:2", hostId: "renamed",
      stopRequestSourceMessageId: "rename" }),
  ]);
  let reads = 0;
  port.daemonOnline = async () => { reads++; return false; };
  await orchestrateProductAgentIntervention({ channelId: "channel-1", sourceMessageId: "rename", body: "/kill all", port });
  assert.equal(reads, 1);
  assert.equal(port.stops.length, 2);
});

function fencedKillAllPort() {
  return portWithTargets([target({ stopRequestSourceMessageId: "message-fenced" }),
    target({ instanceId: "instance-2", runId: "run-2", mentionTarget: "codex:2", stopRequestSourceMessageId: "message-fenced" })]);
}
