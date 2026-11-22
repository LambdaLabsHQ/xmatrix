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

test("multi-page purchase catalogs list and submit later-page products, while truncated catalogs fail closed", async () => {
  const laterRoutes = { ...catalog(),
    "GET /v1/apps/6760000001/inAppPurchasesV2": call => call.query.cursor
      ? { data: [purchase("p-1", "app.beans.later", "CONSUMABLE", "READY_TO_SUBMIT")] }
      : { data: [purchase("p-2", "app.beans.starter", "CONSUMABLE", "APPROVED")],
        links: { next: "https://api.appstoreconnect.apple.com/v1/apps/6760000001/inAppPurchasesV2?cursor=2" } } };
  const complete = await run(laterRoutes, `@appstoreconnect:in_app_purchases:${BUNDLE}`);
  assert.doesNotMatch(complete.value.summary, /list is incomplete/u);
  assert.match(complete.value.summary, /app\.beans\.later/u);
  const submittedLater = await run(laterRoutes, `@appstoreconnect:submit_in_app_purchases:${BUNDLE} app.beans.later`);
  assert.deepEqual(itemsOf(submittedLater.calls), ["iv-1"]);

  const paged = { ...catalog(), "GET /v1/apps/6760000001/inAppPurchasesV2": call => {
    const nextCursor = Number(call.query.cursor ?? "1") + 1;
    return { data: nextCursor === 2 ? [purchase("p-1", "app.beans.starter", "CONSUMABLE", "READY_TO_SUBMIT")] : [],
      links: { next: `https://api.appstoreconnect.apple.com/v1/apps/6760000001/inAppPurchasesV2?cursor=${nextCursor}` } };
  } };
  const shown = await run(paged, `@appstoreconnect:in_app_purchases:${BUNDLE}`);
  assert.match(shown.value.summary, /list is incomplete/u);
  for (const products of ["", "app.beans.starter", "app.beans.later"]) {
    const refused = await withApple(paged, () => assert.rejects(ACTIONS.submit_in_app_purchases.execute({ credentials },
      { app: BUNDLE, products }), /no purchases were submitted/u));
    assert.deepEqual(writes(refused.calls), []);
  }
  const foreign = { ...catalog(), "GET /v1/apps/6760000001/inAppPurchasesV2": { data: [], links: { next: "https://evil.example/v1/apps" } } };
  await assert.rejects(run(foreign, `@appstoreconnect:in_app_purchases:${BUNDLE}`), /outside its API/u);
});

test("in_app_purchases supports resumable cursor continuation beyond 5 pages (#1384)", async () => {
  const sixPages = { ...catalog(), "GET /v1/apps/6760000001/inAppPurchasesV2": call => {
    const page = Number(call.query.cursor ?? "1");
    return {
      data: [purchase(`p-${page}`, `app.beans.page${page}`, "CONSUMABLE", "READY_TO_SUBMIT")],
      ...(page < 6 ? { links: { next: `https://api.appstoreconnect.apple.com/v1/apps/6760000001/inAppPurchasesV2?cursor=${page + 1}` } } : {}),
    };
  } };
  const first = await run(sixPages, `@appstoreconnect:in_app_purchases:${BUNDLE}`);
  assert.match(first.value.summary, /app\.beans\.page5/u);
  assert.doesNotMatch(first.value.summary, /app\.beans\.page6/u);
  const cursorMatch = first.value.summary.match(/Continue with cursor:([A-Za-z0-9_-]+)/u);
  assert.ok(cursorMatch, "incomplete listing prints a resumable continuation cursor");
  const second = await run(sixPages, `@appstoreconnect:in_app_purchases:${BUNDLE} cursor:${cursorMatch[1]}`);
  assert.match(second.value.summary, /app\.beans\.page6/u);
  assert.doesNotMatch(second.value.summary, /list is incomplete/u);
});

test("submit_in_app_purchases freezes exact product identities at prepare, rejects post-approval widening, and recovers partial writes (#1384)", async () => {
  let rows = [purchase("p-1", "app.beans.starter", "CONSUMABLE", "READY_TO_SUBMIT"),
    purchase("p-2", "app.beans.propack", "CONSUMABLE", "READY_TO_SUBMIT")];
  const draftItems = [];
  let failSecondItem = true;
  const routes = {
    ...apps,
    "GET /v1/apps/6760000001/inAppPurchasesV2": () => ({ data: rows }),
    "GET /v1/reviewSubmissions": () => ({ data: draftItems.length ? [{ type: "reviewSubmissions", id: "draft-1", attributes: { state: "READY_FOR_REVIEW" } }] : [] }),
    "POST /v1/reviewSubmissions": { data: { type: "reviewSubmissions", id: "draft-1", attributes: { state: "READY_FOR_REVIEW" } } },
    "GET /v1/reviewSubmissions/draft-1/items": () => ({ data: draftItems.map((versionId, idx) => ({
      type: "reviewSubmissionItems", id: `item-${idx}`,
      relationships: { inAppPurchaseVersion: { data: { type: "inAppPurchaseVersions", id: versionId } } },
    })) }),
    "GET /v2/inAppPurchases/p-1/versions": { data: [{ type: "inAppPurchaseVersions", id: "iv-1", attributes: { state: "PREPARE_FOR_SUBMISSION" } }] },
    "GET /v2/inAppPurchases/p-2/versions": { data: [{ type: "inAppPurchaseVersions", id: "iv-2", attributes: { state: "PREPARE_FOR_SUBMISSION" } }] },
    "POST /v1/reviewSubmissionItems": (call) => {
      const versionId = call.body.relationships.inAppPurchaseVersion.data.id;
      if (versionId === "iv-2" && failSecondItem) {
        failSecondItem = false;
        return { status: 500, errors: [{ detail: "transient Apple failure" }] };
      }
      draftItems.push(versionId);
      return { data: { type: "reviewSubmissionItems", id: `item-${versionId}` } };
    },
  };

  // Prepare freezes exact p-1 and p-2 identities with zero writes.
  const prep = await withApple(routes, () => ACTIONS.submit_in_app_purchases.prepare({ credentials }, { app: BUNDLE, products: "" }));
  assert.deepEqual(writes(prep.calls), []);
  assert.ok(prep.value.preparedDigest);
  assert.match(prep.value.preview, /app\.beans\.starter \(p-1\)/u);

  // Even if a third product becomes READY_TO_SUBMIT after approval, execute submits ONLY the frozen targets.
  rows = [...rows, purchase("p-3", "app.beans.surprise", "CONSUMABLE", "READY_TO_SUBMIT")];

  // First execute fails midway after adding iv-1 (partial write).
  await withApple(routes, () => assert.rejects(ACTIONS.submit_in_app_purchases.execute({ credentials }, prep.value), /transient Apple failure/u));
  assert.deepEqual(draftItems, ["iv-1"]);

  // Replay with the same frozen approval skips iv-1 (already in draft) and completes iv-2; never touches p-3.
  const replayed = await withApple(routes, () => ACTIONS.submit_in_app_purchases.execute({ credentials }, prep.value));
  assert.deepEqual(draftItems, ["iv-1", "iv-2"]);
  assert.deepEqual(itemsOf(replayed.calls), ["iv-2"]);
  assert.doesNotMatch(replayed.value.summary, /app\.beans\.surprise/u);

  // Tampered digest fails closed with zero writes.
  const tampered = await withApple(routes, () => assert.rejects(
    ACTIONS.submit_in_app_purchases.execute({ credentials }, { ...prep.value, preparedDigest: "0".repeat(64) }), /no longer matches/u));
  assert.deepEqual(writes(tampered.calls), []);
});
