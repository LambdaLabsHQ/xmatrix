import assert from "node:assert/strict";
import test from "node:test";
import { ControlError } from "@xmatrix/db";
import {
  reconcileRegistrationStops,
} from "../src/registration-revocation-reconcile.ts";

function fixture() {
  const intent = { runId: "run", instanceId: "instance", controlId: "control", generation: 1, leaseOwner: "worker",
    channelId: "channel", hostId: "host", executionKey: "execution", allocationId: "allocation",
    key: { spaceId: "space", ownerUserId: "owner", machineId: "machine", harness: "codex" } };
  const events = [], settlements = [];
  let released = false, status = { status: "leased" };
  const repository = {
    prepare: async () => { events.push("prepare"); },
    claim: async (_channelId, includeParked) => { events.push(`claim:${includeParked}`); return [intent]; },
    settle: async input => { settlements.push(input); },
    completeChanges: async () => { events.push("ledger"); },
  };
  const port = {
    release: async target => { assert.equal(target, intent); events.push("release"); return { state: released ? "released" : "stopping" }; },
    issue: async target => { assert.equal(target, intent); events.push("issue"); return {}; },
    status: async target => { assert.equal(target, intent); events.push("status"); return status; },
    finalize: async target => { assert.equal(target, intent); events.push("finalize"); },
  };
  return { intent, events, settlements, repository, port, run: () => reconcileRegistrationStops(repository, port, "channel"),
    released: () => { released = true; }, status: value => { status = value; } };
}

test("offline or leased stops remain pending and keep their command identity", async () => {
  for (const mode of ["offline", "leased"]) {
    const f = fixture();
    if (mode === "offline") {
      f.status({ status: "missing" });
      f.port.issue = async () => { throw new ControlError("machine_offline", 503, "offline", true); };
    }
    assert.equal(await f.run(), 1);
    assert.equal(f.settlements[0].completed, false);
    assert.equal(f.settlements[0].replaceCommand, false);
    assert.ok(!f.events.includes("finalize"));
  }
});

test("never admitted or independently confirmed terminal resources finalize without another stop", async () => {
  const f = fixture(); f.released(); await f.run();
  assert.deepEqual(f.events, ["prepare", "claim:false", "release", "finalize", "ledger"]);
  assert.equal(f.settlements[0].completed, true);
});

test("expired delivery rotates only its command attempt, not its execution target", async () => {
  for (const status of ["missing", "expired", "failed"]) {
    const f = fixture(); f.status({ status }); await f.run();
    assert.equal(f.settlements[0].replaceCommand, true);
    assert.equal(f.settlements[0].completed, false);
    assert.equal(f.settlements[0].intent, f.intent);
    assert.ok(!f.events.includes("finalize"));
  }
});

test("completed delivery needs exact Run and Instance evidence plus global terminal proof", async () => {
  for (const result of [{ ok: false, runId: "run", instanceId: "instance" },
    { ok: true, runId: "successor", instanceId: "instance" }, { ok: true, runId: "run", instanceId: "other" },
    { ok: true, runId: "run", instanceId: "instance" }]) {
    const f = fixture(); f.status({ status: "completed", result }); await f.run();
    assert.equal(f.settlements[0].completed, false);
    assert.ok(!f.events.includes("finalize"));
  }
  const f = fixture();
  f.port.status = async () => { f.released(); return ({ status: "completed",
    result: { ok: true, runId: "run", instanceId: "instance" } }); };
  await f.run();
  assert.equal(f.settlements[0].completed, true);
});

test("a failed lifecycle commit remains retryable after process termination", async () => {
  const f = fixture(); f.released();
  f.port.finalize = async () => { throw new Error("commit unknown"); };
  await f.run(); assert.equal(f.settlements[0].completed, false);
  f.port.finalize = async () => {};
  await f.run(); assert.equal(f.settlements[1].completed, true);
  assert.ok(!f.events.includes("issue"));
});

test("discovery failure does not starve existing stop obligations or hide the error", async () => {
  const f = fixture(); f.released();
  f.repository.prepare = async () => { throw new Error("discovery unavailable"); };
  await assert.rejects(f.run, /discovery unavailable/u);
  assert.equal(f.settlements[0].completed, true);
  assert.ok(!f.events.includes("ledger"));
});


test("committed delivery can finish after the issue replay expires", async () => {
  const f = fixture();
  f.port.issue = async () => { throw new Error("old issue replay expired"); };
  f.port.status = async () => {
    f.released();
    return ({ status: "completed", result: { ok: true, runId: "run", instanceId: "instance" } });
  };
  await f.run(); assert.equal(f.settlements[0].completed, true);
});

test("a missing command is issued once and an unavailable status cannot authorize delivery", async () => {
  const f = fixture(); f.status({ status: "missing" });
  f.port.issue = async () => { f.events.push("issue"); f.status({ status: "queued" }); return {}; };
  await f.run();
  assert.deepEqual(f.events, ["prepare", "claim:false", "release", "status", "issue", "status", "ledger"]);
  assert.equal(f.settlements[0].replaceCommand, false);
  f.events.length = 0;
  f.port.status = async () => { throw new ControlError("forbidden", 403, "refused"); };
  await f.run(); assert.ok(!f.events.includes("issue"));
  assert.equal(f.settlements[1].completed, false);
});

test("claimed stops run one at a time and a spent pass settles the rest untouched", async () => {
  const f = fixture();
  const intents = ["a", "b", "c"].map(runId => ({ ...f.intent, runId }));
  f.repository.claim = async () => intents;
  f.port.finalize = async () => {};
  let active = 0, peak = 0;
  f.port.release = async () => {
    active += 1; peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 20));
    active -= 1;
    return { state: "released" };
  };
  assert.equal(await reconcileRegistrationStops(f.repository, f.port, "channel"), 3);
  assert.equal(peak, 1);
  assert.deepEqual(f.settlements.map(s => [s.intent.runId, s.completed]), [["a", true], ["b", true], ["c", true]]);

  const slow = fixture();
  slow.repository.claim = async () => intents;
  let releases = 0;
  slow.port.release = async () => { releases += 1; await new Promise(resolve => setTimeout(resolve, 30)); return { state: "stopping" }; };
  await reconcileRegistrationStops(slow.repository, slow.port, "channel", { passMs: 10 });
  assert.equal(releases, 1);
  assert.deepEqual(slow.settlements.map(s => [s.intent.runId, s.completed, s.errorCode]),
    intents.map(i => [i.runId, false, "registration_stop_deferred:registration_stop_timeout"]));
});

test("a stop delivered but not yet run by its host is parked, and a wake rechecks it", async () => {
  for (const status of ["queued", "leased"]) {
    const f = fixture(); f.status({ status });
    await f.run();
    assert.equal(f.settlements[0].parked, true);
    assert.equal(f.settlements[0].completed, false);
  }
  const offline = fixture(); offline.status({ status: "missing" });
  offline.port.issue = async () => { throw new ControlError("machine_offline", 503, "offline", true); };
  await offline.run();
  assert.equal(offline.settlements[0].parked, false, "an undelivered stop keeps retrying with backoff");

  const woken = fixture(); woken.released();
  await reconcileRegistrationStops(woken.repository, woken.port, "channel", { includeParked: true });
  assert.equal(woken.events[1], "claim:true");
});

test("a deferred stop records why it failed, never free text", async () => {
  const issue503 = fixture(); issue503.status({ status: "missing" });
  issue503.port.issue = async () => { throw new ControlError("machine_offline", 503, "offline", true); };
  await issue503.run();
  assert.equal(issue503.settlements[0].errorCode, "registration_stop_deferred:machine_offline");

  const coded = fixture();
  coded.port.release = async () => { throw Object.assign(new Error("Registration is not visible"), { code: "registration_not_found" }); };
  await coded.run();
  assert.equal(coded.settlements[0].errorCode, "registration_stop_deferred:registration_not_found");

  const prose = fixture();
  prose.port.release = async () => { throw new TypeError("cannot read properties of owner@example.com"); };
  await prose.run();
  assert.equal(prose.settlements[0].errorCode, "registration_stop_deferred:TypeError");
});
