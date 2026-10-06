import { connectionString as url, integration } from "./postgres-database.fixture.mjs";
import assert from "node:assert/strict";
import { Client, Pool } from "pg";

import { createAuthorityDatabase } from "../dist/index.js";

// A placed single read takes the Space placement fence FOR SHARE in the same
// statement as the caller's read. Only overlapping real connections show that
// a move and a read actually serialize on that row lock.

async function waitFor(probe, message, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await probe()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting: ${message}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** Settles to a tagged outcome so a pending promise can be inspected without awaiting it. */
function track(promise) {
  const state = { settled: false, at: 0 };
  state.done = promise.then(
    (value) => Object.assign(state, { settled: true, at: performance.now(), value }),
    (error) => Object.assign(state, { settled: true, at: performance.now(), error }),
  );
  return state;
}

async function fixture(t, options = {}) {
  assert.ok(url, "XMATRIX_TEST_POSTGRES_URL is required");
  const admin = new Client({ connectionString: url });
  await admin.connect();
  const mover = new Client({ connectionString: url });
  await mover.connect();
  const spaceId = `fence-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  for (const shard of ["shard-0", "shard-1"]) {
    await admin.query(`INSERT INTO control.postgres_shards (shard_id,state,capacity_class,created_at,updated_at)
      VALUES ($1,'active',$1,now(),now()) ON CONFLICT DO NOTHING`, [shard]);
  }
  await admin.query(`INSERT INTO control.space_placement
    (space_id,shard_id,placement_epoch,state,plan_class,created_at,updated_at)
    VALUES ($1,'shard-0',1,'active','standard',now(),now())`, [spaceId]);
  let pool;
  // Only this fixture's reads use this pool, so its backends identify them.
  const readerPids = new Set();
  const database = createAuthorityDatabase({
    connectionString: url, shardId: "shard-0", connectTimeoutMs: 60_000,
    lockTimeoutMs: options.lockTimeoutMs ?? 10_000,
    poolFactory: (config) => {
      pool = new Pool(config);
      pool.on("connect", (client) => readerPids.add(client.processID));
      return pool;
    },
  });
  t.after(async () => {
    await mover.query("ROLLBACK").catch(() => undefined);
    await mover.end();
    await admin.query("DELETE FROM control.space_placement WHERE space_id=$1", [spaceId]);
    await admin.end();
    if (pool && !pool.ended) await pool.end();
  });
  const read = (marker, sleepSeconds = 0) => database.transaction({
    requestId: `${spaceId}-${marker}`, operation: "fence-probe", statement: "single_read",
    placement: { spaceId, shardId: "shard-0", placementEpoch: 1 },
  }, (transaction) => transaction.query({
    name: `fence_probe_${marker}_v1`,
    text: `SELECT '${marker}'::text AS marker, pg_sleep(${sleepSeconds})::text AS slept`,
    maxRows: 1,
  }));
  /** The backend running this fixture's in-flight read, as pg_stat_activity sees it. */
  const backend = async () => (await admin.query(`SELECT pid, wait_event_type FROM pg_stat_activity
    WHERE pid = ANY($1::int[]) AND state = 'active'`, [[...readerPids]])).rows[0];
  return { admin, mover, spaceId, read, backend, pool: () => pool };
}

integration("a move waits for a placed read that holds the fence, and the read keeps its epoch", async (t) => {
  const { admin, mover, spaceId, read, backend } = await fixture(t);
  const reading = track(read("hold-a", 1.5));
  // The table-level RowShareLock is taken at executor start, immediately
  // before the fence row lock; the read then sleeps for 1.5 s holding both.
  await waitFor(async () => {
    const running = await backend();
    if (!running) return false;
    const locks = await admin.query(`SELECT 1 FROM pg_locks
      WHERE pid=$1 AND relation='control.space_placement'::regclass AND mode='RowShareLock'`, [running.pid]);
    return locks.rowCount > 0;
  }, "the read to take the placement fence");
  await new Promise((resolve) => setTimeout(resolve, 200));

  const moving = track(mover.query(`UPDATE control.space_placement
    SET placement_epoch=2, updated_at=now() WHERE space_id=$1`, [spaceId]));
  await waitFor(async () => (await admin.query(`SELECT 1 FROM pg_stat_activity
    WHERE query LIKE 'UPDATE control.space_placement%' AND wait_event_type='Lock'`)).rowCount > 0,
  "the move to block on the read's fence");
  assert.equal(reading.settled, false, "the read is still holding the fence while the move waits");
  assert.equal(moving.settled, false, "the move cannot pass a read that holds the fence");

  await reading.done;
  await moving.done;
  assert.equal(reading.error, undefined);
  assert.deepEqual(reading.value.map((row) => row.marker), ["hold-a"], "the read admits its rows at epoch 1");
  assert.equal(moving.error, undefined);
  assert.ok(moving.at >= reading.at, "the move completes only after the read's statement ends");
  const after = await admin.query("SELECT placement_epoch FROM control.space_placement WHERE space_id=$1", [spaceId]);
  assert.equal(Number(after.rows[0].placement_epoch), 2);
});

for (const [label, change] of [
  ["a new epoch", "placement_epoch=2"],
  ["a moving placement", "state='moving', target_shard_id='shard-1'"],
]) {
  integration(`a placed read that waits on a move refuses ${label} once it commits`, async (t) => {
    const { mover, spaceId, read, backend } = await fixture(t);
    await mover.query("BEGIN");
    await mover.query(`UPDATE control.space_placement SET ${change}, updated_at=now() WHERE space_id=$1`, [spaceId]);

    const marker = `wait-${label.replace(/\W+/gu, "-")}`;
    const reading = track(read(marker));
    await waitFor(async () => (await backend())?.wait_event_type === "Lock",
      "the read to wait on the move's row lock");
    assert.equal(reading.settled, false, "the read cannot take the fence while the move holds it");

    await mover.query("COMMIT");
    await reading.done;
    assert.equal(reading.value, undefined, "no caller rows are returned");
    assert.match(String(reading.error?.message), /local Space placement fence is stale/u);
  });
}

integration("a placed read that cannot take the fence in time fails and leaves its connection usable", async (t) => {
  const { mover, spaceId, read, pool } = await fixture(t, { lockTimeoutMs: 300 });
  await mover.query("BEGIN");
  await mover.query("UPDATE control.space_placement SET updated_at=now() WHERE space_id=$1", [spaceId]);

  const reading = track(read("timeout-c"));
  await reading.done;
  assert.equal(reading.value, undefined, "no caller rows are returned");
  assert.equal(reading.error?.code, "55P03", "the configured lock_timeout ends the wait");

  await mover.query("ROLLBACK");
  const checkedOut = pool().totalCount - pool().idleCount;
  assert.equal(checkedOut, 0, "the failed read returned or discarded its connection");
  assert.deepEqual((await read("after-c")).map((row) => row.marker), ["after-c"],
    "the next placed read takes the released fence normally");
});
