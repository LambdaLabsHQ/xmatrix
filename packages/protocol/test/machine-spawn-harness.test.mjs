import assert from "node:assert/strict";
import test from "node:test";

import { agentLaunchExecutable, withMachineSpawnHarness } from "../dist/index.js";

test("a delivered spawn carries the Hub's harness spec for its preset", () => {
  const spawn = { type: "machine_spawn_agent", requestId: "r1", agentPresetId: "codex",
    runtime: "/Users/owner/bin/codex-wrapper" };
  const delivered = withMachineSpawnHarness(spawn);
  assert.equal(delivered.harness?.id, "codex");
  assert.equal(delivered.harness?.runtime, "codex");
  assert.equal(delivered.runtime, "/Users/owner/bin/codex-wrapper");
  assert.equal(spawn.harness, undefined, "the stored command is not mutated");
});

test("a spawn without a preset id still resolves a preset launcher runtime", () => {
  assert.equal(withMachineSpawnHarness({ type: "machine_spawn_agent", runtime: "claude" }).harness?.id, "claude");
});

test("other commands, unknown runtimes and explicit specs pass through unchanged", () => {
  const stop = { type: "machine_stop_agent", runtime: "codex" };
  assert.equal(withMachineSpawnHarness(stop), stop);
  const unknown = { type: "machine_spawn_agent", runtime: "/opt/unknown" };
  assert.equal(withMachineSpawnHarness(unknown), unknown);
  const explicit = { type: "machine_spawn_agent", agentPresetId: "codex", harness: { id: "claude" } };
  assert.equal(withMachineSpawnHarness(explicit), explicit);
  assert.equal(withMachineSpawnHarness(null), null);
});

test("a harness key names a preset, never an executable", () => {
  assert.equal(agentLaunchExecutable("claude_code"), "claude");
  assert.equal(agentLaunchExecutable("cursor"), "cursor-agent");
  assert.equal(agentLaunchExecutable("claude-code"), "claude-code");
  assert.equal(agentLaunchExecutable("/opt/bin/claude_code"), "/opt/bin/claude_code");
  assert.equal(agentLaunchExecutable("custom"), "custom");
});
