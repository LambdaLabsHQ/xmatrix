import assert from "node:assert/strict";
import { test } from "node:test";

import { ACTIONS, apps, BUNDLE, credentials, run, statement, withApple, writes } from "./support/app-store-connect-double.mjs";

const purchase = (id, productId, type, state) => ({ type: "inAppPurchases", id,
  attributes: { productId, name: productId.split(".").at(-1), inAppPurchaseType: type, state } });
const catalog = (...rows) => ({ ...apps, "GET /v1/apps/6760000001/inAppPurchasesV2": { data: rows },
  "POST /v1/inAppPurchaseSubmissions": (call) => ({ data: { type: "inAppPurchaseSubmissions", id: `sub-${call.body.relationships.inAppPurchaseV2.data.id}` } }) });
const submittedIds = (calls) => calls.filter(call => call.method === "POST" && call.path === "/v1/inAppPurchaseSubmissions")
  .map(call => call.body.relationships.inAppPurchaseV2.data.id);

test("in-app purchase statements are validated before any request", () => {
  assert.deepEqual(statement(`@appstoreconnect:in_app_purchases:${BUNDLE}`), { app: BUNDLE });
  assert.deepEqual(statement(`@appstoreconnect:submit_in_app_purchases:${BUNDLE} app.beans.starter`), { app: BUNDLE, products: "app.beans.starter" });
  for (const bad of [`in_app_purchases:${BUNDLE} extra`, `submit_in_app_purchases:${BUNDLE} has/slash`]) {
    assert.equal(typeof statement(`@appstoreconnect:${bad}`), "string", bad);
  }
});

// NomadCafé's coffee-bean packs are consumables: the connector listed only auto-renewable subscriptions,
// so their review state could not be read and they could not join a resubmission.
test("one-time purchases are listed with their type and review state, and the ready ones are submitted", async () => {
  const rows = [purchase("p-1", "app.beans.starter", "CONSUMABLE", "READY_TO_SUBMIT"),
    purchase("p-2", "app.passport.lifetime", "NON_CONSUMABLE", "MISSING_METADATA"), purchase("p-3", "app.beans.old", "CONSUMABLE", "APPROVED")];
  const shown = await run(catalog(...rows), `@appstoreconnect:in_app_purchases:${BUNDLE}`);
  assert.match(shown.value.summary, /app\.beans\.starter\tstarter\tCONSUMABLE\tREADY_TO_SUBMIT\napp\.passport\.lifetime\tlifetime\tNON_CONSUMABLE\tMISSING_METADATA/u);
  assert.deepEqual(writes(shown.calls), []);

  const sent = await run(catalog(...rows), `@appstoreconnect:submit_in_app_purchases:${BUNDLE}`);
  assert.deepEqual(submittedIds(sent.calls), ["p-1"], "by default only what is ready to submit");
  assert.match(sent.value.summary, /Submitted app\.beans\.starter .*run submit for that version/u);

  const blocked = await withApple(catalog(...rows), () => assert.rejects(ACTIONS.submit_in_app_purchases.execute({ credentials },
    { app: BUNDLE, products: "app.beans.starter app.passport.lifetime" }), /app\.passport\.lifetime is MISSING_METADATA/u));
  assert.deepEqual(writes(blocked.calls), [], "one unready product stops the whole statement");
  const missing = await withApple(catalog(...rows), () => assert.rejects(ACTIONS.submit_in_app_purchases.execute({ credentials },
    { app: BUNDLE, products: "app.beans.mega" }), /no In-App Purchase app\.beans\.mega/u));
  assert.deepEqual(writes(missing.calls), []);
});
