import assert from "node:assert/strict";
import { test } from "node:test";

import {
  orchestrateProductAgentControlCommands,
  parseProductAgentControlCommands,
} from "../src/product-agent-model-effort.ts";

/** The single-statement reading the older assertions are written against. */
const parseOne = (body) => parseProductAgentControlCommands(body)[0];

import {
  agentChannelMessageDeliveryIntent,
  channelMessageDeliveryIntent,
} from "../src/runtime-transport/channel-message-frame.ts";

function portWith(outcome) {
  const requests = [];
  const notices = [];
  return {
    requests,
    notices,
    async switchControl(input) {
      requests.push(input);
      if (outcome instanceof Error) throw outcome;
      return outcome;
    },
    async publishSystemNotice(_channelId, body) {
      notices.push(body);
    },
  };
}

test("model and effort commands keep the exact channel-instance address", () => {
  assert.deepEqual(parseOne("@claude:1 /model fable"), {
    kind: "model",
    target: "claude:1",
    value: "fable",
  });
  assert.deepEqual(parseOne("@codex:12 /effort high"), {
    kind: "effort",
    target: "codex:12",
    value: "high",
  });
  // Codex documents /reasoning for the same control.
  assert.deepEqual(parseOne("@codex:2 /reasoning low"), {
    kind: "effort",
    target: "codex:2",
    value: "low",
  });
  // A bare command asks what is on offer rather than switching to nothing.
  assert.deepEqual(parseOne("@claude:1 /model"), {
    kind: "model",
    target: "claude:1",
  });
});

test("prose that merely mentions a model is not a command", () => {
  assert.equal(parseOne("can you switch to fable"), undefined);
  assert.equal(parseOne("@claude:1 what model are you"), undefined);
  // A trailing argument list is not the single-token grammar the runtime accepts.
  assert.equal(parseOne("@claude:1 /model fable please"), undefined);
  assert.equal(parseOne("/model fable"), undefined);
});

test("a confirmed switch names the model the instance actually accepted", async () => {
  const port = portWith({ status: "switched", selected: "fable" });
  const result = await orchestrateProductAgentControlCommands({
    channelId: "channel-1",
    body: "@claude:1 /model fable",
    port,
  });
  assert.deepEqual(port.requests, [{
    channelId: "channel-1",
    target: "claude:1",
    kind: "model",
    value: "fable",
  }]);
  assert.equal(result[0].outcome.status, "switched");
  assert.match(port.notices[0], /Switched @claude:1 to `fable`/u);
  // The receipt says what the switch does to running work: it preempts, and
  // the Instance resumes that work on the new selection by itself.
  assert.match(port.notices[0], /A turn that was running is interrupted and continues on it\./u);
});

test("a bare command lists the catalog and the current selection", async () => {
  const port = portWith({ status: "catalog", current: "opus", options: ["fable", "opus"] });
  await orchestrateProductAgentControlCommands({
    channelId: "channel-1",
    body: "@claude:1 /model",
    port,
  });
  assert.equal(port.requests[0].value, undefined);
  assert.match(port.notices[0], /`fable`, `opus`/u);
  assert.match(port.notices[0], /Current: `opus`/u);
});

test("a missing instance and a failed switch both report instead of going silent", async () => {
  const missing = portWith({ status: "no_instance" });
  await orchestrateProductAgentControlCommands({
    channelId: "channel-1",
    body: "@claude:9 /effort high",
    port: missing,
  });
  assert.match(missing.notices[0], /could not find a live instance for `@claude:9`/u);

  const failed = portWith({ status: "error", message: "timed out." });
  await orchestrateProductAgentControlCommands({
    channelId: "channel-1",
    body: "@claude:1 /model fable",
    port: failed,
  });
  assert.match(failed.notices[0], /Could not switch the model for @claude:1: timed out\./u);
});

test("a thrown port failure is narrated, not swallowed", async () => {
  const port = portWith(new Error("runtime unavailable"));
  const result = await orchestrateProductAgentControlCommands({
    channelId: "channel-1",
    body: "@claude:1 /model fable",
    port,
  });
  assert.equal(result[0].outcome.status, "error");
  assert.match(port.notices[0], /runtime unavailable/u);
});

test("non-commands never reach the port", async () => {
  const port = portWith({ status: "switched", selected: "fable" });
  const result = await orchestrateProductAgentControlCommands({
    channelId: "channel-1",
    body: "just a normal message",
    port,
  });
  assert.deepEqual(result, []);
  assert.deepEqual(port.requests, []);
  assert.deepEqual(port.notices, []);
});

test("a control command delivers as context so it cannot burn an instance turn", () => {
  const recipient = { agentName: "claude", channelInstanceId: "1" };
  const intent = (body) => agentChannelMessageDeliveryIntent({ body }, recipient);

  assert.equal(intent("@claude:1 /model fable"), "context");
  assert.equal(intent("@claude:1 /effort high"), "context");
  // Ordinary work must stay a task; only the command grammar is exempt.
  assert.equal(intent("@claude:1 please switch to fable"), "work");
  assert.equal(intent("ship it"), "work");
});

test("only Instance delivery is suppressed, never the Human or history read", () => {
  // The Hub executes the switch, so the addressed Instance must not also be
  // handed the text as work. Every other audience still reads it as an
  // ordinary message: the humans typed it and must see it in the transcript.
  for (const body of ["@claude:1 /model fable", "@claude:1 /effort high"]) {
    assert.equal(channelMessageDeliveryIntent({ body }), "work");
  }
});

test("one message carries several statements and answers with one receipt", async () => {
  const port = portWith({ status: "switched", selected: "fable" });
  const result = await orchestrateProductAgentControlCommands({
    channelId: "channel-1",
    body: "@claude:1 /model fable\n@claude:1 /effort high",
    port,
  });
  assert.deepEqual(result.map((entry) => entry.kind), ["model", "effort"]);
  assert.deepEqual(port.requests.map((request) => request.kind), ["model", "effort"]);
  // A tag edit is one decision; it must not post one system message per tag.
  assert.equal(port.notices.length, 1);
  assert.match(port.notices[0], /^- Switched @claude:1/u);
  assert.equal(port.notices[0].split("\n").length, 2);
});

test("a statement that is not a command disqualifies the whole message", () => {
  // Executing half and delivering the other half as work would answer one
  // message twice.
  assert.deepEqual(
    parseProductAgentControlCommands("@claude:1 /model fable\nand then ship it"),
    [],
  );
  assert.equal(
    parseProductAgentControlCommands("@claude:1 /model fable\n@claude:1 /effort high").length,
    2,
  );
});

test("multi-statement control messages still deliver as context", () => {
  const recipient = { agentName: "claude", channelInstanceId: "1" };
  const intent = (body) => agentChannelMessageDeliveryIntent({ body }, recipient);
  assert.equal(intent("@claude:1 /model fable\n@claude:1 /effort high"), "context");
  assert.equal(intent("@claude:1 /model fable\nand then ship it"), "work");
});
