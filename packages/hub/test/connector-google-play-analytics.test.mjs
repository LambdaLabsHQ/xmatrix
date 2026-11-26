import { withProviderResponses as fetched } from "./support/fetch-responses.mjs";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { test } from "node:test";

import { GOOGLE_PLAY_ACTIONS as ACTIONS } from "../src/connectors/actions/google-play.ts";
import { decodePlayCsv, parseCsvRows, parseVitalsOptions } from "../src/connectors/actions/google-play-analytics.ts";
import { statementParser } from "./support/google-read-grant.mjs";

const credentials = { oauthToken: "play-access" };
const statement = statementParser("googleplay", ACTIONS);

const rsaPair = await webcrypto.subtle.generateKey(
  { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
  true,
  ["sign", "verify"],
);
const pkcs8 = Buffer.from(await webcrypto.subtle.exportKey("pkcs8", rsaPair.privateKey)).toString("base64");
const saPem = `-----BEGIN PRIVATE KEY-----\n${pkcs8.match(/.{1,64}/gu).join("\n")}\n-----END PRIVATE KEY-----\n`;
const saJson = JSON.stringify({ client_email: "reports@made-by-robot-xmatrix.iam.gserviceaccount.com", private_key: saPem });

test("vitals validates metrics, days and dimensions, and queries Play Developer Reporting using freshness latestEndTime", async () => {
  assert.deepEqual(parseVitalsOptions(""), { metric: "overview", days: 7 });
  assert.deepEqual(parseVitalsOptions("metric=crash days=14 by=version"), { metric: "crash", days: 14, by: "versionCode" });
  for (const bad of ["metric=bogus", "days=0", "days=31", "by=unknown", "metric=overview by=version", "metric=errors by=country"]) {
    assert.equal(typeof parseVitalsOptions(bad), "string", bad);
  }

  const freshness = {
    name: "apps/sh.xmatrix.app/crashRateMetricSet",
    freshnessInfo: { freshnesses: [{ aggregationPeriod: "DAILY", latestEndTime: { year: 2026, month: 11, day: 24, timeZone: { id: "America/Los_Angeles" } } }] },
  };
  const queryBody = {
    rows: [{
      startTime: { year: 2026, month: 11, day: 23 },
      dimensions: [{ dimension: "versionCode", int64Value: "1472" }],
      metrics: [
        { metric: "crashRate", decimalValue: { value: "0.005" } },
        { metric: "userPerceivedCrashRate", decimalValue: { value: "0.002" } },
        { metric: "crashRate7dUserWeighted", decimalValue: { value: "0.004" } },
        { metric: "distinctUsers", decimalValue: { value: "250" } },
      ],
    }],
  };

  const { result, calls } = await fetched([{ body: freshness }, { body: queryBody }],
    () => ACTIONS.vitals.execute({ credentials }, statement("@googleplay:vitals:sh.xmatrix.app metric=crash days=7 by=version")));
  assert.equal(calls[0].url, "https://playdeveloperreporting.googleapis.com/v1beta1/apps/sh.xmatrix.app/crashRateMetricSet");
  assert.equal(calls[1].url, "https://playdeveloperreporting.googleapis.com/v1beta1/apps/sh.xmatrix.app/crashRateMetricSet:query");
  assert.deepEqual(calls[1].body.timelineSpec.endTime, { year: 2026, month: 11, day: 24, timeZone: { id: "America/Los_Angeles" } });
  assert.deepEqual(calls[1].body.timelineSpec.startTime, { year: 2026, month: 11, day: 17, timeZone: { id: "America/Los_Angeles" } });
  assert.deepEqual(calls[1].body.dimensions, ["versionCode"]);
  assert.match(result.summary, /2026-11-23\t1472\t0\.50%\t0\.20%\t0\.40%\t250/u);
});

test("error_issues, anomalies, reviews and voided_purchases format Play operational data", async () => {
  const issues = await fetched([{
    body: {
      errorIssues: [{
        type: "CRASH", errorReportCount: "14", distinctUsers: "9",
        firstAppVersion: { versionCode: "1236" }, lastAppVersion: { versionCode: "1472" },
        cause: "java.lang.NullPointerException", location: "WebAppActivity.java:42",
      }],
    },
  }], () => ACTIONS.error_issues.execute({ credentials }, statement("@googleplay:error_issues:sh.xmatrix.app days=14 type=crash limit=10")));
  assert.match(issues.calls[0].url, /errorIssues:search\?/u);
  assert.match(issues.calls[0].url, /filter=errorIssueType\+%3D\+CRASH/u);
  assert.match(issues.result.summary, /CRASH\t14\t9\t1236\.\.1472\tjava\.lang\.NullPointerException\tWebAppActivity\.java:42/u);

  const anomalies = await fetched([{
    body: {
      anomalies: [{
        metricSet: "apps/sh.xmatrix.app/crashRateMetricSet",
        metric: { metric: "crashRate", decimalValue: { value: "0.03" } },
        timelineSpec: { startTime: { year: 2026, month: 11, day: 20 }, endTime: { year: 2026, month: 11, day: 24 } },
        dimensions: [{ dimension: "versionCode", int64Value: "1472" }],
      }],
    },
  }], () => ACTIONS.anomalies.execute({ credentials }, statement("@googleplay:anomalies:sh.xmatrix.app")));
  assert.match(anomalies.result.summary, /crashRateMetricSet\tcrashRate\t0\.03\t2026-11-20\.\.2026-11-24\t1472/u);

  const reviews = await fetched([{
    body: {
      reviews: [
        { reviewId: "r-1", authorName: "Alice", comments: [{ userComment: { starRating: 5, text: "Great app", appVersionName: "4.6.2", lastModified: { seconds: "1795400000" } } }] },
        { reviewId: "r-2", authorName: "Bob", comments: [
          { userComment: { starRating: 3, text: "OK", appVersionName: "4.6.2", lastModified: { seconds: "1795400000" } } },
          { developerComment: { text: "Thanks!" } },
        ] },
      ],
    },
  }], () => ACTIONS.reviews.execute({ credentials }, statement("@googleplay:reviews:sh.xmatrix.app unanswered limit=10")));
  assert.match(reviews.result.summary, /4\.00★ across 2 review\(s\)/u);
  assert.match(reviews.result.summary, /r-1\t5★/u);
  assert.doesNotMatch(reviews.result.summary, /r-2\t3★/u);

  const voided = await fetched([{
    body: {
      voidedPurchases: [{
        orderId: "GPA.1234-5678", purchaseTimeMillis: "1795300000000", voidedTimeMillis: "1795400000000",
        voidedSource: 0, voidedReason: 1,
      }],
    },
  }], () => ACTIONS.voided_purchases.execute({ credentials }, statement("@googleplay:voided_purchases:sh.xmatrix.app days=28")));
  assert.match(voided.calls[0].url, /voidedpurchases\?.*type=1/u);
  assert.match(voided.result.summary, /GPA\.1234-5678[\s\S]*user\tremorse/u);
  assert.equal(typeof statement("@googleplay:voided_purchases:sh.xmatrix.app days=30"), "string");

  // Overview handles non-game 403 on slowRenderingRateMetricSet and includes mandatory startType on slowStartRateMetricSet.
  const fresh = { freshnessInfo: { freshnesses: [{ aggregationPeriod: "DAILY", latestEndTime: { year: 2026, month: 11, day: 24, timeZone: { id: "America/Los_Angeles" } } }] } };
  const overview = await fetched([
    { body: fresh }, { body: fresh }, { body: fresh },
    { status: 403, body: { error: { status: "PERMISSION_DENIED", message: "slowRenderingRateMetricSet resource is only accessible to games" } } },
    { body: fresh }, { body: { anomalies: [] } },
    { body: { rows: [] } }, { body: { rows: [] } }, { body: { rows: [] } }, { body: { rows: [] } },
  ], () => ACTIONS.vitals.execute({ credentials }, statement("@googleplay:vitals:sh.xmatrix.app")));
  assert.match(overview.result.summary, /Slow rendering\t-\t\(games only\)/u);
  const slowStartCall = overview.calls.find(c => c.url.includes("slowStartRateMetricSet:query"));
  assert.deepEqual(slowStartCall.body.dimensions, ["startType"]);
  assert.equal(slowStartCall.body.filter, "startType = COLD");
});

test("store_reports decodes Play Console UTF-16LE CSVs, uses OAuth token directly when authorized, and falls back to service account", async () => {
  const csv = 'Date,Package Name,Daily Device Installs,Daily Device Uninstalls\r\n2026-11-23,sh.xmatrix.app,42,3\r\n2026-11-24,sh.xmatrix.app,"18",1\r\n';
  const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(csv, "utf16le")]);
  assert.equal(decodePlayCsv(utf16), csv);
  assert.equal(parseCsvRows(csv).length, 3);

  assert.equal(typeof statement("@googleplay:store_reports:sh.xmatrix.app bucket=arbitrary-bucket"), "string");
  assert.deepEqual(
    statement("@googleplay:store_reports:sh.xmatrix.app kind=installs month=202611 bucket=gs://pubsite_prod_rev_1234567890/stats/installs/"),
    { packageName: "sh.xmatrix.app", kind: "installs", month: "202611", bucket: "pubsite_prod_rev_1234567890" },
  );
  // Before devstorage.read_only is enabled on OAuth (and without reportsServiceAccount), do not emit a dead-end reportsBucket card.
  await assert.rejects(
    ACTIONS.store_reports.execute({ credentials }, statement("@googleplay:store_reports:sh.xmatrix.app")),
    error => error.status === 503 && error.fix === undefined && /devstorage\.read_only/u.test(error.message),
  );
  // Once devstorage.read_only is enabled on the Hub, an older two-scope grant asks for one-click reconnect rather than a service account card.
  await assert.rejects(
    ACTIONS.store_reports.execute(
      { credentials: { ...credentials, oauthScopes: "https://www.googleapis.com/auth/androidpublisher https://www.googleapis.com/auth/playdeveloperreporting" }, googlePlayStorageScope: true },
      statement("@googleplay:store_reports:sh.xmatrix.app"),
    ),
    error => error.fix?.kind === "reconnect",
  );
  // When storage access is available (via verified OAuth scope or explicit service account) and only the bucket is missing, surface reportsBucket.
  await assert.rejects(
    ACTIONS.store_reports.execute({ credentials, googlePlayStorageScope: true }, statement("@googleplay:store_reports:sh.xmatrix.app")),
    error => error.fix?.field === "reportsBucket",
  );
  await assert.rejects(
    ACTIONS.store_reports.execute({ credentials: { ...credentials, reportsServiceAccount: saJson } }, statement("@googleplay:store_reports:sh.xmatrix.app")),
    error => error.fix?.field === "reportsBucket",
  );

  const saved = [];
  const origFetch = globalThis.fetch;
  const calls = [];
  let oauthStatus = 200;
  globalThis.fetch = async (url, init = {}) => {
    const headers = new Headers(init.headers);
    calls.push({ url: String(url), method: init.method ?? "GET", headers });
    if (String(url).startsWith("https://oauth2.googleapis.com/token")) {
      return Response.json({ access_token: "gcs-token", expires_in: 300, token_type: "Bearer" });
    }
    if (headers.get("authorization") === "Bearer play-access" && oauthStatus !== 200) {
      return Response.json({ error: { code: oauthStatus, message: "Insufficient Permission" } }, { status: oauthStatus });
    }
    return new Response(utf16, { status: 200, headers: { "content-type": "text/csv" } });
  };
  try {
    // OAuth token works directly without any Service Account JSON when the grant includes storage read access.
    const oauthRes = await ACTIONS.store_reports.execute(
      { credentials: { ...credentials, oauthScopes: "https://www.googleapis.com/auth/androidpublisher https://www.googleapis.com/auth/devstorage.read_only" }, saveCredentials: async fields => { saved.push(fields); } },
      statement("@googleplay:store_reports:sh.xmatrix.app kind=installs month=202611 bucket=pubsite_prod_rev_1234567890"),
    );
    assert.deepEqual(saved, [{ reportsBucket: "pubsite_prod_rev_1234567890" }]);
    assert.equal(calls[0].headers.get("authorization"), "Bearer play-access");
    assert.match(oauthRes.summary, /Totals across 2 row\(s\): Daily Device Installs: 60, Daily Device Uninstalls: 4/u);

    // When the OAuth token gets 403 and storage scope is enabled on the Hub, prompt one-click reconnect (not a Service Account secret card).
    oauthStatus = 403;
    await assert.rejects(
      ACTIONS.store_reports.execute(
        { credentials, googlePlayStorageScope: true },
        statement("@googleplay:store_reports:sh.xmatrix.app kind=installs month=202611 bucket=pubsite_prod_rev_1234567890"),
      ),
      error => error.fix?.kind === "reconnect" && /devstorage\.read_only/u.test(error.message),
    );
    // When storage scope is not yet enabled on the Hub, explain cleanly without pushing a Service Account secret card.
    await assert.rejects(
      ACTIONS.store_reports.execute(
        { credentials },
        statement("@googleplay:store_reports:sh.xmatrix.app kind=installs month=202611 bucket=pubsite_prod_rev_1234567890"),
      ),
      error => error.status === 403 && error.fix === undefined && /devstorage\.read_only/u.test(error.message),
    );
    // When the grant already has devstorage.read_only but GCS still returns 403, point to Play Console user permissions.
    await assert.rejects(
      ACTIONS.store_reports.execute(
        { credentials: { ...credentials, oauthScopes: "https://www.googleapis.com/auth/androidpublisher https://www.googleapis.com/auth/devstorage.read_only" }, googlePlayStorageScope: true },
        statement("@googleplay:store_reports:sh.xmatrix.app kind=installs month=202611 bucket=pubsite_prod_rev_1234567890"),
      ),
      error => error.status === 403 && error.fix === undefined && /Play Console → Users and permissions/u.test(error.message),
    );

    // Explicit reportsServiceAccount still works as fallback.
    const saRes = await ACTIONS.store_reports.execute(
      { credentials: { ...credentials, reportsServiceAccount: saJson } },
      statement("@googleplay:store_reports:sh.xmatrix.app kind=installs month=202611 bucket=pubsite_prod_rev_1234567890"),
    );
    assert.equal(calls.at(-1).headers.get("authorization"), "Bearer gcs-token");
    assert.match(saRes.summary, /2026-11-24\t18\t1/u);
  } finally {
    globalThis.fetch = origFetch;
  }
});
