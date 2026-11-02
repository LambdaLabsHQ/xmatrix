import { connectionString as url, integration, postgresConnections } from "./postgres-database.fixture.mjs";
import assert from "node:assert/strict";
import { registrationQuotaSchema } from "./registration-quota.fixture.mjs";
import { registrationQuotaProbeTargets } from "../dist/agent-registration-quota-probe.js";
import { observeRegistrationQuota } from "../dist/registration-quota-state.js";
import { owedRegistrationQuotaWaitOwners, readyRegistrationQuotaWaits, settleRegistrationQuotaWaits,
  waitedRegistrationsOnMachine, waitForRegistrationQuota } from "../dist/registration-quota-waiters.js";

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
    const reading = (observedAt, percent) => ({ quotaSource: "provider_api", quotaObservedAt: observedAt,
      quotaUsages: [{ label: "5h", percent, resetAt }] });
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
    assert.equal(await observeRegistrationQuota(database, codex, reading(at(-40_000), 20), "reset"), true,
      "the reading that clears the pool readies the wait in its own transaction");
    const [first] = await ready();
    assert.equal(first.channelId, "a");
    assert.match(first.readyToken, /^[0-9a-f-]{36}$/u);

    // A newer refusal re-arms the wait between its read and its settlement: the old delivery settles nothing.
    assert.equal(await observeRegistrationQuota(database, codex, reading(at(-30_000), 100), "used-up-again"), false);
    assert.equal(await wait("a", at(-30_000)), false);
    await settleRegistrationQuotaWaits(database, { waits: [first], requestId: "stale-settle" });
    assert.equal((await sql(`SELECT count(*) FROM control.registration_quota_waiters WHERE channel_id='a'`)).rows[0].count,
      "1", "a re-armed wait outlives the delivery that read it before");
    assert.deepEqual(await waitedRegistrationsOnMachine(database, { ownerUserId: "owner", machineId: "m1",
      requestId: "waited" }), [codex], "a reconnecting machine reads again what is waited on");

    // A reading that landed between a refusal and its wait readies the wait as it is recorded.
    assert.equal(await observeRegistrationQuota(database, codex, reading(at(-20_000), 30), "cleared-again"), true);
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
