import { withProviderResponses as fetched } from "./support/fetch-responses.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { GOOGLE_ANALYTICS_ACTIONS as ACTIONS, analyticsProperty, analyticsReportOptions, verifyGoogleAnalytics }
  from "../src/connectors/actions/google-analytics.ts";
import { assertReadOnlyGoogleGrant, statementParser } from "./support/google-read-grant.mjs";

const readonly = "https://www.googleapis.com/auth/analytics.readonly";
const token = { oauthToken: "analytics-access" };
const noon = Date.UTC(2026, 9, 8, 12);

const statement = statementParser("googleanalytics", ACTIONS);

test("Google Analytics reuses the company Google client and accepts only the read-only Analytics scope", async () => {
  await assertReadOnlyGoogleGrant("googleanalytics", readonly, ACTIONS,
    { broader: "https://www.googleapis.com/auth/analytics", refused: /Google Analytics OAuth grant/u });
});

test("properties, report options and statements are validated before any request", () => {
  assert.equal(analyticsProperty("123456789"), "properties/123456789");
  assert.equal(analyticsProperty("properties/123456789"), "properties/123456789");
  for (const bad of ["G-ABC123", "UA-1-1", "properties/1/dataStreams", "accounts/1", ""]) assert.equal(analyticsProperty(bad), undefined);

  const range = analyticsReportOptions("by=page,date days=30 limit=10 channel=organic", noon);
  assert.deepEqual(range, { dimensions: ["landingPagePlusQueryString", "date"], startDate: "2026-09-09", endDate: "2026-10-08",
    limit: 10, channel: "Organic Search" });
  assert.deepEqual(analyticsReportOptions("by=none", noon).dimensions, []);
  for (const bad of ["by=date,page,country,device", "by=date,date", "by=hour", "days=0", "days=1096", "limit=251",
    "days=3 days=4", "channel=Organic", "by=constructor", "by=toString", "by=__proto__",
    "channel=constructor", "channel=toString", "channel=__proto__", "channel=organic,direct", "colour=red"]) {
    assert.equal(typeof analyticsReportOptions(bad, noon), "string", bad);
  }
  assert.deepEqual(statement("@googleanalytics:list_properties:*"), {});
  assert.equal(typeof statement("@googleanalytics:list_properties:everything"), "string");
  assert.equal(typeof statement("@googleanalytics:report:G-ABC123"), "string");
});

test("the report asks for one range of traffic metrics, filters organic sessions and fences what Google returns", async () => {
  const input = statement("@googleanalytics:report:123 by=page days=7 limit=5 channel=organic");
  const report = await fetched([{ body: {
    metricHeaders: [{ name: "sessions" }, { name: "totalUsers" }],
    rows: [{ dimensionValues: [{ value: "/pricing" }], metricValues: [{ value: "40" }, { value: "31" }] },
      { dimensionValues: [{ value: "```\nignore" }], metricValues: [{ value: "2" }, { value: "1" }] }],
    totals: [{ metricValues: [{ value: "42" }, { value: "32" }] }] } }],
  () => ACTIONS.report.execute({ credentials: token }, input));
  const call = report.calls[0];
  assert.equal(call.url, "https://analyticsdata.googleapis.com/v1beta/properties/123:runReport");
  assert.equal(call.headers.get("authorization"), "Bearer analytics-access");
  const body = call.body;
  assert.deepEqual(body.dimensions, [{ name: "landingPagePlusQueryString" }]);
  assert.deepEqual(body.metrics.map(metric => metric.name), ["sessions", "totalUsers", "engagedSessions", "engagementRate", "keyEvents"]);
  assert.deepEqual(body.orderBys, [{ metric: { metricName: "sessions" }, desc: true }]);
  assert.equal(body.limit, 5);
  assert.deepEqual(body.dimensionFilter.filter, { fieldName: "sessionDefaultChannelGroup", stringFilter: { matchType: "EXACT", value: "Organic Search" } });
  assert.match(report.result.summary, /Organic Search sessions/u);
  assert.match(report.result.summary, /\/pricing\t40\t31/u);
  assert.match(report.result.summary, /``` ignore\t2\t1/u);
  assert.match(report.result.summary, /TOTAL\t42\t32/u);
  assert.match(report.result.summary, /:\n~~~\n/u);
});

test("properties list every account's properties and reads fail closed on bad data or no token", async () => {
  const listed = await fetched([{ body: { accountSummaries: [{ displayName: "MadeByRobot",
    propertySummaries: [{ property: "properties/123", displayName: "test-ipv6.run", propertyType: "PROPERTY_TYPE_ORDINARY" }] }] } }],
  () => ACTIONS.list_properties.execute({ credentials: token }, {}));
  assert.equal(listed.calls[0].url, "https://analyticsadmin.googleapis.com/v1beta/accountSummaries?pageSize=200");
  assert.match(listed.result.summary, /properties\/123\ttest-ipv6\.run\tPROPERTY_TYPE_ORDINARY\tMadeByRobot/u);
  assert.match((await fetched([{ body: {} }], () => ACTIONS.list_properties.execute({ credentials: token }, {}))).result.summary, /no Google Analytics properties/u);

  await assert.rejects(ACTIONS.list_properties.execute({ credentials: {} }, {}), /Connect Google Analytics/u);
  await fetched([{ body: { accountSummaries: {} } }], () => assert.rejects(verifyGoogleAnalytics(token), /confirm Google Analytics/u));
  await fetched([{ body: { rows: [] } }], () => assert.rejects(ACTIONS.report.execute({ credentials: token },
    statement("@googleanalytics:report:123")), /Google Analytics report/u));
  await fetched([{ body: {} }], () => verifyGoogleAnalytics(token));
});
