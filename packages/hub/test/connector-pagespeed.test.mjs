import { withProviderResponses as fetched } from "./support/fetch-responses.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { PAGESPEED_ACTIONS as ACTIONS, verifyPageSpeed } from "../src/connectors/actions/pagespeed.ts";
import { statementParser } from "./support/google-read-grant.mjs";

const key = { apiKey: "AIzaFixtureKey_123" };
const statement = statementParser("pagespeed", ACTIONS);

test("pages, origins and options are validated before any request", () => {
  assert.deepEqual(statement("@pagespeed:audit:https://example.com/pricing"), { url: "https://example.com/pricing", strategy: "mobile" });
  assert.deepEqual(statement("@pagespeed:audit:https://example.com/ strategy=desktop"), { url: "https://example.com/", strategy: "desktop" });
  assert.deepEqual(statement("@pagespeed:field:https://example.com"), { origin: "https://example.com", form: "all" });
  assert.deepEqual(statement("@pagespeed:field:https://example.com/a?b=1 form=phone"), { url: "https://example.com/a?b=1", form: "phone" });
  assert.deepEqual(statement("@pagespeed:field:https://example.com/a scope=origin"), { origin: "https://example.com", form: "all" });
  for (const bad of ["@pagespeed:audit:example.com", "@pagespeed:audit:http://127.0.0.1/", "@pagespeed:audit:https://u:p@example.com/",
    "@pagespeed:audit:https://example.com/ strategy=tablet", "@pagespeed:audit:https://example.com/ form=phone",
    "@pagespeed:field:https://example.com/ form=watch", "@pagespeed:field:https://example.com/ scope=site"]) {
    assert.equal(typeof statement(bad), "string", bad);
  }
});

test("the audit sends the key only in a header, masks the Lighthouse report and fences what Google returns", async () => {
  const audits = {
    "largest-contentful-paint": { title: "LCP", score: 0.5, scoreDisplayMode: "numeric", displayValue: "3.9 s" },
    "document-title": { title: "Document has a `<title>`\n```", score: 0, scoreDisplayMode: "binary" },
    "meta-description": { title: "Document has a meta description", score: 1, scoreDisplayMode: "binary" },
    "uses-long-cache-ttl": { title: "Long cache", score: 0.4, scoreDisplayMode: "metricSavings", displayValue: "12 resources" },
    "diagnostics": { title: "Diagnostics", score: null, scoreDisplayMode: "informative" },
  };
  const run = await fetched([{ body: { lighthouseResult: { finalUrl: "https://example.com/", fetchTime: "2026-10-12T08:00:00Z",
    categories: { performance: { score: 0.61 }, accessibility: { score: 0.9 }, "best-practices": { score: 1 }, seo: { score: 0.83 } }, audits },
  loadingExperience: { overall_category: "AVERAGE", metrics: { LARGEST_CONTENTFUL_PAINT_MS: { percentile: 2900,
    distributions: [{ proportion: 0.7 }, { proportion: 0.2 }, { proportion: 0.1 }] } } } } }],
  () => ACTIONS.audit.execute({ credentials: key }, statement("@pagespeed:audit:https://example.com/")));
  const call = new URL(run.calls[0].url);
  assert.equal(call.origin + call.pathname, "https://www.googleapis.com/pagespeedonline/v5/runPagespeed");
  assert.equal(call.searchParams.get("key"), null);
  assert.equal(run.calls[0].headers.get("x-goog-api-key"), key.apiKey);
  assert.deepEqual(call.searchParams.getAll("category"), ["PERFORMANCE", "ACCESSIBILITY", "BEST_PRACTICES", "SEO"]);
  assert.match(call.searchParams.get("fields"), /^id,lighthouseResult\(/u);
  const summary = run.result.summary;
  assert.match(summary, /performance 61, accessibility 90, best-practices 100, seo 83/u);
  assert.match(summary, /largest-contentful-paint\t3\.9 s/u);
  assert.match(summary, /failing audits \(2\):\n {2}document-title\t0\tDocument has a `<title>` ```\n {2}uses-long-cache-ttl\t40\tLong cache \(12 resources\)/u);
  assert.doesNotMatch(summary, /meta-description|Diagnostics/u);
  assert.match(summary, /field data \(28 days, Chrome users\): AVERAGE\nLARGEST_CONTENTFUL_PAINT_MS\t2900\t70%\t20%\t10%/u);
  assert.match(summary, /:\n~~~\n/u);
});

test("field data reads the Chrome UX Report and answers too little traffic as no data", async () => {
  const read = await fetched([{ body: { record: { collectionPeriod: { firstDate: { year: 2026, month: 9, day: 13 }, lastDate: { year: 2026, month: 10, day: 10 } },
    metrics: { largest_contentful_paint: { percentiles: { p75: 2100 }, histogram: [{ density: 0.8 }, { density: 0.15 }, { density: 0.05 }] },
      round_trip_time: { percentiles: { p75: 90 } } } } } }],
  () => ACTIONS.field.execute({ credentials: key }, statement("@pagespeed:field:https://example.com form=phone")));
  assert.equal(read.calls[0].url, "https://chromeuxreport.googleapis.com/v1/records:queryRecord");
  assert.deepEqual(read.calls[0].body, { origin: "https://example.com", formFactor: "PHONE" });
  assert.match(read.result.summary, /2026-09-13 to 2026-10-10/u);
  assert.match(read.result.summary, /largest_contentful_paint\t2100\t80%\t15%\t5%/u);
  assert.doesNotMatch(read.result.summary, /round_trip_time/u);

  const none = await fetched([{ status: 404, body: { error: { message: "chrome ux report data not found" } } }],
    () => ACTIONS.field.execute({ credentials: key }, statement("@pagespeed:field:https://example.com/rare")));
  assert.deepEqual(none.calls[0].body, { url: "https://example.com/rare" });
  assert.match(none.result.summary, /no data for https:\/\/example\.com\/rare/u);
});

test("a missing or malformed key and an empty answer fail closed", async () => {
  for (const credentials of [{}, { apiKey: "has space" }, { apiKey: "x".repeat(201) }]) {
    await assert.rejects(ACTIONS.field.execute({ credentials }, { origin: "https://example.com", form: "all" }), /Save a Google API key/u);
  }
  await fetched([{ status: 403, body: { error: { message: "API not enabled" } } }],
    () => assert.rejects(ACTIONS.field.execute({ credentials: key }, { origin: "https://example.com", form: "all" }), /Provider returned 403/u));
  await fetched([{ body: { lighthouseResult: {} } }],
    () => assert.rejects(ACTIONS.audit.execute({ credentials: key }, { url: "https://example.com/", strategy: "mobile" }), /Lighthouse result/u));
  await fetched([{ body: { record: {} } }], () => assert.rejects(verifyPageSpeed(key), /confirm Chrome UX Report/u));
  const verified = await fetched([{ body: { record: { metrics: { largest_contentful_paint: {} } } } }], () => verifyPageSpeed(key));
  assert.equal(verified.calls[0].headers.get("x-goog-api-key"), key.apiKey);
});
