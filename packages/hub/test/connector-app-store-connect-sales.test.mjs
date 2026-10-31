import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { test } from "node:test";

import { salesOptions } from "../src/connectors/actions/app-store-connect-sales.ts";
import { APP, BUNDLE, run, statement, writes } from "./support/app-store-connect-double.mjs";

const noon = Date.UTC(2026, 9, 31, 12);
const HEAD = ["Provider", "Provider Country", "SKU", "Developer", "Title", "Version", "Product Type Identifier", "Units",
  "Developer Proceeds", "Begin Date", "End Date", "Customer Currency", "Country Code", "Currency of Proceeds", "Apple Identifier",
  "Customer Price", "Promo Code", "Parent Identifier"];
const line = (type, units, country, appleId, { proceeds = "0", currency = "USD", parent = "" } = {}) =>
  ["APPLE", "US", "sku", "Dev", "Title", "1.0", type, units, proceeds, "", "", "USD", country, currency, appleId, "0", "", parent].join("\t");
const report = (...rows) => new Response(gzipSync([HEAD.join("\t"), ...rows].join("\n") + "\n"),
  { headers: { "content-type": "application/a-gzip" } });
const app = { ...APP, attributes: { ...APP.attributes, sku: "EXAMPLE" } };

test("sales options name a vendor and whole past days or months", () => {
  assert.deepEqual(salesOptions("vendor=89123456 days=3", noon), { vendor: "89123456", frequency: "DAILY",
    periods: ["2026-10-30", "2026-10-29", "2026-10-28"] });
  assert.deepEqual(salesOptions("vendor=89123456 by=month months=2", noon).periods, ["2026-09", "2026-08"]);
  assert.deepEqual(salesOptions("vendor=89123456 months=1", Date.UTC(2026, 0, 15)).periods, ["2025-12"]);
  assert.equal(salesOptions("vendor=89123456", noon).periods.length, 14);
  for (const bad of ["", "days=3", "vendor=abc", "vendor=89123456 days=32", "vendor=89123456 by=week",
    "vendor=89123456 by=day months=2", "vendor=89123456 by=month days=2", "vendor=89123456 months=13", "vendor=89123456 colour=red"]) {
    assert.equal(typeof salesOptions(bad, noon), "string", bad);
  }
  assert.equal(typeof statement(`@appstoreconnect:sales:${BUNDLE} vendor=89123456`), "object");
  assert.equal(typeof statement("@appstoreconnect:sales:* vendor=89123456 by=month"), "object");
  assert.equal(typeof statement("@appstoreconnect:sales:has/slash vendor=89123456"), "string");
});

test("sales counts one app's downloads, redownloads, updates and in-app units per day", async () => {
  const yesterday = new Date(Math.floor(Date.now() / 86_400_000) * 86_400_000 - 86_400_000).toISOString().slice(0, 10);
  const before = new Date(Date.parse(yesterday) - 86_400_000).toISOString().slice(0, 10);
  const days = { [yesterday]: report(line("1", "5", "US", APP.id), line("1F", "2", "CN", APP.id), line("3", "1", "US", APP.id),
    line("7", "9", "JP", APP.id), line("IA1", "2", "US", "999", { parent: "EXAMPLE", proceeds: "0.70" }),
    line("1", "40", "US", "123456")) };
  const shown = await run({ "GET /v1/apps": { data: [app] },
    "GET /v1/salesReports": (call) => days[call.query["filter[reportDate]"]] },
  `@appstoreconnect:sales:${BUNDLE} vendor=89123456 days=2`);
  const asked = shown.calls.filter(call => call.path === "/v1/salesReports");
  assert.equal(asked.length, 2);
  assert.deepEqual(asked[0].query, { "filter[frequency]": "DAILY", "filter[reportType]": "SALES", "filter[reportSubType]": "SUMMARY",
    "filter[vendorNumber]": "89123456", "filter[reportDate]": yesterday, "filter[version]": "1_0" });
  const summary = shown.value.summary;
  assert.ok(summary.includes(`${yesterday}\t7\t1\t9\t2\n${before}\t(no report)\nTOTAL\t7\t1\t9\t2`), "another app's 40 downloads are not counted");
  assert.match(summary, /downloads by country \(top 10\): US 5, CN 2/u);
  assert.match(summary, /developer proceeds: 1\.40 USD/u);
  assert.deepEqual(writes(shown.calls), []);
});

test("sales across all apps counts every row and explains a refused key", async () => {
  const all = await run({ "GET /v1/salesReports": () => report(line("1", "5", "US", APP.id), line("1", "40", "DE", "123456")) },
    "@appstoreconnect:sales:* vendor=89123456 by=month months=1");
  assert.match(all.value.summary, /all apps/u);
  assert.match(all.value.summary, /2026-\d\d\t45\t0\t0\t0/u);
  await assert.rejects(run({ "GET /v1/salesReports": { status: 403, errors: [{ detail: "not allowed" }] } },
    "@appstoreconnect:sales:* vendor=89123456 days=1"), /403: not allowed \(reports need an API key with the Sales, Finance or Admin role\)/u);
});
