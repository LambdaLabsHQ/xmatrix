import assert from "node:assert/strict";
import { test } from "node:test";

import { authorityPort, recordingCommands } from "./support/machine-daemon-port.mjs";

const session = Object.freeze({
  principal: Object.freeze({
    ownerUserId: "user-1",
    ownerEmail: "owner@example.test",
    machineId: "machine-1",
    hostId: "host-1",
  }),
  connectionEpoch: 7,
  displayName: "Workstation",
  capabilities: Object.freeze([]),
  machineMetadata: Object.freeze({}),
  connectedAt: "2026-08-06T00:00:00.000Z",
  lastSeenAt: "2026-08-06T00:00:00.000Z",
});

for (const [type, extra] of [
  ["machine_run_exited", { completed: true, requestId: "exit-1" }],
  ["machine_stop_result", { ok: true, requestId: "stop-1" }],
  ["machine_spawn_result", { ok: false, requestId: "spawn-1" }],
]) {
  test(`${type} commits the authoritative lifecycle before returning`, async () => {
    const order = [];
    const port = lifecycleRecordingPort(order);
    const reply = await port.execute(session, { type, runId: "run-1", executionKey: "execution-1", ...extra });
    if (type === "machine_run_exited") {
      assert.deepEqual(reply, { type: "machine_run_report_acked", requestId: "exit-1", runId: "run-1" });
    }
    assert.deepEqual(order, ["report", "lifecycle"]);
  });
}

for (const type of ["machine_run_exited", "machine_stop_result"]) {
  test(`a committed ${type} is answered at once and finalized by the coordinator`, async () => {
    const order = [];
    const port = lifecycleRecordingPort(order, { runTerminalReportRecorded: true }, {
      async dispatchChannelAboutFollowUp() { order.push("about"); },
      async wakeCoordinator() { order.push("wake"); },
    });
    const reply = await port.execute(session, { type, requestId: "report-1", runId: "run-1",
      executionKey: "execution-1", ok: true });
    // No lifecycle or About round trip holds the socket's frame.
    assert.deepEqual(order, ["report", "wake"]);
    if (type === "machine_run_exited") {
      assert.deepEqual(reply, { type: "machine_run_report_acked", requestId: "report-1", runId: "run-1" });
    }
  });
}

test("a committed exit report no Channel can finalize is still acknowledged", async () => {
  const port = authorityPort({
    commands: { async command() { return {}; } },
  });
  // Unanswered, the daemon would resend this report every 30 s forever.
  assert.deepEqual(await port.execute(session, { type: "machine_run_exited", requestId: "exit-1",
    runId: "run-unknown", executionKey: "execution-1" }),
  { type: "machine_run_report_acked", requestId: "exit-1", runId: "run-unknown" });
});

test("terminal socket cleanup uses only the committed lifecycle result, including replay", async () => {
  const closed = [];
  let terminalInstanceIds = ["instance-authoritative"];
  const port = authorityPort({
    commands: { async command(_name, input) {
      return input.runLifecycleReplica ? { terminalInstanceIds }
        : { runLifecycleChannelId: "channel-1", terminalInstanceIds: ["not-lifecycle-authority"] };
    } },
    terminateInstance(id) { closed.push(id); },
  });
  const report = { type: "machine_run_exited", requestId: "exit-cleanup", runId: "run-1",
    executionKey: "execution-1", instanceId: "untrusted-report-instance" };
  await port.execute(session, report);
  assert.deepEqual(closed, ["instance-authoritative"]);
  terminalInstanceIds = []; // Current authority no longer permits closing it.
  await port.execute(session, report);
  assert.deepEqual(closed, ["instance-authoritative"]);
  terminalInstanceIds = ["valid", null];
  await assert.rejects(port.execute(session, report), /Invalid authoritative terminal Instance list/);
  assert.deepEqual(closed, ["instance-authoritative"], "validate the complete list before any close");
});

test("fresh connection performs exactly one catch-up claim", async () => {
  const calls = [];
  const port = authorityPort({
    commands: recordingCommands(calls, () => ({ commands: [] })),
  });

  await port.connected(session, async () => {
    throw new Error("empty catch-up must not deliver");
  });
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, "machine-daemon-control");
  assert.equal(calls[0].input.action, "claim");
  assert.equal(calls[0].input.connectionEpoch, 7);
});

test("quota probes are capability gated and complete through the existing lease", async () => {
  const calls = [];
  const probe = { requestId: "probe-1", connectionEpoch: 7,
    targets: [{ targetId: "registration:codex", configurationDigest: "a".repeat(64) }] };
  const lease = { leaseOwner: "machine-lease", leaseGeneration: 1, entityVersion: 2, daemonEpoch: 7 };
  const port = authorityPort({
    commands: recordingCommands(calls, (_name, input) => (input.action === "claim"
      ? { commands: input.commandTypes.includes("quota_probe")
        ? [{ ...lease, payload: { type: "machine_quota_probe", requestId: probe.requestId, probe } }] : [] }
      : {})),
  });
  assert.deepEqual(await port.claimCommands(session), []);
  assert.equal(calls[0].input.commandTypes.includes("quota_probe"), false);
  const capable = { ...session, capabilities: ["machine_quota_probe_v2"] };
  const [command] = await port.claimCommands(capable);
  assert.equal(command.type, "machine_quota_probe");
  assert.deepEqual(command.relayLease, lease);
  const response = { type: "machine_quota_probe_result", requestId: probe.requestId,
    probe: { requestId: probe.requestId, connectionEpoch: 7,
      results: [{ ...probe.targets[0], status: "unavailable", reason: "provider_unavailable" }] } };
  assert.deepEqual(await port.execute(capable, response), {
    type: "machine_command_completion_acked", requestId: "probe-1", controlId: "probe-1",
  });
  assert.equal(calls.at(-1).input.action, "complete");
  assert.deepEqual(calls.at(-1).input.relayLease, lease);
  const before = calls.length;
  await assert.rejects(port.execute(session, response), /capable active connection/);
  await assert.rejects(port.execute({ ...capable, connectionEpoch: 8 }, response), /capable active connection/);
  assert.equal(calls.length, before, "rejected responses never reach the authority");
});

test("harness actions are capability gated, carry no command, and complete through the lease", async () => {
  const calls = [];
  const requestId = "harness:00000000-0000-4000-8000-000000000000";
  const lease = { leaseOwner: "machine-lease", leaseGeneration: 1, entityVersion: 2, daemonEpoch: 7 };
  let payload = { type: "machine_harness_action", requestId, presetId: "claude", action: "update" };
  const port = authorityPort({
    commands: recordingCommands(calls, (_name, input) => (input.action === "claim"
      ? { commands: input.commandTypes.includes("harness_action") ? [{ ...lease, payload }] : [] }
      : {})),
  });
  assert.deepEqual(await port.claimCommands(session), []);
  assert.equal(calls[0].input.commandTypes.includes("harness_action"), false);
  const capable = { ...session, capabilities: ["machine_harness_action_v1"] };
  const [command] = await port.claimCommands(capable);
  assert.deepEqual(command, { ...payload, relayLease: lease });
  payload = { ...payload, command: "rm -rf /" };
  await assert.rejects(port.claimCommands(capable), /invalid harness action/);
  const response = { type: "machine_harness_action_result", requestId,
    result: { presetId: "claude", action: "update", status: "succeeded", exitCode: 0 } };
  assert.deepEqual(await port.execute(capable, response), {
    type: "machine_command_completion_acked", requestId, controlId: requestId,
  });
  assert.equal(calls.at(-1).input.action, "complete");
  const before = calls.length;
  await assert.rejects(port.execute(session, response), /capable connection/);
  assert.equal(calls.length, before, "rejected responses never reach the authority");
});

test("terminal reports dispatch one durable coalesced Channel About successor", async () => {
  const followUps = [];
  const port = authorityPort({
    commands: {
      async command() {
        return {
          channelAboutFollowUps: [{
            spaceId: "space-1",
            channelId: "channel-1",
            requestId: "channel-about:channel-1:2",
            successorOfRunId: "run-about-1",
            actorUserId: "user-1",
          }],
        };
      },
    },
    async dispatchChannelAboutFollowUp(input) {
      followUps.push(input);
    },
  });

  await port.execute(session, {
    type: "machine_run_exited",
    runId: "run-about-1",
    executionKey: "execution-about-1",
    completed: true,
  });

  assert.deepEqual(followUps, [{
    spaceId: "space-1",
    channelId: "channel-1",
    requestId: "channel-about:channel-1:2",
    successorOfRunId: "run-about-1",
    actorUserId: "user-1",
  }]);
});

test("live-socket lease renew uses Authority renew and echoes leaseUntil", async () => {
  const calls = [];
  const port = authorityPort({
    commands: recordingCommands(calls, () => ({ leaseUntil: "2026-08-16T07:00:00.000Z" })),
  });

  const reply = await port.execute(session, {
    type: "machine_command_lease_renew",
    requestId: "renew-1",
    controlId: "spawn-1",
    relayLease: {
      leaseOwner: "owner-1",
      leaseGeneration: 1,
      entityVersion: 2,
      daemonEpoch: 7,
    },
  });

  assert.deepEqual(reply, {
    type: "machine_command_lease_renewed",
    requestId: "renew-1",
    controlId: "spawn-1",
    leaseUntil: "2026-08-16T07:00:00.000Z",
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, "machine-daemon-control");
  assert.equal(calls[0].input.action, "renew");
  assert.equal(calls[0].input.controlId, "spawn-1");
  assert.equal(calls[0].input.leaseMs, 60_000);
  assert.equal(calls[0].input.connectionEpoch, 7);
  assert.deepEqual(calls[0].input.relayLease, {
    leaseOwner: "owner-1",
    leaseGeneration: 1,
    entityVersion: 2,
    daemonEpoch: 7,
  });
});

test("live-socket lease renew fails closed without Authority lease evidence", async () => {
  const port = authorityPort({
    commands: {
      async command() {
        throw new Error("Authority must not run without lease evidence");
      },
    },
  });

  await assert.rejects(
    () => port.execute(session, {
      type: "machine_command_lease_renew",
      requestId: "renew-2",
      controlId: "spawn-2",
    }),
    /requires authority/,
  );
});

test("journal admission extends the short lease and advances the exact Launch", async () => {
  const calls = [];
  const admittedAt = new Date().toISOString();
  const port = authorityPort({
    commands: recordingCommands(calls, (name) => (name === "machine-daemon-control"
      ? { leaseUntil: "2026-08-16T07:00:00.000Z" } : {})),
  });
  const reply = await port.execute(session, {
    type: "machine_command_admitted", requestId: "admit:spawn-1", controlId: "spawn-1",
    launchId: "launch-1", channelId: "channel-1",
    admittedAt,
    relayLease: { leaseOwner: "owner-1", leaseGeneration: 1,
      entityVersion: 2, daemonEpoch: 7 },
  });
  assert.deepEqual(reply, { type: "machine_command_admission_acked",
    requestId: "admit:spawn-1", controlId: "spawn-1",
    leaseUntil: "2026-08-16T07:00:00.000Z" });
  assert.equal(calls[0].name, "machine-daemon-control");
  assert.equal(calls[0].input.action, "renew");
  assert.equal(calls[0].input.leaseMs, 60_000);
  assert.deepEqual(calls[1], { name: "agent-launch-update", input: {
    launchId: "launch-1", channelId: "channel-1", actorUserId: "user-1", state: "admitted",
    at: admittedAt,
  } });
});

test("recovery connect and activation frames preserve exact transaction evidence", async () => {
  const calls = [];
  const port = authorityPort({
    async authenticate() { return session.principal; },
    commands: recordingCommands(calls, (_name, input) => ({
      daemon: {
        id: "daemon-1", userId: "user-1", email: "owner@example.test",
        machineId: "machine-1", hostId: "host-1", name: "Workstation",
        status: "online", capabilities: [], metadata: {},
        createdAt: "2026-08-30T00:00:00.000Z",
        updatedAt: "2026-08-30T00:00:00.000Z",
        lastSeenAt: "2026-08-30T00:00:00.000Z",
      },
      connectionEpoch: 8,
      activation: {
        transactionId: "tx-1",
        artifactSha256: "a".repeat(64),
        connectionEpoch: 8,
        phase: ["recover_connect", "activation_begin"].includes(input.action)
          ? "recovering" : "activation_prepared",
        receiptId: ["recover_connect", "activation_begin"].includes(input.action)
          ? "recovering:tx-1" : "prepared:tx-1",
        ...(input.action === "activation_prepare" ? { runSetDigest: "b".repeat(64) } : {}),
      },
    })),
  });
  const activation = {
    mode: "recovering",
    transactionId: "tx-1",
    transactionNonce: "nonce-1",
    artifactSha256: "a".repeat(64),
    sourceConnectionEpoch: 7,
  };
  const authentication = await port.authenticate({
    type: "machine_daemon_connect",
    requestId: "connect-1",
    token: "token",
    displayName: "Workstation",
    machineId: "machine-1",
    hostId: "host-1",
    activation,
  });
  assert.equal(calls[0].input.action, "recover_connect");
  assert.deepEqual(calls[0].input.activation, activation);
  assert.equal(authentication.connected.activation.phase, "recovering");

  const begun = await port.execute(session, {
    type: "machine_activation_begin",
    requestId: "begin-1",
    transactionId: "tx-1",
    transactionNonce: "nonce-1",
    artifactSha256: "a".repeat(64),
    sourceConnectionEpoch: 7,
  });
  assert.equal(calls[1].input.action, "activation_begin");
  assert.equal(calls[1].input.payload.transactionNonce, "nonce-1");
  assert.equal(begun.phase, "recovering");

  const prepared = await port.execute({ ...session, connectionEpoch: 8, activationPhase: "recovering" }, {
    type: "machine_activation_prepare",
    requestId: "prepare-1",
    transactionId: "tx-1",
    artifactSha256: "a".repeat(64),
    connectionEpoch: 8,
    runSetDigest: "b".repeat(64),
    expectedRunIds: ["run-1"],
    adoptedRunIds: ["run-1"],
    naturalTerminalRunIds: [],
  });
  assert.equal(calls[2].input.action, "activation_prepare");
  assert.equal(calls[2].input.connectionEpoch, 8);
  assert.equal(calls[2].input.payload.transactionId, "tx-1");
  assert.equal(prepared.phase, "activation_prepared");
  assert.equal(prepared.runSetDigest, "b".repeat(64));
});

test("leased command completion returns an explicit durable effect acknowledgement", async () => {
  const port = authorityPort({
    commands: { async command() { return {}; } },
  });
  const result = await port.execute(session, {
    type: "machine_stop_result",
    requestId: "stop-1",
    ok: true,
  });
  assert.deepEqual(result, {
    type: "machine_command_completion_acked",
    requestId: "stop-1",
    controlId: "stop-1",
  });
});

test("a replayed completion gets a fresh lifecycle reconciliation command after reconnect", async () => {
  async function lifecycleCommandId(reused) {
    const calls = [];
    const port = authorityPort({
      commands: recordingCommands(calls, (name, input) => {
        if (name === "machine-daemon-control" && input.action === "complete") {
          return { reused, runLifecycleChannelId: "channel-1" };
        }
        return {};
      }),
    });
    await port.execute(session, {
      type: "machine_spawn_result", requestId: "spawn-1", runId: "run-1",
      launchId: "launch-1", channelId: "channel-1", executionKey: "execution-1",
      instanceId: "instance-1", agentName: "codex-next", identityId: "agent-1", ok: true,
      pid: 123,
    });
    return calls.find((call) => call.input.runLifecycleReplica === true).input.commandId;
  }

  assert.notEqual(await lifecycleCommandId(true), await lifecycleCommandId(false));
});

test("deterministic daemon spawn failures are terminal while transport failures remain retryable", async () => {
  for (const [error, retryable] of [
    ["Provider executable is missing", false],
    ["Machine command lease is stale", true],
  ]) {
    const calls = [];
    const port = authorityPort({
      commands: recordingCommands(calls),
    });
    await port.execute(session, {
      type: "machine_spawn_result", requestId: `spawn-${retryable}`,
      launchId: `launch-${retryable}`, channelId: "channel-1", runId: `run-${retryable}`,
      executionKey: `execution-${retryable}`, instanceId: `instance-${retryable}`,
      agentName: "codex-next", identityId: `agent-${retryable}`, ok: false, error,
    });
    const update = calls.find((call) => call.name === "agent-launch-update");
    assert.equal(update.input.state, "failed");
    assert.equal(update.input.retryable, retryable);
  }
});

test("successful daemon spawn records the daemon-side OS occurrence time", async () => {
  const calls = [];
  const spawnedAt = new Date().toISOString();
  const port = authorityPort({
    commands: recordingCommands(calls),
  });
  await port.execute(session, {
    type: "machine_spawn_result", requestId: "spawn-success",
    launchId: "launch-success", channelId: "channel-1", runId: "run-success",
    executionKey: "execution-success", instanceId: "instance-success",
    agentName: "codex-next", identityId: "agent-success", ok: true, spawnedAt, pid: 123,
  });
  const update = calls.find((call) => call.name === "agent-launch-update");
  assert.equal(update.input.state, "spawned");
  assert.equal(update.input.at, spawnedAt);
});

test("causal snapshot evidence is connection-fenced and produces a stable lifecycle command", async () => {
  const calls = [];
  const background = [];
  const port = authorityPort({
    commands: recordingCommands(calls, (_name, input) => (input.runLifecycleReplica
      ? { changedRunIds: [] } : { runLifecycleChannelIds: ["channel-1"] })),
    keepAlive: (task) => background.push(task),
  });
  const causalSession = { ...session, capabilities: ["machine_run_snapshot_causal_v1"] };
  const snapshot = { type: "machine_run_snapshot", snapshotComplete: true,
    registryConnectionEpoch: 7, registrySequence: 12,
    capturedAt: new Date().toISOString(), runs: [] };
  await port.execute(causalSession, snapshot);
  await Promise.all(background);
  await port.execute(causalSession, snapshot);
  await Promise.all(background);
  const replicas = calls.filter((call) => call.input.runLifecycleReplica === true);
  assert.equal(replicas.length, 2);
  assert.equal(replicas[0].input.commandId, replicas[1].input.commandId);
  assert.equal(replicas[0].input.connectionEpoch, 7);

  const before = calls.length;
  await assert.rejects(() => port.execute(causalSession, {
    ...snapshot, registryConnectionEpoch: 6, registrySequence: 13,
  }), /does not match the active connection/u);
  assert.equal(calls.length, before, "invalid causal evidence must fail before Authority mutation");
});

test("a partial snapshot reconciles only its Runs' Channels in its frame; a full one fans out off the socket", async () => {
  const reconciled = [];
  const background = [];
  const port = authorityPort({
    keepAlive(task) { background.push(task); },
    commands: { async command(name, input) {
      if (input.action === "claim") {
        return { commands: [{ controlId: "stop-1", commandType: "stop", leaseOwner: "owner",
          leaseGeneration: 1, entityVersion: 2, daemonEpoch: 7, payload: { type: "machine_stop_agent",
            requestId: "stop-1", runId: "run-elsewhere", channelId: "channel-elsewhere" } }] };
      }
      if (!input.runLifecycleReplica) return { runLifecycleChannelIds: ["channel-3"] };
      reconciled.push(input.channelId);
      return { changedRunIds: [] };
    } },
  });
  // A claimed command remembers its Run's Channel; only a full snapshot may reach it.
  await port.claimCommands(session);
  await port.execute(session, { type: "machine_run_snapshot", snapshotComplete: false, runs: [] });
  assert.deepEqual(reconciled, ["channel-3"]);
  assert.equal(background.length, 0);

  reconciled.length = 0;
  await port.execute(session, { type: "machine_run_snapshot", snapshotComplete: true, runs: [] });
  assert.equal(background.length, 1);
  await Promise.all(background);
  assert.deepEqual(reconciled.sort(), ["channel-3", "channel-elsewhere"]);
});

test("every claimed spawn carries the Hub's harness preset", async () => {
  const lease = { leaseOwner: "machine-lease", leaseGeneration: 1, entityVersion: 2, daemonEpoch: 7 };
  const spawn = (requestId, extra) => ({ ...lease, payload: { type: "machine_spawn_agent", requestId,
    spaceId: "space-1", channelId: "channel-1", agentName: "codex", prompt: "go",
    workspace: { machineId: "machine-1", canonicalCwd: "/work" }, ...extra } });
  const port = authorityPort({
    commands: { async command(_name, input) {
      return input.action === "claim" ? { commands: [
        spawn("by-preset", { runtime: "/usr/local/bin/claude", agentPresetId: "claude" }),
        spawn("by-launcher", { runtime: "codex.exe" }),
        spawn("custom", { runtime: "/opt/tool", agentPresetId: "custom" }),
      ] } : {};
    } },
  });
  const [byPreset, byLauncher, custom] = await port.claimCommands(session);
  assert.equal(byPreset.harness.id, "claude");
  assert.equal(byPreset.harness.agentType, "claude_code");
  assert.equal(byPreset.harness.backend, "claude-print");
  assert.deepEqual(byPreset.harness.defaultArgs, ["--dangerously-skip-permissions"]);
  assert.equal(byPreset.harness.displayName, undefined, "presentation fields stay on the Hub");
  assert.equal(byLauncher.harness.id, "codex");
  assert.equal(custom.harness, undefined, "a custom runtime has no Hub preset to send");
});

test("a snapshot frame answers before its Channel fan-out, and a newer snapshot replaces a waiting one", async () => {
  const replicas = [];
  const background = [];
  const delivered = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const port = authorityPort({
    commands: { async command(_name, input) {
      if (!input.runLifecycleReplica) return { runLifecycleChannelIds: ["channel-1", "channel-2"] };
      replicas.push(input.commandId);
      // The first fan-out stalls: the socket must not wait for it.
      if (replicas.length === 1) await gate;
      return { changedRunIds: [], ...(input.channelId === "channel-2" ? { channelAboutFollowUps: [{
        spaceId: "space-1", channelId: "channel-2", requestId: `about-${replicas.length}`,
        successorOfRunId: "run-1", actorUserId: "user-1" }] } : {}) };
    } },
    async dispatchChannelAboutFollowUp() {},
    async deliverPending(principal) { delivered.push(principal.machineId); },
    keepAlive: (task) => background.push(task),
  });
  const causalSession = { ...session, capabilities: ["machine_run_snapshot_causal_v1"] };
  const snapshot = (registrySequence) => ({ type: "machine_run_snapshot", snapshotComplete: true,
    registryConnectionEpoch: 7, registrySequence, capturedAt: new Date().toISOString(), runs: [] });

  assert.equal(await port.execute(causalSession, snapshot(1)), undefined);
  // Both frames return while the first fan-out is still blocked.
  await port.execute(causalSession, snapshot(2));
  await port.execute(causalSession, snapshot(3));
  assert.equal(replicas.length, 1);
  assert.equal(background.length, 1, "one fan-out lane per machine");

  release();
  await Promise.all(background);
  // Snapshot 2 was superseded while it waited; only the newest one ran next.
  const sequences = replicas.map((commandId) => commandId.includes(":7:1") ? 1
    : commandId.includes(":7:2") ? 2 : commandId.includes(":7:3") ? 3 : undefined);
  assert.equal(replicas.length, 4);
  assert.ok(!sequences.includes(2), "a superseded snapshot never reaches Authority");
  assert.deepEqual(delivered, ["machine-1", "machine-1"], "issued successors are delivered after each fan-out");
});


test("connect binds the credential's Machine and records the current hostname observation", async () => {
  const calls = [];
  const port = authorityPort({
    async authenticate() { return { ...session.principal, hostId: "old-host", hostName: "old-host" }; },
    commands: recordingCommands(calls, (_name, input) => ({ daemon: { id: "daemon-1", userId: "user-1",
      email: "owner@example.test", name: "Laptop", machineId: "machine-1", hostname: input.hostname,
      status: "online", metadata: {}, lastSeenAt: new Date().toISOString() }, connectionEpoch: 8 })),
  });
  const message = { type: "machine_daemon_connect", token: "credential", machineId: "machine-1",
    hostname: "new-host", displayName: "daemon" };
  const result = await port.authenticate(message);
  assert.equal(result.principal.hostId, "new-host");
  assert.equal(result.connected.daemon.hostname, "new-host");
  assert.equal(calls[0].input.machineId, "machine-1");
  assert.equal(calls[0].input.hostname, "new-host");
  await assert.rejects(port.authenticate({ ...message, hostname: "\u0000" }), /bounded observation/);
  await assert.rejects(port.authenticate({ ...message, machineId: "machine-2" }), /does not match the Machine/);
  assert.equal(calls.length, 1, "another Machine never reaches the authority mutation");
});

function lifecycleRecordingPort(order, result = {}, options = {}) {
  return authorityPort({ commands: { async command(_name, input) {
    order.push(input.runLifecycleReplica ? "lifecycle" : "report");
    return { runLifecycleChannelId: "channel-1", ...result };
  } }, ...options });
}
