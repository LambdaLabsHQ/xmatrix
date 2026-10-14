import assert from "node:assert/strict";
import { test } from "node:test";

import { ACTIONS, apps, APP, BUNDLE, credentials, statement, withApple, writes } from "./support/app-store-connect-double.mjs";

const session = { ...credentials, webSession: "myacinfo=abc123; itctx=t1" };
const run = (body, routes, keys = session) => {
  const input = statement(body);
  assert.equal(typeof input, "object", `parses: ${input}`);
  const action = ACTIONS[body.match(/^@appstoreconnect:([a-z_]+):/u)[1]];
  return withApple(routes, () => action.execute({ credentials: keys, saveCredentials: async () => {} }, input));
};
const bundle = { "GET /v1/bundleIds": { data: [{ type: "bundleIds", id: "b1", attributes: { identifier: BUNDLE, name: "Example", platform: "IOS" } }] } };
const create = '@appstoreconnect:create_app:com.example.app {"name":"Example","sku":"EXAMPLE","locale":"en-US"}';

test("create_app sends the website's app record with its first version, through the session alone", async () => {
  const done = await run(create, { "GET /v1/apps": { data: [] }, ...bundle,
    "POST /iris/v1/apps": { data: { type: "apps", id: "6760000009" } } });
  const post = done.calls.find((call) => call.path === "/iris/v1/apps");
  assert.equal(post.origin, "https://appstoreconnect.apple.com");
  assert.equal(post.authorization, null, "the website never gets the API key's token");
  assert.equal(post.cookie, "myacinfo=abc123; itctx=t1");
  assert.deepEqual(post.body.attributes, { sku: "EXAMPLE", primaryLocale: "en-US", bundleId: BUNDLE });
  assert.deepEqual(post.included.map((row) => `${row.type} ${JSON.stringify(row.attributes ?? {})}`), [
    "appInfos {}", 'appInfoLocalizations {"locale":"en-US","name":"Example"}',
    'appStoreVersions {"platform":"IOS","versionString":"1.0"}', 'appStoreVersionLocalizations {"locale":"en-US"}']);
  assert.equal(post.body.relationships.appStoreVersions.data[0].id, post.included[2].id, "the version is tied to the app by its placeholder id");
  assert.match(done.value.summary, /Created the app record Example for com\.example\.app \(Apple id 6760000009\), with version 1\.0/u);
});

test("create_app refuses an app that exists or a bundle ID that is not registered, before touching the website", async () => {
  const exists = await run(create, { ...apps }).catch((error) => error);
  assert.match(exists.message, /already has an app record, Example \(6760000001\)/u);
  const unregistered = await run(create, { "GET /v1/apps": { data: [] }, "GET /v1/bundleIds": { data: [] } }).catch((error) => error);
  assert.match(unregistered.message, /not a registered bundle ID; run register_bundle_id first/u);
  for (const bad of ['{"name":"Example","sku":"bad sku","locale":"en-US"}', '{"name":"Example","sku":"E","locale":"en-US","platform":"android"}',
    '{"name":"An app name that is far too long to fit","sku":"E","locale":"en-US"}', '{"name":"Example","sku":"E","locale":"en-US","extra":1}']) {
    assert.equal(typeof statement(`@appstoreconnect:create_app:com.example.app ${bad}`), "string", bad);
  }
});

test("Apple's refusal comes back in Apple's words, and a bare 403 means the session lapsed", async () => {
  const taken = await run(create, { "GET /v1/apps": { data: [] }, ...bundle,
    "POST /iris/v1/apps": { status: 409, errors: [{ status: "409", code: "ENTITY_ERROR", detail: "The App Name you entered is already being used." }] } }).catch((error) => error);
  assert.match(taken.message, /website returned 409: The App Name you entered is already being used\./u);
  const lapsed = await run(create, { "GET /v1/apps": { data: [] }, ...bundle, "POST /iris/v1/apps": { status: 403 } }).catch((error) => error);
  assert.match(lapsed.message, /web session is missing or has expired/u);
});

const privacyRoutes = (existing = []) => ({ ...apps,
  "GET /iris/v1/appDataUsageCategories": { data: ["EMAIL_ADDRESS", "CRASH_DATA"].map((id) => ({ type: "appDataUsageCategories", id })) },
  "GET /iris/v1/appDataUsagePurposes": { data: ["APP_FUNCTIONALITY", "ANALYTICS"].map((id) => ({ type: "appDataUsagePurposes", id })) },
  [`GET /iris/v1/apps/${APP.id}/dataUsages`]: { data: existing },
  "DELETE /iris/v1/appDataUsages/u1": null,
  "POST /iris/v1/appDataUsages": { data: { type: "appDataUsages", id: "new" } },
  [`GET /iris/v1/apps/${APP.id}/dataUsagePublishState`]: { data: { type: "appDataUsagesPublishState", id: "p1", attributes: { published: false } } },
  "PATCH /iris/v1/appDataUsagesPublishState/p1": { data: { type: "appDataUsagesPublishState", id: "p1", attributes: { published: true } } },
});

test("set_privacy replaces every answer, one per purpose and protection, then publishes", async () => {
  const body = '@appstoreconnect:set_privacy:com.example.app {"data":[{"category":"EMAIL_ADDRESS","purposes":["APP_FUNCTIONALITY","ANALYTICS"],"linked":true,"tracking":true}]}';
  const done = await run(body, privacyRoutes([{ type: "appDataUsages", id: "u1" }]));
  assert.deepEqual(writes(done.calls), ["DELETE /iris/v1/appDataUsages/u1", ...Array(4).fill("POST /iris/v1/appDataUsages"),
    "PATCH /iris/v1/appDataUsagesPublishState/p1"]);
  const sent = done.calls.filter((call) => call.method === "POST").map((call) => call.body.relationships);
  assert.deepEqual(sent.map((rel) => `${rel.category.data.id} ${rel.purpose.data.id} ${rel.dataProtection.data.id}`), [
    "EMAIL_ADDRESS APP_FUNCTIONALITY DATA_LINKED_TO_YOU", "EMAIL_ADDRESS APP_FUNCTIONALITY DATA_USED_TO_TRACK_YOU",
    "EMAIL_ADDRESS ANALYTICS DATA_LINKED_TO_YOU", "EMAIL_ADDRESS ANALYTICS DATA_USED_TO_TRACK_YOU"]);
  assert.ok(sent.every((rel) => rel.app.data.id === APP.id));
  assert.equal(done.calls.find((call) => call.method === "PATCH").body.attributes.published, true);
  assert.match(done.value.summary, /1 data type\(s\) are collected \(EMAIL_ADDRESS\); 4 answer\(s\) sent, 1 earlier one\(s\) replaced, published\./u);
});

test("set_privacy says no data is collected with one answer, and checks ids against Apple's lists first", async () => {
  const none = await run('@appstoreconnect:set_privacy:com.example.app {"data":[],"publish":false}', privacyRoutes());
  assert.deepEqual(writes(none.calls), ["POST /iris/v1/appDataUsages"]);
  assert.deepEqual(none.calls.find((call) => call.method === "POST").body.relationships.dataProtection.data.id, "DATA_NOT_COLLECTED");
  assert.equal(none.calls.find((call) => call.method === "POST").body.relationships.category, undefined);
  assert.match(none.value.summary, /no data is collected; 1 answer\(s\) sent, 0 earlier one\(s\) replaced, left unpublished/u);
  const routes = privacyRoutes([{ type: "appDataUsages", id: "u1" }]);
  let removed = false;
  routes["DELETE /iris/v1/appDataUsages/u1"] = () => { removed = true; return null; };
  const unknown = await run('@appstoreconnect:set_privacy:com.example.app {"data":[{"category":"HEARTBEAT","purposes":["ANALYTICS"],"linked":false,"tracking":false}]}',
    routes).catch((error) => error);
  assert.match(unknown.message, /HEARTBEAT is not one of Apple's data types: CRASH_DATA, EMAIL_ADDRESS/u);
  assert.equal(removed, false, "nothing is removed before the answers are known to be valid");
  for (const bad of ['{"data":[{"category":"EMAIL_ADDRESS","purposes":["ANALYTICS"]}]}', '{"data":[{"category":"EMAIL_ADDRESS","purposes":[],"linked":true,"tracking":false}]}',
    '{"data":[{"category":"EMAIL_ADDRESS","purposes":["ANALYTICS"],"linked":true,"tracking":false},{"category":"EMAIL_ADDRESS","purposes":["ANALYTICS"],"linked":true,"tracking":false}]}',
    '{"collected":false}']) {
    assert.equal(typeof statement(`@appstoreconnect:set_privacy:com.example.app ${bad}`), "string", bad);
  }
});

test("a set_privacy cut short says how far it got", async () => {
  const routes = privacyRoutes([{ type: "appDataUsages", id: "u1" }]);
  routes["POST /iris/v1/appDataUsages"] = { status: 409, errors: [{ detail: "Conflicting answer" }] };
  const failed = await run('@appstoreconnect:set_privacy:com.example.app {"data":[{"category":"CRASH_DATA","purposes":["ANALYTICS"],"linked":false,"tracking":false}]}', routes)
    .catch((error) => error);
  assert.match(failed.message, /Conflicting answer\. App Privacy is part way: 1 earlier answer\(s\) removed and 0 sent; run set_privacy again/u);
});

test("privacy reads the answers by data type and whether they are published", async () => {
  const usage = (id, category, purpose, protection) => ({ type: "appDataUsages", id, relationships: {
    category: { data: { type: "appDataUsageCategories", id: category } }, purpose: { data: { type: "appDataUsagePurposes", id: purpose } },
    dataProtection: { data: { type: "appDataUsageDataProtections", id: protection } } } });
  const read = await run("@appstoreconnect:privacy:com.example.app", { ...apps,
    [`GET /iris/v1/apps/${APP.id}/dataUsages`]: { data: [usage("a", "EMAIL_ADDRESS", "APP_FUNCTIONALITY", "DATA_LINKED_TO_YOU"),
      usage("b", "EMAIL_ADDRESS", "ANALYTICS", "DATA_LINKED_TO_YOU"), usage("c", "CRASH_DATA", "ANALYTICS", "DATA_NOT_LINKED_TO_YOU")] },
    [`GET /iris/v1/apps/${APP.id}/dataUsagePublishState`]: { data: { type: "appDataUsagesPublishState", id: "p1", attributes: { published: true } } } });
  assert.equal(read.value.summary, "com.example.app App Privacy (published), 2 data type(s):\n" +
    "- EMAIL_ADDRESS: APP_FUNCTIONALITY, ANALYTICS; linked to the user\n- CRASH_DATA: ANALYTICS; not linked");
});
