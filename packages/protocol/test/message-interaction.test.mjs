import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { matchInteractionGrammar, parseMessageInteraction, MessageInteractionRegistry,
  parseConnectorActionCommand, parseAgentControlCommands, parseAgentStopCommand, parseAgentStopInvocation,
  summarizeStopReceipts, agentInteractionTarget, connectorInteractionTarget,
  humanInteractionTarget, interactionRegistry } from "../dist/index.js";

const vectors = JSON.parse(await readFile(new URL("./message-interaction-vectors.json", import.meta.url), "utf8"));
for (const { rule, body, matches } of vectors) {
  test(`${rule}: ${body}`, () => assert.deepEqual(matchInteractionGrammar(rule, body), matches));
}

test("whole-message control, lifecycle and launch plans are disjoint", () => {
  const control = parseMessageInteraction("@codex /model test-model");
  assert.equal(control.controls.length, 1);
  assert.deepEqual(control.launches, []);
  const handoff = parseMessageInteraction("@codex:3:handoff:@auto", ["codex", "auto"]);
  assert.equal(handoff.handoff.length, 1);
  assert.deepEqual(handoff.launches, []);
  assert.deepEqual(handoff.mentions, []);
  assert.equal(parseMessageInteraction("@codex:new").refused, "retired_launch_syntax");
  assert.equal(parseMessageInteraction("/stop all").stop.all, true);
});

test("examples, escaped addresses and Markdown literals cannot execute controls", () => {
  for (const body of ["`@codex /model test`", "> @codex:3:reborn", "    @codex /effort high",
    "````\n@codex:3:handoff:@auto\n````", "\\@codex:3:reborn", "[@codex:3:reborn](https://example.com)"]) {
    const parsed = parseMessageInteraction(body);
    assert.deepEqual(parsed.controls, [], body);
    assert.deepEqual(parsed.reborn, [], body);
    assert.deepEqual(parsed.handoff, [], body);
    assert.deepEqual(parsed.launches, [], body);
  }
  assert.deepEqual(parseAgentControlCommands("@codex /model one\nexplain this"), []);
  assert.deepEqual(parseAgentControlCommands(Array(9).fill("@codex /model one").join("\n")), []);
});

const descriptor = (targetId, aliases = ["helper"]) => ({ schemaVersion: 1, descriptorRevision: "7", targetId,
  kind: "agent", aliases, operations: [{ id: "stop", syntaxRefs: ["lifecycle.stop.v1"],
    inputSchemaRef: "stop.v1", executionContract: "runtime-lifecycle.v1", presentationRef: "stop.v1" }] });

test("registry refuses ambiguous aliases, unknown operations and reserved names", () => {
  const registry = new MessageInteractionRegistry([descriptor("a"), descriptor("b")]);
  assert.equal(registry.resolve("helper", "stop").status, "ambiguous");
  assert.equal(registry.resolve("missing", "stop").status, "unknown");
  const unique = new MessageInteractionRegistry([descriptor("a")]);
  assert.equal(unique.resolve("helper", "launch").status, "unsupported");
  assert.equal(unique.resolve("HELPER", "stop").target.targetId, "a");
  assert.throws(() => new MessageInteractionRegistry([descriptor("a", ["auto"])]));
  assert.throws(() => new MessageInteractionRegistry([descriptor("a"), descriptor("a")]));
  const bad = descriptor("a"); bad.operations[0].syntaxRefs = ["remote-script.v1"];
  assert.throws(() => new MessageInteractionRegistry([bad]));
  const human = descriptor("human"); human.kind = "human";
  assert.throws(() => new MessageInteractionRegistry([human]));
});

test("a person's display name may hold single spaces; an Agent's alias is one word", () => {
  const person = humanInteractionTarget("u1", ["Online Person"]);
  assert.equal(new MessageInteractionRegistry([person]).resolve("online person", "mention").status, "resolved");
  for (const alias of ["Two  Spaces", "Tab\tName", "@Person"]) {
    assert.throws(() => new MessageInteractionRegistry([humanInteractionTarget("u2", [alias])]), alias);
  }
  assert.throws(() => new MessageInteractionRegistry([agentInteractionTarget("a1", "two words")]));
});

test("shared target projections pass the registry, and a refused one is left out", () => {
  const registry = interactionRegistry([
    humanInteractionTarget("u1", ["Dana", "dana-h"]),
    agentInteractionTarget("a1", "codex"), connectorInteractionTarget("github", ["create_issue", "Bad Id"]),
    humanInteractionTarget("u2", ["everyone"]), agentInteractionTarget("a2", "codex"),
  ]);
  assert.deepEqual(registry.descriptors().map(item => item.targetId),
    ["human:u1", "agent:a1", "connector:github", "agent:a2"]);
  assert.equal(registry.resolve("dana-h", "mention").target.targetId, "human:u1");
  assert.equal(registry.resolve("github", "create_issue").operation.presentationRef, "connector.v1");
  assert.equal(registry.resolve("github", "bad id").status, "unsupported");
  // Two Agents of one name stay listed but cannot be resolved by that name alone.
  assert.equal(registry.resolve("codex", "launch").status, "ambiguous");
  assert.equal(new MessageInteractionRegistry([agentInteractionTarget("a1", "codex")]).resolve("codex", "handoff")
    .operation.executionContract, "runtime-lifecycle.v1");
});

test("catalog copies cannot mutate the resolver or smuggle regular expressions", () => {
  const source = descriptor("stable");
  const registry = new MessageInteractionRegistry([source]);
  source.aliases[0] = "other";
  registry.descriptors()[0].aliases[0] = "other";
  registry.resolve("helper", "stop").target.targetId = "spoofed";
  assert.equal(registry.resolve("helper", "stop").target.targetId, "stable");
  assert.equal(parseConnectorActionCommand(".*", "@github:comment:x hi"), undefined);
  assert.deepEqual(parseConnectorActionCommand("github", "@github:comment:x hello\nworld"), {
    actionId: "comment", statement: { target: "x", text: "hello\nworld" } });
});

test("a stop invocation is the command span the chip hangs on", () => {
  const exact = parseAgentStopInvocation("@claude:1:stop");
  assert.equal(exact.start, 0);
  assert.equal(exact.end, "@claude:1:stop".length);
  assert.equal(exact.text, "@claude:1:stop");
  assert.deepEqual(parseAgentStopCommand("@claude:1:stop"), { target: exact.target, all: exact.all });
  assert.deepEqual({ target: exact.target, all: exact.all }, { target: "claude:1", all: false });
  const all = parseAgentStopInvocation("/kill all");
  assert.equal(all.text, "/kill all");
  assert.equal(all.all, true);
  assert.equal(parseAgentStopCommand("/kill all").all, true);
  const reasoned = parseAgentStopInvocation("@grok:3:stop grok:2 继续，停掉 grok:3。");
  assert.deepEqual([reasoned.start, reasoned.end, reasoned.text, reasoned.reason],
    [0, "@grok:3:stop".length, "@grok:3:stop", "grok:2 继续，停掉 grok:3。"]);
  assert.equal(parseAgentStopInvocation("/stop all  done for today\n").text, "/stop all");
  assert.equal(parseAgentStopInvocation("`@claude:1:stop`"), undefined);
  assert.equal(parseAgentStopInvocation("please @claude:1:stop"), undefined);
});

test("stop receipts summarize without treating acceptance as confirmation", () => {
  const stop = (phase, machineName) => ({ stopId: phase + (machineName ?? ""), channelId: "c", sourceMessageId: "m",
    runId: phase + (machineName ?? ""), targetName: "claude", phase, requestedAt: "2026-10-06T08:46:35.000Z",
    ...(machineName ? { machineName } : {}) });
  assert.equal(summarizeStopReceipts([stop("confirmed", "srv"), stop("accepted", "srv")]).phase, "accepted");
  assert.equal(summarizeStopReceipts([stop("confirmed", "a"), stop("failed", "b")]).phase, "failed");
  assert.equal(summarizeStopReceipts([]).phase, "unconfirmed");
  const confirmed = summarizeStopReceipts([stop("confirmed", "build-box-1"), stop("confirmed", "build-box-1")]);
  assert.equal(confirmed.phase, "confirmed");
  assert.equal(confirmed.confirmed, 2);
  assert.equal(confirmed.machineName, "build-box-1");
  assert.equal(summarizeStopReceipts([stop("confirmed", "a"), stop("confirmed", "b")]).machineName, undefined);
});
