import assert from "node:assert/strict";
import test from "node:test";
import { isChannelOrdinal } from "../dist/instance-run-key.js";

test("ordinals are positive decimal strings, including historical 8e15 ordinals", () => {
  for (const value of ["1", "42", "8000123456789012"]) assert.equal(isChannelOrdinal(value), true, value);
  for (const value of ["0", "-1", "01", "1.5", "", "9007199254740993", 3, null]) {
    assert.equal(isChannelOrdinal(value), false, String(value));
  }
});

test("stored ids are the natural key and parse back to it", async () => {
  const { naturalInstanceId, naturalRunId, parseNaturalInstanceId, parseNaturalRunId } = await import("../dist/instance-run-key.js");
  const channelId = "12455ba3-2a8b-06c8-39cd-d0bee435aba7";
  assert.equal(naturalInstanceId({ channelId, channelInstanceId: "3" }), `${channelId}:3`);
  assert.equal(naturalRunId({ channelId, channelInstanceId: "3", runOrdinal: "2" }), `${channelId}:3#2`);
  assert.equal(naturalRunId({ channelId, about: true, runOrdinal: "4" }), `${channelId}:about#4`);
  assert.deepEqual(parseNaturalInstanceId(`${channelId}:3`), { channelId, channelInstanceId: "3" });
  assert.deepEqual(parseNaturalRunId(`${channelId}:3#2`), { channelId, channelInstanceId: "3", runOrdinal: "2" });
  assert.deepEqual(parseNaturalRunId(`${channelId}:about#4`), { channelId, about: true, runOrdinal: "4" });
  for (const legacy of ["instance:e3284238-170b-4a3a-b83c-d6bc07907367", "instance:summon:abc", `${channelId}:0`]) {
    assert.equal(parseNaturalInstanceId(legacy), null, legacy);
  }
  for (const legacy of ["run:reborn:abc", `${channelId}:3`, `${channelId}:3#0`]) assert.equal(parseNaturalRunId(legacy), null, legacy);
});
