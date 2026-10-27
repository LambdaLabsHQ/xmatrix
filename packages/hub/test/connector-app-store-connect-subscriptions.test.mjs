import assert from "node:assert/strict";
import { test } from "node:test";

import { ACTIONS, apps, BUNDLE, credentials, run, statement, withApple, writes } from "./support/app-store-connect-double.mjs";

const subscription = (id, productId, state) => ({ type: "subscriptions", id,
  attributes: { productId, name: productId.split(".").at(-1), state, groupLevel: 1, subscriptionPeriod: id === "s-year" ? "ONE_YEAR" : "ONE_MONTH" } });
const catalog = (...rows) => ({ ...apps,
  "GET /v1/apps/6760000001/subscriptionGroups": { data: [{ type: "subscriptionGroups", id: "g-1", attributes: { referenceName: "Pro" } }] },
  "GET /v1/subscriptionGroups/g-1/subscriptions": { data: rows } });
const submitted = { "POST /v1/subscriptionSubmissions": (call) => ({ data: { type: "subscriptionSubmissions", id: `sub-${call.body.relationships.subscription.data.id}` } }) };

test("subscription statements are validated before any request", () => {
  assert.deepEqual(statement(`@appstoreconnect:subscriptions:${BUNDLE}`), { app: BUNDLE });
  assert.deepEqual(statement(`@appstoreconnect:submit_subscriptions:${BUNDLE}`), { app: BUNDLE, products: "" });
  assert.deepEqual(statement(`@appstoreconnect:submit_subscriptions:${BUNDLE} app.pro.monthly app.pro.annual`),
    { app: BUNDLE, products: "app.pro.monthly app.pro.annual" });
  for (const bad of [`subscriptions:${BUNDLE} extra`, `submit_subscriptions:${BUNDLE} has/slash`, `submit_subscriptions:has/slash`]) {
    assert.equal(typeof statement(`@appstoreconnect:${bad}`), "string", bad);
  }
});

test("subscriptions lists each product with its group and review state", async () => {
  const shown = await run(catalog(subscription("s-month", "app.pro.monthly", "READY_TO_SUBMIT"), subscription("s-year", "app.pro.annual", "APPROVED")),
    `@appstoreconnect:subscriptions:${BUNDLE}`);
  assert.match(shown.value.summary, /Pro\tapp\.pro\.monthly\tmonthly\tONE_MONTH\t1\tREADY_TO_SUBMIT\nPro\tapp\.pro\.annual\tannual\tONE_YEAR\t1\tAPPROVED/u);
  assert.deepEqual(writes(shown.calls), []);
});

test("submit_subscriptions sends every ready subscription, each exactly once", async () => {
  const sent = await run({ ...catalog(subscription("s-month", "app.pro.monthly", "READY_TO_SUBMIT"), subscription("s-year", "app.pro.annual", "READY_TO_SUBMIT"),
    subscription("s-old", "app.pro.legacy", "APPROVED")), ...submitted }, `@appstoreconnect:submit_subscriptions:${BUNDLE}`);
  assert.deepEqual(sent.calls.filter(call => call.method === "POST").map(call => call.body.relationships.subscription.data),
    [{ type: "subscriptions", id: "s-month" }, { type: "subscriptions", id: "s-year" }]);
  assert.match(sent.value.summary, /Submitted app\.pro\.monthly, app\.pro\.annual .*submit that version to send them/u);
  const none = await run(catalog(subscription("s-old", "app.pro.legacy", "APPROVED")), `@appstoreconnect:submit_subscriptions:${BUNDLE}`);
  assert.match(none.value.summary, /nothing was submitted/u);
  assert.deepEqual(writes(none.calls), []);
});

test("named subscriptions must exist and be ready, or nothing is sent", async () => {
  const routes = { ...catalog(subscription("s-month", "app.pro.monthly", "READY_TO_SUBMIT"), subscription("s-year", "app.pro.annual", "WAITING_FOR_REVIEW")), ...submitted };
  const missing = await withApple(routes, () => assert.rejects(ACTIONS.submit_subscriptions.execute({ credentials }, { app: BUNDLE, products: "app.pro.weekly" }),
    /no subscription app\.pro\.weekly/u));
  assert.deepEqual(writes(missing.calls), []);
  const blocked = await withApple(routes, () => assert.rejects(ACTIONS.submit_subscriptions.execute({ credentials },
    { app: BUNDLE, products: "app.pro.monthly app.pro.annual" }), /app\.pro\.annual is WAITING_FOR_REVIEW/u));
  assert.deepEqual(writes(blocked.calls), [], "one unready product stops the whole statement");
  const one = await run(routes, `@appstoreconnect:submit_subscriptions:${BUNDLE} app.pro.monthly`);
  assert.deepEqual(writes(one.calls), ["POST /v1/subscriptionSubmissions"]);
});
