import assert from "node:assert/strict";
import { createAuth } from "../src/better-auth.ts";
import { integration, isolatedPostgres } from "../../db/test/postgres-database.fixture.mjs";

const EMAIL = "keyholder@example.test";
const cookiesOf = (response) => response.headers.getSetCookie()
  .map((value) => value.split(";", 1)[0]).filter((pair) => !pair.endsWith("=")).join("; ");

// The ceremony itself is the passkey library's; this pins what the Hub adds:
// the PostgreSQL table and column mapping, and the app's domain as relying party.
integration("passkeys are offered for the app's domain and kept in the auth table, per person", async () => {
  const f = await isolatedPostgres("passkeys", { shard: true });
  try {
    const env = { AUTH_AUTHORITY: "postgres", RELAY_POSTGRES: { connectionString: f.url.toString() },
      RELAY_POSTGRES_SHARD_ID: "shard-0", BETTER_AUTH_SECRET: "isolated-passkey-secret-not-production",
      APP_URL: "https://app.passkey.test", HUB_URL: "https://hub.passkey.test" };
    const auth = createAuth(env);
    const call = (path, { body, cookie, method } = {}) => auth.handler(new Request(`${env.HUB_URL}/api/auth${path}`, {
      method: method ?? (body ? "POST" : "GET"),
      headers: { origin: env.APP_URL, ...(cookie ? { cookie } : {}), ...(body ? { "content-type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }));
    await f.run(`INSERT INTO control.auth_users(id,name,email,email_verified,created_at,updated_at,handle)
      VALUES ('keyholder','Key Holder',$1,true,now(),now(),'keyholder')`, [EMAIL]);
    await f.run(`INSERT INTO control.auth_verifications(id,identifier,value,expires_at,created_at,updated_at)
      VALUES (gen_random_uuid()::text,$1,'135790:0',now()+interval '5 minutes',now(),now())`, [`sign-in-otp-${EMAIL}`]);
    const signedIn = await call("/sign-in/email-otp", { body: { email: EMAIL, otp: "135790" } });
    assert.equal(signedIn.status, 200);
    const cookie = cookiesOf(signedIn);

    const options = await call("/passkey/generate-register-options", { cookie });
    assert.equal(options.status, 200, await options.clone().text());
    const registration = await options.json();
    assert.equal(registration.rp.id, "app.passkey.test", "a passkey belongs to the app's domain, not the Hub's");
    assert.equal(registration.rp.name, "xMatrix");

    await f.run(`INSERT INTO control.auth_passkeys
      (id,name,public_key,user_id,credential_id,counter,device_type,backed_up,transports,created_at)
      VALUES ('pk-1','Laptop','public-key','keyholder','credential-1',0,'multiDevice',true,'internal',now())`);
    const listed = await (await call("/passkey/list-user-passkeys", { cookie })).json();
    assert.deepEqual(listed.map(({ id, name, credentialID, backedUp }) => ({ id, name, credentialID, backedUp })),
      [{ id: "pk-1", name: "Laptop", credentialID: "credential-1", backedUp: true }]);
    assert.equal((await call("/passkey/delete-passkey", { cookie, body: { id: "pk-1" } })).status, 200);
    assert.equal((await f.run("SELECT count(*)::int n FROM control.auth_passkeys"))[0].n, 0);
  } finally { await f.close(); }
});
