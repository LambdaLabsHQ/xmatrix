import assert from "node:assert/strict";
import { test } from "node:test";

import { APP_CONNECTOR_PROVIDER_MANIFESTS } from "../../protocol/src/app-connector-manifests.ts";
import { parseActionCommand } from "../src/connectors/action-parse.ts";
import { receiveCloudflareDelivery } from "../src/connectors/cloudflare-events.ts";
import { CLOUDFLARE_ACTIONS, CLOUDFLARE_SUBSCRIPTIONS, cloudflareGrantContext } from "../src/connectors/cloudflare-api.ts";
import { connectorProvider } from "../src/connectors/registry.ts";

const ACCOUNT = "0123456789abcdef0123456789abcdef";
const SPACE = "space-1";
const INGRESS = `https://hub.test/api/connectors/cloudflare/events/${SPACE}/ingress-key`;
const credentials = { oauthToken: "cf-token", webhookSecret: "cf-secret", ingressKey: "ingress-key" };
const env = { HUB_URL: "https://hub.test" };

/* A Cloudflare API double keyed by "METHOD path"; every call is recorded. */
function cloudflareApi(routes) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const method = init.method ?? "GET";
    const path = new URL(String(url)).pathname.replace("/client/v4/", "");
    calls.push({ method, path, body: init.body ? JSON.parse(init.body) : undefined,
      authorization: new Headers(init.headers).get("authorization") });
    const route = routes[`${method} ${path}`];
    const result = typeof route === "function" ? route(calls.at(-1)) : route;
    if (result === undefined) return Response.json({ success: false, errors: [{ code: 7003, message: `no route ${method} ${path}` }] }, { status: 404 });
    return Response.json({ success: true, errors: [], result });
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

async function withApi(routes, work) {
  const api = cloudflareApi(routes);
  try {
    return { value: await work(), calls: api.calls };
  } finally {
    api.restore();
  }
}

const oneAccount = { "GET accounts": [{ id: ACCOUNT, name: "Acme" }] };
const alerts = { [`GET accounts/${ACCOUNT}/alerting/v3/available_alerts`]: {
  "Workers Observability": [{ type: "workers_observability_real_time_issue" }],
  "Cloudflare Status": [{ type: "incident_alert" }],
} };

function delivery(body, secret = "cf-secret") {
  return { rawBody: JSON.stringify(body), headers: new Headers({ "cf-webhook-auth": secret }),
    url: new URL("https://hub.test/ingress"), credentials: { webhookSecret: "cf-secret" } };
}

test("Cloudflare alerts route by alert type and report whether they fired or resolved", async () => {
  const alert = { name: "xMatrix · workers_observability_real_time_issue", text: "New issue on xmatrix-hub @admin",
    data: { service: "xmatrix-hub", count: 42, nested: { ignored: true } }, ts: 1, account_id: ACCOUNT,
    alert_type: "workers_observability_real_time_issue", alert_correlation_id: "corr-1", alert_event: "ALERT_STATE_EVENT_START" };
  const fired = await receiveCloudflareDelivery(delivery(alert));
  assert.equal(fired.ok, true);
  const [event] = fired.events;
  assert.equal(event.sourceRef, "cloudflare:workers_observability_real_time_issue");
  assert.equal(event.feature, "fired");
  assert.equal(event.eventId, "cloudflare:corr-1:start");
  assert.equal(event.url, `https://dash.cloudflare.com/${ACCOUNT}/notifications`);
  assert.match(event.body, /🔴 Fired/u);
  assert.match(event.body, /service: xmatrix-hub · count: 42/u);
  assert.doesNotMatch(event.body, /ignored/u, "nested data stays out of the message");
  assert.doesNotMatch(event.body, /@admin/u, "mentions in the payload never address anyone");

  const resolved = await receiveCloudflareDelivery(delivery({ ...alert, alert_event: "ALERT_STATE_EVENT_END" }));
  assert.equal(resolved.events[0].feature, "resolved");
  assert.equal(resolved.events[0].eventId, "cloudflare:corr-1:end", "the two edges of one alert are distinct events");

  const features = APP_CONNECTOR_PROVIDER_MANIFESTS.find((manifest) => manifest.id === "cloudflare").events.features.map((feature) => feature.id);
  assert.deepEqual(features, ["fired", "resolved"]);
});

test("the destination test message reaches only * and a wrong secret is refused", async () => {
  const test = await receiveCloudflareDelivery(delivery({ text: "Hello World! This is a test message" }));
  assert.equal(test.events[0].sourceRef, "cloudflare:test");
  assert.equal(test.events[0].url, undefined);
  assert.equal((await receiveCloudflareDelivery(delivery({ text: "x" }, "wrong"))).status, 401);
});

test("subscribing creates the account's xMatrix destination and alert policy once", async () => {
  const created = await withApi({
    ...oneAccount, ...alerts,
    [`GET accounts/${ACCOUNT}/alerting/v3/policies`]: [],
    [`GET accounts/${ACCOUNT}/alerting/v3/destinations/webhooks`]: [],
    [`POST accounts/${ACCOUNT}/alerting/v3/destinations/webhooks`]: { id: "hook-1" },
    [`POST accounts/${ACCOUNT}/alerting/v3/policies`]: { id: "policy-1" },
  }, () => CLOUDFLARE_SUBSCRIPTIONS.sync({ env, spaceId: SPACE, credentials,
    source: "workers_observability_real_time_issue", subscribed: true }));
  assert.equal(created.value, undefined);
  const hook = created.calls.find((call) => call.method === "POST" && call.path.endsWith("/webhooks"));
  assert.deepEqual(hook.body, { name: `xMatrix · ${SPACE}`, url: INGRESS, secret: "cf-secret" });
  const policy = created.calls.find((call) => call.method === "POST" && call.path.endsWith("/policies"));
  assert.equal(policy.body.name, `xMatrix · workers_observability_real_time_issue · ${SPACE}`);
  assert.equal(policy.body.alert_type, "workers_observability_real_time_issue");
  assert.deepEqual(policy.body.mechanisms, { webhooks: [{ id: "hook-1" }] });
  assert.ok(created.calls.every((call) => call.authorization === "Bearer cf-token"));

  const again = await withApi({
    ...oneAccount, ...alerts,
    [`GET accounts/${ACCOUNT}/alerting/v3/policies`]: [{ id: "policy-1", name: `xMatrix · workers_observability_real_time_issue · ${SPACE}`,
      alert_type: "workers_observability_real_time_issue", mechanisms: { webhooks: [{ id: "hook-1" }] } }],
    [`GET accounts/${ACCOUNT}/alerting/v3/destinations/webhooks`]: [{ id: "hook-1", url: INGRESS }],
    [`PUT accounts/${ACCOUNT}/alerting/v3/destinations/webhooks/hook-1`]: { id: "hook-1" },
  }, () => CLOUDFLARE_SUBSCRIPTIONS.sync({ env, spaceId: SPACE, credentials: { ...credentials, webhookSecret: "rotated" },
    source: "workers_observability_real_time_issue", subscribed: true }));
  assert.equal(again.value, undefined);
  assert.deepEqual(again.calls.filter((call) => call.method !== "GET").map((call) => [call.method, call.body.secret]),
    [["PUT", "rotated"]], "the destination is reused with the current secret and the policy is kept");
});

test("a policy of ours that sends to a retired ingress URL is replaced, not duplicated", async () => {
  const { calls } = await withApi({
    ...oneAccount, ...alerts,
    [`GET accounts/${ACCOUNT}/alerting/v3/policies`]: [{ id: "stale", name: `xMatrix · incident_alert · ${SPACE}`,
      alert_type: "incident_alert", mechanisms: { webhooks: [{ id: "old-hook" }] } }],
    [`GET accounts/${ACCOUNT}/alerting/v3/destinations/webhooks`]: [{ id: "old-hook", url: "https://hub.test/old" }],
    [`POST accounts/${ACCOUNT}/alerting/v3/destinations/webhooks`]: { id: "hook-2" },
    [`DELETE accounts/${ACCOUNT}/alerting/v3/policies/stale`]: {},
    [`POST accounts/${ACCOUNT}/alerting/v3/policies`]: { id: "fresh" },
  }, () => CLOUDFLARE_SUBSCRIPTIONS.sync({ env, spaceId: SPACE, credentials, source: "incident_alert", subscribed: true }));
  assert.deepEqual(calls.filter((call) => call.method !== "GET").map((call) => `${call.method} ${call.path.split("/").at(-1)}`),
    ["POST webhooks", "DELETE stale", "POST policies"]);
  assert.deepEqual(calls.at(-1).body.mechanisms, { webhooks: [{ id: "hook-2" }] });
});

test("an unknown alert type is refused with examples, and * configures nothing", async () => {
  const refused = await withApi({ ...oneAccount, ...alerts, [`GET accounts/${ACCOUNT}/alerting/v3/policies`]: [] },
    () => CLOUDFLARE_SUBSCRIPTIONS.sync({ env, spaceId: SPACE, credentials, source: "notification", subscribed: true }));
  assert.match(refused.value, /notification is not a Cloudflare alert type/u);
  assert.match(refused.value, /workers_observability_real_time_issue/u);
  assert.ok(refused.calls.every((call) => call.method === "GET"));

  const wildcard = await withApi({}, () => CLOUDFLARE_SUBSCRIPTIONS.sync({ env, spaceId: SPACE, credentials, source: "*", subscribed: true }));
  assert.equal(wildcard.value, undefined);
  assert.equal(wildcard.calls.length, 0);
});

test("the last unsubscribe deletes only this Space's policy for that alert type", async () => {
  const removed = await withApi({
    ...oneAccount,
    [`GET accounts/${ACCOUNT}/alerting/v3/policies`]: [
      { id: "policy-1", name: `xMatrix · incident_alert · ${SPACE}`, alert_type: "incident_alert" },
      { id: "policy-2", name: "Team pager", alert_type: "incident_alert" },
      { id: "policy-3", name: "xMatrix · incident_alert · space-2", alert_type: "incident_alert",
        mechanisms: { webhooks: [{ id: "other-space-hook" }] } },
    ],
    [`DELETE accounts/${ACCOUNT}/alerting/v3/policies/policy-1`]: {},
  }, () => CLOUDFLARE_SUBSCRIPTIONS.sync({ env, spaceId: SPACE, credentials, source: "incident_alert", subscribed: false }));
  assert.deepEqual(removed.calls.filter((call) => call.method === "DELETE").map((call) => call.path),
    [`accounts/${ACCOUNT}/alerting/v3/policies/policy-1`]);
});

test("a login with several accounts connects, and subscribing asks for its Account ID", async () => {
  const two = { "GET accounts": [{ id: ACCOUNT }, { id: "fedcba9876543210fedcba9876543210" }] };
  await withApi(two, () => connectorProvider("cloudflare").verify(credentials));
  await assert.rejects(withApi({ "GET accounts": [] }, () => connectorProvider("cloudflare").verify(credentials)), /reaches no account/u);
  await assert.rejects(withApi({ ...two, [`GET accounts/${ACCOUNT}/alerting/v3/policies`]: [] }, () => CLOUDFLARE_SUBSCRIPTIONS.sync({
    env, spaceId: SPACE, credentials, source: "incident_alert", subscribed: true })), /reaches 2 accounts; set Account ID/u);
  await withApi(two, () => connectorProvider("cloudflare").verify({ ...credentials, accountId: ACCOUNT }));
  await assert.rejects(withApi(oneAccount, () => connectorProvider("cloudflare").verify({ ...credentials,
    accountId: "fedcba9876543210fedcba9876543210" })), /cannot reach the configured Account ID/u);
  assert.deepEqual((await withApi(oneAccount, () => cloudflareGrantContext("t"))).value, { accountId: ACCOUNT });
  assert.deepEqual((await withApi(two, () => cloudflareGrantContext("t"))).value, {});
});

async function act(body, routes) {
  const parsed = parseActionCommand("cloudflare", body);
  assert.ok(parsed, body);
  const action = CLOUDFLARE_ACTIONS[parsed.actionId];
  const input = action.parse(parsed.statement);
  assert.equal(typeof input, "object", String(input));
  return withApi({ ...oneAccount, ...routes }, () => action.execute({ credentials }, input));
}

test("query_logs counts a Worker's log messages over a bounded window", async () => {
  const { value, calls } = await act("@cloudflare:query_logs:xmatrix-hub 30", {
    [`POST accounts/${ACCOUNT}/workers/observability/telemetry/query`]: { calculations: [{ aggregates: [
      { count: 5, groups: [{ key: "$metadata.message", value: "runtime session failure" }] },
      { count: 900, groups: [{ key: "$metadata.message", value: "hibernation attachment" }] },
    ] }] },
  });
  const query = calls.find((call) => call.method === "POST").body;
  assert.equal(query.chartType, "aggregate");
  assert.equal(query.ignoreSeries, true);
  assert.equal(query.timeframe.to - query.timeframe.from, 30 * 60_000);
  assert.deepEqual(query.parameters.filters.map((filter) => filter.value), ["xmatrix-hub", "error"]);
  assert.match(value.summary, /xmatrix-hub: 905 error events in 30 min/u);
  assert.ok(value.summary.indexOf("900 ×") < value.summary.indexOf("5 ×"), "largest group first");
  assert.equal(typeof CLOUDFLARE_ACTIONS.query_logs.parse({ target: "x", text: "99999" }), "string", "window is bounded");
  assert.equal(typeof CLOUDFLARE_ACTIONS.query_logs.parse({ target: "../x", text: "" }), "string");
});

const history = { [`GET accounts/${ACCOUNT}/workers/scripts/xmatrix-web/deployments`]: { deployments: [
  { id: "d1", created_on: "2026-10-04T17:00:00Z", versions: [{ version_id: "11111111-1111-4111-8111-111111111111", percentage: 100 }] },
  { id: "d2", created_on: "2026-10-04T19:00:00Z", versions: [{ version_id: "22222222-2222-4222-8222-222222222222", percentage: 100 }],
    annotations: { "workers/message": "release v2" } },
] } };

test("list_deployments shows the newest deployments first", async () => {
  const { value } = await act("@cloudflare:list_deployments:xmatrix-web", history);
  assert.match(value.summary, /2 recent deployments/u);
  assert.ok(value.summary.indexOf("22222222") < value.summary.indexOf("11111111"));
  assert.match(value.summary, /release v2/u);
});

test("rollback deploys the previous deployment, or the named version, at 100%", async () => {
  const route = `POST accounts/${ACCOUNT}/workers/scripts/xmatrix-web/deployments`;
  const previous = await act("@cloudflare:rollback:xmatrix-web errors after v2", { ...history, [route]: { id: "d3" } });
  const posted = previous.calls.find((call) => call.method === "POST").body;
  assert.deepEqual(posted.versions, [{ version_id: "11111111-1111-4111-8111-111111111111", percentage: 100 }]);
  assert.equal(posted.annotations["workers/message"], "xMatrix rollback: errors after v2");

  const named = await act("@cloudflare:rollback:xmatrix-web 33333333-3333-4333-8333-333333333333", { ...history, [route]: { id: "d4" } });
  assert.deepEqual(named.calls.find((call) => call.method === "POST").body.versions,
    [{ version_id: "33333333-3333-4333-8333-333333333333", percentage: 100 }]);
  assert.equal(CLOUDFLARE_ACTIONS.rollback.effect, "write");
});

test("a Cloudflare refusal reaches the subscriber with its reason", async () => {
  const api = cloudflareApi({});
  globalThis.fetch = async () => Response.json({ success: false, errors: [{ code: 17000, message: "filters are required for this alert type" }] });
  try {
    await assert.rejects(connectorProvider("cloudflare").verify(credentials), /Cloudflare refused the request: filters are required/u);
  } finally {
    api.restore();
  }
});
