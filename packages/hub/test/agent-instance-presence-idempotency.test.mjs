import assert from "node:assert/strict";
import { test } from "node:test";

import {
  runtimeVersionedCommandId,
} from "../src/runtime-transport/runtime-messages.ts";

test("Agent presence transition command IDs are bound to the expected instance version", () => {
  const first = runtimeVersionedCommandId("agent-presence", "instance-1", 4);
  const replay = runtimeVersionedCommandId("agent-presence", "instance-1", 4);
  const reborn = runtimeVersionedCommandId("agent-presence", "instance-1", 6);

  assert.equal(replay, first);
  assert.notEqual(reborn, first);
  assert.match(reborn, /^agent-presence:instance-1:6$/u);
});
