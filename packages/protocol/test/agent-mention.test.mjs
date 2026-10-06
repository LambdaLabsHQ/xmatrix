import assert from "node:assert/strict";
import { test } from "node:test";

import { loadTypescriptModule } from "./load-typescript-module.mjs";

const {
  HANDOFF_INSTANCE_MENTION_AT_CARET_RE,
  createInstanceMentionScanner,
  handoffInstanceMentionScanner,
  parseHarnessCapabilityMentions,
  repoSummonReference,
} = await loadTypescriptModule(new URL("../src/agent-mention.ts", import.meta.url));

test("the scanner has no lastIndex state between bodies", () => {
  const scanner = createInstanceMentionScanner();
  assert.equal(scanner.test("a long prefix then @agent:new"), true);
  // A fresh scanner per body is what keeps the second read from skipping ahead.
  assert.equal(createInstanceMentionScanner().test("@agent:new"), true);
});

test("repo references normalize to one spelling per repository", () => {
  assert.equal(repoSummonReference("LambdaLabsHQ/xmatrix"), "LambdaLabsHQ/xmatrix");
  assert.equal(repoSummonReference("LambdaLabsHQ/xmatrix.git"), "LambdaLabsHQ/xmatrix");
  assert.equal(
    repoSummonReference("https://github.com/LambdaLabsHQ/xmatrix.git"),
    "LambdaLabsHQ/xmatrix",
  );
  assert.equal(
    repoSummonReference("git@github.com:LambdaLabsHQ/xmatrix.git"),
    "LambdaLabsHQ/xmatrix",
  );
  assert.equal(
    repoSummonReference("ssh://git@github.com/LambdaLabsHQ/xmatrix.git"),
    "LambdaLabsHQ/xmatrix",
  );
});

test("repo references never carry credentials, query, or fragment", () => {
  for (const remote of [
    "https://user:token@github.com/LambdaLabsHQ/xmatrix.git",
    "https://github.com/LambdaLabsHQ/xmatrix.git?token=secret",
    "https://github.com/LambdaLabsHQ/xmatrix.git#secret",
  ]) {
    const reference = repoSummonReference(remote);
    assert.equal(reference, "LambdaLabsHQ/xmatrix", remote);
  }
  assert.equal(
    repoSummonReference("https://user:token@gitlab.com/team/proj.git"),
    "https://gitlab.com/team/proj",
  );
});

test("local references are working-dir launches, never repo summons", () => {
  for (const value of [
    "/tmp/project",
    "~/project",
    "./local",
    "../local",
    "C:\\Users\\dev\\project",
    "\\\\server\\share\\project",
    "file:///tmp/project",
  ]) {
    assert.equal(repoSummonReference(value), undefined, value);
  }
});

test("the handoff caret pattern opens the successor picker", () => {
  assert.deepEqual(
    "@claude-mba:1:handoff:".match(HANDOFF_INSTANCE_MENTION_AT_CARET_RE)?.slice(1),
    ["1", undefined],
  );
  assert.deepEqual(
    "@claude-mba:1:handoff:@".match(HANDOFF_INSTANCE_MENTION_AT_CARET_RE)?.slice(1),
    ["1", ""],
  );
  assert.deepEqual(
    "@claude-mba:1:handoff:@grok".match(HANDOFF_INSTANCE_MENTION_AT_CARET_RE)?.slice(1),
    ["1", "grok"],
  );
  assert.equal(
    "@claude-mba:1:handoff:@grok-daniel-windows continue".match(HANDOFF_INSTANCE_MENTION_AT_CARET_RE),
    null,
  );
});

test("the handoff scanner has no lastIndex state between bodies", () => {
  const scanner = handoffInstanceMentionScanner();
  assert.equal(scanner.test("prefix @claude-mba:1:handoff:@grok-daniel-windows"), true);
  assert.equal(
    handoffInstanceMentionScanner().test("@claude-mba:1:handoff:@grok-daniel-windows"),
    true,
  );
});

test("bare @codex is an abstract capability shout", () => {
  assert.deepEqual(parseHarnessCapabilityMentions("@codex ship the routing north star").map((item) => item.harness),
    ["codex"]);
  assert.deepEqual(parseHarnessCapabilityMentions("@codex:1 already running"), []);
  assert.deepEqual(parseHarnessCapabilityMentions("@codex:new:/repo"), []);
  assert.deepEqual(parseHarnessCapabilityMentions("@codex-daniel-mba:new:/repo"), []);
});

test("full-width sentence punctuation closes a start mention", () => {
  for (const [body, target] of [
    ["@agent:new:LambdaLabsHQ/xmatrix，继续", "agent:new:LambdaLabsHQ/xmatrix"],
    ["@agent:once:owner/repo。", "agent:once:owner/repo"],
    ["@agent:new:/Users/dev/xmatrix！", "agent:new:/Users/dev/xmatrix"],
  ]) {
    const matches = [...body.matchAll(createInstanceMentionScanner())];
    assert.equal(matches.length, 1, body);
    assert.equal(matches[0][1], target, body);
  }
});

test("ASCII sentence separators stay inside a path", () => {
  const body = "@agent:new:/Users/dev/my,dir.v2";
  assert.equal([...body.matchAll(createInstanceMentionScanner())][0][1], "agent:new:/Users/dev/my,dir.v2");
});
