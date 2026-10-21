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
    return { raw: client, async query({ name, text, values, maxRows }) {
      const result = await client.query(rewrite(text), values);
      assert.ok(result.rows.length <= maxRows, `${name} exceeded its row bound`);
      return result.rows;
    } };
  };
  try {
    await run({ tx: await connect(), connect, rewrite, sql: (text, values) => admin.query(rewrite(text), values) });
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
    await markWorkSent(tx, waiting, 0);
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
    const relay = { horizonMs: 24 * 3_600_000, cooldownMs: 60_000 };
    const relays = await Promise.all([relayWork(await connect(), far, relay), relayWork(await connect(), far, relay)]);
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
    const first = await scheduleWork(tx, id("a", "system:big"), { op: "set", at: past() });
    const second = await scheduleWork(tx, id("b", "system:big"), { op: "set", at: past() });
    const running = await startWork(tx, first, limited);
    assert.equal(await startWork(tx, second, limited), "quota");
    const refused = await row(sql, id("b", "system:big"));
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

integration("an old permanent or uncertain outcome never stops a newer business plan", async () => {
  await protocol(async ({ tx, sql }) => {
    for (const outcome of [{ kind: "permanent", errorCode: "old_failure" }, { kind: "uncertain", errorCode: "lost_reply" }]) {
      const identity = id(`plan-${outcome.kind}`);
      const dispatch = await scheduleWork(tx, identity, { op: "set", at: past() });
      const execution = await startWork(tx, dispatch, shard);
      await scheduleWork(tx, identity, { op: "set", at: past() });
      const { settled, next } = await finishWork(tx, execution, outcome, shard);
      assert.equal(settled, true);
      assert.ok(next, `${outcome.kind}: the newer plan still has a message to send`);
      const resumed = await startWork(tx, next, shard);
      assert.equal(typeof resumed, "object", `${outcome.kind}: the newer plan runs`);
      assert.equal(resumed.needsReconcile, outcome.kind === "uncertain",
        "an unknown outcome is carried to the next execution as evidence");
      if (outcome.kind === "uncertain") assert.equal((await row(sql, identity)).unknown_outcomes, 1);
    }
  });
});

integration("unsettled evidence survives cancel, done and recreate until it is reconciled", async () => {
  await protocol(async ({ tx, sql }) => {
    const identity = id("evidence");
    const dispatch = await scheduleWork(tx, identity, { op: "set", at: past() });
    await startWork(tx, dispatch, { ...shard, leaseMs: 1 });
    await sleep(20);
    await reconcileExpiredWork(tx, { limit: 10, retryAfterMs: 0,
      effects: { safe: [], reconcile: ["gmail.route"], at_most_once: [] } });
    await scheduleWork(tx, identity, { op: "cancel" });
    const kept = await row(sql, identity);
    assert.deepEqual([kept.state, kept.cancelled, kept.needs_reconcile, kept.unknown_outcomes],
      ["parked", true, true, 1], "cancel does not delete an unknown outcome");
    const recreated = await scheduleWork(tx, identity, { op: "set", at: past() });
    assert.equal(recreated.incarnation, dispatch.incarnation, "the evidence keeps its identity");
    const execution = await startWork(tx, recreated, shard);
    assert.equal(execution.needsReconcile, true);
    await finishWork(tx, execution, { kind: "done" }, shard);
    assert.equal((await row(sql, identity)).state, "parked", "done without reconciling keeps the evidence");
    const again = await scheduleWork(tx, identity, { op: "set", at: past() });
    const reconciling = await startWork(tx, again, shard);
    await finishWork(tx, reconciling, { kind: "done", reconciled: true }, shard);
    assert.equal(await row(sql, identity), undefined, "only a reconciled outcome lets the intent go");
  });
});

integration("a Space intent without placement evidence fails closed", async () => {
  await protocol(async ({ tx }) => {
    await assert.rejects(scheduleWork(tx, id("x", "space:missing"), { op: "set", at: past() }), /placement epoch/u);
    await assert.rejects(scheduleWork(tx, id("x", "system:gmail"), { op: "set", at: past() }, 1), /placement epoch/u);
    const unplaced = await scheduleWork(tx, id("x", "space:missing"), { op: "set", at: past() }, 1);
    assert.equal(await startWork(tx, unplaced, shard), "stale", "no placement row means no start");
  });
});

integration("a finish that waits for the row lock past its lease settles nothing", async () => {
  await protocol(async ({ tx, connect, sql, rewrite }) => {
    const dispatch = await scheduleWork(tx, id("lock-wait"), { op: "set", at: past() });
    const execution = await startWork(tx, dispatch, { ...shard, leaseMs: 300 });
    const { lease_until: leaseUntil } = await row(sql, id("lock-wait"));
    const blocker = await connect();
    await blocker.raw.query("BEGIN");
    await blocker.raw.query(rewrite("SELECT 1 FROM data.work_intents FOR UPDATE"));
    const finishing = finishWork(await connect(), execution, { kind: "done" }, shard);
    await sleep(Math.max(0, leaseUntil.getTime() - Date.now() + 100));
    await blocker.raw.query("COMMIT");
    assert.deepEqual(await finishing, { settled: false, next: null });
    assert.equal((await row(sql, id("lock-wait"))).state, "started", "the reconciler owns the expired execution");
  });
});

integration("recovery reads only intents whose recovery time has come, however many wait for the future", async () => {
  await protocol(async ({ tx, connect, sql, rewrite }) => {
    await sql(`INSERT INTO data.work_intents(scope,kind,key,incarnation,state,pending_at,planned_at,dispatch_token,
        sent_at,recover_at)
      SELECT 'system:gmail','gmail.route',g::text,gen_random_uuid(),'pending',now()+interval '30 days',
        now()+interval '30 days',gen_random_uuid(),now()-interval '1 day',now()+interval '30 days'
      FROM generate_series(1,100000) g`);
    await scheduleWork(tx, id("due-now"), { op: "set", at: past() });
    await sql("ANALYZE data.work_intents");
    const explaining = await connect();
    let plan;
    await explaining.raw.query("BEGIN");
    await reconcileUnsentWork({ async query({ text, values }) {
      plan = (await explaining.raw.query(`EXPLAIN (ANALYZE, FORMAT JSON) ${rewrite(text)}`, values)).rows[0]["QUERY PLAN"];
      return [];
    } }, { cooldownMs: 60_000, limit: 10 });
    await explaining.raw.query("ROLLBACK");
    const nodes = [];
    const walk = node => { nodes.push(node); for (const child of node.Plans ?? []) walk(child); };
    walk(plan[0].Plan);
    const scans = nodes.filter(node => node["Relation Name"]?.endsWith("work_intents") && node["Index Name"]);
    assert.ok(scans.some(node => node["Index Name"] === "work_intents_recovery"), JSON.stringify(nodes.map(n => n["Node Type"])));
    const examined = nodes.reduce((sum, node) => sum + (node["Rows Removed by Filter"] ?? 0), 0);
    assert.ok(examined <= 10, `the recovery scan filtered ${examined} future rows`);
  });
});
