import assert from "node:assert/strict";
import test from "node:test";

import {
  PostgresScheduleOccurrenceLifecycle,
} from "../src/postgres-automation-authority.ts";

function occurrence() {
  return {
    id: "occurrence-1", task_id: "task-1", task_version: 2,
    lease_owner: "lease-1", attempts: 1, delivery_kind: "agent_run",
    run_id: "run-1", instance_id: "instance-1", execution_timeout_ms: 60_000,
  };
}

test("scheduled occurrence lifecycle scans all shards and preserves claim affinity", async () => {
  const calls = [];
  const first = {
    async maintain() { calls.push("maintain-0"); },
    async claim() { calls.push("claim-0"); return undefined; },
  };
  const second = {
    async maintain() { calls.push("maintain-1"); },
    async claim() { calls.push("claim-1"); return occurrence(); },
    async getExecutionAutomation() { calls.push("task-1"); return { id: "task-1" }; },
    async markPrepared() { calls.push("prepared-1"); },
  };
  const lifecycle = new PostgresScheduleOccurrenceLifecycle({
    RELAY_POSTGRES: { connectionString: "postgres://unused" },
    RELAY_POSTGRES_SHARD_ID: "shard-0",
  }, undefined, { repositories: [first, second] });

  await lifecycle.maintain(new Date(), "2026-08-30T10:00:00.000Z");
  const claimed = await lifecycle.claim(new Date(), "2026-08-30T10:00:00.000Z", "lease-1");
  assert.equal(claimed.id, "occurrence-1");
  assert.deepEqual(await lifecycle.getAutomation("task-1"), { id: "task-1" });
  await lifecycle.markPrepared(claimed, "2026-08-30T10:00:01.000Z");
  assert.deepEqual(calls.slice(0, 4).sort(),
    ["claim-0", "claim-1", "maintain-0", "maintain-1"].sort());
  assert.equal(calls.includes("task-1"), true);
  assert.equal(calls.includes("prepared-1"), true);
});

test("scoped scheduled execution admits claims only for its exact Space", async () => {
  let claimInput, maintenanceInput;
  const repository = {
    async claim(input) { claimInput = input; return undefined; },
    async maintain(input) { maintenanceInput = input; },
  };
  const lifecycle = new PostgresScheduleOccurrenceLifecycle({
    RELAY_POSTGRES: { connectionString: "postgres://unused" },
    RELAY_POSTGRES_SHARD_ID: "shard-0",
  }, undefined, { repositories: [repository], spaceId: "space-1" });
  await lifecycle.claim(new Date(), "2026-08-30T10:00:00.000Z", "lease-1");
  assert.equal(claimInput.spaceId, "space-1");
  await lifecycle.maintain(new Date(), "2026-08-30T10:00:00.000Z");
  assert.equal(maintenanceInput.spaceId, "space-1");
});
