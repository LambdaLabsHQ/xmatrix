import { connectionString as url, integration, postgresConnections } from "./postgres-database.fixture.mjs";
import assert from "node:assert/strict";
import { registrationQuotaSchema } from "./registration-quota.fixture.mjs";
import { registrationQuotaProbeTargets } from "../dist/agent-registration-quota-probe.js";
import { observeRegistrationQuota } from "../dist/registration-quota-state.js";
import { owedRegistrationQuotaWaitOwners, readyRegistrationQuotaWaits, reconcileOwedRegistrationQuotaPools,
  settleRegistrationQuotaWaits, waitedRegistrationsOnMachine, waitForRegistrationQuota } from "../dist/registration-quota-waiters.js";

integration("a refused summon's quota wait is made ready by the reading that clears it, and only by a newer one", async () => {
  assert.ok(url);
  const { sql, rewrite, close } = await registrationQuotaSchema("registration_quota_waiters");
  try {
    await sql(`INSERT INTO data.machine_daemons VALUES ('d1','owner','m1','h1','online','["machine_quota_probe_v2"]',3)`);
    for (const harness of ["codex", "grok"]) {
      await sql(`INSERT INTO data.agent_registrations VALUES ('owner','m1',$1,1,now(),now())`, [harness]);
      await sql(`INSERT INTO control.machine_execution_capacity VALUES ('owner','m1',4,1,now()) ON CONFLICT DO NOTHING`);
      await sql(`INSERT INTO control.agent_registration_environments VALUES ('owner','m1',$1,'{"enabled":true}',1,now())`,
        [harness]);
    }
    const database = postgresConnections(undefined, { rewrite });
    const codex = { ownerUserId: "owner", machineId: "m1", harness: "codex" };
    const at = offset => new Date(Date.now() + offset).toISOString();
    const resetAt = at(3_600_000);
    // Each reset starts another window: within one, a share read used up stays so.
    const reading = (observedAt, percent, reset = resetAt) => ({ quotaSource: "provider_api", quotaObservedAt: observedAt,
      quotaUsages: [{ label: "5h", percent, resetAt: reset }] });
    const expiresAt = at(86_400_000);
    const wait = (channelId, refusedThrough) => waitForRegistrationQuota(database, { channelId, registrations: [codex],
      refusedThrough, expiresAt, requestId: `wait-${channelId}` });
    const ready = () => readyRegistrationQuotaWaits(database, { ownerUserId: "owner", requestId: "ready" });

    // The summon was refused by a used-up reading; it waits for a newer one with headroom.
    const refusing = at(-60_000);
    assert.equal(await observeRegistrationQuota(database, codex, reading(refusing, 100), "refusing"), false);
    assert.equal(await wait("a", refusing), false, "the refusing reading itself is no news");
    assert.equal(await observeRegistrationQuota(database, codex, reading(at(-50_000), 100), "still-used-up"), false,
      "a newer reading that is still used up ends nothing");
    assert.deepEqual(await ready(), []);
    assert.equal(await observeRegistrationQuota(database, codex, reading(at(-40_000), 20, at(2 * 3_600_000)), "reset"), true,
      "the reading that clears the pool readies the wait in its own transaction");
    const [first] = await ready();
    assert.equal(first.channelId, "a");
    assert.match(first.readyToken, /^[0-9a-f-]{36}$/u);

    // A newer refusal re-arms the wait between its read and its settlement: the old delivery settles nothing.
    assert.equal(await observeRegistrationQuota(database, codex, reading(at(-30_000), 100, at(3 * 3_600_000)), "used-up-again"), false);
    assert.equal(await wait("a", at(-30_000)), false);
    await settleRegistrationQuotaWaits(database, { waits: [first], requestId: "stale-settle" });
    assert.equal((await sql(`SELECT count(*) FROM control.registration_quota_waiters WHERE channel_id='a'`)).rows[0].count,
      "1", "a re-armed wait outlives the delivery that read it before");
    assert.deepEqual(await waitedRegistrationsOnMachine(database, { ownerUserId: "owner", machineId: "m1",
      requestId: "waited" }), [codex], "a reconnecting machine reads again what is waited on");

    // A reading that landed between a refusal and its wait readies the wait as it is recorded.
    assert.equal(await observeRegistrationQuota(database, codex, reading(at(-20_000), 30, at(4 * 3_600_000)), "cleared-again"), true);
    assert.equal(await wait("b", at(-25_000)), true, "the wait sees the newer reading already in");
    const both = await ready();
    assert.deepEqual(both.map(wait => wait.channelId).sort(), ["a", "b"]);
    assert.notEqual(both.find(wait => wait.channelId === "a").readyToken, first.readyToken,
      "becoming ready again is a new version");

    // Delivery that missed its moment is owed; settling by token finishes it.
    assert.deepEqual(await owedRegistrationQuotaWaitOwners(database, { olderThanMs: 30_000, limit: 10, requestId: "owed" }), []);
    await sql(`UPDATE control.registration_quota_waiters SET ready_at=now()-interval '31 seconds'`);
    assert.deepEqual(await owedRegistrationQuotaWaitOwners(database, { olderThanMs: 30_000, limit: 10, requestId: "owed" }),
      ["owner"]);
    await settleRegistrationQuotaWaits(database, { waits: both, requestId: "settle" });
    assert.deepEqual(await ready(), []);
    assert.equal((await sql(`SELECT count(*) FROM control.registration_quota_waiters`)).rows[0].count, "0");

    // A summon's ordinary refresh reads only quota no current reading covers.
    const unread = await registrationQuotaProbeTargets(database, { requestId: "unread", onlyUnread: true,
      registrations: [codex, { ...codex, harness: "grok" }] });
    assert.deepEqual(unread.map(target => target.harness), ["grok"]);
  } finally { await close(); }
});

const at = offset => new Date(Date.now() + offset).toISOString();
const quotaReading = (observedAt, percent, resetAt) => ({
  quotaSource: "provider_api",
  quotaObservedAt: observedAt,
  quotaUsages: [{ label: "5h", percent, resetAt }],
});

async function seedHarnesses(sql, harnesses) {
  await sql(`INSERT INTO control.machine_execution_capacity VALUES ('owner','m1',4,1,now()) ON CONFLICT DO NOTHING`);
  for (const harness of harnesses) {
    await sql(`INSERT INTO data.agent_registrations VALUES ('owner','m1',$1,1,now(),now())`, [harness]);
    await sql(`INSERT INTO control.agent_registration_environments VALUES ('owner','m1',$1,'{"enabled":true}',1,now())`, [harness]);
  }
}

function withQueryBarrier(database, matchName, onHit) {
  return {
    ...database,
    transaction(context, fn) {
      return database.transaction(context, tx => fn({
        ...tx,
        async query(query) {
          const rows = await tx.query(query);
          if (query.name === matchName) await onHit();
          return rows;
        },
      }));
    },
  };
}

integration("concurrent wait registration and observation serialize per pool across both interleavings and missing observation rows", async () => {
  assert.ok(url);
  const { sql, rewrite, close } = await registrationQuotaSchema("registration_quota_waiters_race");
  try {
    await seedHarnesses(sql, ["codex", "zai"]);
    const db1 = postgresConnections(undefined, { rewrite });
    const db2 = postgresConnections(undefined, { rewrite });
    const codex = { ownerUserId: "owner", machineId: "m1", harness: "codex" };
    const zai = { ownerUserId: "owner", machineId: "m1", harness: "zai" };
    const expiresAt = at(86_400_000);

    // Interleaving A: wait starts first on an exhausted pool, pauses before commit; observation runs concurrently.
    const t0 = at(-60_000);
    await observeRegistrationQuota(db1, codex, quotaReading(t0, 100, at(3_600_000)), "seed-exhausted");
    let releaseWait;
    const waitPaused = new Promise(resolve => { releaseWait = resolve; });
    let waitHit;
    const waitReached = new Promise(resolve => { waitHit = resolve; });
    const waitPromise = waitForRegistrationQuota(
      withQueryBarrier(db1, "registration_quota_wait_v2", async () => { waitHit(); await waitPaused; }),
      { channelId: "race-a", registrations: [codex], refusedThrough: t0, expiresAt, requestId: "race-wait-a" },
    );
    await waitReached;
    const obsPromise = observeRegistrationQuota(db2, codex, quotaReading(at(-30_000), 20, at(2 * 3_600_000)), "race-obs-a");
    await new Promise(resolve => setTimeout(resolve, 60));
    releaseWait();
    const [waitReady, obsReady] = await Promise.all([waitPromise, obsPromise]);
    assert.equal(waitReady || obsReady, true, "at least one committing side records readiness");
    const readyA = await readyRegistrationQuotaWaits(db1, { ownerUserId: "owner", requestId: "read-race-a" });
    assert.deepEqual(readyA.map(wait => wait.channelId), ["race-a"]);
    await settleRegistrationQuotaWaits(db1, { waits: readyA, requestId: "settle-race-a" });

    // Interleaving B with missing observation row: observation inserts first and pauses; wait runs concurrently.
    let releaseObs;
    const obsPaused = new Promise(resolve => { releaseObs = resolve; });
    let obsHit;
    const obsReached = new Promise(resolve => { obsHit = resolve; });
    const obsPromiseB = observeRegistrationQuota(
      withQueryBarrier(db1, "registration_quota_observe_insert_v1", async () => { obsHit(); await obsPaused; }),
      zai,
      quotaReading(at(-20_000), 25, at(3 * 3_600_000)),
      "race-obs-b",
    );
    await obsReached;
    const waitPromiseB = waitForRegistrationQuota(db2, {
      channelId: "race-b", registrations: [zai], refusedThrough: at(-40_000), expiresAt, requestId: "race-wait-b",
    });
    await new Promise(resolve => setTimeout(resolve, 60));
    releaseObs();
    const [obsReadyB, waitReadyB] = await Promise.all([obsPromiseB, waitPromiseB]);
    assert.equal(obsReadyB || waitReadyB, true, "missing observation row still serializes and readies the wait");
    const readyB = await readyRegistrationQuotaWaits(db1, { ownerUserId: "owner", requestId: "read-race-b" });
    assert.deepEqual(readyB.map(wait => wait.channelId), ["race-b"]);
  } finally { await close(); }
});

async function registerWaitRange(db, prefix, start, end, registration, refusedThrough, expiresAt) {
  for (let i = start; i <= end; i++) {
    await waitForRegistrationQuota(db, {
      channelId: `${prefix}-${String(i).padStart(3, "0")}`,
      registrations: [registration],
      refusedThrough,
      expiresAt,
      requestId: `w-${prefix}-${i}`,
    });
  }
}

integration("exhausted prefix never starves sibling pools, 135+ waits drain across resumable pages, and exhausted replacement or legacy rows reconcile safely", async () => {
  assert.ok(url);
  const { sql, rewrite, close } = await registrationQuotaSchema("registration_quota_waiters_scale");
  try {
    await seedHarnesses(sql, ["codex", "zai", "legacy"]);
    const db = postgresConnections(undefined, { rewrite });
    const codex = { ownerUserId: "owner", machineId: "m1", harness: "codex" };
    const zai = { ownerUserId: "owner", machineId: "m1", harness: "zai" };
    const t0 = at(-120_000);
    const expiresAt = at(86_400_000);

    // 1. 128 waits on exhausted codex + 1 wait on zai -> zai readies on its very first open reading.
    await observeRegistrationQuota(db, codex, quotaReading(t0, 100, at(3_600_000)), "codex-0");
    await observeRegistrationQuota(db, zai, quotaReading(t0, 100, at(3_600_000)), "zai-0");
    await registerWaitRange(db, "codex", 1, 128, codex, t0, expiresAt);
    await waitForRegistrationQuota(db, { channelId: "zai-001", registrations: [zai], refusedThrough: t0, expiresAt, requestId: "w-z-1" });
    assert.equal(await observeRegistrationQuota(db, zai, quotaReading(at(-90_000), 20, at(2 * 3_600_000)), "zai-open"), true);
    const readyZai = await readyRegistrationQuotaWaits(db, { ownerUserId: "owner", requestId: "ready-zai" });
    assert.deepEqual(readyZai.map(wait => wait.channelId), ["zai-001"]);
    await settleRegistrationQuotaWaits(db, { waits: readyZai, requestId: "settle-zai" });

    // 2. 135 waits on codex: observation readies first 128 and persists durable cursor; DB-only reconcile drains remaining 7.
    await registerWaitRange(db, "codex", 129, 135, codex, t0, expiresAt);
    assert.equal(await observeRegistrationQuota(db, codex, quotaReading(at(-80_000), 25, at(3 * 3_600_000)), "codex-open"), true);
    const afterPage1 = await sql(`SELECT count(*) FILTER (WHERE ready_at IS NOT NULL) AS ready_count,
      count(*) FILTER (WHERE ready_at IS NULL) AS pending_count FROM control.registration_quota_waiters
      WHERE quota_pool_id='registration:m1:codex'`);
    assert.equal(Number(afterPage1.rows[0].ready_count), 128);
    assert.equal(Number(afterPage1.rows[0].pending_count), 7);
    assert.deepEqual(await owedRegistrationQuotaWaitOwners(db, { olderThanMs: 60_000, limit: 10, requestId: "owed-cursor" }), ["owner"],
      "unacknowledged pool reconciliation keeps owner owed for DB-only recovery");

    // Delete one unready channel mid-cursor (cancellation/deletion) before resuming.
    await sql(`DELETE FROM control.registration_quota_waiters WHERE channel_id='codex-130'`);
    const resumed = await reconcileOwedRegistrationQuotaPools(db, { ownerUserId: "owner", requestId: "resume-codex" });
    assert.deepEqual(resumed, { readied: 6, more: false });
    const ledger = await sql(`SELECT reconcile_needed_revision,reconciled_revision,reconcile_cursor_channel_id
      FROM control.registration_quota_pool_reconciliations WHERE quota_pool_id='registration:m1:codex'`);
    assert.equal(ledger.rows[0].reconciled_revision, ledger.rows[0].reconcile_needed_revision);
    assert.equal(ledger.rows[0].reconcile_cursor_channel_id, null);

    // 3. Exhausted replacement observation between pages stops remaining unready waits from becoming ready.
    await sql(`DELETE FROM control.registration_quota_waiters`);
    const t1 = at(-70_000);
    await observeRegistrationQuota(db, codex, quotaReading(t1, 100, at(4 * 3_600_000)), "codex-exhaust-2");
    await registerWaitRange(db, "batch", 1, 132, codex, t1, expiresAt);
    await observeRegistrationQuota(db, codex, quotaReading(at(-60_000), 10, at(5 * 3_600_000)), "codex-brief-open");
    await observeRegistrationQuota(db, codex, quotaReading(at(-50_000), 100, at(6 * 3_600_000)), "codex-re-exhausted");
    const afterExhausted = await reconcileOwedRegistrationQuotaPools(db, { ownerUserId: "owner", requestId: "after-exhaust" });
    assert.deepEqual(afterExhausted, { readied: 0, more: false });
    const unreadyAfter = await sql(`SELECT count(*) AS count FROM control.registration_quota_waiters WHERE ready_at IS NULL`);
    assert.equal(Number(unreadyAfter.rows[0].count), 4, "remaining 4 waits are not falsely woken after exhausted replacement");

    // 4. Legacy pre-migration unready row (no reconciliation ledger row) is discovered and repaired DB-only.
    await sql(`DELETE FROM control.registration_quota_waiters`);
    await sql(`INSERT INTO control.registration_quota_observations
      (owner_user_id,quota_pool_id,remaining,observed_at,expires_at,source,windows_json)
      VALUES ('owner','registration:m1:legacy',80,now()-interval '10 seconds',now()+interval '1 hour','provider',NULL)`);
    await sql(`INSERT INTO control.registration_quota_waiters
      (owner_user_id,quota_pool_id,channel_id,refused_through,expires_at)
      VALUES ('owner','registration:m1:legacy','legacy-ch',now()-interval '60 seconds',now()+interval '1 day')`);
    assert.deepEqual(await owedRegistrationQuotaWaitOwners(db, { olderThanMs: 60_000, limit: 10, requestId: "owed-legacy" }), ["owner"]);
    const repaired = await reconcileOwedRegistrationQuotaPools(db, { ownerUserId: "owner", requestId: "repair-legacy" });
    assert.deepEqual(repaired, { readied: 1, more: false });
    const readyLegacy = await readyRegistrationQuotaWaits(db, { ownerUserId: "owner", requestId: "read-legacy" });
    assert.deepEqual(readyLegacy.map(wait => wait.channelId), ["legacy-ch"]);
  } finally { await close(); }
});
