import { connectionString as url, integration, postgresConnections } from "./postgres-database.fixture.mjs";
import assert from "node:assert/strict";
import { routingQuotaRecord } from "@xmatrix/protocol";
import { registrationQuotaSchema } from "./registration-quota.fixture.mjs";
import { isRegistrationBillingRefusalRow, upsertRegistrationQuotaObservation } from "../dist/agent-registration-quota-probe.js";

// A prepaid account that said "Insufficient Balance" is held with no reset.
// After a top-up, the provider's own balance reading says the account covers
// requests again; that reading ends the hold, so the Agent shows its balance
// and returns to routing without a Run having to succeed first.
integration("a balance reading that says the account is allowed lifts an account billing hold", async () => {
  assert.ok(url);
  const { sql, rewrite, close } = await registrationQuotaSchema("registration_billing_hold_balance");
  try {
    await sql(`INSERT INTO control.machine_execution_capacity VALUES ('owner','m1',4,1,now())`);
    for (const harness of ["deepseek", "other"]) {
      await sql(`INSERT INTO data.agent_registrations VALUES ('owner','m1',$1,1,now(),now())`, [harness]);
      await sql(`INSERT INTO control.agent_registration_environments VALUES ('owner','m1',$1,'{"enabled":true}'::jsonb,1,now())`,
        [harness]);
      await sql(`INSERT INTO control.registration_quota_observations
          (owner_user_id,quota_pool_id,remaining,observed_at,expires_at,source,windows_json,account_json,
            scoped_windows_json,scoped_observed_at,scoped_expires_at) VALUES
        ('owner',$1,0,now()-interval '6 days',now()+interval '359 days','daemon',NULL,'{"billingRefusal":true}'::jsonb,
          NULL,NULL,NULL)`, [`registration:m1:${harness}`]);
    }
    const now = Date.now();
    const reading = quotaAccount => routingQuotaRecord({ quotaSource: "provider_api",
      quotaObservedAt: new Date(now).toISOString(), quotaUsages: [], quotaAccount }, now);
    const database = postgresConnections(undefined, { rewrite });
    await database.transaction({}, async tx => {
      await upsertRegistrationQuotaObservation(tx, { ownerUserId: "owner", quotaPoolId: "registration:m1:deepseek",
        record: reading({ allowed: true, credits: { balance: 19.99, currency: "CNY" } }) });
      await upsertRegistrationQuotaObservation(tx, { ownerUserId: "owner", quotaPoolId: "registration:m1:other",
        record: reading({ allowed: false, credits: { balance: 0, currency: "CNY" } }) });
    });
    const row = async harness => (await sql(`SELECT source,remaining,expires_at,account_json
      FROM control.registration_quota_observations WHERE owner_user_id='owner' AND quota_pool_id=$1`,
    [`registration:m1:${harness}`])).rows[0];
    const lifted = await row("deepseek");
    assert.equal(lifted.source, "provider", "the provider's reading replaced the hold");
    assert.equal(isRegistrationBillingRefusalRow(lifted), false);
    assert.deepEqual(lifted.account_json, { allowed: true, credits: { balance: 19.99, currency: "CNY" } });
    assert.ok(new Date(lifted.expires_at).getTime() < now + 24 * 3600_000, "an ordinary reading's lifetime, not a year");
    const kept = await row("other");
    assert.equal(kept.source, "daemon", "a reading that still refuses leaves the hold");
    assert.equal(isRegistrationBillingRefusalRow(kept), true);
  } finally {
    await close();
  }
});
