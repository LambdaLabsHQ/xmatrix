import assert from "node:assert/strict";
import test from "node:test";
import { createHash, randomUUID } from "node:crypto";
import {
  executionReportCommand,
} from "../src/machine-execution-report-command.ts";
import { machineRunLifecycleReport } from "../src/machine-run-lifecycle-report.ts";
const principal = { ownerUserId: "owner", machineId: "machine", hostId: "host" };
const body = { schemaVersion: 1, requestId: randomUUID(), scope: { hubOrigin: "https://hub.test", channelId: "channel",
  runId: "run", instanceId: "instance", agentId: "agent", executionFingerprint: createHash("sha256").update("execution-key").digest("hex") },
  report: { executionId: randomUUID(), revision: 2, sourceCount: 1,
    sources: [{ channelId: "channel", messageId: "source", sequence: 1, entityVersion: 1, bodyHash: "a".repeat(64) }],
    state: "completed", startedAtMillis: Date.now(), updatedAtMillis: Date.now(), finishedAtMillis: Date.now() } };
body.report.updatedAtMillis = body.report.finishedAtMillis;

test("execution submission cannot supply Machine authority or broaden its command", () => {
  const command = executionReportCommand(principal, body);
  assert.deepEqual(command.principal, { kind: "machine", ...principal });
  assert.equal(command.eventType, "machine_execution_report");
  for (const key of ["principal", "ownerUserId", "machineId", "hostId", "eventType", "action", "runLifecycleReplica"]) {
    assert.equal(executionReportCommand(principal, { ...body, [key]: "forged" }), null);
    assert.equal(executionReportCommand(principal, { ...body, scope: { ...body.scope, [key]: "forged" } }), null);
  }
});

test("execution acknowledgement uses PostgreSQL without requiring a new connection epoch or mutating Run state", async () => {
  const calls = [];
  const database = { cacheMode: "disabled", async transaction(_context, callback) {
    return callback({ async query(query) {
      calls.push(query);
      if (query.name === "channel_space_directory_resolve_v2") return [{ channel_id: "channel", space_id: "space",
        shard_id: "shard-1", placement_epoch: 1, entity_version: 1 }];
      if (query.name === "space_placement_resolve_v1") return [{ space_id: "space", shard_id: "shard-1", placement_epoch: 1,
        state: "active", target_shard_id: null, plan_class: "single" }];
      if (query.name === "runtime_execution_report_owner_v4") return [{ run_id: "run", instance_id: "instance",
        metadata_json: { executionKey: "execution-key" }, channel_instance_id: 1 }];
      if (["runtime_message_execution_prior_v1", "runtime_message_execution_upsert_v2", "runtime_execution_report_receipt_v1"].includes(query.name)) return [];
      throw new Error(`Unexpected query ${query.name}`);
    } });
  } };
  const command = executionReportCommand(principal, body);
  const receipt = await machineRunLifecycleReport({}, command, { database });
  assert.equal(receipt.requestId, body.requestId);
  assert.equal(receipt.status, "source_unavailable");
  assert.ok(calls.some(query => query.name === "runtime_message_execution_upsert_v2"));
  assert.ok(calls.every(query => !/UPDATE data\.(runs|instances)/u.test(query.text)), "only execution observation storage may change");
});
