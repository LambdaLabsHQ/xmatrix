import assert from "node:assert/strict";
import { test } from "node:test";

import { humanizeMachineRunFailureDetail } from "../src/machine-run-failure.ts";

test("overlay root invalid is not classified as machine offline", () => {
  const humanized = humanizeMachineRunFailureDetail(
    "management overlay device quota reservation failed: daemon_relay_v2_overlay_root_invalid",
  );
  assert.equal(humanized.code, "startup_failed");
  assert.match(humanized.summary, /overlay_root_invalid|quota reservation/i);
  assert.notEqual(humanized.code, "machine_unavailable");
});

test("control-plane offline still maps to machine_unavailable", () => {
  const humanized = humanizeMachineRunFailureDetail(
    "Machine Daemon control connection is offline",
  );
  assert.equal(humanized.code, "machine_unavailable");
});

test("vendor attribution survives startup failure presentation", () => {
  for (const vendor of ["Codex", "Claude Code", "Grok", "Kimi", "ZCode"]) {
    const detail = `${vendor} error: This request was blocked by our safety systems. Reason: Potentially unintended activity.`;
    const humanized = humanizeMachineRunFailureDetail(detail);
    assert.equal(humanized.code, "startup_failed");
    assert.equal(humanized.summary, detail);
  }
});

test("codex websocket capacity errors keep vendor and size limits", () => {
  const detail =
    "Codex WebSocket transport: message too large (20184530 bytes; limit 16777216 bytes)";
  const humanized = humanizeMachineRunFailureDetail(detail);
  assert.equal(humanized.code, "startup_failed");
  assert.equal(humanized.summary, detail);
});
