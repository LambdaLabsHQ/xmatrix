import assert from "node:assert/strict";
import { test } from "node:test";

import { ACTIONS, apps, BUNDLE, credentials, run, statement, withApple, writes } from "./support/app-store-connect-double.mjs";

const purchase = (id, productId, type, state) => ({ type: "inAppPurchases", id,
  attributes: { productId, name: productId.split(".").at(-1), inAppPurchaseType: type, state } });
const catalog = (...rows) => ({ ...apps, "GET /v1/apps/6760000001/inAppPurchasesV2": { data: rows },
  "GET /v1/reviewSubmissions": { data: [] },
  "POST /v1/reviewSubmissions": { data: { type: "reviewSubmissions", id: "draft-1", attributes: { state: "READY_FOR_REVIEW" } } },
  "GET /v1/reviewSubmissions/draft-1/items": { data: [] },
  // p-1 already has a draft version with its metadata; p-2 has only an approved one, so it gets a new version.
  "GET /v2/inAppPurchases/p-1/versions": { data: [{ type: "inAppPurchaseVersions", id: "iv-1", attributes: { state: "PREPARE_FOR_SUBMISSION" } }] },
  "GET /v2/inAppPurchases/p-2/versions": { data: [{ type: "inAppPurchaseVersions", id: "iv-old", attributes: { state: "APPROVED" } }] },
  "POST /v1/inAppPurchaseVersions": (call) => ({ data: { type: "inAppPurchaseVersions", id: `iv-${call.body.relationships.inAppPurchase.data.id}` } }),
  "POST /v1/reviewSubmissionItems": (call) => ({ data: { type: "reviewSubmissionItems", id: `item-${call.body.relationships.inAppPurchaseVersion.data.id}` } }) });
const itemsOf = (calls) => calls.filter(call => call.method === "POST" && call.path === "/v1/reviewSubmissionItems")
  .map(call => call.body.relationships.inAppPurchaseVersion.data.id);

test("in-app purchase statements are validated before any request", () => {
  assert.deepEqual(statement(`@appstoreconnect:in_app_purchases:${BUNDLE}`), { app: BUNDLE });
  assert.deepEqual(statement(`@appstoreconnect:submit_in_app_purchases:${BUNDLE} app.beans.starter`), { app: BUNDLE, products: "app.beans.starter" });
  for (const bad of [`in_app_purchases:${BUNDLE} extra`, `submit_in_app_purchases:${BUNDLE} has/slash`]) {
    assert.equal(typeof statement(`@appstoreconnect:${bad}`), "string", bad);
  }
});

// NomadCafé's coffee-bean packs are consumables: the connector listed only auto-renewable subscriptions,
// so their review state could not be read. Apple then refused the direct inAppPurchaseSubmissions for a
// first purchase ("no pending version"): like a subscription, it is reviewed through a version in the draft.
test("one-time purchases are listed with their type and review state, and the ready ones are submitted", async () => {
  const rows = [purchase("p-1", "app.beans.starter", "CONSUMABLE", "READY_TO_SUBMIT"), purchase("p-2", "app.beans.propack", "CONSUMABLE", "READY_TO_SUBMIT"),
    purchase("p-4", "app.passport.lifetime", "NON_CONSUMABLE", "MISSING_METADATA"), purchase("p-3", "app.beans.old", "CONSUMABLE", "APPROVED")];
  const shown = await run(catalog(...rows), `@appstoreconnect:in_app_purchases:${BUNDLE}`);
  assert.match(shown.value.summary, /app\.beans\.propack\tpropack\tCONSUMABLE\tREADY_TO_SUBMIT\napp\.passport\.lifetime\tlifetime\tNON_CONSUMABLE\tMISSING_METADATA/u);
  assert.deepEqual(writes(shown.calls), []);

  const sent = await run(catalog(...rows), `@appstoreconnect:submit_in_app_purchases:${BUNDLE}`);
  assert.deepEqual(itemsOf(sent.calls), ["iv-1", "iv-p-2"], "a draft version is reused, an approved one gets a new one");
  assert.ok(!sent.calls.some(call => call.path === "/v1/inAppPurchaseSubmissions"), "never the direct submission Apple refuses");
  assert.ok(!sent.calls.some(call => call.method === "PATCH"), "the draft is left for submit to send with the app version");
  assert.match(sent.value.summary, /Added app\.beans\.starter, app\.beans\.propack .*Run submit for the app version/u);

  const blocked = await withApple(catalog(...rows), () => assert.rejects(ACTIONS.submit_in_app_purchases.execute({ credentials },
    { app: BUNDLE, products: "app.beans.starter app.passport.lifetime" }), /app\.passport\.lifetime is MISSING_METADATA/u));
  assert.deepEqual(writes(blocked.calls), [], "one unready product stops the whole statement");
  const missing = await withApple(catalog(...rows), () => assert.rejects(ACTIONS.submit_in_app_purchases.execute({ credentials },
    { app: BUNDLE, products: "app.beans.mega" }), /no In-App Purchase app\.beans\.mega/u));
  assert.deepEqual(writes(missing.calls), []);
});
