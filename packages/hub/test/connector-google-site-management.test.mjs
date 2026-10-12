import assert from "node:assert/strict";
import { test } from "node:test";
import { withProviderResponses as fetched } from "./support/fetch-responses.mjs";
import { GOOGLE_SEARCH_CONSOLE_ACTIONS as actions, searchAnalyticsOptions } from "../src/connectors/actions/google-search-console.ts";
import { actionRefusal } from "../src/connectors/connector-commands.ts";

const credentials = { oauthToken: "test-access", oauthScopes: "https://www.googleapis.com/auth/webmasters https://www.googleapis.com/auth/siteverification" };
const property = "sc-domain:example.com";
const resource = { id: "http://example.com/", site: { type: "INET_DOMAIN", identifier: "example.com" }, owners: ["owner@example.com"] };
const parse = (id, target = property, text = "") => actions[id].parse({ target, text });

// Protect the provider HTTP boundary: missing actions, wrong verbs/escaping, grant upgrades,
// or accepting a different site's verification response must fail here. Existing query tests
// cover basic reads; they do not exercise these new mutations or verification requests.
test("property and sitemap management use exact typed addresses and distinguish add from verification", async () => {
  const added = await fetched([{ status: 204, raw: null }], () => actions.add_site.execute({ credentials }, parse("add_site")));
  assert.equal(added.calls[0].method, "PUT");
  assert.equal(added.calls[0].url, "https://www.googleapis.com/webmasters/v3/sites/sc-domain%3Aexample.com");
  assert.equal(added.calls[0].body, undefined);
  assert.match(added.result.summary, /verification is a separate step/u);
  const read = await fetched([{ body: { siteUrl: property, permissionLevel: "siteUnverifiedUser" } }], () => actions.get_site.execute({ credentials }, parse("get_site")));
  assert.match(read.result.summary, /siteUnverifiedUser/u);
  const deleted = await fetched([{ status: 204, raw: null }], () => actions.delete_site.execute({ credentials }, parse("delete_site")));
  assert.equal(deleted.calls[0].method, "DELETE");
  const page = "https://example.com/sitemap.xml";
  const sitemap = await fetched([{ body: { path: page, isPending: true } }], () => actions.get_sitemap.execute({ credentials }, parse("get_sitemap", property, page)));
  assert.match(sitemap.result.summary, /isPending/u);
  assert.equal(sitemap.calls[0].url, "https://www.googleapis.com/webmasters/v3/sites/sc-domain%3Aexample.com/sitemaps/https%3A%2F%2Fexample.com%2Fsitemap.xml");
  const removed = await fetched([{ status: 204, raw: null }], () => actions.delete_sitemap.execute({ credentials }, parse("delete_sitemap", property, page)));
  assert.equal(removed.calls[0].method, "DELETE");
  assert.equal(removed.calls[0].url, sitemap.calls[0].url);
  assert.equal(typeof parse("delete_sitemap", property, "https://evil.example/sitemap.xml"), "string");
  assert.equal(typeof parse("delete_site", property, "extra"), "string");
  await fetched([{ body: { siteUrl: "sc-domain:elsewhere.com", permissionLevel: "siteOwner" } }], () => assert.rejects(actions.get_site.execute({ credentials }, parse("get_site"))));
});

test("verification tokens map only valid domain/site methods and are inert public records", async () => {
  const token = await fetched([{ body: { method: "DNS_TXT", token: "google-site-verification=public-record" } }],
    () => actions.get_verification_token.execute({ credentials }, parse("get_verification_token", property, "DNS_TXT")));
  assert.equal(token.calls[0].url, "https://www.googleapis.com/siteVerification/v1/token");
  assert.equal(token.calls[0].method, "POST");
  assert.deepEqual(token.calls[0].body, { site: { type: "INET_DOMAIN", identifier: "example.com" }, verificationMethod: "DNS_TXT" });
  assert.match(token.result.summary, /google-site-verification=public-record/u);
  assert.deepEqual(parse("verify_site", "https://example.com/", "FILE"), { type: "SITE", identifier: "https://example.com/", method: "FILE" });
  for (const [target, method] of [[property, "FILE"], [property, "DNS"], [property, "DNS_TXT extra"], ["https://example.com/", "DNS_TXT"], ["*", "META"]]) {
    assert.equal(typeof parse("verify_site", target, method), "string");
  }
  const verified = await fetched([{ body: resource }], () => actions.verify_site.execute({ credentials }, parse("verify_site", property, "DNS_TXT")));
  assert.equal(verified.calls[0].url, "https://www.googleapis.com/siteVerification/v1/webResource?verificationMethod=DNS_TXT");
  assert.equal(verified.calls[0].method, "POST");
  assert.deepEqual(verified.calls[0].body, { site: { type: "INET_DOMAIN", identifier: "example.com" } });
  assert.match(verified.result.summary, /Ownership verified/u);
});

test("verification refuses legacy grants before HTTP and rejects mismatched or denied provider confirmations", async () => {
  for (const old of [{ oauthToken: "old" }, { oauthToken: "old", oauthScopes: "https://www.googleapis.com/auth/webmasters" }]) {
    const result = await fetched([], () => assert.rejects(actions.get_verification_token.execute({ credentials: old }, parse("get_verification_token", property, "DNS_TXT")), /Reconnect/u));
    assert.equal(result.calls.length, 0);
  }
  for (const body of [{ method: "FILE", token: "wrong" }, {}, { method: "DNS_TXT", token: "" }]) {
    await fetched([{ body }], () => assert.rejects(actions.get_verification_token.execute({ credentials }, parse("get_verification_token", property, "DNS_TXT"))));
  }
  await fetched([{ body: { ...resource, site: { ...resource.site, identifier: "elsewhere.com" } } }],
    () => assert.rejects(actions.verify_site.execute({ credentials }, parse("verify_site", property, "DNS_TXT"))));
  await fetched([{ status: 403, body: {} }], () => assert.rejects(actions.verify_site.execute({ credentials }, parse("verify_site", property, "DNS_TXT")), /403/u));
});

test("verification resource reads, owner replacement and unverification encode opaque ids", async () => {
  const listed = await fetched([{ body: { items: [resource] } }], () => actions.list_verifications.execute({ credentials }, parse("list_verifications", "*")));
  assert.equal(listed.calls[0].url, "https://www.googleapis.com/siteVerification/v1/webResource");
  assert.match(listed.result.summary, /owner@example.com/u);
  const read = await fetched([{ body: resource }], () => actions.get_verification.execute({ credentials }, parse("get_verification", resource.id)));
  assert.equal(read.calls[0].url, "https://www.googleapis.com/siteVerification/v1/webResource/http%3A%2F%2Fexample.com%2F");
  const replaced = await fetched([{ body: resource }], () => actions.update_verification_owners.execute({ credentials }, parse("update_verification_owners", resource.id, '{"owners":["owner@example.com"]}')));
  assert.equal(replaced.calls[0].method, "PUT");
  assert.deepEqual(replaced.calls[0].body, { owners: ["owner@example.com"] });
  const deleted = await fetched([{ status: 204, raw: null }], () => actions.delete_verification.execute({ credentials }, parse("delete_verification", resource.id)));
  assert.equal(deleted.calls[0].method, "DELETE");
  assert.equal(deleted.calls[0].url, read.calls[0].url);
  for (const text of ['{}', '{"owners":[]}', '{"owners":["bad"]}', '{"owners":["a@example.com","a@example.com"]}', '{"owners":["a@example.com"],"site":{}}']) {
    assert.equal(typeof parse("update_verification_owners", resource.id, text), "string");
  }
  assert.equal(typeof parse("delete_verification", resource.id, "extra"), "string");
});

test("new mutations retain the existing Channel deny gate", () => {
  for (const id of ["add_site", "delete_site", "delete_sitemap", "verify_site", "update_verification_owners", "delete_verification"]) {
    assert.equal(actions[id].effect, "write");
    assert.match(actionRefusal({ actionId: id, mode: "deny" }), /denied/u);
  }
});

test("advanced analytics forwards supported bounded options and uses Pacific dates", async () => {
  const options = { startDate: "2026-10-01", endDate: "2026-10-05", dimensions: ["query", "page", "country", "device"], rowLimit: 50,
    startRow: 250, type: "web", aggregationType: "auto", dataState: "all",
    dimensionFilterGroups: [{ groupType: "and", filters: [{ dimension: "query", operator: "contains", expression: "pixel art" }] }] };
  const result = await fetched([{ body: { rows: [], metadata: { first_incomplete_date: "2026-10-05" } } }],
    () => actions.query.execute({ credentials }, parse("query", property, JSON.stringify(options))));
  assert.deepEqual(result.calls[0].body, options);
  assert.match(result.result.summary, /Next startRow: 250/u);
  assert.match(result.result.summary, /first_incomplete_date/u);
  assert.match(result.result.summary, /dataState=all/u);
  const large = await fetched([{ body: { rows: Array.from({ length: 50 }, () => ({ keys: Array(4).fill("x".repeat(300)), clicks: 1 })) } }],
    () => actions.query.execute({ credentials }, parse("query", property, JSON.stringify(options))));
  assert.ok(large.result.summary.length < 17_000);
  assert.match(large.result.summary, /Output truncated at 16000 characters/u);
  assert.equal(searchAnalyticsOptions("days=1", Date.UTC(2026, 9, 7, 1)).endDate, "2026-10-06");
  for (const changes of [{ startDate: "2026-02-30" }, { endDate: "2026-09-30" }, { startRow: -1 }, { rowLimit: 251 },
    { dimensions: ["query", "query"] }, { unexpected: true }, { dimensionFilterGroups: [{ groupType: "or", filters: [] }] },
    { dimensionFilterGroups: [{ filters: [{ dimension: "date", expression: "today" }] }] }]) {
    assert.equal(typeof searchAnalyticsOptions(JSON.stringify({ ...options, ...changes })), "string");
  }
});


test("inspection preserves full provider results and forwards an explicit language", async () => {
  const input = parse("inspect_url", property, "https://example.com/page language=zh-CN");
  const result = await fetched([{ body: { inspectionResult: { indexStatusResult: { verdict: "PASS" },
    richResultsResult: { detectedItems: [{ richResultType: "Product" }] } } } }], () => actions.inspect_url.execute({ credentials }, input));
  assert.equal(result.calls[0].body.languageCode, "zh-CN");
  assert.match(result.result.summary, /richResultsResult/u);
  assert.equal(typeof parse("inspect_url", property, "https://example.com/page language=en extra"), "string");
});
