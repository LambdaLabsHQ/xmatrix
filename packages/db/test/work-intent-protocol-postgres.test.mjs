import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { Client } from "pg";
import { connectionString, integration } from "./postgres-database.fixture.mjs";
import {
  finishWork, markWorkSent, reconcileExpiredWork, reconcileUnsentWork, relayWork, scheduleWork, startWork,
  WORK_INTENT_PROTOTYPE_SCHEMA,
} from "../dist/work-intent.js";

/** The prototype's tables in a committed schema of their own, so tests can use several connections. */
async function protocol(run) {
  const schema = `work_intent_${randomUUID().replaceAll("-", "")}`;
  const rewrite = text => text.replaceAll("data.", `${schema}.`).replaceAll("control.", `${schema}.`);
  const admin = new Client({ connectionString });
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${schema}`);
  await admin.query(rewrite(WORK_INTENT_PROTOTYPE_SCHEMA));
  await admin.query(`CREATE TABLE ${schema}.space_placement
    (space_id text PRIMARY KEY, shard_id text, placement_epoch bigint, state text, target_shard_id text)`);
  const clients = [];
  const connect = async () => {
    const client = new Client({ connectionString });
    await client.connect();
    clients.push(client);
    return { async query({ name, text, values, maxRows }) {
      const result = await client.query(rewrite(text), values);
      assert.ok(result.rows.length <= maxRows, `${name} exceeded its row bound`);
      return result.rows;
    } };
  };
  try {
    await run({ tx: await connect(), connect, sql: (text, values) => admin.query(rewrite(text), values) });
  } finally {
    for (const client of clients) await client.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
}

const shard = { leaseMs: 30_000, scopeLimit: 4, shardId: "shard-0" };
const past = () => new Date(Date.now() - 1_000);
const later = minutes => new Date(Date.now() + minutes * 60_000);
const id = (key = "route-1", scope = "system:gmail") => ({ scope, kind: "gmail.route", key });
const row = async (sql, identity) => (await sql(`SELECT * FROM data.work_intents WHERE scope=$1 AND kind=$2 AND key=$3`,
  [identity.scope, identity.kind, identity.key])).rows[0];

integration("A: a committed intent whose message was never sent is sent again with the same token", async () => {
  await protocol(async ({ tx }) => {
    const committed = await scheduleWork(tx, id(), { op: "set", at: past() });
    const [resent] = await reconcileUnsentWork(tx, { cooldownMs: 60_000, limit: 10 });
    assert.equal(resent.dispatchToken, committed.dispatchToken);
    assert.equal(typeof (await startWork(tx, resent, shard)), "object");
  });
});

integration("B: one dispatch token starts once, even from concurrent consumers", async () => {
  await protocol(async ({ tx, connect }) => {
    const dispatch = await scheduleWork(tx, id(), { op: "set", at: past() });
    const consumers = await Promise.all([connect(), connect(), connect()]);
    const results = await Promise.all(consumers.map(consumer => startWork(consumer, dispatch, shard)));
    assert.equal(results.filter(result => typeof result === "object").length, 1);
    assert.deepEqual(results.filter(result => typeof result === "string"), ["stale", "stale"]);
  });
});

integration("B: a queue slower than the re-send cooldown never invalidates the message waiting in it", async () => {
  await protocol(async ({ tx }) => {
    const waiting = await scheduleWork(tx, id(), { op: "set", at: past() });
    await markWorkSent(tx, waiting);
    for (let round = 0; round < 3; round++) {
      const [resent] = await reconcileUnsentWork(tx, { cooldownMs: 0, limit: 10 });
      assert.equal(resent.dispatchToken, waiting.dispatchToken);
    }
    assert.equal(typeof (await startWork(tx, waiting, shard)), "object", "the first message still starts");
  });
});

integration("B: a late message after its execution finished is stale", async () => {
  await protocol(async ({ tx }) => {
    const dispatch = await scheduleWork(tx, id(), { op: "set", at: past() });
    const execution = await startWork(tx, dispatch, shard);
    assert.deepEqual(await finishWork(tx, execution, { kind: "done" }, shard), { settled: true, next: null });
    assert.equal(await startWork(tx, dispatch, shard), "stale");
    assert.deepEqual(await finishWork(tx, execution, { kind: "done" }, shard), { settled: false, next: null });
  });
});

integration("B: an early message is not due; a long-delay relay replaces its token exactly once", async () => {
  await protocol(async ({ tx, connect }) => {
    const far = await scheduleWork(tx, id(), { op: "set", at: later(3 * 24 * 60) });
    assert.equal(await startWork(tx, far, shard), "not_due");
    const relays = await Promise.all([relayWork(await connect(), far, 24 * 3_600_000),
      relayWork(await connect(), far, 24 * 3_600_000)]);
    const next = relays.filter(Boolean);
    assert.equal(next.length, 1);
    assert.notEqual(next[0].dispatchToken, far.dispatchToken);
    assert.equal(await startWork(tx, far, shard), "stale");
    assert.equal(await startWork(tx, next[0], shard), "not_due");
  });
});

integration("C: a reschedule during an execution wins over the old execution's next time", async () => {
  await protocol(async ({ tx, sql }) => {
    const dispatch = await scheduleWork(tx, id(), { op: "set", at: past() });
    const execution = await startWork(tx, dispatch, shard);
    const businessPlan = later(60);
    assert.equal(await scheduleWork(tx, id(), { op: "set", at: businessPlan }), null,
      "a running intent is sent again by its finish, not now");
    const { settled, next } = await finishWork(tx, execution, { kind: "defer", at: later(5) }, shard);
    assert.equal(settled, true);
    assert.equal(next.wakeAt.getTime(), businessPlan.getTime());
    assert.notEqual(next.dispatchToken, dispatch.dispatchToken);
    assert.equal((await row(sql, id())).state, "pending");
  });
});

integration("C: cancel during an execution leaves nothing behind; a recreate is a new incarnation", async () => {
  await protocol(async ({ tx, sql }) => {
    const dispatch = await scheduleWork(tx, id(), { op: "set", at: past() });
    const execution = await startWork(tx, dispatch, shard);
    await scheduleWork(tx, id(), { op: "cancel" });
    assert.deepEqual(await finishWork(tx, execution, { kind: "defer", at: later(5) }, shard),
      { settled: true, next: null }, "the old execution cannot schedule cancelled work again");
    assert.equal(await row(sql, id()), undefined);
    const recreated = await scheduleWork(tx, id(), { op: "set", at: past() });
    assert.notEqual(recreated.incarnation, dispatch.incarnation);
    assert.equal(await startWork(tx, dispatch, shard), "stale");
    assert.deepEqual(await finishWork(tx, execution, { kind: "done" }, shard), { settled: false, next: null });
    assert.equal(typeof (await startWork(tx, recreated, shard)), "object");
  });
});

integration("C: an idle cancel removes the intent; its old message is stale", async () => {
  await protocol(async ({ tx }) => {
    const dispatch = await scheduleWork(tx, id(), { op: "set", at: later(5) });
    await scheduleWork(tx, id(), { op: "cancel" });
    assert.equal(await startWork(tx, dispatch, shard), "stale");
    assert.deepEqual(await reconcileUnsentWork(tx, { cooldownMs: 0, limit: 10 }), []);
  });
});

integration("expired executions follow the kind's effect contract instead of being replayed blindly", async () => {
  await protocol(async ({ tx, sql }) => {
    const safe = id("safe-1"), once = { ...id("once-1"), kind: "mail.send" };
    const executions = [];
    for (const identity of [safe, once]) {
      const dispatch = await scheduleWork(tx, identity, { op: "set", at: past() });
      executions.push(await startWork(tx, dispatch, { ...shard, leaseMs: 1 }));
    }
    await sleep(20);
    assert.deepEqual(await finishWork(tx, executions[0], { kind: "done" }, shard), { settled: false, next: null },
      "an expired execution cannot settle");
    const resent = await reconcileExpiredWork(tx, { limit: 10, retryAfterMs: 0,
      effects: { safe: ["gmail.route"], reconcile: [], at_most_once: ["mail.send"] } });
    assert.deepEqual(resent.map(dispatch => dispatch.key), ["safe-1"]);
    assert.equal(typeof (await startWork(tx, resent[0], shard)), "object");
    const parked = await row(sql, once);
    assert.equal(parked.state, "parked");
    assert.equal(parked.needs_reconcile, true);
    assert.equal(parked.unknown_outcomes, 1);
  });
});

integration("a scope's quota refuses without holding a slot or consuming a business attempt", async () => {
  await protocol(async ({ tx, sql }) => {
    const limited = { ...shard, scopeLimit: 1 };
    const first = await scheduleWork(tx, id("a", "space:big"), { op: "set", at: past() });
    const second = await scheduleWork(tx, id("b", "space:big"), { op: "set", at: past() });
    const running = await startWork(tx, first, limited);
    assert.equal(await startWork(tx, second, limited), "quota");
    const refused = await row(sql, id("b", "space:big"));
    assert.equal(refused.business_attempts, 0);
    assert.equal(refused.refusals, 1);
    await finishWork(tx, running, { kind: "done" }, shard);
    assert.equal(typeof (await startWork(tx, second, limited)), "object");
  });
});

integration("a retry keeps the planned time and waits for its backoff", async () => {
  await protocol(async ({ tx, sql }) => {
    const planned = past();
    const dispatch = await scheduleWork(tx, id(), { op: "set", at: planned });
    const execution = await startWork(tx, dispatch, shard);
    const notBefore = later(10);
    const { next } = await finishWork(tx, execution,
      { kind: "retry", notBefore, errorCode: "provider_unavailable" }, shard);
    assert.equal(next.wakeAt.getTime(), notBefore.getTime());
    assert.equal(await startWork(tx, next, shard), "not_due");
    assert.equal((await row(sql, id())).planned_at.getTime(), planned.getTime(), "lag still counts from the plan");
  });
});

integration("H: an old placement epoch can neither start nor settle", async () => {
  await protocol(async ({ tx, sql }) => {
    const space = id("route-1", "space:abc");
    await sql(`INSERT INTO data.space_placement VALUES ('abc','shard-0',1,'active',NULL)`);
    const dispatch = await scheduleWork(tx, space, { op: "set", at: past() }, 1);
    const execution = await startWork(tx, dispatch, shard);
    assert.equal(typeof execution, "object");
    await sql(`UPDATE data.space_placement SET placement_epoch=2 WHERE space_id='abc'`);
    assert.deepEqual(await finishWork(tx, execution, { kind: "done" }, shard), { settled: false, next: null });
    const again = await scheduleWork(tx, id("route-2", "space:abc"), { op: "set", at: past() }, 1);
    assert.equal(await startWork(tx, again, shard), "stale");
    assert.equal(await startWork(tx, { ...again, placementEpoch: 2 }, shard), "stale",
      "a message cannot claim an epoch the intent does not carry");
  });
});
