import { withProviderResponses as fetched } from "./support/fetch-responses.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { GOOGLE_BUSINESS_PROFILE_ACTIONS as ACTIONS, verifyGoogleBusinessProfile }
  from "../src/connectors/actions/google-business-profile.ts";
import { exchangeOAuthGrant, oauthClient } from "../src/connectors/oauth.ts";
import { statementParser } from "./support/google-read-grant.mjs";

const company = { CONNECTOR_GOOGLE_CLIENT_ID: "fixture-client.apps.googleusercontent.com", CONNECTOR_GOOGLE_CLIENT_SECRET: "fixture-secret" };
const manage = "https://www.googleapis.com/auth/business.manage";
const token = { oauthToken: "gbp-access" };
const statement = statementParser("googlebusinessprofile", ACTIONS);
const location = "accounts/11/locations/22";

test("Business Profile keeps a grant only for exactly business.manage", async () => {
  const client = oauthClient(company, "googlebusinessprofile");
  assert.equal(client.clientId, company.CONNECTOR_GOOGLE_CLIENT_ID);
  const accepted = { access_token: "a", refresh_token: "r", token_type: "Bearer", expires_in: 3600, scope: manage };
  assert.equal((await fetched([{ body: accepted }], () => exchangeOAuthGrant(client, "code", "https://hub.test/cb"))).result.fields.oauthToken, "a");
  await fetched([{ body: { ...accepted, scope: `${manage} https://www.googleapis.com/auth/webmasters` } }],
    () => assert.rejects(exchangeOAuthGrant(client, "code", "https://hub.test/cb"), /Business Profile OAuth grant/u));
});

test("accounts, locations, reviews and replies are validated before any request", () => {
  assert.deepEqual(statement("@googlebusinessprofile:list_locations:accounts/11"), { account: "accounts/11" });
  assert.deepEqual(statement(`@googlebusinessprofile:performance:${location} days=90`), { account: "accounts/11", location: "locations/22", days: "90" });
  assert.deepEqual(statement(`@googlebusinessprofile:reply_review:${location}/reviews/AbC_1 Thank you!\nSee you soon.`),
    { review: `${location}/reviews/AbC_1`, comment: "Thank you!\nSee you soon." });
  for (const bad of ["@googlebusinessprofile:list_locations:11", "@googlebusinessprofile:performance:locations/22",
    `@googlebusinessprofile:performance:${location} days=541`, `@googlebusinessprofile:reviews:${location} extra`,
    `@googlebusinessprofile:reply_review:${location}/reviews/AbC_1`, `@googlebusinessprofile:reply_review:${location}/reviews/a/b hi`,
    `@googlebusinessprofile:reply_review:${location}/reviews/x ${"a".repeat(4097)}`]) {
    assert.equal(typeof statement(bad), "string", bad);
  }
});

test("performance sums each metric over a range that ends three days ago", async () => {
  const now = Date.UTC(2026, 9, 12, 12);
  const read = await fetched([{ body: { multiDailyMetricTimeSeries: [{ dailyMetricTimeSeries: [
    { dailyMetric: "WEBSITE_CLICKS", timeSeries: { datedValues: [{ value: "3" }, { value: "4" }, {}] } },
    { dailyMetric: "CALL_CLICKS", timeSeries: { datedValues: [{ value: "1" }] } }] }] } }],
  () => ACTIONS.performance.execute({ credentials: token }, { account: "accounts/11", location: "locations/22", days: "7" }, now));
  const url = new URL(read.calls[0].url);
  assert.equal(url.origin + url.pathname, "https://businessprofileperformance.googleapis.com/v1/locations/22:fetchMultiDailyMetricsTimeSeries");
  assert.equal(url.searchParams.getAll("dailyMetrics").length, 7);
  assert.deepEqual(["year", "month", "day"].map(part => url.searchParams.get(`dailyRange.start_date.${part}`)), ["2026", "10", "3"]);
  assert.deepEqual(["year", "month", "day"].map(part => url.searchParams.get(`dailyRange.end_date.${part}`)), ["2026", "10", "9"]);
  assert.match(read.result.summary, /2026-10-03 to 2026-10-09/u);
  assert.match(read.result.summary, /website_clicks\t7\ncall_clicks\t1\nbusiness_direction_requests\t0/u);
});

test("reviews are fenced and a reply is a PUT of the comment", async () => {
  const reviews = await fetched([{ body: { averageRating: 4.5, totalReviewCount: 12, reviews: [
    { name: `${location}/reviews/r1`, starRating: "FIVE", updateTime: "2026-10-10T09:00:00Z", reviewer: { displayName: "Ann" }, comment: "Great\n```" },
    { name: `${location}/reviews/r2`, starRating: "TWO", updateTime: "2026-10-01T09:00:00Z", reviewReply: { comment: "Sorry" } }] } }],
  () => ACTIONS.reviews.execute({ credentials: token }, { account: "accounts/11", location: "locations/22" }));
  assert.equal(reviews.calls[0].url, `https://mybusiness.googleapis.com/v4/${location}/reviews?pageSize=50&orderBy=updateTime%20desc`);
  assert.equal(reviews.calls[0].headers.get("authorization"), "Bearer gbp-access");
  assert.match(reviews.result.summary, /average 4\.5 from 12/u);
  assert.match(reviews.result.summary, /reviews\/r1\t5\t2026-10-10\tno reply\tAnn\tGreat ```/u);
  assert.match(reviews.result.summary, /reviews\/r2\t2\t2026-10-01\treplied/u);

  const reply = await fetched([{ body: { comment: "Thanks" } }],
    () => ACTIONS.reply_review.execute({ credentials: token }, { review: `${location}/reviews/r1`, comment: "Thanks" }));
  assert.equal(reply.calls[0].method, "PUT");
  assert.equal(reply.calls[0].url, `https://mybusiness.googleapis.com/v4/${location}/reviews/r1/reply`);
  assert.deepEqual(reply.calls[0].body, { comment: "Thanks" });
});

test("locations list the account's places and calls fail closed without access", async () => {
  const listed = await fetched([{ body: { locations: [{ name: "locations/22", title: "Cafe", websiteUri: "https://cafe.example/",
    storefrontAddress: { addressLines: ["1 Main St"], locality: "Springfield" }, metadata: { mapsUri: "https://maps.google.com/?cid=1" } }] } }],
  () => ACTIONS.list_locations.execute({ credentials: token }, { account: "accounts/11" }));
  assert.equal(new URL(listed.calls[0].url).searchParams.get("readMask"), "name,title,storefrontAddress,websiteUri,metadata");
  assert.match(listed.result.summary, /accounts\/11\/locations\/22\tCafe\t1 Main St, Springfield\thttps:\/\/cafe\.example\/\thttps:\/\/maps/u);

  await assert.rejects(ACTIONS.list_accounts.execute({ credentials: {} }, {}), /Connect Google Business Profile/u);
  await fetched([{ status: 403, body: { error: { message: "API not approved" } } }], () => assert.rejects(verifyGoogleBusinessProfile(token), /Provider returned 403/u));
  await fetched([{ body: { accounts: {} } }], () => assert.rejects(verifyGoogleBusinessProfile(token), /Business Profile access/u));
  await fetched([{ body: {} }], () => verifyGoogleBusinessProfile(token));
});
