import assert from "node:assert/strict";
import { test } from "node:test";
import { withProviderResponses as fetched } from "./support/fetch-responses.mjs";
import { GCP_ACTIONS as actions } from "../src/connectors/gcp-api.ts";
import { request } from "../src/connectors/gcp-common.ts";

const context = { credentials: { oauthToken: "cloud-access" } };
const project = "billing-project";
const sku = "ABCD-1234-5678";
const parse = (action, target, options) => actions[action].parse({ target, text: options === undefined ? "" : JSON.stringify(options) });
const window = { from: new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 19) + "Z", to: new Date(Date.now() - 86400000).toISOString().slice(0, 19) + "Z" };

test("SKU attribution uses the exact public resource and same OAuth identity with an IAM-checked quota project, rejecting injection and mismatched responses", async () => {
  for (const target of [`${project}/../secret`, `${project}/${sku}/price`, `${project}\r\nx-other:private/${sku}`, `https://evil.test/${sku}`]) assert.equal(typeof parse("read_sku", target), "string");
  assert.equal(typeof parse("read_sku", `${project}/${sku}`, { headers: { authorization: "other" } }), "string");
  const input = parse("read_sku", `${project}/${sku}`);
  const run = await fetched([{ body: { name: `skus/${sku}`, skuId: sku, displayName: "Gemini model output tokens", service: "services/AEFD-7695-64FA" } }], () => actions.read_sku.execute(context, input));
  assert.equal(run.calls[0].url, `https://cloudbilling.googleapis.com/v2beta/skus/${sku}`);
  assert.equal(run.calls[0].headers.get("authorization"), "Bearer cloud-access");
  assert.equal(run.calls[0].headers.get("x-goog-user-project"), project);
  assert.match(run.result.summary, /Gemini model output tokens/u);
  assert.match(run.result.summary, /NOT usage or account prices/u);
  for (const body of [{ name: "skus/OTHER", skuId: sku }, { name: `skus/${sku}`, skuId: "OTHER" }]) await fetched([{ body }], () => assert.rejects(actions.read_sku.execute(context, input), /requested SKU/u));
  await assert.rejects(request(context.credentials, "https://cloudbilling.googleapis.com/v2beta/skus/test", undefined, "project\r\nx-other:private"), /Invalid Google Cloud quota project/u);
});

test("billing quota context is opt-in, typed and separate from billing-resource access", async () => {
  assert.equal(typeof parse("read_billing_info", project, { quotaProject: "other-project" }), "string");
  assert.equal(typeof parse("list_billing_accounts", "*", { quotaProject: "bad\r\nproject" }), "string");
  for (const withQuota of [false, true]) {
    const linkage = await fetched([{ body: { projectId: project, billingEnabled: true } }], () => actions.read_billing_info.execute(context, parse("read_billing_info", project, withQuota ? { quotaProject: project } : undefined)));
    assert.equal(linkage.calls[0].headers.get("x-goog-user-project"), withQuota ? project : null);
    assert.equal(linkage.calls[0].url, `https://cloudbilling.googleapis.com/v1/projects/${project}/billingInfo`);
  }
  const accounts = await fetched([{ body: { billingAccounts: [] } }], () => actions.list_billing_accounts.execute(context, parse("list_billing_accounts", "*", { quotaProject: project, pageToken: "next" })));
  assert.equal(accounts.calls[0].headers.get("x-goog-user-project"), project);
  assert.equal(new URL(accounts.calls[0].url).searchParams.get("pageToken"), "next");
  await fetched([{ status: 403, body: { error: { status: "PERMISSION_DENIED" } } }], calls => assert.rejects(actions.read_billing_info.execute(context, parse("read_billing_info", project, { quotaProject: project })), /PERMISSION_DENIED/u).then(() => assert.equal(calls.length, 1)));
});

test("historical API usage fixes the metric, service filter and aggregation with bounded dates, exact counts and explicit incomplete/empty semantics", async () => {
  for (const changes of [{ filter: "true" }, { apiService: "evil.googleapis.com" }, { responseClass: '2xx" OR true' }, { from: "2000-01-01T00:00:00Z" }, { to: "2100-01-01T00:00:00Z" }, { from: window.to, to: window.from }, { pageToken: "bad\ntoken" }]) assert.equal(typeof parse("query_api_usage", project, { ...window, ...changes }), "string");
  const run = await fetched([{ body: { timeSeries: [{ points: [{ interval: { startTime: window.from, endTime: window.to }, value: { int64Value: "9007199254740993" } }] }], nextPageToken: "more" } }], () => actions.query_api_usage.execute(context, parse("query_api_usage", project, { ...window, responseClass: "5xx", pageToken: "next" })));
  const url = new URL(run.calls[0].url);
  assert.equal(url.searchParams.get("filter"), 'metric.type = "serviceruntime.googleapis.com/api/request_count" AND resource.type = "consumed_api" AND resource.labels.project_id = "billing-project" AND resource.labels.service = "generativelanguage.googleapis.com" AND metric.labels.response_code_class = "5xx"');
  assert.equal(typeof parse("query_api_usage", "123456789", window), "string");
  assert.equal(url.searchParams.get("aggregation.perSeriesAligner"), "ALIGN_SUM");
  assert.equal(url.searchParams.get("aggregation.crossSeriesReducer"), "REDUCE_SUM");
  assert.equal(url.searchParams.get("aggregation.alignmentPeriod"), "86400s");
  assert.equal(url.searchParams.get("pageToken"), "next");
  assert.equal(run.calls[0].headers.get("x-goog-user-project"), project);
  assert.match(run.result.summary, /9007199254740993/u);
  assert.match(run.result.summary, /page is incomplete/u);
  assert.match(run.result.summary, /not billable tokens/u);
  const empty = await fetched([{ body: {} }], () => actions.query_api_usage.execute(context, parse("query_api_usage", project, window)));
  assert.match(empty.result.summary, /does not establish zero requests/u);
  await fetched([{ body: { timeSeries: [{ points: [{ value: { int64Value: "bad" } }] }] } }], () => assert.rejects(actions.query_api_usage.execute(context, parse("query_api_usage", project, window)), /malformed usage counts/u));
});
