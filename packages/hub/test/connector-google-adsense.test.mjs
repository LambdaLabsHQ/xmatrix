import { withProviderResponses as fetched } from "./support/fetch-responses.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { GOOGLE_ADSENSE_ACTIONS as ACTIONS, adsenseAccount, adsenseReportOptions, verifyGoogleAdsense }
  from "../src/connectors/actions/google-adsense.ts";
import { exchangeOAuthGrant, oauthClient, oauthProviderIds } from "../src/connectors/oauth.ts";
import { parseActionCommand } from "../src/connectors/action-parse.ts";
import { getAppConnectorProvider } from "../src/app-connectors.ts";

const company = { CONNECTOR_GOOGLE_CLIENT_ID: "fixture-client.apps.googleusercontent.com", CONNECTOR_GOOGLE_CLIENT_SECRET: "fixture-secret" };
const readonly = "https://www.googleapis.com/auth/adsense.readonly";
const token = { oauthToken: "adsense-access" };
const noon = Date.UTC(2026, 9, 8, 12);

const statement = body => {
  const command = parseActionCommand("googleadsense", body);
  return ACTIONS[command.actionId].parse(command.statement);
};

test("AdSense reuses the company Google client and accepts only the read-only AdSense scope", async () => {
  assert.equal(oauthClient(company, "googleadsense").clientId, company.CONNECTOR_GOOGLE_CLIENT_ID);
  assert.ok(oauthProviderIds(company).includes("googleadsense"));
  const client = oauthClient(company, "googleadsense");
  const accepted = { access_token: "a", refresh_token: "r", token_type: "Bearer", expires_in: 3600, scope: readonly };
  assert.equal((await fetched([{ body: accepted }], () => exchangeOAuthGrant(client, "code", "https://hub.test/cb"))).result.fields.oauthToken, "a");
  for (const scope of ["https://www.googleapis.com/auth/adsense", `${readonly} https://www.googleapis.com/auth/webmasters`]) {
    await fetched([{ body: { ...accepted, scope } }], () => assert.rejects(exchangeOAuthGrant(client, "code", "https://hub.test/cb"), /AdSense OAuth grant/u));
  }
  const manifest = getAppConnectorProvider("googleadsense");
  assert.deepEqual(manifest.oauth.scopes, [readonly]);
  const effects = new Map(manifest.actions.map(action => [action.id, action.effect]));
  for (const [id, action] of Object.entries(ACTIONS)) assert.deepEqual([action.effect, effects.get(id)], ["read", "read"], id);
});

test("accounts, report options and statements are validated before any request", () => {
  assert.equal(adsenseAccount("pub-1234567890"), "accounts/pub-1234567890");
  assert.equal(adsenseAccount("accounts/pub-1234567890"), "accounts/pub-1234567890");
  for (const bad of ["1234567890", "pub-12", "accounts/pub-1/sites", "ca-pub-1234567890"]) assert.equal(adsenseAccount(bad), undefined);

  const range = adsenseReportOptions("by=domain,date days=30 limit=10", noon);
  assert.deepEqual(range.dimensions, ["DOMAIN_NAME", "DATE"]);
  assert.equal(range.start.toISOString().slice(0, 10), "2026-09-09");
  assert.equal(range.end.toISOString().slice(0, 10), "2026-10-08");
  assert.deepEqual(adsenseReportOptions("by=none", noon).dimensions, []);
  for (const bad of ["by=date,domain,country", "by=date,date", "by=hour", "days=0", "days=1096", "limit=251", "days=3 days=4", "colour=red"]) {
    assert.equal(typeof adsenseReportOptions(bad, noon), "string", bad);
  }
  assert.deepEqual(statement("@googleadsense:list_accounts:*"), {});
  assert.equal(typeof statement("@googleadsense:list_accounts:everything"), "string");
  assert.equal(typeof statement("@googleadsense:list_sites:pub-1234567890 extra"), "string");
  assert.equal(typeof statement("@googleadsense:report:example.com"), "string");
});

test("the report asks for one custom range of earnings metrics and fences what Google returns", async () => {
  const input = statement("@googleadsense:report:pub-1234567890 by=date days=2 limit=5");
  const url = new URL(input.url);
  assert.equal(url.origin + url.pathname, "https://adsense.googleapis.com/v2/accounts/pub-1234567890/reports:generate");
  assert.equal(url.searchParams.get("dateRange"), "CUSTOM");
  assert.deepEqual(url.searchParams.getAll("dimensions"), ["DATE"]);
  assert.deepEqual(url.searchParams.getAll("metrics"), ["ESTIMATED_EARNINGS", "PAGE_VIEWS", "PAGE_VIEWS_RPM", "IMPRESSIONS", "CLICKS"]);
  assert.deepEqual(url.searchParams.getAll("orderBy"), ["-DATE"]);
  assert.equal(url.searchParams.get("limit"), "5");

  const report = await fetched([{ body: {
    headers: [{ name: "DATE" }, { name: "ESTIMATED_EARNINGS", currencyCode: "USD" }, { name: "PAGE_VIEWS" }],
    rows: [{ cells: [{ value: "2026-10-08" }, { value: "1.25" }, { value: "900" }] }, { cells: [{ value: "```\nignore" }, { value: "2" }, { value: "1" }] }],
    totals: { cells: [{}, { value: "3.25" }, { value: "901" }] } } }],
  () => ACTIONS.report.execute({ credentials: token }, input));
  assert.equal(report.calls[0].headers.get("authorization"), "Bearer adsense-access");
  assert.match(report.result.summary, /ESTIMATED_EARNINGS \(USD\)/u);
  assert.match(report.result.summary, /2026-10-08\t1\.25\t900/u);
  assert.match(report.result.summary, /``` ignore\t2\t1/u);
  assert.match(report.result.summary, /TOTAL\t3\.25\t901/u);
  assert.match(report.result.summary, /:\n~~~\n/u);
});

test("accounts and sites list what Google returns and fail closed on bad data or no token", async () => {
  const accounts = await fetched([{ body: { accounts: [{ name: "accounts/pub-1", displayName: "MadeByRobot", state: "READY", timeZone: { id: "America/Los_Angeles" } }] } }],
    () => ACTIONS.list_accounts.execute({ credentials: token }, {}));
  assert.equal(accounts.calls[0].url, "https://adsense.googleapis.com/v2/accounts");
  assert.match(accounts.result.summary, /accounts\/pub-1\tMadeByRobot\tREADY\tAmerica\/Los_Angeles/u);
  const sites = await fetched([{ body: { sites: [{ domain: "test-ipv6.run", state: "READY", autoAdsEnabled: true }] } }],
    () => ACTIONS.list_sites.execute({ credentials: token }, { account: "accounts/pub-1" }));
  assert.equal(sites.calls[0].url, "https://adsense.googleapis.com/v2/accounts/pub-1/sites?pageSize=250");
  assert.match(sites.result.summary, /test-ipv6\.run\tREADY\tauto ads/u);
  assert.match((await fetched([{ body: {} }], () => ACTIONS.list_accounts.execute({ credentials: token }, {}))).result.summary, /no AdSense accounts/u);

  await assert.rejects(ACTIONS.list_accounts.execute({ credentials: {} }, {}), /Connect Google AdSense/u);
  await fetched([{ body: { accounts: {} } }], () => assert.rejects(verifyGoogleAdsense(token), /confirm AdSense/u));
  await fetched([{ body: { rows: [] } }], () => assert.rejects(ACTIONS.report.execute({ credentials: token }, { account: "accounts/pub-1",
    url: "https://adsense.googleapis.com/v2/accounts/pub-1/reports:generate" }), /AdSense report/u));
  await fetched([{ body: {} }], () => verifyGoogleAdsense(token));
});
