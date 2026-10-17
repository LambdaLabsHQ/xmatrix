import assert from "node:assert/strict";
import { test } from "node:test";
import { harnessOutdatedOn } from "../dist/agent-registration-launch.js";

const reporting = (version) => ({ metadata_json: { harnesses: { schemaVersion: 1, capturedAt: "2026-10-17T09:00:00Z",
  items: [{ id: "cursor", installed: true, version, probeStatus: "ok" }] } } });

test("routing leaves out a harness its machine reports older than the version xMatrix can talk to", () => {
  assert.equal(harnessOutdatedOn(reporting("2025.09.12-4852336"), "cursor"), true);
  assert.equal(harnessOutdatedOn(reporting("2026.09.26-dd393fe"), "cursor"), false);
  assert.equal(harnessOutdatedOn({ metadata_json: {} }, "cursor"), false, "no report, no judgement");
  assert.equal(harnessOutdatedOn(reporting("2025.09.12-4852336"), "codex"), false, "another harness's report says nothing");
});
