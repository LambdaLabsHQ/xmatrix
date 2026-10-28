import assert from "node:assert/strict";
import test from "node:test";
import { sendErrorReports } from "@xmatrix/protocol/error-reporting";
import { RuntimeSocketState } from "../src/runtime-transport/ordered-socket-dispatch.ts";
import { sentryEventMetadata } from "../src/connectors/actions/sentry-event-metadata.ts";
import { captureErrorReports, exceptionEvents } from "./support/error-reports.mjs";
import { authorityPort, recordingCommands } from "./support/machine-daemon-port.mjs";

const session = {
  principal: { ownerUserId: "PRIVATE_SENTINEL_owner", machineId: "PRIVATE_SENTINEL_machine" },
  connectionEpoch: 7, capabilities: ["machine_run_snapshot_causal_v1"],
  clientVersion: "1.12.3-beta.1",
};
const snapshot = { type: "machine_run_snapshot", snapshotComplete: true,
  registryConnectionEpoch: 7, registrySequence: 2, capturedAt: new Date().toISOString(), runs: [] };

// The existing port test proves the fence, but its generic Error lost the cause
// and original stack at the socket boundary (HUB-AX). Exercise that boundary
// and the real Sentry envelope, with no authority mutations for rejected data.
test("registry rejections retain finite causes through the socket and issue reader (XMATRIX-HUB-AX)", async t => {
  const envelopes = captureErrorReports(t);
  const calls = [];
  const port = authorityPort({ commands: recordingCommands(calls) });
  const sockets = new RuntimeSocketState("test", (_id, message, failure) => ({ message, failure }), () => {});
  const cases = [
    ["epoch_missing", { ...snapshot, registryConnectionEpoch: undefined }],
    ["epoch_invalid", { ...snapshot, registryConnectionEpoch: "PRIVATE_SENTINEL_epoch" }],
    ["snapshot_epoch_stale", { ...snapshot, registryConnectionEpoch: 6 }],
    ["epoch_future", { ...snapshot, registryConnectionEpoch: 8, snapshotComplete: false }],
    ["sequence_missing", { ...snapshot, registrySequence: undefined, snapshotComplete: undefined }],
    ["sequence_invalid", { ...snapshot, registrySequence: "PRIVATE_SENTINEL_sequence" }],
    ["epoch_future", { type: "machine_spawn_result", ok: true, requestId: "PRIVATE_SENTINEL_request",
      registryConnectionEpoch: 8, registrySequence: 1 }],
    ["epoch_invalid", { ...snapshot, registryConnectionEpoch: 0 },
      { capabilities: [], clientVersion: "PRIVATE_SENTINEL_client" }],
  ];
  for (const [index, [reason, report, override]] of cases.entries()) {
    const replies = [];
    await sockets.answerOperation({ send: raw => replies.push(JSON.parse(raw)) }, "report", "Report failed",
      () => port.execute({ ...session, ...override }, report));
    await sendErrorReports();
    assert.equal(calls.length, 0, "invalid evidence never reaches an authority or a physical effect");
    assert.equal(replies.length, 1);
    assert.equal(replies[0].failure.code, "runtime.session_failed");
    assert.equal(replies[0].failure.retryable, false);
    assert.doesNotMatch(JSON.stringify(replies), /PRIVATE_SENTINEL|registry_/u);
    const events = exceptionEvents(envelopes);
    assert.equal(events.length, index + 1, "exactly one exception per rejected operation");
    const latest = events.at(-1);
    const frame = report.type === "machine_spawn_result" ? "spawn_success"
      : report.snapshotComplete === true ? "snapshot_full"
      : report.snapshotComplete === false ? "snapshot_partial" : "snapshot_unspecified";
    assert.equal(latest.extra.machine_registry_reason, reason);
    assert.equal(latest.extra.machine_registry_frame, frame);
    assert.equal(latest.extra.diagnosticId, replies[0].failure.diagnosticId);
    assert.deepEqual(latest.fingerprint, ["machine-daemon-registry", frame, reason]);
    assert.ok(latest.exception.values[0].stacktrace.frames.some(value => value.function === "assertMachineRegistryCausality"));
    const metadata = sentryEventMetadata({ tags: [{ key: "operation", value: latest.tags.operation }], context: latest.extra });
    const client = override ? "legacy · client=unavailable" : "advertised · client=1.12.3-beta.1";
    assert.ok(metadata.includes(`Machine registry rejection: ${frame} · ${reason} · ${client}`));
    assert.ok(metadata.includes("Capture operation: runtime.machine-registry"));
    assert.doesNotMatch(JSON.stringify(events), /PRIVATE_SENTINEL/u);
  }
  const extra = exceptionEvents(envelopes)[0].extra;
  for (const key of ["machine_registry_reason", "machine_registry_frame", "machine_registry_capability", "machine_registry_client"]) {
    assert.ok(!sentryEventMetadata({ context: { ...extra, [key]: "PRIVATE_SENTINEL" } })
      .some(line => line.startsWith("Machine registry rejection:")), "untrusted metadata is allowlisted");
  }
});

test("causal diagnostics preserve current snapshots, older spawn evidence and legacy compatibility", async t => {
  const envelopes = captureErrorReports(t);
  const calls = [];
  const port = authorityPort({ commands: recordingCommands(calls) });
  await port.execute(session, snapshot);
  await port.execute(session, { type: "machine_spawn_result", ok: true, requestId: "spawn",
    registryConnectionEpoch: 6, registrySequence: 1 });
  await port.execute({ ...session, capabilities: [] }, { type: "machine_run_snapshot", runs: [] });
  await port.execute({ ...session, capabilities: [] }, { type: "machine_spawn_result", ok: true, requestId: "legacy" });
  assert.equal(calls.length, 4);
  await sendErrorReports();
  assert.equal(exceptionEvents(envelopes).length, 0, "accepted reports do not create errors");
});
