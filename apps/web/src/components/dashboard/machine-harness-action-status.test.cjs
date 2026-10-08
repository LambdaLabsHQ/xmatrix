const assert = require("node:assert/strict");
const test = require("node:test");
require("./typescript-require.cjs").installTypeScriptRequire();
const { describeHarnessAction } = require("./machine-harness-action-status.ts");

const base = { controlId: "harness:00000000-0000-4000-8000-000000000000", presetId: "codex", action: "install",
  requestedAt: "2026-10-07T10:09:00.000Z" };
const at = (minutes) => Date.parse(base.requestedAt) + minutes * 60_000;
const describe = (status, minutes = 0) => describeHarnessAction(status, { displayName: "Codex", now: at(minutes) });

test("status is worded for people, never shown as a raw enum", () => {
  for (const status of ["queued", "running", "succeeded", "failed", "unsupported", "expired"]) {
    assert.doesNotMatch(describe({ ...base, status }).text, new RegExp(`^${status}$`, "u"));
  }
  assert.equal(describe(undefined).tone, "pending");
  assert.equal(describe({ ...base, status: "running" }).text, "Running on the machine…");
  assert.equal(describe({ ...base, status: "expired", error: "gone" }).tone, "error");
});

test("an action left unclaimed says the machine may not be connected", () => {
  assert.equal(describe({ ...base, status: "queued" }, 0.5).tone, "pending");
  const waiting = describe({ ...base, status: "queued" }, 4);
  assert.equal(waiting.tone, "warning");
  assert.match(waiting.text, /not picked this up for 4 min/u);
  assert.match(waiting.text, /within 10 minutes/u);
});

test("a succeeded install whose re-probe finds nothing says so instead of 'succeeded'", () => {
  const missing = describe({ ...base, status: "succeeded",
    result: { presetId: "codex", action: "install", status: "succeeded", item: { id: "codex", installed: false, probeStatus: "missing" } } });
  assert.equal(missing.tone, "warning");
  assert.match(missing.text, /^Install finished, but Codex was not found on this machine's PATH/u);
  const updated = describe({ ...base, action: "update", status: "succeeded",
    result: { presetId: "codex", action: "update", status: "succeeded", item: { id: "codex", installed: false, probeStatus: "missing" } } });
  assert.match(updated.text, /^Update finished, but Codex was not found/u);
  const installed = describe({ ...base, status: "succeeded",
    result: { presetId: "codex", action: "install", status: "succeeded", item: { id: "codex", installed: true, probeStatus: "ok", version: "1.0.0" } } });
  assert.deepEqual(installed, { text: "Done", tone: "done" });
  const kept = describe({ ...base, action: "uninstall", status: "succeeded",
    result: { presetId: "codex", action: "uninstall", status: "succeeded", item: { id: "codex", installed: true, probeStatus: "ok" } } });
  assert.match(kept.text, /still found/u);
});
