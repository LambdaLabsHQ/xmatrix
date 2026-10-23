import assert from "node:assert/strict";
import { test } from "node:test";
import { harnessSignedOutOn } from "../dist/agent-registration-launch.js";
import { recordHarnessActionInventory } from "../dist/machine-harness-actions.js";

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
  // A full report after the refusal answers it.
  assert.equal(harnessSignedOutOn(reporting("signed_in"), key, before), undefined);
  assert.equal(harnessSignedOutOn(reporting(undefined), key, null), undefined);
  assert.equal(harnessSignedOutOn(reporting("signed_in"), key, "not a time"), undefined);
});

test("a sign-in through xMatrix answers an earlier refusal though only its own item was re-probed", async () => {
  // The inventory was captured before the refusal; the sign-in re-probed codex alone afterwards.
  const stored = reporting("signed_out").metadata_json.harnesses;
  let written;
  const tx = { query: async ({ name, values }) => {
    if (name === "machine_harness_action_item_lock_v2") return [{ harnesses: stored }];
    if (name === "machine_harness_action_item_v2") written = JSON.parse(values[2]);
    return [];
  } };
  await recordHarnessActionInventory(tx, { ownerUserId: "owner", machineId: "machine:mac", hostId: "mac-mini",
    at: "2026-10-18T07:05:12.000Z", result: { presetId: "codex", action: "login_finish", status: "succeeded",
      item: { id: "codex", installed: true, version: "0.130.0", probeStatus: "ok", login: "signed_in" } } });
  assert.equal(written.capturedAt, "2026-10-18T07:00:00Z", "the rest of the inventory is as old as it was");
  assert.equal(written.items[0].observedAt, "2026-10-18T07:05:12.000Z");
  const daemon = { machine_name: "mac-mini", metadata_json: { harnesses: written } };
  assert.equal(harnessSignedOutOn(daemon, key, "2026-10-18T07:01:00Z"), undefined, "the sign-in came after the refusal");
  assert.equal(harnessSignedOutOn(daemon, key, "2026-10-18T07:06:00Z").program, "Codex", "a later refusal still counts");
});
