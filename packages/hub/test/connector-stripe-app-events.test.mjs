import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import { handleStripeAppDelivery } from "../src/connectors/stripe-app-ingress.ts";
import { handleStripePublisherDelivery } from "../src/connectors/stripe-publisher-ingress.ts";
import { ProviderRequestError } from "../src/connectors/http.ts";

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
  const queries = [], appends = [], retirements = [], automations = [];
  const state = { connections: [{ connectionId: "space-a:stripe", spaceId: "space-a", credentialVersion: 2,
    grantGeneration: "11111111-1111-4111-8111-111111111111" }], beforeRoutes: () => {} };
  const apps = {
    async connectorEventRoutes(input) { state.beforeRoutes(); return [{ channelId: `${input.connectionId}:ch`, authorityRootUserId: "owner", features: ["events"] }]; },
  };
  const accounts = {
    async eventConnections(input) { queries.push(input); return state.connections.map(connection => ({ ...connection })); },
    async retireAccount(input) { retirements.push(input); return 1; },
  };
  const dependencies = {
    apps: () => apps,
    accounts: () => accounts,
    credentials: () => ({ async resolve() { throw new Error("platform delivery must not read a Space secret"); } }),
    async append(_env, _channel, input) { appends.push(input); return Response.json({}); },
    async automations(_env, input) { automations.push(input); },
  };
  return { queries, appends, retirements, automations, dependencies, state };
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

const publisherSigning = "whsec_fixturePublisherSecret";
const publisherEnv = { ...env, CONNECTOR_STRIPE_PUBLISHER_ACCOUNT_ID: account,
  CONNECTOR_STRIPE_PUBLISHER_SIGNING_SECRET: publisherSigning };
const publisherEvent = () => ({ id: "evt_publisher1", object: "event", type: "invoice.payment_failed",
  created: Math.floor(Date.now() / 1000), livemode: true, data: { object: { id: "in_publisher1", amount: 500, currency: "usd" } } });

function publisherFixture(t, reply) {
  const f = fixture(), reads = [];
  f.dependencies.grant = async (_env, spaceId, accountId) => ({ accountId, appClientId: env.CONNECTOR_STRIPE_CLIENT_ID,
    generation: f.state.connections[0]?.grantGeneration, accessToken: "retained-account-token" });
  t.mock.method(globalThis, "fetch", async (url, init) => {
    reads.push({ url: String(url), headers: new Headers(init.headers) });
    return reply(url, init);
  });
  return { ...f, reads };
}

async function sendPublisher(payload, f, signature = sign(JSON.stringify(payload), publisherSigning), requestEnv = publisherEnv) {
  return handleStripePublisherDelivery({ env: requestEnv, request: new Request("https://hub.test/api/connectors/stripe/publisher/events", {
    method: "POST", body: JSON.stringify(payload), headers: { "stripe-signature": signature.header },
  }) }, f.dependencies);
}

// Contract: the publisher's own-account endpoint must never infer a Space from
// an unsigned/account-less platform delivery, or use the operator's broad key.
// The existing platform test cannot exercise this independent signer/read boundary.
test("publisher ingress requires its independent configuration and signature before grant lookup", async t => {
  const payload = publisherEvent(), f = publisherFixture(t, () => { throw new Error("must not call Stripe"); });
  for (const change of [{ CONNECTOR_STRIPE_PUBLISHER_ACCOUNT_ID: "" }, { CONNECTOR_STRIPE_PUBLISHER_SIGNING_SECRET: "" },
    { CONNECTOR_STRIPE_PUBLISHER_SIGNING_SECRET: signing }, { STRIPE_WEBHOOK_SECRET: publisherSigning }]) {
    assert.equal((await sendPublisher(payload, f, undefined, { ...publisherEnv, ...change })).status, 404);
  }
  for (const proof of [sign(JSON.stringify(payload)), sign(JSON.stringify(payload), publisherSigning, Math.floor(Date.now() / 1000) - 600),
    sign(JSON.stringify({ ...payload, id: "evt_tampered" }), publisherSigning)]) {
    assert.equal((await sendPublisher(payload, f, proof)).status, 401);
  }
  for (const change of [{ account }, { account: null }, { account: "acct_other" }, { id: "../anything" }, { livemode: false }, { created: undefined }]) {
    assert.equal((await sendPublisher({ ...payload, ...change }, f)).status, 400);
  }
  assert.equal(f.queries.length + f.reads.length + f.appends.length + f.automations.length, 0);
});

test("publisher delivery uses the retained grant to retrieve the same event and posts Stripe's content with a stable replay id", async t => {
  const payload = publisherEvent();
  const f = publisherFixture(t, () => Response.json({ ...payload, data: { object: { id: "in_publisher1", amount: 900, currency: "usd" } } }));
  for (let attempt = 0; attempt < 2; attempt++) {
    assert.deepEqual(await (await sendPublisher(payload, f)).json(), { ok: true, events: 1, delivered: 1 });
  }
  assert.equal(f.reads[0].url, "https://api.stripe.com/v1/events/evt_publisher1");
  assert.equal(f.reads[0].headers.get("authorization"), `Basic ${btoa("retained-account-token:")}`);
  assert.equal(f.reads[0].headers.get("stripe-account"), null);
  assert.match(f.appends[0].body, /Amount: 900 USD/);
  assert.match(f.appends[0].body, /acct_fixtureA/);
  assert.equal(f.appends[0].messageId, f.appends[1].messageId);
  assert.equal(f.automations.length, 2);
  assert.equal(f.queries.every(query => query.accountId === account && query.appClientId === env.CONNECTOR_STRIPE_CLIENT_ID), true);
});

test("an unreadable or mismatched publisher event never posts or fires Automations", async t => {
  const payload = publisherEvent(); let reply;
  const f = publisherFixture(t, () => reply());
  for (const status of [401, 403, 404]) {
    reply = () => Response.json({ error: { message: "not readable" } }, { status });
    assert.deepEqual(await (await sendPublisher(payload, f)).json(), { ok: true, events: 0, delivered: 0 });
  }
  for (const change of [{ id: "evt_other" }, { object: "invoice" }, { livemode: false }, { account: "acct_other" },
    { type: "charge.dispute.created" }, { created: payload.created - 1 }]) {
    reply = () => Response.json({ ...payload, ...change });
    assert.deepEqual(await (await sendPublisher(payload, f)).json(), { ok: true, events: 0, delivered: 0 });
  }
  f.dependencies.grant = async () => { throw new ProviderRequestError(403, "removed"); };
  assert.deepEqual(await (await sendPublisher(payload, f)).json(), { ok: true, events: 0, delivered: 0 });
  assert.equal(f.appends.length + f.automations.length, 0);
});

test("publisher confirmation is specific to each Space grant and is fenced against reconnection and removal", async t => {
  const payload = publisherEvent(); let duringRead = () => {};
  const f = publisherFixture(t, () => { duringRead(); return Response.json(payload); });
  duringRead = () => { f.state.connections[0].grantGeneration = "22222222-2222-4222-8222-222222222222"; };
  assert.deepEqual(await (await sendPublisher(payload, f)).json(), { ok: true, events: 0, delivered: 0 });
  duringRead = () => {}; f.state.beforeRoutes = () => { f.state.connections = []; };
  await assert.rejects(sendPublisher(payload, f), /Connector Channel delivery failed/);
  assert.equal(f.appends.length + f.automations.length, 0);
  // With no retained grant it does not ask Stripe to read anything.
  const count = f.reads.length;
  assert.deepEqual(await (await sendPublisher(payload, f)).json(), { ok: true, events: 0, delivered: 0 });
  assert.equal(f.reads.length, count);
});

test("a publisher event readable in one Space is not evidence for another Space", async t => {
  const payload = publisherEvent();
  const f = publisherFixture(t, (_url, init) => new Headers(init.headers).get("authorization") === `Basic ${btoa("space-a-token:")}`
    ? Response.json(payload) : Response.json({}, { status: 403 }));
  f.state.connections.push({ connectionId: "space-b:stripe", spaceId: "space-b", credentialVersion: 1,
    grantGeneration: "22222222-2222-4222-8222-222222222222" });
  f.dependencies.grant = async (_env, spaceId) => ({ accountId: account, appClientId: env.CONNECTOR_STRIPE_CLIENT_ID,
    generation: f.state.connections.find(connection => connection.spaceId === spaceId).grantGeneration,
    accessToken: `${spaceId}-token` });
  assert.deepEqual(await (await sendPublisher(payload, f)).json(), { ok: true, events: 1, delivered: 1 });
  assert.equal(f.reads.length, 2);
  assert.deepEqual(f.appends.map(append => append.channelId), ["space-a:stripe:ch"]);
  assert.deepEqual(f.automations.map(automation => automation.spaceId), ["space-a"]);
  // A switched or wrongly scoped credential is rejected before any event read.
  f.dependencies.grant = async () => ({ accountId: "acct_other", appClientId: env.CONNECTOR_STRIPE_CLIENT_ID,
    generation: f.state.connections[0].grantGeneration, accessToken: "other-token" });
  assert.deepEqual(await (await sendPublisher(payload, f)).json(), { ok: true, events: 0, delivered: 0 });
  assert.equal(f.reads.length, 2);
});

test("the actual publisher HTTP route verifies before lookup and sanitizes upstream failures", async t => {
  const { Hono } = await import("hono");
  const { compileCommonJsSourceModule } = await import("./support/commonjs-source-module.mjs");
  const route = await compileCommonJsSourceModule(new URL("../src/index-routes-connectors.ts", import.meta.url));
  const payload = publisherEvent(); let unavailable = false;
  const f = publisherFixture(t, () => {
    if (unavailable) throw new ProviderRequestError(503, "private-provider-response");
    return Response.json(payload);
  });
  const imports = { "@xmatrix/protocol": await import("@xmatrix/protocol"),
    "./connectors/stripe-publisher-ingress": { handleStripePublisherDelivery: input => handleStripePublisherDelivery(input, f.dependencies) } };
  const noop = () => {}, app = new Hono();
  route(name => imports[name] ?? new Proxy({}, { get: () => noop })).registerConnectorRoutes(app);
  const request = signature => new Request("https://hub.test/api/connectors/stripe/publisher/events", {
    method: "POST", body: JSON.stringify(payload), headers: { "stripe-signature": signature },
  });
  assert.equal((await app.fetch(request("forged"), publisherEnv)).status, 401);
  assert.equal(f.queries.length + f.reads.length, 0);
  assert.equal((await app.fetch(request(sign(JSON.stringify(payload), publisherSigning).header), publisherEnv)).status, 200);
  unavailable = true;
  const failed = await app.fetch(request(sign(JSON.stringify(payload), publisherSigning).header), publisherEnv);
  assert.equal(failed.status, 503); assert.doesNotMatch(await failed.text(), /private-provider-response|retained-account-token/);
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
