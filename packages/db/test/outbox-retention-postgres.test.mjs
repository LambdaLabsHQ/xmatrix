import assert from "node:assert/strict";
import { Client } from "pg";
import { integration, isolatedPostgres } from "./postgres-database.fixture.mjs";
import { parseLifecycleOptions, runLifecycleMaintenance } from "../scripts/postgres-lifecycle-maintenance.mjs";

// Proves the destructive boundary with actual rows and a concurrent lock:
// age alone must never remove a lease, attempted delivery or recent update.
integration("outbox retention deletes only old unconsumed envelopes within its batch bound", async () => {
  const f = await isolatedPostgres("outbox_retention");
  const locker = new Client({ connectionString: f.url.toString() });
  await locker.connect();
  try {
    const variants = [
      ["old-a", "pending", 0, false, 36, 36, 36],
      ["old-b", "pending", 0, false, 36, 36, 36],
      ["locked", "pending", 0, false, 36, 36, 36],
      ["recent", "pending", 0, false, 1, 1, 1],
      ["updated", "pending", 0, false, 36, 1, 36],
      ["future", "pending", 0, false, 36, 36, -1],
      ["attempted", "pending", 1, false, 36, 36, 36],
      ["leased", "leased", 0, true, 36, 36, 36],
      ["pending-lease", "pending", 0, true, 36, 36, 36],
      ["failed", "failed", 0, false, 36, 36, 36],
      ["delivered", "delivered", 1, false, 36, 36, 36],
    ];
    for (const [id, status, attempts, lease, created, updated, available] of variants) {
      await f.run(`INSERT INTO data.outbox
        (outbox_id,space_id,topic,aggregate_kind,aggregate_id,aggregate_sequence,payload_json,
         status,attempts,lease_until,created_at,updated_at,available_at)
        VALUES ($1,'space','message','message',$1,1,'{}',$2,$3,
          CASE WHEN $4 THEN now()+interval '1 hour' ELSE NULL END,
          now()-$5*interval '1 day',now()-$6*interval '1 day',now()-$7*interval '1 day')`,
      [id, status, attempts, lease, created, updated, available]);
    }
    const dry = await runLifecycleMaintenance(f.client, parseLifecycleOptions(["--dry-run"]));
    assert.equal(dry.before.retainedOutboxRowsCapped, 3);
    assert.equal(dry.deletedRetainedOutboxRows, 0);
    await locker.query("BEGIN");
    await locker.query("SELECT outbox_id FROM data.outbox WHERE outbox_id='locked' FOR UPDATE");
    const options = parseLifecycleOptions(["--batch-size=1", "--max-rows=1"]);
    assert.equal((await runLifecycleMaintenance(f.client, options)).deletedRetainedOutboxRows, 1);
    assert.equal((await runLifecycleMaintenance(f.client, options)).deletedRetainedOutboxRows, 1);
    assert.equal((await runLifecycleMaintenance(f.client, options)).deletedRetainedOutboxRows, 0, "locked row is skipped");
    await locker.query("COMMIT");
    assert.equal((await runLifecycleMaintenance(f.client, options)).deletedRetainedOutboxRows, 1);
    assert.equal((await runLifecycleMaintenance(f.client, options)).deletedRetainedOutboxRows, 0, "retry is idempotent");
    assert.deepEqual((await f.run("SELECT outbox_id FROM data.outbox ORDER BY outbox_id")).map(row => row.outbox_id),
      ["attempted", "delivered", "failed", "future", "leased", "pending-lease", "recent", "updated"]);
  } finally {
    await locker.query("ROLLBACK").catch(() => {});
    await locker.end();
    await f.close();
  }
});
