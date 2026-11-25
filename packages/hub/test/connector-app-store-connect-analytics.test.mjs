import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { test } from "node:test";

import { parseAnalyticsOptions, summarizeAnalyticsTsv } from "../src/connectors/actions/app-store-connect-analytics.ts";
import { APP, BUNDLE, run, statement, writes } from "./support/app-store-connect-double.mjs";

const gz = (text) => new Response(gzipSync(text), { headers: { "content-type": "application/octet-stream" } });

function analyticsRoutes({ reportId, reportName, category, segmentUrl, extra = {} }) {
  return {
    "GET /v1/apps": { data: [APP] },
    "GET /v1/apps/6760000001/analyticsReportRequests": {
      data: [{ type: "analyticsReportRequests", id: "req-1", attributes: { accessType: "ONGOING", stoppedDueToInactivity: false } }],
    },
    "GET /v1/analyticsReportRequests/req-1/reports": {
      data: [{ type: "analyticsReports", id: reportId, attributes: { name: reportName, category } }],
    },
    [`GET /v1/analyticsReports/${reportId}/instances`]: {
      data: [{ type: "analyticsReportInstances", id: "inst-1", attributes: { granularity: "DAILY", processingDate: "2026-11-24" } }],
    },
    "GET /v1/analyticsReportInstances/inst-1/segments": {
      data: [{ type: "analyticsReportSegments", id: "seg-1", attributes: { url: segmentUrl, sizeInBytes: 256, checksum: "abc" } }],
    },
    ...extra,
  };
}

test("analytics options validate report presets, granularity and bounded day counts", () => {
  assert.deepEqual(parseAnalyticsOptions(""), { report: "engagement", granularity: "DAILY", days: 7 });
  assert.deepEqual(parseAnalyticsOptions("report=downloads granularity=weekly days=4"), { report: "downloads", granularity: "WEEKLY", days: 4 });
  assert.deepEqual(parseAnalyticsOptions("report=list"), { report: "list", granularity: "DAILY", days: 7 });
  for (const bad of ["report=bogus", "granularity=hourly", "days=0", "days=32", "granularity=monthly days=13", "extra=1"]) {
    assert.equal(typeof parseAnalyticsOptions(bad), "string", bad);
  }
  assert.equal(typeof statement(`@appstoreconnect:analytics:${BUNDLE} report=engagement days=3`), "object");
  assert.equal(typeof statement("@appstoreconnect:analytics:bad/id"), "string");
});

test("analytics downloads and summarizes gzipped Apple Analytics engagement and downloads segments without sending Apple auth to S3", async () => {
  const engagementTsv = [
    "Date\tApp Name\tApp Apple Identifier\tEvent\tPage Type\tSource Type\tEngagement Type\tDevice\tPlatform Version\tTerritory\tCounts\tUnique Counts",
    "2026-11-23\tExample\t6760000001\tImpression\tNo page\tApp Store search\t\tiPhone\tiOS 26.6\tUS\t10\t8",
    "2026-11-23\tExample\t6760000001\tPage view\tProduct page\tApp Store search\t\tiPhone\tiOS 26.6\tUS\t4\t3",
    "2026-11-24\tExample\t6760000001\tImpression\tNo page\tApp Store browse\t\tiPad\tiOS 26.4\tJP\t2\t2",
  ].join("\n") + "\n";

  const routes = analyticsRoutes({
    reportId: "r14-req-1",
    reportName: "App Store Discovery and Engagement Standard",
    category: "APP_STORE_ENGAGEMENT",
    segmentUrl: "https://asp-us-west-2.s3.us-west-2.amazonaws.com/reports/6760000001/eng.csv.gz?X-Amz-Signature=ok",
    extra: { "GET /reports/6760000001/eng.csv.gz": () => gz(engagementTsv) },
  });

  const res = await run(routes, `@appstoreconnect:analytics:${BUNDLE} report=engagement days=7`);
  assert.match(res.value.summary, /2026-11-23\t10\t8\t4\t3\t40\.0%/u);
  assert.match(res.value.summary, /TOTAL\t12\t10\t4\t3\t33\.3%/u);
  assert.match(res.value.summary, /top sources: App Store search 14, App Store browse 2/u);
  assert.match(res.value.summary, /top territories: US 14, JP 2/u);
  const s3Call = res.calls.find(c => c.origin === "https://asp-us-west-2.s3.us-west-2.amazonaws.com");
  assert.ok(s3Call, "downloaded the signed S3 segment");
  assert.equal(s3Call.authorization, null, "never sends Apple JWT to S3 pre-signed URL");
  assert.deepEqual(writes(res.calls), []);
});

test("analytics refuses segment URLs outside allowed Apple/S3 hosts and guides enablement when no request exists", async () => {
  const noReq = await run({
    "GET /v1/apps": { data: [APP] },
    "GET /v1/apps/6760000001/analyticsReportRequests": { data: [] },
  }, `@appstoreconnect:analytics:${BUNDLE}`);
  assert.match(noReq.value.summary, /enable_analytics/u);

  const evilRoutes = analyticsRoutes({
    reportId: "r3-req-1",
    reportName: "App Downloads Standard",
    category: "COMMERCE",
    segmentUrl: "https://evil.example/steal.gz",
  });
  await assert.rejects(run(evilRoutes, `@appstoreconnect:analytics:${BUNDLE} report=downloads`), /outside allowed Apple\/S3 storage hosts/u);

  const dlSummary = summarizeAnalyticsTsv("downloads", [
    "Date\tApp Name\tApp Apple Identifier\tDownload Type\tApp Version\tDevice\tPlatform Version\tSource Type\tPage Type\tPre-Order\tTerritory\tCounts\n" +
    "2026-11-23\tExample\t6760000001\tFirst-time download\t1.0\tiPhone\tiOS 26.6\tApp Store search\tNo page\t\tUS\t3\n" +
    "2026-11-23\tExample\t6760000001\tAuto-update\t1.0\tiPhone\tiOS 26.6\tApp referrer\tProduct page\t\tCN\t2\n",
  ]);
  assert.match(dlSummary, /2026-11-23\t3\t0\t2\t5/u);
  assert.match(dlSummary, /first-time by source: App Store search 3/u);
});

test("enable_analytics is idempotent when ONGOING is active and creates a request when missing", async () => {
  const existing = await run({
    "GET /v1/apps": { data: [APP] },
    "GET /v1/apps/6760000001/analyticsReportRequests": {
      data: [{ type: "analyticsReportRequests", id: "req-existing", attributes: { accessType: "ONGOING", stoppedDueToInactivity: false } }],
    },
  }, `@appstoreconnect:enable_analytics:${BUNDLE} ongoing`);
  assert.match(existing.value.summary, /already active/u);
  assert.deepEqual(writes(existing.calls), []);

  const created = await run({
    "GET /v1/apps": { data: [APP] },
    "GET /v1/apps/6760000001/analyticsReportRequests": { data: [] },
    "POST /v1/analyticsReportRequests": { data: { type: "analyticsReportRequests", id: "req-new", attributes: { accessType: "ONGOING" } } },
  }, `@appstoreconnect:enable_analytics:${BUNDLE}`);
  assert.match(created.value.summary, /req-new/u);
  assert.deepEqual(writes(created.calls), ["POST /v1/analyticsReportRequests"]);
});

test("metrics reads Xcode perfPowerMetrics and subscription_reports / finance summarize Apple TSV reports", async () => {
  const perf = await run({
    "GET /v1/apps": { data: [APP] },
    "GET /v1/apps/6760000001/perfPowerMetrics": {
      productData: [{
        metricCategories: [{
          identifier: "LAUNCH",
          metrics: [{ identifier: "launchTime", unit: { displayName: "ms" }, datasets: [{ points: [{ version: "4.11.0", value: 420 }] }] }],
        }],
      }],
      insights: { regressions: [{ id: "r1" }], trendingUp: [] },
    },
  }, `@appstoreconnect:metrics:${BUNDLE} type=launch`);
  assert.match(perf.value.summary, /LAUNCH\tlaunchTime\t4\.11\.0\t420 ms/u);
  assert.match(perf.value.summary, /1 regression\(s\), 0 trending up/u);

  const subTsv = [
    "App Name\tSubscription Name\tCountry\tActive Standard Price Subscriptions\tActive Free Trial Introductory Offer Subscriptions\tSubscribers in Grace Period\tSubscribers in Billing Retry",
    "Example\tPro Monthly\tUS\t12\t3\t1\t0",
    "Other App\tPro\tUS\t99\t0\t0\t0",
  ].join("\n") + "\n";
  const sub = await run({
    "GET /v1/apps": { data: [APP] },
    "GET /v1/salesReports": () => gz(subTsv),
  }, `@appstoreconnect:subscription_reports:${BUNDLE} vendor=89123456 kind=summary days=1`);
  assert.match(sub.value.summary, /\t12\t3\t1\t1/u);
  assert.equal(sub.calls.find(c => c.path === "/v1/salesReports").query["filter[reportType]"], "SUBSCRIPTION");

  const finTsv = [
    "Start Date\tEnd Date\tUPC\tISRC/ISBN\tVendor Identifier\tQuantity\tPartner Share\tExtended Partner Share\tPartner Share Currency\tSales or Return\tApple Identifier\tArtist/Show/Developer/Author\tTitle",
    "10/01/2026\t10/31/2026\t\t\tsh.xmatrix.app\t5\t7.00\t35.00\tUSD\tS\t6760000001\tMBR\txMatrix Pro",
    "Total_Rows\t1",
  ].join("\n") + "\n";
  const fin = await run({
    "GET /v1/financeReports": () => gz(finTsv),
  }, "@appstoreconnect:finance:* vendor=89123456 region=ZZ month=2026-10");
  assert.match(fin.value.summary, /sh\.xmatrix\.app\txMatrix Pro\t5\t35\.00 USD/u);
  assert.match(fin.value.summary, /total partner share: 35\.00 USD/u);
});
