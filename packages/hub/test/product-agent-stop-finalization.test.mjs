import assert from "node:assert/strict";
import test from "node:test";
import {
  finalizeConfirmedAgentStop,
} from "../src/product-agent-stop-finalization.ts";

function fixture() {
  const calls = [];
  const run = { id: "old-run", status: "running", version: 7 };
  const instance = { id: "stable-instance", runId: "old-run", status: "online", version: 12 };
  const port = {
    readRun: async () => ({ ...run }), readInstance: async () => ({ ...instance }),
    transitionRun: async version => {
      calls.push({ kind: "run", version });
      if (version !== run.version) return "conflict";
      run.status = "stopped"; run.version++; return "applied";
    },
    transitionInstance: async (version, expectedRunId) => {
      calls.push({ kind: "instance", version, expectedRunId });
      if (version !== instance.version || expectedRunId !== instance.runId) return "conflict";
      instance.status = "offline"; instance.version++; return "applied";
    },
  };
  return { calls, run, instance, port, finish: () => finalizeConfirmedAgentStop({
    runId: "old-run", instanceId: "stable-instance", versionedAuthority: true, port,
  }) };
}

test("confirmed stop supplies fresh required versions for both lifecycle writes", async () => {
  const f = fixture(); await f.finish();
  assert.deepEqual(f.calls, [{ kind: "run", version: 7 },
    { kind: "instance", version: 12, expectedRunId: "old-run" }]);
  assert.equal(f.run.status, "stopped"); assert.equal(f.instance.status, "offline");
  await f.finish(); assert.equal(f.calls.length, 2, "a completed stop is a no-op");
});

test("reborn before finalization never terminalizes the successor Instance", async () => {
  const f = fixture(); f.instance.runId = "successor"; f.instance.version++;
  await f.finish();
  assert.deepEqual(f.calls, [{ kind: "run", version: 7 }]);
  assert.equal(f.instance.status, "online");
});

test("reborn between read and write is fenced, then reread without retargeting", async () => {
  const f = fixture();
  f.port.transitionInstance = async (version, expectedRunId) => {
    f.calls.push({ kind: "instance", version, expectedRunId });
    f.instance.runId = "successor"; f.instance.version++;
    return "conflict";
  };
  await f.finish();
  assert.equal(f.calls.filter(call => call.kind === "instance").length, 1);
  assert.equal(f.instance.status, "online");
});

test("a concurrent Run update is reread and retried with its new version", async () => {
  const f = fixture(), transition = f.port.transitionRun;
  let raced = false;
  f.port.transitionRun = async version => {
    if (!raced) { raced = true; f.run.version++; return "conflict"; }
    return transition(version);
  };
  await f.finish();
  assert.equal(f.calls[0].version, 8);
});

test("invalid versions and persistent conflicts fail closed without invented state", async () => {
  const invalid = fixture(); invalid.run.version = undefined;
  await assert.rejects(invalid.finish, /current lifecycle version/);
  assert.equal(invalid.calls.length, 0);
  const racing = fixture(); let writes = 0;
  racing.port.transitionRun = async () => { writes++; return "conflict"; };
  await assert.rejects(racing.finish, /retry finalization/);
  assert.equal(writes, 3);
});

test("a terminal Run whose launch never created an Instance finalizes without an Instance write", async () => {
  const f = fixture(); f.run.status = "failed"; f.port.readInstance = async () => null;
  await f.finish();
  assert.deepEqual(f.calls, []);
});

test("a missing Instance never skips stopping an active Run", async () => {
  const f = fixture(); f.port.readInstance = async () => null;
  await f.finish();
  assert.deepEqual(f.calls, [{ kind: "run", version: 7 }]);
  assert.equal(f.run.status, "stopped");
});
