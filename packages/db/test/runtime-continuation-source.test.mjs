import assert from "node:assert/strict";
import test from "node:test";
import { readContinuationSource } from "../dist/runtime-continuation-source.js";

const source = { schemaVersion: 1, kind: "reborn", sourceMessageId: "message", sourceMessageVersion: 1,
  sourceMention: "＠Alpha:1:reborn", sourceInstanceId: "instance-a",
  sourceRunId: "run-a", sourceName: "Alpha", sourceOrdinal: 1, targetInstanceId: "instance-a" };
test("continuation snapshots keep exact source text and only bounded fields", () => {
  assert.deepEqual(readContinuationSource({ ...source, token: "private", cwd: "/private/path" }), source);
  assert.equal(readContinuationSource({ ...source, sourceMessageVersion: 0 }), undefined);
  assert.equal(readContinuationSource({ ...source, sourceMention: "@Other:1:reborn" }), undefined);
  assert.equal(readContinuationSource({ ...source, sourceOrdinal: 2 }), undefined);
  assert.equal(readContinuationSource({ ...source, targetInstanceId: "other" }), undefined);
});
test("handoff binds the predecessor phrase without treating its successor as another Run", () => {
  const handoff = { ...source, kind: "handoff", sourceMention: "@Alpha:1:handoff:@Beta", targetInstanceId: "instance-b" };
  assert.deepEqual(readContinuationSource(handoff), handoff);
  assert.equal(readContinuationSource({ ...handoff, sourceMention: "@Alpha:1:handoff:@Beta:2" }), undefined);
  assert.equal(readContinuationSource({ ...handoff, targetInstanceId: source.sourceInstanceId }), undefined);
});

test("stable Instance addresses are independent of the historical display name", () => {
  const instanceId = "c42915d6-d025-4446-b7a9-02b5ad5d0ffd";
  const stable = { ...source, sourceInstanceId: instanceId, targetInstanceId: instanceId, sourceName: "cursor",
    sourceOrdinal: 8016265100379358, sourceMention: `@${instanceId}:8016265100379358:reborn` };
  assert.deepEqual(readContinuationSource(stable), stable);
  assert.equal(readContinuationSource({ ...stable, sourceMention: "@another-instance:8016265100379358:reborn" }), undefined);
  assert.equal(readContinuationSource({ ...stable, sourceOrdinal: 1 }), undefined);
  const handoff = { ...source, kind: "handoff", sourceMention: "@instance-a:1:handoff:@Beta", targetInstanceId: "instance-b" };
  assert.deepEqual(readContinuationSource(handoff), handoff);
  assert.equal(readContinuationSource({ ...handoff, sourceInstanceId: "instance-c" }), undefined);
});
