import assert from "node:assert/strict";
import test from "node:test";
import { ControlError } from "@xmatrix/db";
import {
  reconcileRebornWithPort,
  rebornFailureNotice,
  rebornRequestMessageId,
  wakeFailureReason,
} from "../src/reborn-reconcile.ts";

function fixture() {
  const row = { intent_id: "intent", source_run_id: "old", successor_run_id: "next",
    source_instance_id: "instance", state: "waiting", stop_required: true,
    stop_control_id: "stop-exact", spawn_payload_json: { requestId: "spawn-exact" } };
  const events = [], processes = new Set(), queries = [];
  let stopState = "leased", spawnState = "leased", lostSpawnResponse = false, spawnResult = { ok: true };
  const database = { async transaction(_context, body) { return body({ async query(q) {
    queries.push(q);
    if (q.name === "reborn_claim_v2") return (["waiting", "prepared"].includes(row.state) ||
      row.state === "failed" && !row.notified) ? [{ ...row }] : [];
    if (q.name === "reborn_failure_notified_v1") row.notified = true;
    if (q.name === "reborn_complete_v1") row.state = "spawned";
    if (q.name === "reborn_defer_v1" && q.values[1] !== null) {
      row.state = "failed"; row.error = q.values[1]; row.error_code = q.values[1]; row.error_detail = q.values[3];
    }
    return [];
  } }); } };
  const port = {
    async notifyFailure(_row, body) { events.push(body); },
    async advance() {
      events.push("check");
      if (stopState === "completed" && row.state === "waiting") { row.state = "prepared"; events.push("prepare"); }
      return { state: row.state };
    },
    async stop(r) { events.push(r.stop_control_id); return { ok: true }; },
    async status() { return { status: stopState }; },
    async spawn(r) {
      events.push(r.spawn_payload_json.requestId); processes.add(r.spawn_payload_json.requestId);
      if (lostSpawnResponse) { lostSpawnResponse = false; throw new Error("lost HTTP response"); }
      return { ok: true };
    },
    async spawnStatus() { return { status: spawnState, result: spawnResult }; },
  };
  return { database, port, row, events, processes, queries,
    stopDone() { stopState = "completed"; }, stopFailed() { stopState = "failed"; },
    spawnDone() { spawnState = "completed"; }, loseSpawnReply() { lostSpawnResponse = true; },
    spawnFailed(error) { spawnState = "failed"; spawnResult = { ok: false, error }; } };
}

test("durable reborn resumes after delayed stop and an ambiguous spawn using the same commands", async () => {
  const f = fixture();
  await reconcileRebornWithPort(f.database, "shard", f.port, "channel");
  assert.equal(f.row.state, "waiting");
  assert.equal(f.processes.size, 0);
  f.stopDone(); f.loseSpawnReply();
  await reconcileRebornWithPort(f.database, "shard", f.port, "channel");
  assert.equal(f.row.state, "prepared", "lost response retains the durable spawn phase");
  f.spawnDone();
  await reconcileRebornWithPort(f.database, "shard", f.port, "channel");
  assert.equal(f.row.state, "spawned");
  assert.equal(f.processes.size, 1);
  assert.equal(f.events.filter(e => e === "prepare").length, 1);
  assert.equal(f.events.filter(e => e === "spawn-exact").length, 2);
});

test("failed stop never spawns a successor", async () => {
  const f = fixture(); f.stopFailed();
  await reconcileRebornWithPort(f.database, "shard", f.port, "channel");
  assert.equal(f.row.state, "failed");
  assert.equal(f.row.error, "reborn_stop_failed");
  assert.equal(f.processes.size, 0);
});

test("current permission and deletion fences are checked before physical control", async () => {
  for (const code of ["forbidden", "reborn_source_fenced", "reborn_source_changed"]) {
    const f = fixture();
    f.port.advance = async () => { throw Object.assign(new Error("denied"), { code }); };
    await reconcileRebornWithPort(f.database, "shard", f.port, "channel");
    assert.equal(f.row.state, "failed");
    assert.deepEqual(f.events, []);
    assert.equal(f.processes.size, 0);
    await reconcileRebornWithPort(f.database, "shard", f.port, "channel");
    assert.ok(f.events.some(event => event.includes(`Reborn failed [${code}]`)));
    assert.equal(f.row.notified, true);
  }
});

test("failed notice delivery retries without losing the rejection or issuing controls", async () => {
  const f = fixture();
  f.row.state = "failed"; f.row.error_code = "reborn_expired";
  let attempts = 0;
  const bodies = [];
  f.port.notifyFailure = async (_row, body) => {
    attempts++; bodies.push(body);
    if (attempts === 1) throw new Error("lost acknowledgement");
  };
  await reconcileRebornWithPort(f.database, "shard", f.port, "channel");
  assert.equal(f.row.notified, undefined);
  assert.equal(f.row.error_code, "reborn_expired");
  await reconcileRebornWithPort(f.database, "shard", f.port, "channel");
  await reconcileRebornWithPort(f.database, "shard", f.port, "channel");
  assert.equal(attempts, 2);
  assert.equal(bodies[0], bodies[1], "the same persisted intent produces identical notice content");
  assert.deepEqual(f.events, []);
  assert.equal(f.row.notified, true);
});

test("a failure notice no Channel can ever take settles instead of retrying forever", async () => {
  for (const code of ["channel_not_found", "forbidden"]) {
    const f = fixture();
    f.row.state = "failed"; f.row.error_code = "reborn_expired";
    let attempts = 0;
    f.port.notifyFailure = async () => {
      attempts++;
      throw Object.assign(new Error("system notice failed (409)"), { code });
    };
    await reconcileRebornWithPort(f.database, "shard", f.port, "channel");
    await reconcileRebornWithPort(f.database, "shard", f.port, "channel");
    assert.equal(attempts, 1, code);
    assert.equal(f.row.notified, true, code);
    assert.equal(f.row.error_code, "reborn_expired", code);
  }
});

test("failure notices expose actionable reasons without copying arbitrary exception text", () => {
  assert.match(rebornFailureNotice("reborn_source_changed"), /workspace or session/);
  assert.match(rebornFailureNotice("reborn_stop_rejected"), /daemon rejected/);
  assert.match(rebornFailureNotice("reborn_spawn_failed"), /Resuming/);
  assert.equal(rebornFailureNotice("private-token-value").includes("private-token-value"), false);
});

test("stop and resume status permission refusals become visible terminal errors", async () => {
  for (const phase of ["stop", "spawn"]) {
    const f = fixture();
    if (phase === "stop") f.port.status = async () => { throw new ControlError("forbidden", 403, "refused"); };
    else { f.stopDone(); f.port.spawnStatus = async () => { throw new ControlError("forbidden", 403, "refused"); }; }
    await reconcileRebornWithPort(f.database, "shard", f.port, "channel");
    assert.equal(f.row.error_code, `reborn_${phase}_status_rejected`);
    await reconcileRebornWithPort(f.database, "shard", f.port, "channel");
    assert.ok(f.events.some(event => event.includes(`Reborn failed [reborn_${phase}_status_rejected]`)));
  }
});

test("a statement Postgres rejects as mistyped fails the continuation instead of retrying until it expires", async () => {
  const f = fixture();
  f.port.advance = async () => { throw Object.assign(new Error("column is of type timestamptz"), { code: "42804" }); };
  await reconcileRebornWithPort(f.database, "shard", f.port, "channel");
  assert.equal(f.row.state, "failed");
  assert.equal(f.row.error_code, "reborn_internal_error");
  assert.equal(f.row.error_detail, "PostgreSQL 42804");
  await reconcileRebornWithPort(f.database, "shard", f.port, "channel");
  assert.ok(f.events.some(event => event.includes("Reborn failed [reborn_internal_error]")));
  // A transient refusal (serialization, lost connection) still waits and retries.
  for (const code of ["40001", "08006", "57014"]) {
    const transient = fixture();
    transient.port.advance = async () => { throw Object.assign(new Error("transient"), { code }); };
    await reconcileRebornWithPort(transient.database, "shard", transient.port, "channel");
    assert.equal(transient.row.state, "waiting", code);
  }
});

test("a registered successor spawns the payload advance completed with its allocation binding", async () => {
  const f = fixture();
  const bound = { requestId: "spawn-exact", registration: { allocationId: "allocation:1" } };
  const spawned = [];
  const port = { ...f.port,
    async advance() {
      if (f.row.state === "waiting") f.row.state = "prepared";
      return { state: f.row.state, spawnPayload: bound };
    },
    async spawn(r) { spawned.push(r.spawn_payload_json); return { ok: true }; },
  };
  f.stopDone(); f.spawnDone();
  await reconcileRebornWithPort(f.database, "shard", port, "channel");
  assert.deepEqual(spawned, [bound], "the stored pre-allocation payload is never spawned");
  assert.equal(f.row.state, "spawned");
});

test("a failed resume says why, in the notice that answers the reborn request", async () => {
  const f = fixture(); f.stopDone();
  f.spawnFailed("Refusing to reborn: this Instance's working directory was reclaimed\n for another session.");
  await reconcileRebornWithPort(f.database, "shard", f.port, "channel");
  assert.equal(f.row.error_code, "reborn_spawn_failed");
  assert.equal(f.row.error_detail,
    "Refusing to reborn: this Instance's working directory was reclaimed for another session.");
  await reconcileRebornWithPort(f.database, "shard", f.port, "channel");
  const notice = f.events.at(-1);
  assert.match(notice, /^Reborn failed \[reborn_spawn_failed\]\. Resuming the original session failed\. Reason: Refusing to reborn: this Instance's working directory was reclaimed for another session\. /u);
  assert.match(rebornFailureNotice("reborn_spawn_failed", "x".repeat(5000)), /Reason: x{1000} Check/u,
    "a reason is bounded");
  assert.doesNotMatch(rebornFailureNotice("reborn_spawn_failed", "  "), /Reason:/u);
});

test("the failure notice replies to the message that asked for the reborn", () => {
  assert.equal(rebornRequestMessageId({ run_input_json: { invocationSource: { sourceMessageId: "m-9" } } }), "m-9");
  assert.equal(rebornRequestMessageId({ run_input_json: {} }), undefined, "intents written before sources were recorded");
  assert.equal(rebornRequestMessageId({ run_input_json: { invocationSource: { sourceMessageId: " " } } }), undefined);
});

test("a refused resume names the refusal itself, not only that the daemon refused", async () => {
  const f = fixture(); f.stopDone();
  f.port.spawn = async () => { throw new ControlError("idempotency_mismatch", 409, "Machine command id was reused"); };
  await reconcileRebornWithPort(f.database, "shard", f.port, "channel");
  assert.equal(f.row.error_code, "reborn_spawn_rejected");
  assert.equal(f.row.error_detail, "idempotency_mismatch: Machine command id was reused");
  await reconcileRebornWithPort(f.database, "shard", f.port, "channel");
  assert.match(f.events.at(-1), /^Reborn failed \[reborn_spawn_rejected\]\. .* Reason: idempotency_mismatch: Machine command id was reused /u);
});

test("a failed wake answers no message: its Instance shows wake_failed with the reason", async () => {
  const f = fixture();
  Object.assign(f.row, { kind: "wake", channel_id: "channel", state: "failed",
    error_code: "reborn_spawn_failed", error_detail: "slot reclaimed" });
  await reconcileRebornWithPort(f.database, "shard", f.port, "channel");
  assert.deepEqual(f.events, [], "no Channel notice for a wake");
  const failed = f.queries.find(q => q.name === "wake_failure_instance_v1");
  assert.match(failed.text, /rest_state='wake_failed'/u);
  assert.deepEqual([failed.values[0], failed.values[1], failed.values[3]],
    ["instance", "reborn_spawn_failed: slot reclaimed", "channel"]);
  assert.equal(f.row.notified, true);
  assert.equal(wakeFailureReason({ error_code: "private-code", error_detail: null }), "reborn_failed");
  assert.equal(wakeFailureReason({ error_code: "reborn_spawn_failed", error_detail: "y".repeat(500) }).length, 200);
});
