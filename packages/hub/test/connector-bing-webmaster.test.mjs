import { withProviderResponses as fetched } from "./support/fetch-responses.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { BING_WEBMASTER_ACTIONS as ACTIONS, bingSite, verifyBingWebmaster } from "../src/connectors/actions/bing-webmaster.ts";
import { statementParser } from "./support/google-read-grant.mjs";
import { providerEgress } from "../src/connectors/provider-egress.ts";

const key = { apiKey: "0123456789abcdef0123456789abcdef" };
const statement = statementParser("bingwebmaster", ACTIONS);
const site = "https://example.com/";

test("sites and URL lists are validated before any request", () => {
  assert.equal(bingSite(site), site);
  for (const bad of ["example.com", "https://example.com", "https://example.com/?a=1", "https://127.0.0.1/"]) assert.equal(bingSite(bad), undefined, bad);
  assert.deepEqual(statement(`@bingwebmaster:traffic:${site}`), { site });
  assert.equal(typeof statement(`@bingwebmaster:traffic:${site} extra`), "string");
  assert.deepEqual(statement(`@bingwebmaster:submit_urls:${site} https://example.com/a https://example.com/a https://example.com/b`),
    { site, urls: JSON.stringify(["https://example.com/a", "https://example.com/b"]) });
  for (const bad of [`${site}`, `${site} https://other.com/a`, `${site} https://sub.example.com/a`, `${site} not-a-url`,
    `${site} ${Array.from({ length: 101 }, (_, i) => `https://example.com/${i}`).join(" ")}`]) {
    assert.equal(typeof statement(`@bingwebmaster:indexnow:${bad}`), "string", bad);
  }
  assert.deepEqual(statement(`@bingwebmaster:submit_sitemap:${site} https://example.com/sitemap.xml`), { site, feed: "https://example.com/sitemap.xml" });
  assert.equal(typeof statement(`@bingwebmaster:submit_sitemap:${site} https://example.com/a.xml https://example.com/b.xml`), "string");
});

test("reads send the key only as Bing's apikey parameter and fence what Bing returns", async () => {
  const listed = await fetched([{ body: { d: [{ Url: site, IsVerified: true }, { Url: "https://x.com/\n```", IsVerified: false }] } }],
    () => ACTIONS.list_sites.execute({ credentials: key }, {}));
  const call = new URL(listed.calls[0].url);
  assert.equal(call.origin + call.pathname, "https://ssl.bing.com/webmaster/api.svc/json/GetUserSites");
  assert.equal(call.searchParams.get("apikey"), key.apiKey);
  assert.match(listed.result.summary, /https:\/\/example\.com\/\tverified\nhttps:\/\/x\.com\/ ```\tnot verified/u);
  assert.doesNotMatch(listed.result.summary, new RegExp(key.apiKey, "u"));

  const traffic = await fetched([{ body: { d: [{ Date: "/Date(1759968000000-0700)/", Clicks: 4, Impressions: 90 },
    { Date: "/Date(1760054400000)/", Clicks: 7, Impressions: 120 }] } }],
  () => ACTIONS.traffic.execute({ credentials: key }, { site }));
  assert.equal(new URL(traffic.calls[0].url).searchParams.get("siteUrl"), site);
  assert.match(traffic.result.summary, /date\tclicks\timpressions\n2025-10-10\t7\t120\n2025-10-09\t4\t90/u);

  const queries = await fetched([{ body: { d: [{ Query: "seo api", Clicks: 2, Impressions: 30, AvgClickPosition: 3.25, AvgImpressionPosition: 5 },
    { Query: "keyword volume", Clicks: 9, Impressions: 50, AvgClickPosition: -1, AvgImpressionPosition: 2 }] } }],
  () => ACTIONS.queries.execute({ credentials: key }, { site }));
  assert.match(queries.result.summary, /keyword volume\t9\t50\t-\t2\.0\nseo api\t2\t30\t3\.3\t5\.0/u);
  assert.equal(new URL(queries.calls[0].url).pathname.endsWith("/GetQueryStats"), true);
});

test("submissions post to Bing and IndexNow with the site's own key", async () => {
  const urls = JSON.stringify(["https://example.com/a"]);
  const submitted = await fetched([{ body: { d: null } }, { body: { d: { DailyQuota: 99, MonthlyQuota: 2799 } } }],
    () => ACTIONS.submit_urls.execute({ credentials: key }, { site, urls }));
  assert.equal(submitted.calls[0].method, "POST");
  assert.deepEqual(submitted.calls[0].body, { siteUrl: site, urlList: ["https://example.com/a"] });
  assert.match(submitted.result.summary, /today: 99, this month: 2799/u);

  const pushed = await fetched([{ status: 202, raw: "" }],
    () => ACTIONS.indexnow.execute({ credentials: { indexNowKey: "abcdef12-3456" } }, { site, urls }));
  assert.equal(pushed.calls[0].url, "https://api.indexnow.org/indexnow");
  assert.deepEqual(pushed.calls[0].body, { host: "example.com", key: "abcdef12-3456", keyLocation: "https://example.com/abcdef12-3456.txt",
    urlList: ["https://example.com/a"] });
  await assert.rejects(ACTIONS.indexnow.execute({ credentials: { indexNowKey: "short" } }, { site, urls }), /IndexNow key/u);
});

test("a bad key, Bing errors and malformed answers fail closed", async () => {
  await assert.rejects(ACTIONS.list_sites.execute({ credentials: {} }, {}), /Bing Webmaster Tools or save an API key/u);
  await assert.rejects(ACTIONS.list_sites.execute({ credentials: { apiKey: "has space" } }, {}), /Bing Webmaster Tools or save an API key/u);
  const refused = fetched([{ status: 400, body: { ErrorCode: 3, Message: "ERROR!!! InvalidApiKey" } }], () => verifyBingWebmaster(key));
  await assert.rejects(refused, error => /Provider returned 400: InvalidApiKey/u.test(error.message) && !error.message.includes(key.apiKey));
  await fetched([{ body: { d: { Url: site } } }], () => assert.rejects(ACTIONS.traffic.execute({ credentials: key }, { site }), /traffic statistics/u));
  await verifyBingWebmaster({ indexNowKey: "abcdef12-3456" });
});

const relayToken = "relay_token_0123456789abcdef0123456789";

test("a configured relay carries Bing calls, with the key as a header instead of in the URL", async () => {
  const egress = providerEgress({ CONNECTOR_BING_RELAY_URL: "https://bing-relay-abc.a.run.app", CONNECTOR_BING_RELAY_TOKEN: relayToken }, "bingwebmaster");
  assert.deepEqual(egress, { origin: "https://bing-relay-abc.a.run.app", token: relayToken });
  const listed = await fetched([{ body: { d: [{ Url: site, IsVerified: true }] } }],
    () => ACTIONS.list_sites.execute({ credentials: key, egress }, {}));
  const call = new URL(listed.calls[0].url);
  assert.equal(call.origin + call.pathname, "https://bing-relay-abc.a.run.app/webmaster/api.svc/json/GetUserSites");
  assert.equal(call.searchParams.has("apikey"), false);
  assert.equal(listed.calls[0].headers.get("x-bing-apikey"), key.apiKey);
  assert.equal(listed.calls[0].headers.get("authorization"), `Bearer ${relayToken}`);

  const submitted = await fetched([{ body: { d: null } }, { body: { d: { DailyQuota: 1, MonthlyQuota: 2 } } }],
    () => ACTIONS.submit_urls.execute({ credentials: key, egress }, { site, urls: JSON.stringify(["https://example.com/a"]) }));
  assert.ok(submitted.calls.every(entry => entry.url.startsWith("https://bing-relay-abc.a.run.app/") && !entry.url.includes(key.apiKey)));
  await fetched([{ body: { d: [] } }], calls => verifyBingWebmaster(key, undefined, egress).then(() =>
    assert.equal(new URL(calls[0].url).origin, "https://bing-relay-abc.a.run.app")));
});

test("only a complete, public https relay configuration is used; otherwise Bing is called directly", () => {
  const good = { CONNECTOR_BING_RELAY_URL: "https://relay.example.com", CONNECTOR_BING_RELAY_TOKEN: relayToken };
  assert.ok(providerEgress(good, "bingwebmaster"));
  assert.equal(providerEgress(good, "googlesearchconsole"), undefined);
  for (const change of [{ CONNECTOR_BING_RELAY_URL: undefined }, { CONNECTOR_BING_RELAY_TOKEN: undefined },
    { CONNECTOR_BING_RELAY_TOKEN: "short" }, { CONNECTOR_BING_RELAY_URL: "http://relay.example.com" },
    { CONNECTOR_BING_RELAY_URL: "https://127.0.0.1" }, { CONNECTOR_BING_RELAY_URL: "https://relay.example.com/path" },
    { CONNECTOR_BING_RELAY_URL: "https://user@relay.example.com" }, { CONNECTOR_BING_RELAY_URL: "not a url" }]) {
    assert.equal(providerEgress({ ...good, ...change }, "bingwebmaster"), undefined, JSON.stringify(change));
  }
});

test("a Bing sign-in sends its access token as a bearer token, directly or through the relay", async () => {
  const signedIn = { oauthToken: "access-token-abc", apiKey: key.apiKey };
  const direct = await fetched([{ body: { d: [] } }], () => ACTIONS.list_sites.execute({ credentials: signedIn }, {}));
  const call = new URL(direct.calls[0].url);
  assert.equal(call.origin, "https://ssl.bing.com");
  assert.equal(call.searchParams.has("apikey"), false, "the sign-in wins over a saved key");
  assert.equal(direct.calls[0].headers.get("authorization"), "Bearer access-token-abc");

  const egress = { origin: "https://bing-relay-abc.a.run.app", token: relayToken };
  const relayed = await fetched([{ body: { d: [] } }], () => ACTIONS.list_sites.execute({ credentials: signedIn, egress }, {}));
  assert.equal(relayed.calls[0].headers.get("authorization"), `Bearer ${relayToken}`);
  assert.equal(relayed.calls[0].headers.get("x-bing-authorization"), "Bearer access-token-abc");
  assert.equal(relayed.calls[0].headers.get("x-bing-apikey"), null);
  await assert.rejects(ACTIONS.list_sites.execute({ credentials: { oauthToken: "has space" } }, {}), /Sign in to Bing Webmaster Tools again/u);
});
