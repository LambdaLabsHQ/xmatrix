import assert from "node:assert/strict";
import { test } from "node:test";
import { harnessSignedOutOn } from "../dist/agent-registration-launch.js";

const reporting = (login, machineName = "mac-mini") => ({ machine_name: machineName, metadata_json: {
  harnesses: { schemaVersion: 1, capturedAt: "2026-10-18T07:00:00Z",
    items: [{ id: "codex", installed: true, version: "0.130.0", probeStatus: "ok", ...(login ? { login } : {}) }] } } });
const key = { harness: "codex", machineId: "machine:mac" };

test("routing leaves out a harness its machine reports signed out, naming the program and machine", () => {
  assert.deepEqual(harnessSignedOutOn(reporting("signed_out"), key),
    { harness: "codex", program: "Codex", machineId: "machine:mac", machineName: "mac-mini" });
  assert.equal(harnessSignedOutOn(reporting("signed_out", " "), key).machineName, undefined);
  // Only a reported sign-out is judged: signed in, unchecked or unknown routes as before.
  for (const login of ["signed_in", "unknown", undefined]) assert.equal(harnessSignedOutOn(reporting(login), key), undefined, login);
  assert.equal(harnessSignedOutOn({ metadata_json: {} }, key), undefined, "no report, no judgement");
  assert.equal(harnessSignedOutOn(reporting("signed_out"), { ...key, harness: "claude" }), undefined,
    "another harness's report says nothing");
});

test("a start or turn refused as signed out keeps it out until its machine reports again", () => {
  // The program's own status said signed in, but its token could not refresh.
  const before = "2026-10-18T06:59:00Z", after = "2026-10-18T07:01:00Z";
  assert.deepEqual(harnessSignedOutOn(reporting("signed_in"), key, after),
    { harness: "codex", program: "Codex", machineId: "machine:mac", machineName: "mac-mini" });
  assert.equal(harnessSignedOutOn(reporting("signed_in"), key, new Date(after)).program, "Codex");
  // A report after the refusal (a sign-in from the card re-reports) answers it.
  assert.equal(harnessSignedOutOn(reporting("signed_in"), key, before), undefined);
  assert.equal(harnessSignedOutOn(reporting(undefined), key, null), undefined);
  assert.equal(harnessSignedOutOn(reporting("signed_in"), key, "not a time"), undefined);
});
