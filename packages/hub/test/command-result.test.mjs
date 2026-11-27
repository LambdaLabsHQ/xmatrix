import assert from "node:assert/strict";
import { test } from "node:test";

import { recordCommandResult } from "../src/command-result.ts";

function captureCommandResult() {
  const annotations = [];
  const events = [];
  const dependencies = {
    async annotate(_env, input) { annotations.push(input); return { id: input.annotationId }; },
    async publish(_env, input) { events.push(input); },
  };
  return { annotations, events, dependencies };
}

test("a command's result is a Hub annotation on the command, then a live event, never a message", async () => {
  const { annotations, events, dependencies } = captureCommandResult();
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

test("recorded turn interrupts stamp timestamps and publish a live interaction update", async () => {
  const { annotations, events, dependencies } = captureCommandResult();
  await recordCommandResult({}, {
    channelId: "c",
    messageId: "m",
    key: "interrupt",
    entry: { interrupts: [{ instanceId: "c:1", agentName: "codex", channelInstanceId: "1" }] },
  }, dependencies);
  assert.equal(annotations[0].annotationId, "xmatrix.command-result:m:interrupt");
  assert.equal(annotations[0].payload.interrupts.length, 1);
  assert.equal(annotations[0].payload.interrupts[0].instanceId, "c:1");
  assert.equal(annotations[0].payload.interrupts[0].agentName, "codex");
  assert.equal(annotations[0].payload.interrupts[0].channelInstanceId, "1");
  assert.ok(Date.parse(annotations[0].payload.interrupts[0].at) > 0);
  assert.deepEqual(events[0].payload, annotations[0].payload);
});
