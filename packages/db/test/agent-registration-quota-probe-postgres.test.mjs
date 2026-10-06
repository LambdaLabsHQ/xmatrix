import { connectionString as url, integration, postgresConnections } from "./postgres-database.fixture.mjs";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Client } from "pg";
import { readRegistrationQuotaProbeTargets, recordRegistrationQuotaProbeResult, recordRegistrationUsageLimit,
  REGISTRATION_QUOTA_POOL_SQL } from "../dist/agent-registration-quota-probe.js";

import { observeRegistrationQuota, readRegistrationQuotaState, registrationQuotaKey } from "../dist/registration-quota-state.js";

integration("registration quota probe targets are the Space's authorized, singly-hosted registrations", async () => {
  assert.ok(url);
  const schema = `registration_quota_probe_${process.pid}`;
  const setup = new Client({ connectionString: url }); await setup.connect();
  const rewrite = text => text.replaceAll("data.", `${schema}.`).replaceAll("control.", `${schema}.`);
  const sql = (text, values) => setup.query(rewrite(text), values);
  try {
    await setup.query(`CREATE SCHEMA ${schema}`);
    for (const file of ["0059_expand_agent_registration_keys.sql", "0060_expand_registration_access.sql",
      "0063_expand_registration_authority.sql", "0065_expand_registration_environment.sql",
      "0071_expand_registration_quota_observations.sql", "0119_expand_registration_quota_windows.sql", "0158_expand_registration_quota_account.sql"]) {
      await sql(await readFile(new URL(`../migrations/${file}`, import.meta.url), "utf8"));
    }
    await sql(`CREATE TABLE data.space_members (space_id text,user_id text,role text);
      CREATE TABLE data.machine_daemons (daemon_id text,owner_user_id text,machine_id text,hostname text,status text,
        capabilities_json jsonb,connection_epoch bigint);
      CREATE TABLE data.machine_daemon_commands (command_id text,owner_user_id text,machine_id text,hostname text,
        command_type text,created_at timestamptz)`);
    const probe = '["machine_quota_probe_v2"]';
    // owner/m1: grok (default pool), claude (declared pool), codex (revoked grant), kimi (paused policy).
    // owner/m2: two online hosts. owner/m3: daemon without the probe capability. owner/m4: offline.
    // outsider/m5: registration in the Space but not a member.
    const registrations = [["owner", "m1", "grok"], ["owner", "m1", "claude"], ["owner", "m1", "codex"], ["owner", "m1", "kimi"],
      ["owner", "m2", "grok"], ["owner", "m3", "grok"], ["owner", "m4", "grok"], ["outsider", "m5", "grok"]];
    await sql(`INSERT INTO data.space_members VALUES ('space','owner','owner'),('other-space','outsider','owner');
      INSERT INTO data.agent_registration_authority VALUES ('space','composite',repeat('a',64),1,now()),
        ('legacy-space','prepared',repeat('a',64),1,now())`);
    await sql(`INSERT INTO data.machine_daemons VALUES ('d1','owner','m1','h1','online',$1,7),
        ('d2a','owner','m2','h2a','online',$1,1),('d2b','owner','m2','h2b','online',$1,1),
        ('d3','owner','m3','h3','online','[]',1),('d4','owner','m4','h4','offline',$1,1),('d5','outsider','m5','h5','online',$1,1)`,
      [probe]);
    for (const [owner, machine, harness] of registrations) {
      await sql(`INSERT INTO data.agent_registrations VALUES ($1,$2,$3,1,now(),now())`, [owner, machine, harness]);
      await sql(`INSERT INTO data.space_agent_registrations VALUES ('space',$1,$2,$3,'Agent','{}',1,now(),now())`, [owner, machine, harness]);
      await sql(`INSERT INTO control.machine_execution_capacity VALUES ($1,$2,4,1,now()) ON CONFLICT DO NOTHING`, [owner, machine]);
      await sql(`INSERT INTO control.agent_registration_environments VALUES ($1,$2,$3,$4::jsonb,1,now())`,
        [owner, machine, harness, JSON.stringify(harness === "claude" ? { enabled: true, quotaPoolId: "shared-claude" }
          : { enabled: harness !== "kimi" })]);
      await sql(`INSERT INTO data.space_agent_registration_access VALUES ('space',$1,$2,$3,$4,1,'{}',$5,1,'{}',now())`,
        [owner, machine, harness, harness === "codex" ? "revoked" : "active", "enabled"]);
    }
    const database = postgresConnections(undefined, { rewrite });
    const read = spaceId => readRegistrationQuotaProbeTargets({ database, directory: database, requestId: "probe",
      placement: { spaceId, shardId: "test", placementEpoch: 1 } });

    const targets = await read("space");
    await sql("UPDATE data.machine_daemons SET hostname='renamed' WHERE machine_id='m1'");
    assert.deepEqual((await read("space")).map(target => target.configurationDigest),
      targets.map(target => target.configurationDigest), "hostname never changes the registration configuration digest");
    await sql("UPDATE data.machine_daemons SET hostname='h1' WHERE machine_id='m1'");
    assert.deepEqual(targets.map(({ configurationDigest: _configurationDigest, ...target }) => target), [
      { ownerUserId: "owner", machineId: "m1", hostId: "h1", harness: "claude", connectionEpoch: 7,
        quotaPoolId: "shared-claude", targetId: "registration:claude" },
      { ownerUserId: "owner", machineId: "m1", hostId: "h1", harness: "grok", connectionEpoch: 7,
        quotaPoolId: "registration:m1:grok", targetId: "registration:grok" },
    ], "revoked, owner-disabled, non-member, ambiguous, incapable and offline registrations are not probed");
    for (const target of targets) assert.match(target.configurationDigest, /^[a-f0-9]{64}$/u);
    assert.deepEqual(await read("legacy-space"), [], "a Space not on composite authority has no registration targets");

    // The daemon's completed probe writes each reading to the pool its target was issued for.
    const issued = { requestId: "probe-1", connectionEpoch: 7, windowLabels: true,
      targets: targets.map(({ targetId, configurationDigest }) => ({ targetId, configurationDigest })) };
    const resetAt = new Date(Date.now() + 3_600_000).toISOString();
    const recorded = await database.transaction({}, tx => recordRegistrationQuotaProbeResult(tx, { ownerUserId: "owner",
      machineId: "m1", hostId: "h1", issued, now: Date.now(), result: { requestId: "probe-1", connectionEpoch: 7,
        results: issued.targets.map(target => ({ ...target, status: "observed", quotaSource: "provider_api",
          quotaObservedAt: new Date(Date.now() - 1000).toISOString(),
          quotaUsages: [{ percent: target.targetId === "registration:claude" ? 100 : 40, resetAt, label: "5h" }] })) } }));
    assert.equal(recorded, 2);
    const facts = await sql(`SELECT quota_pool_id,remaining,windows_json FROM control.registration_quota_observations
      WHERE owner_user_id='owner' ORDER BY quota_pool_id`);
    assert.deepEqual(facts.rows.map(row => [row.quota_pool_id, Number(row.remaining)]),
      [["registration:m1:grok", 60], ["shared-claude", 0]]);
    assert.deepEqual(facts.rows[0].windows_json, [{ label: "5h", usedPercent: 40, resetAt }],
      "the windows behind the reading are kept for the Agents page");

    // Instance readings feed the same pool. Magnitude never chooses the winner.
    const key = { ownerUserId: "owner", machineId: "m1", harness: "claude" };
    const sample = (ago, percent) => ({ quotaSource: "provider_api",
      quotaObservedAt: new Date(Date.now() - ago).toISOString(),
      quotaUsages: [{ label: "5h", percent, resetAt }] });
    const fresh = sample(100, 12);
    await observeRegistrationQuota(database, key, fresh, "fresh-instance");
    await observeRegistrationQuota(database, key, sample(5000, 99), "late-instance");
    const state = (await readRegistrationQuotaState(database, [key,
      { ...key, ownerUserId: "outsider" }, { ...key, machineId: "m2" }, { ...key, harness: "grok" }], "shared-read"));
    assert.equal(state.get(registrationQuotaKey(key)).quotaUsages[0].percent, 12);
    assert.equal(state.get(registrationQuotaKey(key)).quotaObservedAt, fresh.quotaObservedAt);
    assert.equal(state.get(registrationQuotaKey({ ...key, ownerUserId: "outsider" })), undefined);
    assert.equal(state.get(registrationQuotaKey({ ...key, machineId: "m2" })), undefined);
    assert.equal(state.get(registrationQuotaKey({ ...key, harness: "grok" })).quotaUsages[0].percent, 40);
    await observeRegistrationQuota(database, key, { ...sample(-60_000, 1) }, "future");
    await observeRegistrationQuota(database, key, { quotaUsages: [{ percent: 100 }] }, "untrusted");
    assert.equal((await readRegistrationQuotaState(database, [key], "still-fresh")).get(registrationQuotaKey(key)).quotaUsages[0].percent, 12);
    // A late daemon response cannot overwrite the newer Instance reading either.
    await database.transaction({}, tx => recordRegistrationQuotaProbeResult(tx, { ownerUserId: "owner",
      machineId: "m1", hostId: "h1", issued, now: Date.now(), result: { requestId: "probe-1", connectionEpoch: 7,
        results: issued.targets.map(target => ({ ...target, status: "observed", quotaSource: "provider_api",
          quotaObservedAt: new Date(Date.now() - 5000).toISOString(), quotaUsages: [{ percent: 100, resetAt, label: "5h" }] })) } }));
    assert.equal((await readRegistrationQuotaState(database, [key], "after-late-probe")).get(registrationQuotaKey(key)).quotaUsages[0].percent, 12);

    // A used-up window the provider still serves on credits stays routable, and its verdict reaches readers.
    const credits = { allowed: true, credits: { balance: 137.5 } };
    await observeRegistrationQuota(database, key, { ...sample(10, 100), quotaAccount: credits }, "on-credits");
    const served = (await readRegistrationQuotaState(database, [key], "on-credits-read")).get(registrationQuotaKey(key));
    assert.deepEqual(served.quotaAccount, credits);
    assert.equal(served.quotaState, "observed");
    assert.equal(Number((await sql(`SELECT remaining FROM control.registration_quota_observations
      WHERE owner_user_id='owner' AND quota_pool_id='shared-claude'`)).rows[0].remaining), 1);

    const newestAt = new Date(Date.now() - 5).toISOString();
    await database.transaction({}, tx => recordRegistrationQuotaProbeResult(tx, { ownerUserId: "owner",
      machineId: "m1", hostId: "h1", issued, now: Date.now(), result: { requestId: "probe-1", connectionEpoch: 7,
        results: issued.targets.map(target => ({ ...target, status: "observed", quotaSource: "provider_api",
          quotaObservedAt: newestAt, quotaUsages: [{ percent: 7, resetAt, label: "5h" }] })) } }));
    await observeRegistrationQuota(database, key, sample(5000, 99), "instance-after-new-probe");
    assert.equal((await readRegistrationQuotaState(database, [key], "new-probe-wins")).get(registrationQuotaKey(key)).quotaUsages[0].percent, 7);
    await sql(`INSERT INTO data.agent_registrations VALUES ('owner','shared-machine','claude',1,now(),now());
      INSERT INTO control.machine_execution_capacity VALUES ('owner','shared-machine',4,1,now());
      INSERT INTO control.agent_registration_environments VALUES ('owner','shared-machine','claude',
      '{"enabled":true,"quotaPoolId":"shared-claude"}',1,now())`);
    const shared = { ...key, machineId: "shared-machine" };
    const both = await readRegistrationQuotaState(database, [key, shared], "explicit-shared-pool");
    assert.deepEqual(both.get(registrationQuotaKey(key)), both.get(registrationQuotaKey(shared)));
    await sql(`UPDATE control.registration_quota_observations SET expires_at=now()-interval '1 second',
      observed_at=now()-interval '2 seconds' WHERE quota_pool_id='shared-claude'`);
    const expired = (await readRegistrationQuotaState(database, [key], "expired")).get(registrationQuotaKey(key));
    assert.equal(expired.quotaState, "unknown");
    assert.equal(expired.quotaUsages, undefined);
    assert.ok(expired.quotaObservedAt, "withdrawal keeps the last observation version for delayed frame ordering");

    // Agents page readers share one probe per daemon a minute.
    await sql(`INSERT INTO data.machine_daemon_commands VALUES ('c1','owner','m1','h1','quota_probe',now()-interval '10 seconds')`);
    const throttled = spaceId => readRegistrationQuotaProbeTargets({ database, directory: database, requestId: "probe",
      placement: { spaceId, shardId: "test", placementEpoch: 1 }, probedWithinMs: 60_000 });
    assert.deepEqual(await throttled("space"), [], "a daemon probed within the minute is not asked again");
    assert.equal((await read("space")).length, 2, "a routing refresh is not throttled");
    await sql(`UPDATE data.machine_daemon_commands SET created_at=now()-interval '2 minutes'`);
    assert.equal((await throttled("space")).length, 2);
    await sql(`DELETE FROM data.machine_daemon_commands`);
    await sql(`DELETE FROM control.registration_quota_observations`);

    // The digest follows the environment version, independently of hostname.
    const grokDigest = targets.find(target => target.harness === "grok").configurationDigest;
    await sql(`UPDATE control.agent_registration_environments SET version=2 WHERE machine_id='m1' AND harness='grok'`);
    const bumped = (await read("space")).find(target => target.harness === "grok");
    assert.notEqual(bumped.configurationDigest, grokDigest);
    await sql(`INSERT INTO data.machine_daemons VALUES ('d1b','owner','m1','h1b','online',$1,1)`, [probe]);
    assert.deepEqual(await read("space"), [], "a second online host makes the machine's login ambiguous");

    // The launch chooser reads observations with the same default pool expression.
    await sql(`INSERT INTO control.registration_quota_observations (owner_user_id,quota_pool_id,remaining,observed_at,expires_at,source)
      VALUES ('owner','registration:m1:grok',0,now()-interval '1 second',now()+interval '1 minute','provider'),
        ('outsider','registration:m1:grok',100,now()-interval '1 second',now()+interval '1 minute','provider')`);
    const joined = await sql(`SELECT e.harness,q.remaining FROM control.agent_registration_environments e
      LEFT JOIN control.registration_quota_observations q ON q.owner_user_id=e.owner_user_id
        AND q.quota_pool_id=${REGISTRATION_QUOTA_POOL_SQL}
        AND q.observed_at<=statement_timestamp() AND q.expires_at>statement_timestamp()
      WHERE e.owner_user_id='owner' AND e.machine_id='m1' AND e.harness IN ('grok','claude') ORDER BY e.harness`);
    assert.deepEqual(joined.rows.map(row => [row.harness, row.remaining === null ? null : Number(row.remaining)]),
      [["claude", null], ["grok", 0]], "the owner's exhausted Grok reading is read; another owner's is not");

    // A live Instance's usage limit holds its pool empty until the reported reset, within bounds.
    await sql(`DELETE FROM control.registration_quota_observations`);
    const limit = input => database.transaction({}, tx => recordRegistrationUsageLimit(tx, { ownerUserId: "owner",
      machineId: "m1", ...input }));
    const hours = value => Date.now() + value * 3_600_000;
    const near = (at, expected) => Math.abs(Date.parse(at) - expected) < 120_000;
    const reported = await limit({ harness: "claude", resetsAt: new Date(hours(2)).toISOString() });
    assert.equal(reported.quotaPoolId, "shared-claude", "a declared shared pool is the one held");
    assert.ok(near(reported.limitedUntil, hours(2)));
    const held = await sql(`SELECT remaining,source,windows_json FROM control.registration_quota_observations
      WHERE owner_user_id='owner' AND quota_pool_id='shared-claude'`);
    assert.deepEqual(held.rows.map(row => [Number(row.remaining), row.source, row.windows_json]), [[0, "daemon", null]]);
    const heldProjection = (await readRegistrationQuotaState(database, [key, shared], "held-projection"));
    assert.equal(heldProjection.get(registrationQuotaKey(key)).quotaState, "exhausted");
    assert.deepEqual(heldProjection.get(registrationQuotaKey(key)), heldProjection.get(registrationQuotaKey(shared)));
    assert.equal(heldProjection.get(registrationQuotaKey(key)).quotaUsages[0].label, undefined, "a hold does not invent a provider window");
    assert.ok(near((await limit({ harness: "grok" })).limitedUntil, hours(1)), "no reset time holds for an hour");
    assert.ok(near((await limit({ harness: "grok", resetsAt: new Date(hours(-1)).toISOString() })).limitedUntil, hours(1 / 12)),
      "a reset already past still holds for five minutes");
    assert.ok(near((await limit({ harness: "grok", resetsAt: new Date(hours(24 * 30)).toISOString() })).limitedUntil, hours(24 * 7)),
      "a far reset is held for at most a week");
    assert.ok(near((await limit({ harness: "grok", resetsAt: "not a time" })).limitedUntil, hours(1)));
    assert.equal(await limit({ harness: "unregistered" }), undefined, "no environment, no reading");
  } finally {
    await setup.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await setup.end();
  }
});
