import assert from "node:assert/strict";
import test from "node:test";
import { machineRunFailureNoticeCommand, machineStopResultNoticeCommand } from "../src/machine-run-failure-notice.ts";

const target = { ownerUserId: "owner", ownerEmail: "owner@example.test", machineId: "machine:grok",
  hostId: "cursor", machineName: "Grok Bot Machine", runId: "run", channelId: "channel", agentName: "grok" };

test("Machine notices name the Machine while retaining exact owner, Machine and Run evidence", async () => {
  for (const notice of [await machineRunFailureNoticeCommand({ ...target, detail: "failure" }),
    await machineStopResultNoticeCommand({ ...target, controlKey: "stop", ok: true })]) {
    assert.match(notice.body, /on Grok Bot Machine\./);
    assert.equal(notice.body.includes("cursor"), false);
    const metadata = notice.residual.appMetadata;
    assert.equal(metadata.machineId, target.machineId);
    assert.equal(metadata.machineOwnerUserId, target.ownerUserId);
    assert.equal(metadata.runId, target.runId);
    assert.equal(Object.hasOwn(metadata, "hostId"), false);
  }
  const unnamed = await machineRunFailureNoticeCommand({ ...target, machineName: undefined, detail: "failure" });
  assert.match(unnamed.body, /^Couldn't start @grok\./);
  assert.equal(unnamed.body.includes("cursor"), false);
});
