import assert from "node:assert/strict";
import { test } from "node:test";
import { harnessTooOldOn } from "../dist/agent-registration-launch.js";

const reporting = (version, platform = "macos") => ({ machine_name: "Laptop", metadata_json: { platform,
  harnesses: { schemaVersion: 1, capturedAt: "2026-10-17T09:00:00Z",
    items: [{ id: "cursor", installed: true, version, probeStatus: "ok" }] } } });

test("routing leaves out a harness its machine reports older than the version xMatrix can talk to, naming it", () => {
  assert.deepEqual(harnessTooOldOn(reporting("2025.09.12-4852336"), "cursor"), { program: "Cursor CLI",
    version: "2025.09.12-4852336", minimumVersion: "2026.01.01", machineName: "Laptop", update: "cursor-agent update" });
  assert.equal(harnessTooOldOn(reporting("2025.09.12-4852336", "windows"), "cursor").update, "cursor-agent update");
  // A machine that does not say what it runs is not told what to type.
  assert.equal(harnessTooOldOn(reporting("2025.09.12-4852336", null), "cursor").update, undefined);
  assert.equal(harnessTooOldOn(reporting("2026.09.26-dd393fe"), "cursor"), undefined);
  assert.equal(harnessTooOldOn({ metadata_json: {} }, "cursor"), undefined, "no report, no judgement");
  assert.equal(harnessTooOldOn(reporting("2025.09.12-4852336"), "codex"), undefined, "another harness's report says nothing");
});
