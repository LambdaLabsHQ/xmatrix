import { connectionString as url, integration, postgresConnections } from "./postgres-database.fixture.mjs";
import assert from "node:assert/strict";
import { registrationQuotaSchema } from "./registration-quota.fixture.mjs";
import { readFile } from "node:fs/promises";
import { recordRegistrationQuotaProbeResult, registrationLiveQuota, registrationQuotaAccount, registrationQuotaVerdict,
  registrationQuotaWindows, registrationShownQuotaReading } from "../dist/agent-registration-quota-probe.js";
import { recordHarnessActionInventory } from "../dist/machine-harness-actions.js";

// Cursor's quota is read from its local sign-in only under its owner's grant
// on that machine. When the daemon says there is no grant (never given,
// revoked, or voided by another sign-in), the reading an earlier grant took
// must not outlive it, while a hold Cursor's own refusal caused stays.
integration("a missing sign-in grant drops the last reading and keeps refusal holds", async () => {
  assert.ok(url);
  const { sql, rewrite, close } = await registrationQuotaSchema("registration_quota_access_grant");
  try {
    await sql(`ALTER TABLE data.machine_daemons ADD COLUMN metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb`);
    for (const [machine, harness] of [["m1", "cursor"], ["m2", "cursor"], ["m3", "cursor"], ["m1", "grok"]]) {
      await sql(`INSERT INTO data.agent_registrations VALUES ('owner',$1,$2,1,now(),now())`, [machine, harness]);
      await sql(`INSERT INTO control.machine_execution_capacity VALUES ('owner',$1,4,1,now()) ON CONFLICT DO NOTHING`, [machine]);
      await sql(`INSERT INTO control.agent_registration_environments VALUES ('owner',$1,$2,'{"enabled":true}'::jsonb,1,now())`,
        [machine, harness]);
    }
    const reading = `'[{"label":"1mo","usedPercent":40}]'::jsonb`;
    await sql(`INSERT INTO control.registration_quota_observations
        (owner_user_id,quota_pool_id,remaining,observed_at,expires_at,source,windows_json,account_json,
          scoped_windows_json,scoped_observed_at,scoped_expires_at) VALUES
      ('owner','registration:m1:cursor',60,now()-interval '1 minute',now()+interval '10 minutes','provider',${reading},NULL,
        '[{"scope":"Auto","usedPercent":40}]'::jsonb,now()-interval '1 minute',now()+interval '10 minutes'),
      ('owner','registration:m1:grok',60,now()-interval '1 minute',now()+interval '10 minutes','provider',${reading},NULL,
        NULL,NULL,NULL),
      ('owner','registration:m2:cursor',60,now()-interval '1 minute',now()+interval '10 minutes','provider',${reading},
        '{"billingRefusalScopes":{"API":{"observedAt":"2026-11-24T00:00:00Z","expiresAt":"2027-11-24T00:00:00Z"}}}'::jsonb,
        '[{"scope":"API","usedPercent":100}]'::jsonb,now()-interval '1 minute',now()+interval '10 minutes'),
      ('owner','registration:m3:cursor',0,now()-interval '1 minute',now()+interval '1 hour','daemon',NULL,NULL,
        NULL,NULL,NULL)`);
    const database = postgresConnections(undefined, { rewrite });
    const row = async pool => (await sql(`SELECT source,remaining,windows_json,scoped_windows_json,account_json,
        expires_at>statement_timestamp() AS current FROM control.registration_quota_observations
      WHERE owner_user_id='owner' AND quota_pool_id=$1`, [pool])).rows[0];

    // The probe asked about grants and m1's daemon answers it has none for Cursor.
    const target = { targetId: "registration:cursor", configurationDigest: "c".repeat(64) };
    const issued = { requestId: "probe-1", connectionEpoch: 7, accessGrants: true, targets: [target] };
    await database.transaction({}, tx => recordRegistrationQuotaProbeResult(tx, { ownerUserId: "owner",
      machineId: "m1", hostId: "h1", issued, now: Date.now(),
      result: { requestId: "probe-1", connectionEpoch: 7,
        results: [{ ...target, status: "unavailable", reason: "not_granted" }] } }));
    assert.equal(await row("registration:m1:cursor"), undefined, "the reading taken under the grant is gone");
    assert.ok(await row("registration:m1:grok"), "another harness on that machine keeps its reading");

    // m2's owner revoked from the page: the re-probed item says so.
    await database.transaction({}, tx => recordHarnessActionInventory(tx, { ownerUserId: "owner", machineId: "m2",
      hostId: "h2", at: new Date().toISOString(), result: { presetId: "cursor", action: "quota_access_off",
        status: "succeeded", item: { id: "cursor", installed: true, probeStatus: "ok", version: "1", quotaAccess: "not_granted" } } }));
    const held = await row("registration:m2:cursor");
    assert.equal(held.windows_json, null);
    assert.equal(held.scoped_windows_json, null);
    assert.equal(held.current, false, "no reading counts any more");
    assert.deepEqual(Object.keys(held.account_json), ["billingRefusalScopes"],
      "Cursor's own billing refusal still holds its scope");

    // A usage-limit hold from Cursor's own error is left alone.
    await database.transaction({}, tx => recordHarnessActionInventory(tx, { ownerUserId: "owner", machineId: "m3",
      hostId: "h3", at: new Date().toISOString(), result: { presetId: "cursor", action: "quota_access_off",
        status: "succeeded", item: { id: "cursor", installed: true, probeStatus: "ok", version: "1", quotaAccess: "not_granted" } } }));
    const limited = await row("registration:m3:cursor");
    assert.equal(limited.source, "daemon");
    assert.equal(Number(limited.remaining), 0, "the usage-limit hold stays");
  } finally {
    await close();
  }
});

const QUOTA_COLUMNS = `source,remaining,observed_at,expires_at,windows_json,account_json,scoped_windows_json,
  scoped_observed_at,scoped_expires_at`;

/** How the Agents page is given a pool's reading (agent-registration-control). */
const live = row => registrationLiveQuota(registrationShownQuotaReading(row), registrationQuotaWindows(row),
  registrationQuotaAccount(row));

// An account billing refusal (Cursor's before #1853) is a hold of its own row,
// and later reads under the grant stored their windows beside it. Stopping the
// read leaves the hold and drops those windows, so no number from the sign-in
// is shown again; the hold reads as the provider refusing, not as a window.
integration("a revoked grant drops the windows read beside an account billing hold", async () => {
  assert.ok(url);
  const { sql, rewrite, close } = await registrationQuotaSchema("registration_quota_access_hold");
  try {
    await sql(`ALTER TABLE data.machine_daemons ADD COLUMN metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb`);
    await sql(`INSERT INTO data.agent_registrations VALUES ('owner','m1','cursor',1,now(),now())`);
    await sql(`INSERT INTO control.machine_execution_capacity VALUES ('owner','m1',4,1,now())`);
    await sql(`INSERT INTO control.agent_registration_environments VALUES ('owner','m1','cursor','{"enabled":true}'::jsonb,1,now())`);
    await sql(`INSERT INTO control.registration_quota_observations
        (owner_user_id,quota_pool_id,remaining,observed_at,expires_at,source,windows_json,account_json,
          scoped_windows_json,scoped_observed_at,scoped_expires_at) VALUES
      ('owner','registration:m1:cursor',0,now()-interval '5 days',now()+interval '360 days','daemon',NULL,
        '{"billingRefusal":true}'::jsonb,
        '[{"label":"1mo","scope":"Auto","usedPercent":27,"resetAt":"2099-01-01T00:00:00Z"}]'::jsonb,
        now()-interval '1 minute',now()+interval '14 minutes')`);
    const row = async () => (await sql(`SELECT ${QUOTA_COLUMNS} FROM control.registration_quota_observations
      WHERE owner_user_id='owner' AND quota_pool_id='registration:m1:cursor'`)).rows[0];
    assert.equal(live(await row()).quota.windows?.length, 1, "the Auto window shows while the grant stands");

    const database = postgresConnections(undefined, { rewrite });
    let cleared;
    await database.transaction({}, async tx => {
      cleared = await recordHarnessActionInventory(tx, { ownerUserId: "owner", machineId: "m1", hostId: "h1",
        at: new Date().toISOString(), result: { presetId: "cursor", action: "quota_access_off", status: "succeeded",
          item: { id: "cursor", installed: true, probeStatus: "ok", version: "1", quotaAccess: "not_granted" } } });
    });
    assert.deepEqual(cleared, { quotaCleared: 1 }, "the owner's pages are told the reading changed");
    const held = await row();
    assert.equal(held.source, "daemon");
    assert.equal(Number(held.remaining), 0, "Cursor's own refusal still holds");
    assert.equal(held.scoped_windows_json, null);
    assert.deepEqual(live(held).quota.windows, undefined, "no window read under the grant is shown");
    assert.deepEqual(live(held).quota.account, { allowed: false }, "the hold reads as the provider refusing");
  } finally {
    await close();
  }
});

// Before #1853, Cursor's payment-method refusal (which refuses only its API
// pool) was held as an account billing refusal, keeping the registration out
// of unnamed @auto until a reply that @auto never asked for.
integration("Cursor's pre-scope account billing holds become the API-scope hold, once", async () => {
  assert.ok(url);
  const { sql, close } = await registrationQuotaSchema("registration_quota_cursor_billing_scope");
  try {
    await sql(`INSERT INTO control.machine_execution_capacity VALUES ('owner','m1',4,1,now())`);
    for (const harness of ["cursor", "deepseek"]) {
      await sql(`INSERT INTO data.agent_registrations VALUES ('owner','m1',$1,1,now(),now())`, [harness]);
      await sql(`INSERT INTO control.agent_registration_environments VALUES ('owner','m1',$1,'{"enabled":true}'::jsonb,1,now())`,
        [harness]);
      await sql(`INSERT INTO control.registration_quota_observations
          (owner_user_id,quota_pool_id,remaining,observed_at,expires_at,source,windows_json,account_json) VALUES
        ('owner',$1,0,'2026-11-19T21:57:20Z','2027-11-19T21:57:20Z','daemon',NULL,'{"billingRefusal":true}'::jsonb)`,
      [`registration:m1:${harness}`]);
    }
    const migration = await readFile(new URL("../migrations/0274_contract_cursor_billing_holds_scoped.sql", import.meta.url), "utf8");
    const row = async harness => (await sql(`SELECT ${QUOTA_COLUMNS} FROM control.registration_quota_observations
      WHERE owner_user_id='owner' AND quota_pool_id=$1`, [`registration:m1:${harness}`])).rows[0];
    for (let run = 0; run < 2; run++) await sql(`BEGIN; ${migration} COMMIT;`);

    const cursor = await row("cursor");
    assert.equal(cursor.source, "provider");
    assert.deepEqual(cursor.account_json, { billingRefusalScopes: { API: {
      observedAt: "2026-11-19T21:57:20+00:00", expiresAt: "2027-11-19T21:57:20+00:00" } } });
    assert.equal(registrationQuotaVerdict(cursor, { quotaScopes: ["Auto"] }).state, "unknown",
      "Auto is no longer held: @auto may ask for it");
    assert.equal(registrationQuotaVerdict(cursor, { quotaScopes: ["API"] }).state, "usedUp", "API stays refused");
    assert.equal(live(cursor).quota, undefined, "its Agents cell no longer reads out of quota");

    const deepseek = await row("deepseek");
    assert.equal(deepseek.source, "daemon", "an empty prepaid balance is the account's own refusal and stays");
    assert.deepEqual(live(deepseek).quota.account, { allowed: false });
  } finally {
    await close();
  }
});
