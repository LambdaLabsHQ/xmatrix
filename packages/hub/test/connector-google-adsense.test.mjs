import { withProviderResponses as fetched } from "./support/fetch-responses.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { GOOGLE_ADSENSE_ACTIONS as ACTIONS, accountDays, adsenseAccount, adsenseReportOptions, verifyGoogleAdsense }
  from "../src/connectors/actions/google-adsense.ts";
import { assertReadOnlyGoogleGrant, statementParser } from "./support/google-read-grant.mjs";

const readonly = "https://www.googleapis.com/auth/adsense.readonly";
const token = { oauthToken: "adsense-access" };

const statement = statementParser("googleadsense", ACTIONS);

test("AdSense reuses the company Google client and accepts only the read-only AdSense scope", async () => {
  await assertReadOnlyGoogleGrant("googleadsense", readonly, ACTIONS,
    { broader: "https://www.googleapis.com/auth/adsense", refused: /AdSense OAuth grant/u });
});

test("accounts, report options and statements are validated before any request", () => {
  assert.equal(adsenseAccount("pub-1234567890"), "accounts/pub-1234567890");
  assert.equal(adsenseAccount("accounts/pub-1234567890"), "accounts/pub-1234567890");
  for (const bad of ["1234567890", "pub-12", "accounts/pub-1/sites", "ca-pub-1234567890"]) assert.equal(adsenseAccount(bad), undefined);

  assert.deepEqual(adsenseReportOptions("by=format,date days=30 limit=10 domain=Test-IPv6.run include_today"),
    { dimensions: ["AD_FORMAT_NAME", "DATE"], days: 30, limit: 10, includeToday: true, domain: "test-ipv6.run" });
  assert.deepEqual(adsenseReportOptions("by=none"), { dimensions: [], days: 7, limit: 50, includeToday: false });
  for (const bad of ["by=date,domain,country", "by=date,date", "by=hour", "by=constructor", "by=toString", "by=__proto__",
    "days=0", "days=1096", "limit=251", "days=3 days=4", "colour=red", "domain=https://example.com", "domain=example.com/x",
    "include_today include_today", "today"]) {
    assert.equal(typeof adsenseReportOptions(bad), "string", bad);
  }
  assert.deepEqual(statement("@googleadsense:list_accounts:*"), {});
  assert.equal(typeof statement("@googleadsense:list_accounts:everything"), "string");
  assert.equal(typeof statement("@googleadsense:list_sites:pub-1234567890 extra"), "string");
  assert.equal(typeof statement("@googleadsense:report:example.com"), "string");
});

test("report days are whole days in the account time zone, ending yesterday unless today is asked for", () => {
  // 18:30 UTC on 16 October is already 02:30 on 17 October in Shanghai and still 11:30 on 16 October in Los Angeles.
  const evening = Date.UTC(2026, 9, 16, 18, 30);
  assert.deepEqual(accountDays("Asia/Shanghai", 7, false, evening), { start: "2026-10-10", end: "2026-10-16" });
  assert.deepEqual(accountDays("Asia/Shanghai", 1, true, evening), { start: "2026-10-17", end: "2026-10-17" });
  assert.deepEqual(accountDays("America/Los_Angeles", 1, false, evening), { start: "2026-10-15", end: "2026-10-15" });
  assert.deepEqual(accountDays("Asia/Shanghai", 3, false, Date.UTC(2026, 2, 1, 18)), { start: "2026-02-27", end: "2026-03-01" });
});

test("the report reads the account time zone, asks for one custom range and fences what Google returns", async () => {
  const input = statement("@googleadsense:report:pub-1234567890 by=date days=2 limit=5 domain=test-ipv6.run");
  const report = await fetched([{ body: { name: "accounts/pub-1234567890", timeZone: { id: "Asia/Shanghai" } } }, { body: {
    headers: [{ name: "DATE" }, { name: "ESTIMATED_EARNINGS", currencyCode: "USD" }, { name: "PAGE_VIEWS" }],
    rows: [{ cells: [{ value: "2026-10-08" }, { value: "1.25" }, { value: "900" }] }, { cells: [{ value: "```\nignore" }, { value: "2" }, { value: "1" }] }],
    totals: { cells: [{}, { value: "3.25" }, { value: "901" }] } } }],
  () => ACTIONS.report.execute({ credentials: token }, input));
  assert.equal(report.calls[0].url, "https://adsense.googleapis.com/v2/accounts/pub-1234567890");
  const url = new URL(report.calls[1].url);
  assert.equal(url.origin + url.pathname, "https://adsense.googleapis.com/v2/accounts/pub-1234567890/reports:generate");
  assert.equal(url.searchParams.get("dateRange"), "CUSTOM");
  assert.deepEqual(url.searchParams.getAll("dimensions"), ["DATE"]);
  assert.deepEqual(url.searchParams.getAll("metrics"), ["ESTIMATED_EARNINGS", "PAGE_VIEWS", "PAGE_VIEWS_RPM", "IMPRESSIONS", "CLICKS",
    "AD_REQUESTS", "AD_REQUESTS_COVERAGE", "ACTIVE_VIEW_VIEWABILITY"]);
  assert.deepEqual(url.searchParams.getAll("orderBy"), ["-DATE"]);
  assert.equal(url.searchParams.get("limit"), "5");
  assert.deepEqual(url.searchParams.getAll("filters"), ["DOMAIN_NAME==test-ipv6.run"]);
  assert.match(report.result.summary, /Asia\/Shanghai/u);
  assert.doesNotMatch(report.result.summary, /ad unit name/u);
  assert.equal(report.calls[1].headers.get("authorization"), "Bearer adsense-access");
  assert.match(report.result.summary, /ESTIMATED_EARNINGS \(USD\)/u);
  assert.match(report.result.summary, /2026-10-08\t1\.25\t900/u);
  assert.match(report.result.summary, /``` ignore\t2\t1/u);
  assert.match(report.result.summary, /TOTAL\t3\.25\t901/u);
  assert.match(report.result.summary, /\)\.\n~~~\n/u);
});

test("accounts and sites list what Google returns and fail closed on bad data or no token", async () => {
  const accounts = await fetched([{ body: { accounts: [{ name: "accounts/pub-1", displayName: "MadeByRobot", state: "READY", timeZone: { id: "America/Los_Angeles" } }] } }],
    () => ACTIONS.list_accounts.execute({ credentials: token }, {}));
  assert.equal(accounts.calls[0].url, "https://adsense.googleapis.com/v2/accounts");
  assert.match(accounts.result.summary, /accounts\/pub-1\tMadeByRobot\tREADY\tAmerica\/Los_Angeles/u);
  const sites = await fetched([{ body: { sites: [{ domain: "test-ipv6.run", state: "READY", autoAdsEnabled: true }] } }],
    () => ACTIONS.list_sites.execute({ credentials: token }, { account: "accounts/pub-1" }));
  assert.equal(sites.calls[0].url, "https://adsense.googleapis.com/v2/accounts/pub-1/sites?pageSize=250");
  assert.match(sites.result.summary, /test-ipv6\.run\tREADY\tauto ads on/u);
  assert.match(sites.result.summary, /per-format Auto ads switches/u);
  assert.match((await fetched([{ body: {} }], () => ACTIONS.list_accounts.execute({ credentials: token }, {}))).result.summary, /no AdSense accounts/u);

  await assert.rejects(ACTIONS.list_accounts.execute({ credentials: {} }, {}), /Connect Google AdSense/u);
  await fetched([{ body: { accounts: {} } }], () => assert.rejects(verifyGoogleAdsense(token), /confirm AdSense/u));
  const reportInput = statement("@googleadsense:report:pub-1234567890 by=ad_unit");
  await fetched([{ body: { timeZone: { id: "Asia/Shanghai" } } }, { body: { rows: [] } }],
    () => assert.rejects(ACTIONS.report.execute({ credentials: token }, reportInput), /AdSense report/u));
  await fetched([{ body: {} }], () => assert.rejects(ACTIONS.report.execute({ credentials: token }, reportInput), /account time zone/u));
  const units = await fetched([{ body: { timeZone: { id: "Asia/Shanghai" } } }, { body: { headers: [{ name: "AD_UNIT_NAME" }], rows: [] } }],
    () => ACTIONS.report.execute({ credentials: token }, reportInput));
  assert.match(units.result.summary, /Auto ads have no ad unit name/u);
  await fetched([{ body: {} }], () => verifyGoogleAdsense(token));
});

test("ad units, payments, alerts and policy issues read the account's lists", async () => {
  const client = "accounts/pub-1/adclients/ca-pub-1";
  const units = await fetched([
    { body: { adClients: [{ name: client, productCode: "AFC" }, { name: "accounts/pub-1/adclients/partner-pub-1", productCode: "AFS" }] } },
    { body: { adUnits: [{ displayName: "home-result", state: "ACTIVE", reportingDimensionId: "ca-pub-1:47",
      contentAdsSettings: { type: "DISPLAY", size: "1x3" } }] } }],
  () => ACTIONS.list_adunits.execute({ credentials: token }, { account: "accounts/pub-1" }));
  assert.deepEqual(units.calls.map(call => call.url), ["https://adsense.googleapis.com/v2/accounts/pub-1/adclients?pageSize=250",
    `https://adsense.googleapis.com/v2/${client}/adunits?pageSize=250`]);
  assert.match(units.result.summary, /home-result\tACTIVE\tDISPLAY\t1x3\tca-pub-1:47/u);

  const payments = await fetched([{ body: { payments: [{ name: "accounts/pub-1/payments/unpaid", amount: "$124.70" },
    { name: "accounts/pub-1/payments/20260813", date: { year: 2026, month: 8, day: 13 }, amount: "$146.22" }] } }],
  () => ACTIONS.list_payments.execute({ credentials: token }, { account: "accounts/pub-1" }));
  assert.match(payments.result.summary, /unpaid balance\t\$124\.70\n2026-08-13\t\$146\.22/u);
  const alerts = await fetched([{ body: { alerts: [{ severity: "WARNING", type: "ua-conflict-policy-update", message: "Paused" }] } }],
    () => ACTIONS.list_alerts.execute({ credentials: token }, { account: "accounts/pub-1" }));
  assert.match(alerts.result.summary, /WARNING\tua-conflict-policy-update\tPaused/u);
  const issues = await fetched([{ body: {} }], () => ACTIONS.list_policy_issues.execute({ credentials: token }, { account: "accounts/pub-1" }));
  assert.match(issues.result.summary, /no policy issues/u);
  await fetched([{ body: { adClients: {} } }], () => assert.rejects(
    ACTIONS.list_adunits.execute({ credentials: token }, { account: "accounts/pub-1" }), /ad client list/u));
});
