import assert from "node:assert/strict";
import test from "node:test";
import { deriveHarnessInvocationSelections, digestCanonicalCloneCborV1 } from "../dist/index.js";

const source = async body => ({ spaceId: "space", body, bodyHash: await digestCanonicalCloneCborV1(body), revision: 1 });

test("harness shouts in text become capability selections", async () => {
  const derived = deriveHarnessInvocationSelections(await source("@codex review the diff, then @claude summarize"));
  assert.deepEqual(derived.selections.map(item => [item.text, item.target]), [
    ["@codex", { kind: "capability", harness: "codex" }],
    ["@claude", { kind: "capability", harness: "claude" }],
  ]);
  assert.equal(derived.sourceRevision, 1);
});

test("quoted, code and lifecycle-addressed mentions stay text", async () => {
  const derived = deriveHarnessInvocationSelections(await source(
    "> @codex quoted\n`@claude` in code\n@codex:2:reborn and @codex:new are lifecycle addresses"));
  assert.deepEqual(derived.selections, []);
});

test("unknown names are not harnesses", async () => {
  assert.deepEqual(deriveHarnessInvocationSelections(await source("@eevee please look")).selections, []);
});

test("@auto becomes an auto selection; its conditions stay in the body", async () => {
  const derived = deriveHarnessInvocationSelections(await source("@auto repo:owner/repo model:gpt fix the build"));
  assert.deepEqual(derived.selections.map(item => [item.text, item.target]), [["@auto", { kind: "auto" }]]);
});

test("auto and harness selections keep body order", async () => {
  const derived = deriveHarnessInvocationSelections(await source("@codex first then @auto second"));
  assert.deepEqual(derived.selections.map(item => item.target.kind), ["capability", "auto"]);
});

test("a create mention becomes the selection its name resolved to; an unresolved name stays text", async () => {
  const { createInstanceMentions, selectionLaunchConditions } = await import("../dist/index.js");
  const body = "@eevee:new:owner/repo fix it, and @ghost:new too";
  assert.deepEqual(createInstanceMentions(body).map(item => item.name), ["eevee", "ghost"]);
  const key = { spaceId: "space", ownerUserId: "owner", machineId: "machine", harness: "codex" };
  const derived = deriveHarnessInvocationSelections(await source(body),
    new Map([["eevee", { kind: "registration", key }]]));
  assert.deepEqual(derived.selections.map(item => [item.text, item.target.kind]), [["@eevee:new:owner/repo", "registration"]]);
  assert.match(selectionLaunchConditions(body, derived.selections[0]).error, /retired/);
});

test("retired create-instance suffixes fail closed without becoming workspace tags", async () => {
  const { selectionLaunchConditions } = await import("../dist/index.js");
  const at = (body, text) => selectionLaunchConditions(body, { end: body.indexOf(text) + text.length, text });
  for (const [body, text] of [
    ["@codex:once task", "@codex:once"],
    ["@codex:new:/Users/me/repo task", "@codex:new:/Users/me/repo"],
    ["@codex:new task", "@codex:new"],
  ]) {
    const options = at(body, text);
    assert.deepEqual(options.tags, {});
    assert.match(options.error, /retired/);
  }
  // Trailing tag conditions still parse; the retired suffix never contributes its own workspace.
  const mixed = at("@codex:new:owner/a repo:owner/b task", "@codex:new:owner/a");
  assert.deepEqual(mixed.tags, { repo: "owner/b" });
  assert.match(mixed.error, /retired/);
});
