import assert from "node:assert/strict";
import test from "node:test";

import { reapSpaceAutomationRuns } from "../src/space-automation-alarm.ts";

const NOW = new Date("2026-08-20T00:10:00.000Z");

test("PostgreSQL timeout stop fails closed at Machine authority instead of issuing through local storage", async (t) => {
  t.mock.method(console, "error", () => {});
  const env = {};
  const schedule = {
    async reapExpiredRuns(now, issueStop) {
      assert.equal(now, NOW);
      await assert.rejects(issueStop({
        occurrence: { id: "occ:expired", task_id: "task:focus", attempts: 1,
          owner_user_id: "owner", run_id: "run:expired", instance_id: null },
        machineId: "machine", hostId: "host",
        executionKey: "synthetic-key", controlId: "scheduled:timeout-stop:occ:expired:1",
      }), /PostgreSQL Machine bindings are unavailable/u);
    },
  };
  await reapSpaceAutomationRuns(env, NOW, schedule);
});
