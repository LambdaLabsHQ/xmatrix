import assert from "node:assert/strict";
import test from "node:test";

import {
  admissionCommand,
  executeAdmission,
} from "../scripts/shard-admission.mjs";

test("shard admission inspection is read-only and mutation requires exact confirmation", () => {
  assert.deepEqual(admissionCommand(["show"], { POSTGRES_SHARD_ID: "next-0" }), {
    shard: "next-0", target: "show",
  });
  assert.throws(() => admissionCommand(["draining"], {
    POSTGRES_SHARD_ID: "next-0",
  }), /POSTGRES_SHARD_ADMISSION_CONFIRMATION/u);
  assert.deepEqual(admissionCommand(["draining"], {
    POSTGRES_SHARD_ID: "next-0",
    POSTGRES_SHARD_ADMISSION_CONFIRMATION:
      "SET POSTGRES SHARD next-0 ADMISSION TO draining",
  }), { shard: "next-0", target: "draining" });
});

test("shard admission mutation is locked, bounded, and reports the previous state", async () => {
  const calls = [];
  const client = {
    async query(text, values) {
      calls.push({ text, values });
      if (text.startsWith("SELECT shard_id")) return { rows: [{
        shard_id: "next-0", state: "active", capacity_class: "shared", updated_at: "before",
      }] };
      if (text.startsWith("UPDATE control.postgres_shards")) return { rows: [{
        shard_id: "next-0", state: "draining", capacity_class: "shared", updated_at: "after",
      }] };
      return { rows: [] };
    },
  };
  const result = await executeAdmission(client, { shard: "next-0", target: "draining" });
  assert.equal(result.previousState, "active");
  assert.equal(result.state, "draining");
  assert.deepEqual(calls.map(({ text }) => text.split(" ")[0]), [
    "BEGIN", "SELECT", "SELECT", "UPDATE", "COMMIT",
  ]);
});
