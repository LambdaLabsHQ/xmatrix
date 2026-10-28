import assert from "node:assert/strict";
import { test } from "node:test";

import { ACTIONS, apps, BUNDLE, credentials, run, statement, withApple, writes } from "./support/app-store-connect-double.mjs";

const subscription = (id, productId, state) => ({ type: "subscriptions", id,
  attributes: { productId, name: productId.split(".").at(-1), state, groupLevel: 1, subscriptionPeriod: id === "s-year" ? "ONE_YEAR" : "ONE_MONTH" } });
const catalog = (...rows) => ({ ...apps,
  "GET /v1/apps/6760000001/subscriptionGroups": { data: [{ type: "subscriptionGroups", id: "g-1", attributes: { referenceName: "Pro" } }] },
  "GET /v1/subscriptionGroups/g-1/subscriptions": { data: rows } });
/* No open review submission and no versions yet: each subscription and its group get one, and all join a new draft. */
const submitted = {
  "GET /v1/reviewSubmissions": { data: [] },
  "POST /v1/reviewSubmissions": { data: { type: "reviewSubmissions", id: "draft-1", attributes: { state: "READY_FOR_REVIEW" } } },
  "GET /v1/reviewSubmissions/draft-1/items": { data: [] },
  "GET /v1/subscriptionGroups/g-1/versions": { data: [] },
  "GET /v1/subscriptions/s-month/versions": { data: [{ type: "subscriptionVersions", id: "sv-old", attributes: { state: "APPROVED" } }] },
  "GET /v1/subscriptions/s-year/versions": { data: [{ type: "subscriptionVersions", id: "sv-year", attributes: { state: "PREPARE_FOR_SUBMISSION" } }] },
  "POST /v1/subscriptionGroupVersions": { data: { type: "subscriptionGroupVersions", id: "gv-1" } },
  "POST /v1/subscriptionVersions": (call) => ({ data: { type: "subscriptionVersions", id: `sv-${call.body.relationships.subscription.data.id}` } }),
  "POST /v1/reviewSubmissionItems": (call) => ({ data: { type: "reviewSubmissionItems", id: `item-${Object.keys(call.body.relationships).join("-")}` } }),
};
const itemsOf = (calls) => calls.filter(call => call.method === "POST" && call.path === "/v1/reviewSubmissionItems")
  .map(call => Object.entries(call.body.relationships).find(([key]) => key !== "reviewSubmission")).map(([key, value]) => `${key}:${value.data.id}`);

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

test("submit_subscriptions adds each ready subscription and its group to the draft review submission once", async () => {
  const sent = await run({ ...catalog(subscription("s-month", "app.pro.monthly", "READY_TO_SUBMIT"), subscription("s-year", "app.pro.annual", "READY_TO_SUBMIT"),
    subscription("s-old", "app.pro.legacy", "APPROVED")), ...submitted }, `@appstoreconnect:submit_subscriptions:${BUNDLE}`);
  assert.deepEqual(itemsOf(sent.calls), ["subscriptionGroupVersion:gv-1", "subscriptionVersion:sv-s-month", "subscriptionVersion:sv-year"],
    "an approved version gets a new one, a pending one is reused");
  assert.equal(sent.calls.filter(call => call.method === "POST" && call.path === "/v1/reviewSubmissions").length, 1);
  assert.ok(!sent.calls.some(call => call.method === "PATCH"), "the draft is left for submit to send with the app version");
  assert.match(sent.value.summary, /Added app\.pro\.monthly, app\.pro\.annual .*Run submit for the app version/u);

  const again = await run({ ...catalog(subscription("s-year", "app.pro.annual", "READY_TO_SUBMIT")), ...submitted,
    "GET /v1/reviewSubmissions": { data: [{ type: "reviewSubmissions", id: "draft-1", attributes: { state: "READY_FOR_REVIEW" } }] },
    "GET /v1/subscriptionGroups/g-1/versions": { data: [{ type: "subscriptionGroupVersions", id: "gv-ok", attributes: { state: "APPROVED" } }] },
    "GET /v1/reviewSubmissions/draft-1/items": { data: [{ type: "reviewSubmissionItems", id: "i-1",
      relationships: { subscriptionVersion: { data: { type: "subscriptionVersions", id: "sv-year" } } } }] } }, `@appstoreconnect:submit_subscriptions:${BUNDLE}`);
  assert.deepEqual(writes(again.calls), [], "an approved group and an item already in the draft are not added again");

  const none = await run(catalog(subscription("s-old", "app.pro.legacy", "APPROVED")), `@appstoreconnect:submit_subscriptions:${BUNDLE}`);
  assert.match(none.value.summary, /nothing was submitted/u);
  assert.deepEqual(writes(none.calls), []);
});

test("a review submission already sent is not changed", async () => {
  const busy = await withApple({ ...catalog(subscription("s-month", "app.pro.monthly", "READY_TO_SUBMIT")), ...submitted,
    "GET /v1/reviewSubmissions": { data: [{ type: "reviewSubmissions", id: "r-9", attributes: { state: "WAITING_FOR_REVIEW" } }] } },
  () => assert.rejects(ACTIONS.submit_subscriptions.execute({ credentials }, { app: BUNDLE, products: "" }), /open review submission is WAITING_FOR_REVIEW/u));
  assert.deepEqual(writes(busy.calls), []);
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
  assert.deepEqual(itemsOf(one.calls), ["subscriptionGroupVersion:gv-1", "subscriptionVersion:sv-s-month"]);
});
