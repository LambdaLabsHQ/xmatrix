import assert from "node:assert/strict";
import { test } from "node:test";

import { recordCommandResult } from "../src/command-result.ts";

test("a command's result is a Hub annotation on the command, then a live event, never a message", async () => {
  const annotations = [];
  const events = [];
  const dependencies = {
    async annotate(_env, input) { annotations.push(input); return { id: input.annotationId }; },
    async publish(_env, input) { events.push(input); },
  };
  await recordCommandResult({}, { channelId: "c", messageId: "m", key: "controls",
    entry: { controls: [{ kind: "effort", target: "claude:1", status: "switched", selected: "max" }] } }, dependencies);
  assert.equal(annotations[0].namespace, "xmatrix.command-result");
  assert.equal(annotations[0].messageId, "m");
  assert.equal(annotations[0].annotationId, "xmatrix.command-result:m:controls");
  assert.deepEqual(events[0], { channelId: "c", messageId: "m", annotationId: "xmatrix.command-result:m:controls",
    payload: annotations[0].payload });
});

test("an unchanged or unannotatable result tells nobody", async () => {
  const events = [];
  await recordCommandResult({}, { channelId: "c", messageId: "m", key: "stop", entry: { note: { text: "x" } } }, {
    async annotate() { return null; },
    async publish(_env, input) { events.push(input); },
  });
  assert.deepEqual(events, []);
});
