import assert from "node:assert/strict";
import test from "node:test";
import { mergeInstanceRecord, parseInstanceRecord } from "../dist/index.js";

const record = (version, sequence, fields = {}) => parseInstanceRecord({
  id: "channel:1", channelId: "channel", channelInstanceId: "1", label: "codex:1", agentName: "codex",
  registration: { ownerUserId: "owner", machineId: "machine", harness: "codex" },
  connectedAt: "2026-11-06T18:00:00Z", lastSeenAt: "2026-11-06T18:00:01Z", status: "online",
  revision: { version, sequence }, ...fields,
});

function* permutations(values) {
  if (!values.length) { yield []; return; }
  for (let index = 0; index < values.length; index++) for (const rest of permutations(values.filter((_, slot) => slot !== index))) {
    yield [values[index], ...rest];
  }
}

test("reads, reports, stops and reborn converge in every delivery order", () => {
  const samples = [record(1, 0), record(1, 5, { status: "busy" }), record(2, 0, { status: "offline" }),
    record(3, 0, { rest: "waking", status: "offline" }), record(4, 1, { status: "idle" })];
  for (const delivery of permutations(samples)) {
    assert.equal(delivery.reduce(mergeInstanceRecord, undefined), samples[4]);
  }
});

test("a terminal row fences its old socket irrespective of timestamps or report count", () => {
  const stopped = record(2, 0, { status: "offline" });
  const stale = record(1, 999, { status: "busy", lastSeenAt: "2099-01-01T00:00:00Z" });
  assert.equal(mergeInstanceRecord(stopped, stale), stopped);
  assert.equal(mergeInstanceRecord(stopped, stopped), stopped, "a replay preserves identity");
});

test("a durable base read cannot replace a newer socket report and a new lifecycle replaces the whole record", () => {
  const live = record(2, 5, { status: "busy", activity: "Running", rest: undefined });
  assert.equal(mergeInstanceRecord(live, record(2, 0, { lastSeenAt: "2099-01-01T00:00:00Z" })), live);
  const stopped = record(3, 0, { status: "offline" });
  assert.equal(mergeInstanceRecord(live, stopped), stopped);
  assert.equal(stopped.activity, undefined, "the old turn's activity is not copied into a new lifecycle");
});

test("record identity cannot be transferred and malformed revisions are refused", () => {
  const current = record(2, 1);
  for (const changed of [{ channelId: "other" }, { channelInstanceId: "2" },
    { registration: { ...current.registration, machineId: "other" } }]) {
    assert.throws(() => mergeInstanceRecord(current, record(3, 0, changed)), /identity changed/);
  }
  for (const revision of [{ version: 0, sequence: 0 }, { version: 1, sequence: -1 },
    { version: 1, sequence: 0.5 }, { version: "1", sequence: 0 }]) {
    assert.throws(() => parseInstanceRecord({ ...current, revision }), /Invalid Instance record/);
  }
});
