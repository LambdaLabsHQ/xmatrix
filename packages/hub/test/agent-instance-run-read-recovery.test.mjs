import assert from "node:assert/strict";
import test from "node:test";

import {
  queryAgentInstanceRun,
  runtimeOperationFailure,
  PostgresAgentInstancePort,
  RuntimeControlError,
} from "./support/runtime-run-read-recovery.ts";

const binding = { runId: "run:scheduled:occurrence", ownerUserId: "owner" };
/** What pg throws when a read outlives its connection: no SQLSTATE, a replay can survive it. */
function unavailable() {
  return new Error("Query read timeout");
}
function setup(respond) {
  const calls = [];
  const runtime = {
    async getRun(input) {
      calls.push(input);
      return respond(calls.length);
    },
  };
  return { calls, runtime };
}

test("a code-less pg read failure recovers through fresh Run reads as the same owner", async () => {
  const current = { run: { runId: binding.runId, status: "running", version: 9 } };
  const { calls, runtime } = setup((attempt) => {
    if (attempt < 3) throw unavailable();
    return current;
  });
  assert.deepEqual(await queryAgentInstanceRun(runtime, binding), current);
  assert.equal(calls.length, 3);
  for (const call of calls) assert.deepEqual(call, binding);
});

test("persistent read unavailability exhausts three attempts and fails closed as retryable", async () => {
  const { calls, runtime } = setup(() => { throw unavailable(); });
  await assert.rejects(queryAgentInstanceRun(runtime, binding), (error) => {
    const failure = runtimeOperationFailure(error);
    assert.equal(failure.code, "postgres_runtime_unavailable");
    assert.equal(failure.retryable, true);
    assert.match(failure.diagnosticId, /^diag_[a-f0-9-]{36}$/);
    return true;
  });
  assert.equal(calls.length, 3);
});

test("a denial after a transient failure terminates reads immediately", async () => {
  const { calls, runtime } = setup((attempt) => {
    throw attempt === 1 ? unavailable() : new RuntimeControlError("forbidden", 403, "private detail");
  });
  await assert.rejects(queryAgentInstanceRun(runtime, binding), (error) => error.code === "forbidden");
  assert.equal(calls.length, 2);
});

for (const changed of ["terminal", "execution"]) test(
  `recovered Run reads revalidate ${changed} authority before any connection mutation`, async () => {
    const principal = { ...binding, channelId: "channel", spaceId: "space", agentId: "agent", agentName: "Agent",
      executionKey: "execution", machineId: "machine", hostId: "host" };
    const run = { id: binding.runId, runId: binding.runId,
      channelId: "channel", status: changed === "terminal" ? "failed" : "running",
      metadata: { executionKey: changed === "execution" ? "successor" : "execution",
        machineId: "machine", hostId: "host" } };
    const { calls, runtime } = setup((attempt) => {
      if (attempt === 1) throw unavailable();
      return { run };
    });
    const transitions = [];
    const port = new PostgresAgentInstancePort({
      authenticate: async () => ({ id: "owner", email: "owner@example.test", agentRun: principal }),
      runtime: { ...runtime, async transition(command) { transitions.push(command); return {}; } },
      history: { async join() {}, async leave() {}, async replay() {}, async history() {} },
      signals: { async publish() {} },
    });
    await assert.rejects(port.authenticate({ type: "agent_instance_connect", token: "fixture",
      identityId: "agent", name: "Agent" }),
    error => error.failure?.code === (changed === "terminal" ? "agent_run_not_live" : "agent_run_binding_mismatch"));
    assert.equal(calls.length, 2);
    assert.deepEqual(transitions, []);
  },
);

for (const error of [
  new RuntimeControlError("not_found", 404, "Run not found", true),
  new RuntimeControlError("postgres_runtime_unavailable", 503, "unavailable", false),
  Object.assign(new Error("column does not exist"), { code: "42703" }),
]) test(`a ${error.code} rejection is not replayed, whatever it claims`, async () => {
  const { calls, runtime } = setup(() => { throw error; });
  await assert.rejects(queryAgentInstanceRun(runtime, binding), (thrown) => thrown === error);
  assert.equal(calls.length, 1);
});
