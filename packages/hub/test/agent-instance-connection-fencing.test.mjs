import assert from "node:assert/strict";
import { test } from "node:test";

// The port receives all operational dependencies below. Platform classes are
// imported by its production factory but must never execute in these tests.
// Resolve only: a synchronous load hook cannot forward tsx CommonJS loads
// whose source is supplied asynchronously (notably pg on Node 22).
import {
  PostgresAgentInstancePort,
} from "../src/runtime-transport/postgres-agent-instance-port.ts";
import {
  AgentInstanceRuntimeTransport,
} from "../src/runtime-transport/agent-instance-port.ts";
import {
  parseAgentInstanceHibernationAttachment,
} from "../src/runtime-transport/agent-instance-hibernation.ts";

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

class Socket {
  readyState = 1;
  sent = [];
  send(frame) { this.sent.push(JSON.parse(frame)); }
  close() { this.readyState = 3; }
}

function fixture() {
  const principal = { ownerUserId: "owner", agentId: "instance", agentName: "Agent",
    spaceId: "space", runId: "run", executionKey: "execution", channelId: "channel",
    machineId: "machine", hostId: "host" };
  const state = { id: "run", channelId: "channel", status: "starting",
    instanceId: "instance", instanceStatus: "offline", instanceVersion: 1,
    metadata: { executionKey: "execution", machineId: "machine", hostId: "host" } };
  const commands = [];
  const queries = [];
  const live = new Map();
  const hooks = {};
  const port = new PostgresAgentInstancePort({
    atomicInstanceConnect: true,
    authenticate: async () => ({ id: "owner", email: "owner@example.test", agentRun: principal }),
    runtime: {
      async getRun() { queries.push("get-run"); return { run: structuredClone(state) }; },
      async transition(input) {
        commands.push(input);
        if (input.kind === "instance_connect") {
          if (input.expectedVersion !== state.instanceVersion) throw new Error("Instance changed before connection claim");
          state.instanceStatus = "online";
          state.status = "running";
          const result = { entityVersion: ++state.instanceVersion };
          await hooks.connected?.(result);
          return result;
        }
        assert.equal(input.kind, "instance_transition");
        await hooks.disconnecting?.();
        if (input.expectedVersion !== state.instanceVersion) throw new Error("Instance version changed");
        state.instanceStatus = input.status;
        return { entityVersion: ++state.instanceVersion };
      },
    },
    history: { async join() {}, async leave() {}, async replay() {}, async history() {} },
    signals: {
      async publish() {},
      connected(session) { live.set(session.run.instanceId, session); },
      disconnected(session) { live.delete(session.run.instanceId); },
    },
  });
  const message = { type: "agent_instance_connect", token: "test-token", identityId: "instance",
    name: "Agent", runtime: { kind: "codex", clientVersion: "0.16.698", protocolVersion: 2 },
    runContext: { runId: "run", executionKey: "execution", autoJoinChannelId: "channel",
      machineId: "machine", hostId: "host" } };
  const session = (binding) => ({ principal: binding.principal, run: binding.run,
    connectedAt: new Date().toISOString(), lastSeenAt: new Date().toISOString() });
  return { principal, state, port, message, session, commands, queries, live, hooks };
}

test("unregister carries its connection version and cannot stop a successor", async () => {
  const f = fixture();
  const old = f.session(await f.port.authenticate(f.message));
  const current = f.session(await f.port.authenticate(f.message));
  await assert.rejects(f.port.execute(old, { type: "unregister", requestId: "old" }), /version/i);
  assert.equal(f.state.instanceStatus, "online");
  const response = await f.port.execute(current, { type: "unregister", requestId: "current" });
  assert.equal(response.type, "unregistered");
  assert.equal(f.commands.at(-1).expectedVersion, current.run.connectionVersion);
  assert.equal(f.state.instanceStatus, "offline");
});

test("a legacy unregister cannot borrow the current connection version", async () => {
  const f = fixture();
  const session = f.session(await f.port.authenticate(f.message));
  delete session.run.connectionVersion;
  const count = f.commands.length;
  await assert.rejects(f.port.execute(session, { type: "unregister" }), /connectionVersion/);
  assert.equal(f.commands.length, count);
  assert.equal(f.state.instanceStatus, "online");
});

test("every handshake claims its own version; stale close and refresh cannot adopt the successor", async () => {
  const f = fixture();
  const old = f.session(await f.port.authenticate(f.message));
  const current = f.session(await f.port.authenticate(f.message));
  assert.equal(old.run.connectionVersion, 2);
  assert.equal(current.run.connectionVersion, 3);
  assert.notEqual(f.commands[0].commandId, f.commands[1].commandId);
  const reads = f.queries.length;
  await f.port.disconnected(old);
  assert.equal(f.commands.at(-1).expectedVersion, 2);
  assert.equal(f.queries.length, reads, "disconnect must not borrow the current database version");
  assert.equal(f.state.instanceStatus, "online");
  const commandCount = f.commands.length;
  await assert.rejects(f.port.refresh("test-token", old), /superseded/u);
  await f.port.refresh("test-token", current);
  assert.equal(f.commands.length, commandCount, "token refresh must not claim another connection");
  await f.port.disconnected(current);
  assert.equal(f.state.instanceStatus, "offline");
});

test("reconnect during the predecessor's database close preserves live delivery and Human presence", async () => {
  const f = fixture();
  const changes = [];
  const transport = new AgentInstanceRuntimeTransport(f.port, 1000, (change) => { changes.push(change.reason); });
  const old = new Socket(); transport.accept(old);
  await transport.handleFrame(old, JSON.stringify(f.message));
  const reached = deferred(); const release = deferred();
  f.hooks.disconnecting = async () => { reached.resolve(); await release.promise; };
  const closing = transport.handleClose(old, 1006, "registration timed out", false);
  await reached.promise;
  const current = new Socket(); transport.accept(current);
  await transport.handleFrame(current, JSON.stringify(f.message));
  release.resolve(); await closing;
  assert.equal(f.state.instanceStatus, "online");
  assert.equal(f.live.get("instance"), transport.session(current));
  assert.deepEqual(changes, ["connect", "connect"]);
  assert.equal(transport.liveSessions().length, 1);
});

test("a slower earlier handshake cannot replace the newer authenticated connection", async () => {
  const f = fixture();
  const reached = deferred(); const release = deferred();
  f.hooks.connected = async ({ entityVersion }) => {
    if (entityVersion === 2) { reached.resolve(); await release.promise; }
  };
  const transport = new AgentInstanceRuntimeTransport(f.port);
  const old = new Socket(); transport.accept(old);
  const connecting = transport.handleFrame(old, JSON.stringify(f.message));
  await reached.promise;
  const current = new Socket(); transport.accept(current);
  await transport.handleFrame(current, JSON.stringify(f.message));
  release.resolve(); await connecting;
  assert.equal(transport.session(old), undefined);
  assert.equal(transport.session(current).run.connectionVersion, 3);
  assert.equal(old.sent.at(-1).type, "error");
  assert.equal(f.live.get("instance"), transport.session(current));
});

test("hibernation retains connection ownership and legacy attachments cannot borrow it", async () => {
  const f = fixture();
  const transport = new AgentInstanceRuntimeTransport(f.port);
  const socket = new Socket(); transport.accept(socket);
  await transport.handleFrame(socket, JSON.stringify(f.message));
  const attachment = transport.hibernationAttachment(socket);
  const parsed = parseAgentInstanceHibernationAttachment(attachment);
  assert.equal(parsed.session.run.connectionVersion, 2);
  for (const bad of [0, -1, 1.5, "2", Number.MAX_SAFE_INTEGER + 1]) {
    const invalid = structuredClone(attachment); invalid.session.run.connectionVersion = bad;
    assert.equal(parseAgentInstanceHibernationAttachment(invalid), undefined);
  }
  const legacy = structuredClone(attachment); delete legacy.session.run.connectionVersion;
  assert.ok(parseAgentInstanceHibernationAttachment(legacy));
  const count = f.commands.length;
  await f.port.disconnected(legacy.session);
  assert.equal(f.commands.length, count);
  assert.equal(f.state.instanceStatus, "online");
  const successor = new Socket(); transport.accept(successor);
  await transport.handleFrame(successor, JSON.stringify(f.message));
  const staleRestore = new Socket();
  assert.equal(transport.rehydrate(staleRestore, attachment), true);
  assert.equal(staleRestore.readyState, 3);
  assert.equal(transport.session(staleRestore), undefined);
  const legacyRestore = new Socket();
  assert.equal(transport.rehydrate(legacyRestore, legacy), true);
  assert.equal(transport.session(legacyRestore), undefined);
  assert.equal(transport.session(successor).run.connectionVersion, 3);
});

test("mismatched or terminal Run credentials cannot claim a connection generation", async () => {
  const f = fixture();
  f.principal.executionKey = "wrong-execution";
  await assert.rejects(f.port.authenticate(f.message), /does not match/u);
  assert.equal(f.commands.length, 0);
  f.principal.executionKey = "execution";
  f.state.status = "stopped";
  await assert.rejects(f.port.authenticate(f.message), error => error.failure?.code === "agent_run_not_live");
  assert.equal(f.commands.length, 0);
});

test("a legacy restored socket refreshes through a new handshake without reviving state in token refresh", async () => {
  const f = fixture();
  const original = new AgentInstanceRuntimeTransport(f.port);
  const old = new Socket(); original.accept(old);
  await original.handleFrame(old, JSON.stringify(f.message));
  const attachment = original.hibernationAttachment(old);
  delete attachment.session.run.connectionVersion;
  // A pre-fix close has left the retained socket's durable row offline.
  f.state.instanceStatus = "offline";
  f.state.instanceVersion = 3;
  const restored = new AgentInstanceRuntimeTransport(f.port);
  const socket = new Socket();
  assert.equal(restored.rehydrate(socket, attachment), true);
  const count = f.commands.length;
  await restored.handleFrame(socket, JSON.stringify({ type: "refresh_auth", token: "test-token" }));
  assert.equal(socket.readyState, 3, "existing CLIs reconnect on transport close without restarting the provider");
  assert.equal(f.commands.length, count);
  assert.equal(f.state.instanceStatus, "offline");
  await restored.handleClose(socket, 1012, "refresh claim", true);
  const successor = new Socket(); restored.accept(successor);
  await restored.handleFrame(successor, JSON.stringify(f.message));
  assert.equal(restored.session(successor).run.connectionVersion, 4);
  assert.equal(f.state.instanceStatus, "online");
});


test("registration failures identify the actual phase without exposing dependency text", async () => {
  for (const phase of ["relay.authenticate", "relay.bind_delivery", "relay.publish_presence"]) {
    const f = fixture();
    const fail = () => { throw new Error("PRIVATE_CONNECTION_SENTINEL password=secret"); };
    if (phase === "relay.authenticate") f.port.authenticate = fail;
    if (phase === "relay.bind_delivery") f.port.connected = fail;
    const transport = new AgentInstanceRuntimeTransport(f.port, 1000,
      phase === "relay.publish_presence" ? fail : undefined);
    const socket = new Socket(); transport.accept(socket);
    await transport.handleFrame(socket, JSON.stringify(f.message));
    const error = socket.sent.at(-1);
    assert.equal(error.type, "error");
    assert.equal(error.failure.stage, phase);
    assert.equal(socket.readyState, 3, "failed setup cannot leave a usable half-initialized socket");
    await transport.handleClose(socket, 1011, "Agent connection setup failed", false).catch(() => {});
    assert.equal(transport.session(socket), undefined);
    assert.equal(f.state.instanceStatus, "offline");
    assert.match(error.failure.diagnosticId, /^diag_[a-f0-9-]{36}$/);
    assert.doesNotMatch(JSON.stringify(error), /PRIVATE_CONNECTION_SENTINEL|password|secret/);
  }
});


test("a rejected new handshake closes only that socket and preserves a healthy predecessor", async () => {
  const f = fixture();
  const transport = new AgentInstanceRuntimeTransport(f.port);
  const healthy = new Socket(); transport.accept(healthy);
  await transport.handleFrame(healthy, JSON.stringify(f.message));
  f.port.authenticate = async () => { throw new Error("unavailable"); };
  const failed = new Socket(); transport.accept(failed);
  await transport.handleFrame(failed, JSON.stringify(f.message));
  assert.equal(failed.readyState, 3);
  await transport.handleClose(failed, 1011, "Agent connection setup failed", false);
  assert.equal(healthy.readyState, 1);
  assert.equal(transport.session(healthy).run.instanceId, "instance");
  assert.equal(f.state.instanceStatus, "online");
});
