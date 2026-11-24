import assert from "node:assert/strict";
import { test } from "node:test";
import {
  readDiagnosticsConsent,
  recordDiagnosticsChoice,
  recordSignupDiagnosticsRegime,
  requestDiagnosticsRegime,
} from "../src/diagnostics-consent.ts";
import { integration, isolatedPostgres } from "../../db/test/postgres-database.fixture.mjs";

async function fixture(users) {
  const f = await isolatedPostgres("diagnostics_consent", { shard: true });
  const env = { AUTH_AUTHORITY: "postgres", RELAY_POSTGRES: { connectionString: f.url.toString() },
    RELAY_POSTGRES_SHARD_ID: "shard-0" };
  for (const id of users) {
    await f.run(`INSERT INTO control.auth_users(id,name,email,email_verified,created_at,updated_at,handle)
      VALUES ($1,$1,$1||'@example.test',true,now(),now(),$1)`, [id]);
  }
  return { f, env };
}

function edgeRequest(country, headers = {}) {
  const request = new Request("https://hub.example.test/api/me/diagnostics", { headers });
  if (country !== undefined) Object.defineProperty(request, "cf", { value: { country } });
  return request;
}

test("a request's regime comes from the edge's country only, never from a header a caller sets", () => {
  assert.equal(requestDiagnosticsRegime(edgeRequest("US")), "default-ok");
  assert.equal(requestDiagnosticsRegime(edgeRequest("DE")), "consent-required");
  assert.equal(requestDiagnosticsRegime(edgeRequest(undefined, { "cf-ipcountry": "US" })), "consent-required");
  assert.equal(requestDiagnosticsRegime(edgeRequest("XX")), "consent-required");
});

integration("the signup regime is recorded once and a later request's country never overwrites it", async () => {
  const { f, env } = await fixture(["us_signup", "eu_signup"]);
  try {
    await recordSignupDiagnosticsRegime(env, "us_signup", "default-ok");
    await recordSignupDiagnosticsRegime(env, "eu_signup", "consent-required");
    // A second signup-time write (a retried hook) does not change it.
    await recordSignupDiagnosticsRegime(env, "us_signup", "consent-required");

    // Travelling: the US account reads from a consent-required country.
    assert.deepEqual(await readDiagnosticsConsent(env, "us_signup", "consent-required", { recordMissingRegime: true }),
      { accountRegime: "default-ok", requestRegime: "consent-required", choice: null });
    assert.deepEqual(await readDiagnosticsConsent(env, "eu_signup", "default-ok", { recordMissingRegime: true }),
      { accountRegime: "consent-required", requestRegime: "default-ok", choice: null });
    assert.deepEqual((await f.run("SELECT id, diagnostics_regime FROM control.auth_users ORDER BY id")),
      [{ id: "eu_signup", diagnostics_regime: "consent-required" }, { id: "us_signup", diagnostics_regime: "default-ok" }]);
  } finally { await f.close(); }
});

integration("an older account gets its regime on its first beta read; a stable read records nothing", async () => {
  const { f, env } = await fixture(["older"]);
  try {
    assert.deepEqual(await readDiagnosticsConsent(env, "older", "default-ok", { recordMissingRegime: false }),
      { accountRegime: "consent-required", requestRegime: "default-ok", choice: null });
    assert.equal((await f.run("SELECT diagnostics_regime FROM control.auth_users"))[0].diagnostics_regime, null);

    assert.equal((await readDiagnosticsConsent(env, "older", "default-ok", { recordMissingRegime: true })).accountRegime,
      "default-ok");
    assert.equal((await readDiagnosticsConsent(env, "older", "consent-required", { recordMissingRegime: true }))
      .accountRegime, "default-ok", "kept from then on");
    assert.equal(await readDiagnosticsConsent(env, "missing", "default-ok", { recordMissingRegime: true }), null);
  } finally { await f.close(); }
});

integration("an explicit choice is recorded with its time, and changes only by another explicit choice", async () => {
  const { f, env } = await fixture(["chooser"]);
  try {
    assert.equal(await recordDiagnosticsChoice(env, "chooser", "opted-in"), true);
    assert.equal((await readDiagnosticsConsent(env, "chooser", "consent-required", { recordMissingRegime: true })).choice,
      "opted-in");
    const [row] = await f.run("SELECT diagnostics_choice, diagnostics_choice_at IS NOT NULL AS dated FROM control.auth_users");
    assert.deepEqual(row, { diagnostics_choice: "opted-in", dated: true });
    assert.equal(await recordDiagnosticsChoice(env, "chooser", "opted-out"), true);
    assert.equal((await readDiagnosticsConsent(env, "chooser", "default-ok", { recordMissingRegime: true })).choice,
      "opted-out");
    assert.equal(await recordDiagnosticsChoice(env, "nobody", "opted-in"), false);
  } finally { await f.close(); }
});
