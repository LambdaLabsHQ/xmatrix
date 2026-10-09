import assert from "node:assert/strict";
import { test } from "node:test";
import { withProviderResponses as fetched } from "./support/fetch-responses.mjs";
import { GCP_ACTIONS as actions } from "../src/connectors/gcp-api.ts";

const context = { credentials: { oauthToken: "cloud-access" } };
const target = "billing-project/exports/gcp_billing_export_v1_ABCDEF_123456_AB1234";
const options = { project: "deepmarket-485608", from: "2026-09-01", to: "2026-11-01", location: "US", groupBy: "month_service" };
function input(action, resource = target, values = options) {
  return actions[action].parse({ target: resource, text: values === undefined ? "" : JSON.stringify(values) });
}
function costResponse(entries, totalGroups = "2") {
  const names = ["cost_group", "currency", "cost", "credits", "net_cost", "line_items", "total_cost", "total_credits", "total_net_cost", "total_line_items", "total_groups", "exported_through", "usage_through"];
  return { jobComplete: true, schema: { fields: names.map(name => ({ name })) },
    rows: entries.map(entry => ({ f: [...entry, "12.50", "-2.00", "10.50", "20", totalGroups, "2026-10-09T12:00:00Z", "2026-10-09T10:00:00Z"].map(v => ({ v })) })) };
}

test("cost queries reject arbitrary SQL, identifiers, unbounded scans and invalid date/region options before provider calls", () => {
  for (const resource of ["https://evil.test", "billing-project/exports/ordinary_table", `${target}*/other`, "billing-project/exports`/gcp_billing_export_v1_X", "billing-project/exports/gcp_billing_export_focus_X"]) {
    assert.equal(typeof input("query_costs", resource), "string");
  }
  for (const changes of [
    { sql: "SELECT * FROM private" }, { groupBy: "__proto__" }, { groupBy: "service; DROP TABLE exports" },
    { from: "2026-02-30" }, { from: "2025-01-01" }, { to: "2026-09-01" }, { project: "123456789" },
    { maximumBytesBilled: "1000000001" }, { maximumBytesBilled: 100 }, { maximumBytesBilled: "0" },
    { timezone: "UTC' OR true" }, { location: "us-central1-a" }, { dryRun: "false" }, { job: "other/job" },
  ]) assert.equal(typeof input("query_costs", target, { ...options, ...changes }), "string");
  assert.equal(input("query_costs").dryRun, "true");
  assert.equal(input("query_costs").maximumBytesBilled, "100000000");
});

test("billing discovery uses the connected OAuth grant, exact Google endpoints, bounded pages and visible continuation", async () => {
  const accounts = await fetched([{ body: { billingAccounts: [{ name: "billingAccounts/ABC", displayName: "Business", open: true }], nextPageToken: "next-token" } }],
    () => actions.list_billing_accounts.execute(context, input("list_billing_accounts", "*", {})));
  assert.equal(accounts.calls[0].url, "https://cloudbilling.googleapis.com/v1/billingAccounts?pageSize=30");
  assert.equal(accounts.calls[0].headers.get("authorization"), "Bearer cloud-access");
  assert.match(accounts.result.summary, /NOT actual costs/u);
  assert.match(accounts.result.summary, /next-token/u);
  const datasets = await fetched([{ body: { datasets: [{ datasetReference: { datasetId: "exports" }, location: "EU" }] } }],
    () => actions.list_datasets.execute(context, input("list_datasets", "billing-project", { pageToken: "a+b/=" })));
  assert.equal(new URL(datasets.calls[0].url).searchParams.get("pageToken"), "a+b/=");
  assert.match(datasets.result.summary, /exports\tEU/u);
  const tables = await fetched([{ body: { tables: [{ tableReference: { tableId: "gcp_billing_export_resource_v1_X" }, type: "TABLE" }, { tableReference: { tableId: "private_secrets" } }], nextPageToken: "more" } }],
    () => actions.list_billing_tables.execute(context, input("list_billing_tables", "billing-project/exports", {})));
  assert.match(tables.result.summary, /gcp_billing_export_resource_v1_X/u);
  assert.doesNotMatch(tables.result.summary, /private_secrets/u);
  const linkage = await fetched([{ body: { projectId: "deepmarket-485608", billingAccountName: "billingAccounts/ABC", billingEnabled: true } }],
    () => actions.read_billing_info.execute(context, { project: "deepmarket-485608" }));
  assert.match(linkage.result.summary, /NOT actual costs/u);
});

test("cost dry runs use only parameterized fixed SELECT with numeric credits, full totals and hard query billing bounds", async () => {
  const run = await fetched([{ body: { totalBytesProcessed: "123456" } }], () => actions.query_costs.execute(context, input("query_costs")));
  const body = run.calls[0].body;
  assert.equal(run.calls[0].url, "https://bigquery.googleapis.com/bigquery/v2/projects/billing-project/queries");
  assert.equal(body.dryRun, true);
  assert.equal(body.maximumBytesBilled, "100000000");
  assert.equal(body.useLegacySql, false);
  assert.equal(body.parameterMode, "NAMED");
  assert.equal(body.jobTimeoutMs, "20000");
  assert.deepEqual(body.queryParameters.map(p => [p.name, p.parameterValue.value]), [
    ["project", "deepmarket-485608"], ["from", "2026-09-01"], ["to", "2026-11-01"], ["timezone", "UTC"],
  ]);
  assert.match(body.query, /WHERE project\.id = @project/u);
  assert.match(body.query, /usage_start_time < TIMESTAMP\(@to, @timezone\)/u);
  assert.match(body.query, /UNNEST\(credits\)/u);
  assert.match(body.query, /SUM\(net_cost\) OVER \(PARTITION BY currency\)/u);
  assert.match(body.query, /LIMIT 30$/u);
  assert.doesNotMatch(body.query, /deepmarket-485608/u);
  assert.match(run.result.summary, /dry run only, NOT actual costs/u);
  assert.match(run.result.summary, /123456/u);
});

test("actual reports retain decimal totals, distinguish credits and incomplete detail, and never turn an empty export into zero spend", async () => {
  const run = await fetched([{ body: costResponse([["2026-10 / Cloud Run", "USD", "8.50", "-1.00", "7.50", "10"], ["2026-09 / BigQuery", "USD", "4.00", "-1.00", "3.00", "10"]], "40") }],
    () => actions.query_costs.execute(context, input("query_costs", target, { ...options, dryRun: false })));
  assert.equal(run.calls[0].body.dryRun, false);
  assert.match(run.result.summary, /TOTAL\tUSD\tcost\t12\.50\tcredits\t-2\.00\tnet\t10\.50/u);
  assert.match(run.result.summary, /first 30 groups/u);
  assert.match(run.result.summary, /data can arrive late/u);
  const empty = await fetched([{ body: { jobComplete: true, rows: [] } }],
    () => actions.query_costs.execute(context, input("query_costs", target, { ...options, dryRun: false })));
  assert.match(empty.result.summary, /does not prove zero spend/u);
  await fetched([{ body: { jobComplete: true, rows: [{ f: [{ v: "fake" }] }], schema: { fields: [{ name: "wrong" }] } } }],
    () => assert.rejects(actions.query_costs.execute(context, input("query_costs", target, { ...options, dryRun: false })), /cost report schema/u));
});

test("pending cost jobs can be resumed without rerunning a charged query, but other queries and parameters fail closed", async () => {
  const initial = await fetched([{ body: { jobComplete: false, jobReference: { projectId: "billing-project", jobId: "job-1", location: "US" } } }],
    () => actions.query_costs.execute(context, input("query_costs", target, { ...options, dryRun: false })));
  assert.match(initial.result.summary, /query pending, no totals/u);
  const body = initial.calls[0].body;
  const metadata = { configuration: { labels: body.labels, query: { query: body.query, queryParameters: body.queryParameters, useLegacySql: false } }, status: {} };
  const resume = input("query_costs", target, { ...options, dryRun: false, job: "job-1" });
  const completed = await fetched([{ body: metadata }, { body: costResponse([["Cloud Run", "USD", "12.50", "-2.00", "10.50", "20"]]) }],
    () => actions.query_costs.execute(context, resume));
  assert.equal(completed.calls.every(call => call.method === "GET"), true);
  assert.match(completed.result.summary, /TOTAL\tUSD/u);
  for (const wrong of [ { ...metadata, configuration: { ...metadata.configuration, query: { ...metadata.configuration.query, query: "SELECT secret FROM private" } } },
    { ...metadata, configuration: { ...metadata.configuration, labels: {} } } ]) {
    await fetched([{ body: wrong }], calls => assert.rejects(actions.query_costs.execute(context, resume), /must match this Connector cost query/u).then(() => assert.equal(calls.length, 1)));
  }
  await fetched([{ body: metadata }], () => assert.rejects(actions.query_costs.execute(context, { ...resume, project: "other-project" }), /must match this Connector cost query/u));
});

test("Google failures explain disabled APIs and missing IAM without echoing raw provider bodies or broadening the grant", async () => {
  const error = { status: "PERMISSION_DENIED", message: "private-token must not be repeated", details: [
    { "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "SERVICE_DISABLED", metadata: { service: "bigquery.googleapis.com", consumer: "projects/123456789", other: "private-token" } },
  ] };
  await fetched([{ status: 403, body: { error } }], () => assert.rejects(actions.list_datasets.execute(context, { project: "billing-project" }), failure => {
    assert.match(failure.message, /SERVICE_DISABLED; API=bigquery.googleapis.com; consumer=projects\/123456789/u);
    assert.doesNotMatch(failure.message, /private-token/u);
    return true;
  }));
  await fetched([{ status: 403, body: { error: { status: "PERMISSION_DENIED", message: "Permission 'bigquery.jobs.create' denied for private-token" } } }],
    () => assert.rejects(actions.query_costs.execute(context, input("query_costs")), /permission=bigquery.jobs.create/u));
  assert.equal(actions.enable_api.effect, "write");
  assert.deepEqual(actions.enable_api.parse({ target: "billing-project/bigquery.googleapis.com", text: "" }), { project: "billing-project", api: "bigquery.googleapis.com" });
  for (const resource of ["billing-project/unknown.googleapis.com", "billing-project/bigquery.googleapis.com/", "billing-project/bigquery.googleapis.com/../other"]) {
    assert.equal(typeof actions.enable_api.parse({ target: resource, text: "" }), "string");
  }
  const enabled = await fetched([{ body: { name: "operations/api-enable", done: false } }], () => actions.enable_api.execute(context, { project: "billing-project", api: "bigquery.googleapis.com" }));
  assert.equal(enabled.calls[0].method, "POST");
  assert.equal(enabled.calls[0].url, "https://serviceusage.googleapis.com/v1/projects/billing-project/services/bigquery.googleapis.com:enable");
  assert.match(enabled.result.summary, /pending/u);
});
