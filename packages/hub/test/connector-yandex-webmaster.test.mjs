import { withProviderResponses as fetched } from "./support/fetch-responses.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { YANDEX_WEBMASTER_ACTIONS as ACTIONS, verifyYandexWebmaster, yandexHost } from "../src/connectors/actions/yandex-webmaster.ts";
import { statementParser } from "./support/google-read-grant.mjs";

const token = { token: "y0_AgAAAAFixtureToken-123" };
const statement = statementParser("yandexwebmaster", ACTIONS);
const host = "https:example.com:443";
const user = { body: { user_id: 42 } };

test("hosts and recrawl pages are validated before any request", () => {
  assert.equal(yandexHost(host), host);
  assert.equal(yandexHost("http:www.example.ru:80"), "http:www.example.ru:80");
  for (const bad of ["example.com", "https://example.com", "https:example.com", "https:example.com:99999", "ftp:example.com:21"]) {
    assert.equal(yandexHost(bad), undefined, bad);
  }
  assert.deepEqual(statement(`@yandexwebmaster:summary:${host}`), { host });
  assert.equal(typeof statement(`@yandexwebmaster:summary:${host} extra`), "string");
  assert.deepEqual(statement(`@yandexwebmaster:recrawl:${host} https://example.com/a`), { host, page: "https://example.com/a" });
  for (const page of ["http://example.com/a", "https://www.example.com/a", "https://example.com:8443/a", "not-a-url"]) {
    assert.equal(typeof statement(`@yandexwebmaster:recrawl:${host} ${page}`), "string", page);
  }
});

test("reads send the token as an OAuth header under the token's user and fence what Yandex returns", async () => {
  const hosts = await fetched([user, { body: { hosts: [{ host_id: host, ascii_host_url: "https://example.com/", verified: true },
    { host_id: "https:www.example.com:443", ascii_host_url: "https://www.example.com/\n```", verified: false, main_mirror: { host_id: host } }] } }],
  () => ACTIONS.list_hosts.execute({ credentials: token }, {}));
  assert.deepEqual(hosts.calls.map(call => call.url), ["https://api.webmaster.yandex.net/v4/user", "https://api.webmaster.yandex.net/v4/user/42/hosts"]);
  assert.equal(hosts.calls[1].headers.get("authorization"), `OAuth ${token.token}`);
  assert.match(hosts.result.summary, /https:example\.com:443\thttps:\/\/example\.com\/\tverified\t\n/u);
  assert.match(hosts.result.summary, /https:\/\/www\.example\.com\/ ```\tnot verified\tmirror of https:example\.com:443/u);

  const summary = await fetched([user, { body: { sqi: 70, searchable_pages_count: 120, excluded_pages_count: 8, site_problems: { CRITICAL: 1, RECOMMENDATION: 3 } } }],
    () => ACTIONS.summary.execute({ credentials: token }, { host }));
  assert.equal(summary.calls[1].url, "https://api.webmaster.yandex.net/v4/user/42/hosts/https%3Aexample.com%3A443/summary");
  assert.match(summary.result.summary, /SQI\): 70\npages in search: 120\nexcluded pages: 8\nproblems: fatal 0, critical 1, possible_problem 0, recommendation 3/u);

  const queries = await fetched([user, { body: { date_from: "2026-10-01", date_to: "2026-10-07", queries: [
    { query_text: "seo api", indicators: { TOTAL_SHOWS: 40, TOTAL_CLICKS: 6, AVG_SHOW_POSITION: 4.24, AVG_CLICK_POSITION: null } }] } }],
  () => ACTIONS.queries.execute({ credentials: token }, { host }));
  const url = new URL(queries.calls[1].url);
  assert.equal(url.searchParams.get("order_by"), "TOTAL_CLICKS");
  assert.deepEqual(url.searchParams.getAll("query_indicator"), ["TOTAL_SHOWS", "TOTAL_CLICKS", "AVG_SHOW_POSITION", "AVG_CLICK_POSITION"]);
  assert.match(queries.result.summary, /2026-10-01 to 2026-10-07/u);
  assert.match(queries.result.summary, /seo api\t40\t6\t4\.2\t-/u);
});

test("recrawl posts the page and reports the quota", async () => {
  const queued = await fetched([user, { body: { task_id: "t1", quota_remainder: 19 } }],
    () => ACTIONS.recrawl.execute({ credentials: token }, { host, page: "https://example.com/a" }));
  assert.equal(queued.calls[1].method, "POST");
  assert.equal(queued.calls[1].url, "https://api.webmaster.yandex.net/v4/user/42/hosts/https%3Aexample.com%3A443/recrawl/queue");
  assert.deepEqual(queued.calls[1].body, { url: "https://example.com/a" });
  assert.match(queued.result.summary, /19 recrawls left today/u);
});

test("a missing token, Yandex errors and malformed answers fail closed", async () => {
  for (const credentials of [{}, { token: "has space" }]) await assert.rejects(verifyYandexWebmaster(credentials), /Yandex OAuth token/u);
  await fetched([{ status: 401, body: { error_code: "INVALID_OAUTH_TOKEN", error_message: "Invalid token" } }],
    () => assert.rejects(verifyYandexWebmaster(token), /Provider returned 401: INVALID_OAUTH_TOKEN: Invalid token/u));
  await fetched([{ body: {} }], () => assert.rejects(verifyYandexWebmaster(token), /token's user/u));
  await fetched([user, { body: { hosts: {} } }], () => assert.rejects(ACTIONS.list_hosts.execute({ credentials: token }, {}), /host list/u));
  await fetched([user], () => verifyYandexWebmaster(token));
});
