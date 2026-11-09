import assert from "node:assert/strict";
import { test } from "node:test";
import { ACTIONS, credentials, run, statement, withApple, writes } from "./support/app-store-connect-double.mjs";

const command = (action, operation, request = {}) => `@appstoreconnect:${action}:${operation} ${JSON.stringify(request)}`;
const update = { path: { id: "app-1" }, body: { data: { type: "apps", id: "app-1", attributes: {
  subscriptionStatusUrl: "https://example.com/apple/notifications", subscriptionStatusUrlVersion: "V2" } } } };
const app = name => ({ type: "apps", id: "app-1", attributes: { name } });
const digestOf = result => result.value.summary.match(/digest ([a-f0-9]{64})/u)[1];
const execute = async (action, input, routes, extra = {}) => withApple(routes, () => ACTIONS[action].execute({ credentials, ...extra }, input));

test("official operations preserve read/write authority and validate origin, path, enums and required fields before authentication", async () => {
  for (const [operation, request] of [["apps_getInstance", { path: { id: "../users" } }],
    ["apps_getInstance", { path: { id: "https://evil.test/app" } }], ["apps_getInstance", { path: { id: "app-1" }, query: { arbitrary: true } }],
    ["apps_getCollection", { query: { limit: 201 } }], ["apps_getCollection", { query: { "fields[apps]": ["demoAccountPassword"] } }],
    ["subscriptions_createInstance", { body: { data: { type: "subscriptions", attributes: {} } } }],
    ["apps_updateInstance", { ...update, body: { data: { type: "apps", id: "app-1", attributes: { subscriptionStatusUrlVersion: "made-up" } } } }]]) {
    assert.equal(typeof statement(command("api_read", operation, request)), "string");
  }
  assert.equal(typeof statement(command("api_read", "__proto__")), "string");
  assert.equal(typeof statement(`@appstoreconnect:api_read:apps_getCollection {"query":{"__proto__":{}}}`), "string");
  const refused = await withApple({}, async () => {
    const write = statement(command("api_read", "apps_updateInstance", update));
    await assert.rejects(ACTIONS.api_read.execute({ credentials: {} }, write), /cannot run through api_read/u);
    const read = statement(command("api_write", "apps_getCollection"));
    await assert.rejects(ACTIONS.api_write.execute({ credentials: {} }, read), /Use api_read/u);
  });
  assert.equal(refused.calls.length, 0);
});

test("catalog search and schemas expose provider-owned capabilities without credentials or hidden per-action truncation", async () => {
  const search = await ACTIONS.api_operations.execute({ credentials: {} }, { search: "subscriptionPlanAvailabilities" });
  assert.match(search.summary, /subscriptionPlanAvailabilities_createInstance/u);
  const contract = await ACTIONS.api_schema.execute({ credentials: {} }, { name: "SubscriptionCreateRequest" });
  assert.match(contract.summary, /productId/u);
  assert.match(contract.summary, /subscriptionPeriod/u);
  await assert.rejects(ACTIONS.api_schema.execute({ credentials: {} }, { name: "constructor" }), /unresolved schema/u);
  assert.equal(ACTIONS.api_write.effect, "write");
});

test("reads serialize typed query arrays, page cursors and vendor JSON while hiding review credentials", async () => {
  const response = { data: app("Example"), included: [{ type: "appStoreReviewDetails", id: "review-1", attributes: {
    contactEmail: "private-contact@example.com", notes: "Password is private-notes", demoAccountName: "private-login", demoAccountPassword: "private-password",
    demoAccountRequired: true } }], links: { next: "https://api.appstoreconnect.apple.com/v1/apps?cursor=next" } };
  const read = await run({ "GET /v1/apps": response }, command("api_read", "apps_getCollection", {
    query: { "fields[apps]": ["name", "bundleId"], limit: 10, cursor: "next" } }));
  assert.deepEqual(read.calls[0].query, { "fields[apps]": "name,bundleId", limit: "10", cursor: "next" });
  assert.doesNotMatch(read.value.summary, /private-(?:contact|notes|login|password)/u);
  assert.match(read.value.summary, /demoAccountRequired/u);
  assert.equal(read.calls[0].origin, "https://api.appstoreconnect.apple.com");
  assert.equal(read.calls[0].cookie, null);
});

test("a write binds the request and current resource, rechecks permission, and never overwrites a changed snapshot", async () => {
  let current = app("Before");
  const routes = { "GET /v1/apps/app-1": () => ({ data: current }), "PATCH /v1/apps/app-1": call => {
    current = { ...current, attributes: { ...current.attributes, ...call.body.attributes } }; return { data: current };
  } };
  const preview = await run(routes, command("api_plan", "apps_updateInstance", update));
  assert.deepEqual(writes(preview.calls), []);
  const input = statement(command("api_write", "apps_updateInstance", { ...update, digest: digestOf(preview) }));
  await withApple(routes, () => ACTIONS.api_write.prepare({ credentials }, input));
  let grants = 0;
  const accepted = await execute("api_write", input, routes, { authorizeWrite: async () => { grants++; } });
  assert.equal(grants, 1);
  assert.deepEqual(writes(accepted.calls), ["PATCH /v1/apps/app-1"]);
  assert.match(accepted.value.summary, /Apple accepted/u);
  const stale = await withApple(routes, async () => {
    await assert.rejects(ACTIONS.api_write.execute({ credentials }, input), /resource changed/u);
  });
  assert.deepEqual(writes(stale.calls), []);
  const changed = statement(command("api_write", "apps_updateInstance", { ...update,
    body: { data: { type: "apps", id: "app-1", attributes: { subscriptionStatusUrl: "https://different.example.com" } } }, digest: digestOf(preview) }));
  const refused = await withApple(routes, () => assert.rejects(ACTIONS.api_write.execute({ credentials }, changed), /request or resource changed/u));
  assert.deepEqual(writes(refused.calls), []);
  const next = await run(routes, command("api_plan", "apps_updateInstance", update));
  const revoked = await withApple(routes, () => assert.rejects(ACTIONS.api_write.execute({ credentials,
    authorizeWrite: async () => { throw new Error("grant revoked"); } },
  statement(command("api_write", "apps_updateInstance", { ...update, digest: digestOf(next) }))), /grant revoked/u));
  assert.deepEqual(writes(revoked.calls), []);
});

test("API deletes require a current resource digest; uncertain creates are never automatically retried", async () => {
  const deletion = { path: { id: "reply-1" } };
  const routes = { "GET /v1/customerReviewResponses/reply-1": { data: { type: "customerReviewResponses", id: "reply-1", attributes: { responseBody: "old" } } },
    "DELETE /v1/customerReviewResponses/reply-1": null };
  const planned = await run(routes, command("api_plan", "customerReviewResponses_deleteInstance", deletion));
  const missing = await withApple(routes, () => assert.rejects(ACTIONS.api_write.execute({ credentials },
    statement(command("api_write", "customerReviewResponses_deleteInstance", deletion))), /resource changed/u));
  assert.deepEqual(writes(missing.calls), []);
  const deleted = await run(routes, command("api_write", "customerReviewResponses_deleteInstance", { ...deletion, digest: digestOf(planned) }));
  assert.deepEqual(writes(deleted.calls), ["DELETE /v1/customerReviewResponses/reply-1"]);
  const creation = { body: { data: { type: "subscriptionGroups", attributes: { referenceName: "Example" }, relationships: { app: { data: { type: "apps", id: "app-1" } } } } } };
  const preview = await run({}, command("api_plan", "subscriptionGroups_createInstance", creation));
  let count = 0;
  const uncertain = await withApple({ "POST /v1/subscriptionGroups": () => { count++; throw new Error("network result lost"); } }, async () => {
    await assert.rejects(ACTIONS.api_write.execute({ credentials }, statement(command("api_write", "subscriptionGroups_createInstance", {
      ...creation, digest: digestOf(preview) }))), /network result lost/u);
  });
  assert.equal(count, 1);
  assert.equal(writes(uncertain.calls).length, 1);
});

test("sign-in secrets cannot enter API mutations and malformed write results are explicitly uncertain", async () => {
  const fields = { path: { id: "review-1" }, body: { data: { type: "appStoreReviewDetails", id: "review-1", attributes: { demoAccountPassword: "never-send" } } } };
  assert.match(statement(command("api_plan", "appStoreReviewDetails_updateInstance", fields)), /credentials/u);
  const routes = { "GET /v1/apps/app-1": { data: app("Before") }, "PATCH /v1/apps/app-1": {} };
  const planned = await run(routes, command("api_plan", "apps_updateInstance", update));
  await withApple(routes, () => assert.rejects(ACTIONS.api_write.execute({ credentials }, statement(command("api_write", "apps_updateInstance", {
    ...update, digest: digestOf(planned) }))), /could not be verified.*before any retry/u));
});

test("resources read only through collections need an exact complete snapshot; foreign IDs and sparse fields cannot authorize deletion", async () => {
  const source = { operation: "subscriptions_introductoryOffers_getToManyRelated", path: { id: "sub-1" } };
  let current = { type: "subscriptionIntroductoryOffers", id: "offer-1", attributes: { endDate: "2026-12-31" } };
  const request = { path: { id: "offer-1" }, snapshot: source };
  const routes = { "GET /v1/subscriptions/sub-1/introductoryOffers": () => ({ data: [current] }), "DELETE /v1/subscriptionIntroductoryOffers/offer-1": null };
  const preview = await run(routes, command("api_plan", "subscriptionIntroductoryOffers_deleteInstance", request));
  const input = statement(command("api_write", "subscriptionIntroductoryOffers_deleteInstance", { ...request, digest: digestOf(preview) }));
  current = { ...current, id: "another-offer" };
  const wrong = await withApple(routes, () => assert.rejects(ACTIONS.api_write.execute({ credentials }, input), /exactly one complete target/u));
  assert.deepEqual(writes(wrong.calls), []);
  current = { ...current, id: "offer-1" };
  const deleted = await execute("api_write", input, routes);
  assert.deepEqual(writes(deleted.calls), ["DELETE /v1/subscriptionIntroductoryOffers/offer-1"]);
  const sparse = statement(command("api_plan", "subscriptionIntroductoryOffers_deleteInstance", {
    ...request, snapshot: { ...source, query: { "fields[subscriptionIntroductoryOffers]": ["endDate"] } } }));
  await withApple(routes, () => assert.rejects(ACTIONS.api_plan.execute({ credentials }, sparse), /no sparse fields/u));
});

test("the official subscription create contract preserves nullable attributes and JSON:API relationships", async () => {
  const request = { body: { data: { type: "subscriptions", attributes: { name: "Monthly", productId: "com.example.monthly",
    subscriptionPeriod: "ONE_MONTH", familySharable: null }, relationships: { group: { data: { type: "subscriptionGroups", id: "group-1" } } } } } };
  const preview = await run({}, command("api_plan", "subscriptions_createInstance", request));
  const created = await run({ "POST /v1/subscriptions": call => {
    assert.deepEqual(call.body, request.body.data); return { data: { type: "subscriptions", id: "sub-1", attributes: call.body.attributes } };
  } }, command("api_write", "subscriptions_createInstance", { ...request, digest: digestOf(preview) }));
  assert.deepEqual(writes(created.calls), ["POST /v1/subscriptions"]);
  const csv = await run({ "GET /v1/subscriptionOfferCodeOneTimeUseCodes/codes-1/values": new Response("CODE-1\nCODE-2", {
    headers: { "content-type": "text/csv" } }) }, command("api_read", "subscriptionOfferCodeOneTimeUseCodes_values_getToOneRelated", { path: { id: "codes-1" } }));
  assert.match(csv.value.summary, /CODE-1/u);
});

test("relationship POSTs bind current membership just like replacements and refuse a stale plan", async () => {
  const operation = "betaGroups_betaTesters_createToManyRelationship";
  const path = "/v1/betaGroups/group-1/relationships/betaTesters";
  const request = { path: { id: "group-1" }, body: { data: [{ type: "betaTesters", id: "tester-new" }] } };
  let data = [{ type: "betaTesters", id: "tester-old" }];
  const routes = { [`GET ${path}`]: () => ({ data }), [`POST ${path}`]: null };
  const preview = await run(routes, command("api_plan", operation, request));
  assert.deepEqual(preview.calls.map(call => `${call.method} ${call.path}`), [`GET ${path}`]);
  const input = statement(command("api_write", operation, { ...request, digest: digestOf(preview) }));
  data = [{ type: "betaTesters", id: "someone-else" }];
  const stale = await withApple(routes, () => assert.rejects(ACTIONS.api_write.execute({ credentials }, input), /resource changed/u));
  assert.deepEqual(writes(stale.calls), []);
  data = [{ type: "betaTesters", id: "tester-old" }];
  const accepted = await execute("api_write", input, routes);
  assert.deepEqual(writes(accepted.calls), [`POST ${path}`]);
});

test("a relationship plan requires complete, unambiguous linkage for direct and catalog snapshots", async () => {
  const direct = { operation: "appScreenshotSets_appScreenshots_replaceToManyRelationship", path: "/v1/appScreenshotSets/set-1/relationships/appScreenshots",
    request: { path: { id: "set-1" }, body: { data: [{ type: "appScreenshots", id: "shot-1" }] } } };
  const indirect = { operation: "builds_betaGroups_deleteToManyRelationship", path: "/v1/builds/build-1/relationships/betaGroups",
    request: { path: { id: "build-1" }, body: { data: [{ type: "betaGroups", id: "group-1" }] },
      snapshot: { operation: "builds_getInstance", path: { id: "build-1" }, query: { include: ["betaGroups"] } } } };
  for (const sample of [direct, indirect]) {
    const rows = sample.request.body.data;
    for (const relationship of [
      { data: rows, links: { next: "https://api.appstoreconnect.apple.com/next" } },
      { data: rows, meta: { paging: { total: 2 } } },
      { data: rows, meta: { paging: { total: "unknown" } } },
      { data: rows, links: "malformed" },
      { data: rows, meta: { paging: null } },
      { data: [...rows, ...rows] },
      { data: [{}] },
    ]) {
      const routes = sample === direct ? { [`GET ${sample.path}`]: relationship }
        : { "GET /v1/builds/build-1": { data: { type: "builds", id: "build-1", attributes: {}, relationships: { betaGroups: relationship } } } };
      const input = statement(command("api_plan", sample.operation, sample.request));
      assert.equal(typeof input, "object", "the provider schema admits the request");
      const refused = await withApple(routes, async () => {
        for (const action of ["api_plan", "api_write"]) {
          await assert.rejects(ACTIONS[action].execute({ credentials }, input), /complete.*relationship/u);
        }
      });
      assert.deepEqual(writes(refused.calls), []);
    }
  }
});

test("empty and null complete relationships remain usable snapshots", async () => {
  for (const [operation, path, body, data] of [
    ["appScreenshotSets_appScreenshots_replaceToManyRelationship", "/v1/appScreenshotSets/set-1/relationships/appScreenshots",
      { data: [] }, []],
    ["appStoreVersions_build_updateToOneRelationship", "/v1/appStoreVersions/set-1/relationships/build",
      { data: { type: "builds", id: "build-new" } }, null],
  ]) {
    const request = { path: { id: "set-1" }, body };
    const routes = { [`GET ${path}`]: { data, links: { next: null }, meta: { paging: { total: 0 } } }, [`PATCH ${path}`]: {} };
    const preview = await run(routes, command("api_plan", operation, request));
    const accepted = await run(routes, command("api_write", operation, { ...request, digest: digestOf(preview) }));
    assert.deepEqual(writes(accepted.calls), [`PATCH ${path}`]);
  }
});
