import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import { handleStripeAppDelivery } from "../src/connectors/stripe-app-ingress.ts";

const secret = ["sk", "live", "fixtureNotARealKey"].join("_");
const signing = "whsec_fixtureNotARealSecret";
const env = {
  CONNECTOR_STRIPE_CLIENT_ID: "ca_fixtureClient",
  CONNECTOR_STRIPE_CLIENT_SECRET: secret,
  CONNECTOR_STRIPE_SIGNING_SECRET: signing,
};
const account = "acct_fixtureA";

function sign(raw, key = signing, at = Math.floor(Date.now() / 1000)) {
  const digest = createHmac("sha256", key).update(`${at}.${raw}`).digest("hex");
  return { header: `t=${at},v1=${digest}`, at };
}

function fixture() {
  const queries = [], appends = [], retirements = [];
  const apps = {
    async connectorEventRoutes() { return [{ channelId: "space-a:ch", authorityRootUserId: "owner", features: ["events"] }]; },
  };
  const accounts = {
    async eventConnections(input) { queries.push(input); return [{ connectionId: "space-a:stripe", spaceId: "space-a", credentialVersion: 2, grantGeneration: "11111111-1111-4111-8111-111111111111" }]; },
    async retireAccount(input) { retirements.push(input); return 1; },
  };
  const dependencies = {
    apps: () => apps,
    accounts: () => accounts,
    credentials: () => ({ async resolve() { throw new Error("platform delivery must not read a Space secret"); } }),
    async append(_env, _channel, input) { appends.push(input); return Response.json({}); },
    async automations() {},
  };
  return { queries, appends, retirements, dependencies };
}

async function send(payload, f, signature = sign(JSON.stringify(payload)), requestEnv = env) {
  const raw = JSON.stringify(payload);
  return handleStripeAppDelivery({ env: requestEnv, request: new Request("https://hub.test/api/connectors/stripe/events", {
    method: "POST", body: raw, headers: { "stripe-signature": signature.header },
  }) }, f.dependencies);
}

test("a forged Stripe signature does not query Spaces, and a platform event without an account is ignored", async () => {
  const f = fixture();
  const payload = { id: "evt_1", type: "invoice.payment_failed", account, created: Math.floor(Date.now() / 1000), data: { object: { id: "in_1" } } };
  assert.equal((await send(payload, f, sign(JSON.stringify(payload), "other"))).status, 401);
  assert.equal((await send(payload, f, sign(JSON.stringify(payload)), { ...env, CONNECTOR_STRIPE_SIGNING_SECRET: "" })).status, 404);
  assert.deepEqual(await (await send({ ...payload, account: undefined }, f)).json(), { ok: true, events: 0, delivered: 0 });
  assert.equal((await send({ ...payload, account: "not-an-account" }, f)).status, 400);
  assert.equal(f.queries.length + f.appends.length + f.retirements.length, 0);
});

test("a connected account event is delivered and deauthorization retires without posting", async () => {
  const f = fixture();
  const created = Math.floor(Date.now() / 1000);
  const payload = { id: "evt_1", type: "invoice.payment_failed", account, created, data: { object: { id: "in_1", amount: 500, currency: "usd" } } };
  assert.deepEqual(await (await send(payload, f)).json(), { ok: true, events: 1, delivered: 1 });
  assert.equal(f.queries[0].accountId, account);
  assert.equal(f.appends.length, 1);
  assert.match(JSON.stringify(f.appends[0]), /acct_fixtureA/);
  const deauth = { id: "evt_2", type: "account.application.deauthorized", account, created, data: { object: { id: account } } };
  assert.deepEqual(await (await send(deauth, f)).json(), { ok: true, events: 0, delivered: 0, retired: 1 });
  assert.equal(f.retirements[0].accountId, account);
  assert.equal(f.appends.length, 1);
  const undated = { ...deauth, id: "evt_3", created: undefined };
  const again = fixture();
  assert.equal((await send(undated, again)).status, 400);
  assert.equal(again.retirements.length, 0);
});
