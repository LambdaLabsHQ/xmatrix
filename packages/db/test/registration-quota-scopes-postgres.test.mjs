import { integration, postgresConnections } from "./postgres-database.fixture.mjs";
import assert from "node:assert/strict";
import { routingQuotaObservation } from "@xmatrix/protocol";
import { registrationQuotaSchema } from "./registration-quota.fixture.mjs";
import { recordRegistrationUsageLimit, registrationQuotaReading } from "../dist/agent-registration-quota-probe.js";
import { observeRegistrationQuota, readRegistrationQuotaUsages, registrationQuotaKey } from "../dist/registration-quota-state.js";

integration("a pool reading keeps an account part and a scoped part, and a usage limit records what it used up", async () => {
  const { sql, rewrite, close } = await registrationQuotaSchema("registration_quota_scopes");
  try {
    await sql(`INSERT INTO data.agent_registrations VALUES ('owner','m1','claude',1,now(),now());
      INSERT INTO control.machine_execution_capacity VALUES ('owner','m1',4,1,now());
      INSERT INTO control.agent_registration_environments VALUES ('owner','m1','claude','{"enabled":true}',1,now())`);
    const database = postgresConnections(undefined, { rewrite });
    const key = { ownerUserId: "owner", machineId: "m1", harness: "claude" };
    const fable = { quotaScopes: ["Fable"] };
    const week = new Date(Date.now() + 4 * 86_400_000).toISOString();
    const row = async () => (await sql(`SELECT source,remaining,observed_at,expires_at,windows_json,account_json,
      scoped_windows_json,scoped_observed_at,scoped_expires_at FROM control.registration_quota_observations
      WHERE owner_user_id='owner'`)).rows[0];
    const reading = (ago, account, scoped) => ({ quotaSource: "provider_api",
      quotaObservedAt: new Date(Date.now() - ago).toISOString(),
      quotaUsages: [{ label: "1w", percent: account, resetAt: week }],
      ...(scoped === undefined ? {} : { scopedQuotaUsages: [{ label: "1w", percent: scoped, resetAt: week, scope: "Fable" }] }) });

    // A complete reading writes both parts; Fable's week blocks Fable only.
    await observeRegistrationQuota(database, key, reading(5000, 55, 100), "complete");
    assert.equal(registrationQuotaReading(await row()).remainingPercent, 45);
    assert.equal(registrationQuotaReading(await row(), fable).remainingPercent, 0);
    assert.equal(Date.parse(registrationQuotaReading(await row(), fable).expiresAt), Date.parse(week));
    // A newer partial reading (a rate-limit verdict) renews the account part only.
    await observeRegistrationQuota(database, key, reading(1000, 60), "partial");
    assert.equal(registrationQuotaReading(await row()).remainingPercent, 40);
    assert.equal(registrationQuotaReading(await row(), fable).remainingPercent, 0, "the scoped part stands");
    // An older complete reading renews the scoped part alone; the account part keeps the newer reading.
    await observeRegistrationQuota(database, key, reading(3000, 10, 20), "older-complete");
    assert.equal(registrationQuotaReading(await row()).remainingPercent, 40);
    assert.equal(registrationQuotaReading(await row(), fable).remainingPercent, 40);
    // The row stays current while its scoped part does, after the account part ends.
    await observeRegistrationQuota(database, key, reading(500, 55, 100), "fable-used-up");
    await sql(`UPDATE control.registration_quota_observations SET expires_at=observed_at+interval '1 millisecond'`);
    const usages = await readRegistrationQuotaUsages(database, [key], "scoped-only");
    assert.equal(routingQuotaObservation(usages.get(registrationQuotaKey(key)), Date.now(), { model: fable }).value, 0);

    // A usage limit of one scope marks that scope's window used up and holds no pool.
    await sql(`DELETE FROM control.registration_quota_observations`);
    const limit = input => database.transaction({}, tx => recordRegistrationUsageLimit(tx, { ...key, ...input }));
    const refused = new Date(Date.parse(week) + 1000).toISOString();
    const scoped = await limit({ resetsAt: refused, quotaScope: "Fable", usage: reading(1000, 55, 99) });
    assert.deepEqual([scoped.usedUp, scoped.scope], ["scope", "Fable"]);
    assert.equal((await row()).source, "provider", "no windowless hold");
    assert.equal(registrationQuotaReading(await row()).remainingPercent, 45);
    assert.equal(registrationQuotaReading(await row(), fable).remainingPercent, 0, "rounded to 99%, it is the one used up");
    // The account: its own window resetting with the refusal is used up, for every model.
    await sql(`DELETE FROM control.registration_quota_observations`);
    assert.equal((await limit({ resetsAt: refused, quotaScope: "account", usage: reading(1000, 99, 10) })).usedUp, "account");
    assert.equal(registrationQuotaReading(await row()).remainingPercent, 0);
    // A scope the reading does not show is unresolved.
    await sql(`DELETE FROM control.registration_quota_observations`);
    assert.equal((await limit({ resetsAt: refused, quotaScope: "Sonnet", usage: reading(1000, 55, 10) })).usedUp, "unresolved");
    // Unresolved: the reading under a windowless hold of the pool until the refusal's reset.
    await sql(`DELETE FROM control.registration_quota_observations`);
    const soon = new Date(Date.now() + 2 * 3_600_000).toISOString();
    const unresolved = await limit({ resetsAt: soon, quotaScope: "unresolved", usage: reading(1000, 55, 10) });
    assert.equal(unresolved.usedUp, "unresolved");
    assert.equal((await row()).source, "daemon");
    assert.equal(registrationQuotaReading(await row(), { quotaScopes: ["Sonnet"] }).remainingPercent, 0);
    // A partial reading cannot release the hold; a complete one replaces it,
    // reading the window that resets with the hold as the used-up one.
    await observeRegistrationQuota(database, key, reading(0, 20), "partial-over-hold");
    assert.equal((await row()).source, "daemon", "a partial reading never tells what a hold was");
    const narrowing = { ...reading(0, 20), scopedQuotaUsages: [{ label: "5h", percent: 50, resetAt: soon, scope: "Fable" }] };
    await observeRegistrationQuota(database, key, narrowing, "complete-over-hold");
    assert.equal((await row()).source, "provider");
    assert.equal(registrationQuotaReading(await row()).remainingPercent, 80, "the hold is released for the account");
    assert.equal(registrationQuotaReading(await row(), fable).remainingPercent, 0, "and narrowed to the scope resetting with it");
    // A daemon that predates scopes reports the account used up: a windowless hold, as before.
    await sql(`DELETE FROM control.registration_quota_observations`);
    assert.equal((await limit({ resetsAt: soon })).usedUp, "account");
    assert.equal((await row()).source, "daemon");
  } finally { await close(); }
});
