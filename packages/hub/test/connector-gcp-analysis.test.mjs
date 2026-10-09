import assert from "node:assert/strict";
import { test } from "node:test";
import { withProviderResponses as fetched } from "./support/fetch-responses.mjs";
import { GCP_ACTIONS as actions } from "../src/connectors/gcp-api.ts";
import { request } from "../src/connectors/gcp-common.ts";

const context = { credentials: { oauthToken: "cloud-access" } };
const project = "billing-project";
const sku = "ABCD-1234-5678";
const parse = (action, target, options) => actions[action].parse({ target, text: options === undefined ? "" : JSON.stringify(options) });
const end = new Date(Date.now() - 86400000).toISOString().slice(0, 19) + "Z";
const window = { from: new Date(Date.parse(end) - 29 * 86400000).toISOString().slice(0, 19) + "Z", to: end };

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

test("credential aggregation retains opaque client IDs and methods without accepting caller-defined filters or collapsing them into a daily total", async () => {
  for (const groupBy of ["principal", 'credential" OR true', ["credential"]]) assert.equal(typeof parse("query_api_usage", project, { ...window, groupBy }), "string");
  const credential = "apikey:12345678-1234-4234-8234-123456789abc";
  for (const groupBy of ["credential", "credential_method"]) {
    const body = { timeSeries: [{ resource: { labels: { credential_id: credential, method: "GenerateContent" } }, points: [{ interval: { startTime: window.from, endTime: window.to }, value: { int64Value: "351" } }] }], nextPageToken: "more-callers" };
    const run = await fetched([{ body }], () => actions.query_api_usage.execute(context, parse("query_api_usage", project, { ...window, groupBy })));
    const query = new URL(run.calls[0].url).searchParams;
    assert.deepEqual(query.getAll("aggregation.groupByFields"), groupBy === "credential" ? ["resource.labels.credential_id"] : ["resource.labels.credential_id", "resource.labels.method"]);
    assert.equal(query.get("aggregation.alignmentPeriod"), "2505600s");
    assert.match(query.get("filter"), /resource.labels.project_id = "billing-project"/u);
    assert.match(run.result.summary, /apikey:12345678-1234-4234-8234-123456789abc/u);
    assert.match(run.result.summary, groupBy === "credential_method" ? /GenerateContent/u : /all methods/u);
    assert.match(run.result.summary, /not people, programs or models/u);
    assert.match(run.result.summary, /more-callers/u);
    assert.match(run.result.summary, /page is incomplete/u);
  }
});

const number = "123456789";
const uid = "12345678-1234-4234-8234-123456789abc";

test("API key discovery exposes only exact-project metadata, preserving pagination and dropping secret fields and arbitrary restrictions", async () => {
  for (const [target, opts] of [[project, {}], [`${number}/keys`, {}], [number, { showDeleted: "true" }], [number, { keyString: "read-secret" }], [number, { pageToken: "bad\ntoken" }]]) assert.equal(typeof parse("list_api_keys", target, opts), "string");
  const key = { name: `projects/${number}/locations/global/keys/${uid}`, uid, displayName: "Research worker", createTime: window.from, serviceAccountEmail: "worker@caller-project.iam.gserviceaccount.com",
    keyString: "secret-key-value", annotations: { secret: "secret-annotation" }, restrictions: { apiTargets: [{ service: "generativelanguage.googleapis.com", methods: ["secret-method"] }], browserKeyRestrictions: { allowedReferrers: ["secret-url"] }, arbitrary: "secret-restriction" } };
  const run = await fetched([{ body: { keys: [key], nextPageToken: "next-keys" } }], () => actions.list_api_keys.execute(context, parse("list_api_keys", number, { showDeleted: true, pageToken: "previous" })));
  const url = new URL(run.calls[0].url);
  assert.equal(url.pathname, `/v2/projects/${number}/locations/global/keys`);
  assert.equal(url.searchParams.get("showDeleted"), "true");
  assert.equal(url.searchParams.get("pageToken"), "previous");
  assert.equal(run.calls[0].headers.get("x-goog-user-project"), number);
  assert.match(run.result.summary, /Research worker/u);
  assert.match(run.result.summary, /worker@\u200b?caller-project.iam.gserviceaccount.com/u);
  assert.match(run.result.summary, /next-keys/u);
  assert.match(run.result.summary, /do not prove the human or program/u);
  for (const secret of ["secret-key-value", "secret-annotation", "secret-url", "secret-method", "secret-restriction"]) assert.ok(!run.result.summary.includes(secret));
  for (const changes of [{ name: `projects/987654321/locations/global/keys/${uid}` }, { name: `projects/${number}/locations/global/keys/../keyString` }, { uid: "secret-key-value" }]) await fetched([{ body: { keys: [{ ...key, ...changes }] } }], () => assert.rejects(actions.list_api_keys.execute(context, parse("list_api_keys", number)), /invalid API key identity/u));
  await fetched([{ status: 403, body: { error: { message: "Permission apikeys.keys.list denied", status: "PERMISSION_DENIED" } } }], calls => assert.rejects(actions.list_api_keys.execute(context, parse("list_api_keys", number)), /permission=apikeys.keys.list/u).then(() => assert.equal(calls.length, 1)));
});

test("historical audit activity scopes project/service/time and emits principal evidence without bodies or equating key managers with callers", async () => {
  for (const options of [{ ...window, filter: "true" }, { ...window, service: 'apikeys.googleapis.com" OR true' }, { ...window, from: "2000-01-01T00:00:00Z" }, { ...window, pageToken: "bad token" }]) assert.equal(typeof parse("query_audit_activity", project, options), "string");
  const old = { from: new Date(Date.now() - 200 * 86400000).toISOString().slice(0, 19) + "Z", to: new Date(Date.now() - 199 * 86400000).toISOString().slice(0, 19) + "Z" };
  assert.equal(typeof parse("query_audit_activity", project, old), "object");
  assert.equal(typeof parse("query_api_usage", project, old), "string");
  const input = parse("query_audit_activity", project, { ...window, service: "apikeys.googleapis.com", pageToken: "before" });
  const run = await fetched([{ body: { entries: [{ timestamp: window.from, protoPayload: { serviceName: "apikeys.googleapis.com", methodName: "google.api.apikeys.v2.ApiKeys.CreateKey", resourceName: `projects/${number}/locations/global/keys/${uid}`,
    authenticationInfo: { principalEmail: "creator@example.test", principalSubject: "user:creator@example.test", serviceAccountKeyName: "secret-sa-key" }, requestMetadata: { callerIp: "secret-ip", callerSuppliedUserAgent: "secret-agent" }, request: { keyString: "secret-request" }, response: { keyString: "secret-response" } } }], nextPageToken: "next-audit" } }], () => actions.query_audit_activity.execute(context, input));
  assert.equal(run.calls[0].url, "https://logging.googleapis.com/v2/entries:list");
  assert.equal(run.calls[0].headers.get("x-goog-user-project"), project);
  const query = run.calls[0].body;
  assert.deepEqual(query.resourceNames, [`projects/${project}`]);
  assert.equal(query.filter, `timestamp >= "${window.from}" AND timestamp < "${window.to}" AND protoPayload.serviceName = "apikeys.googleapis.com" AND protoPayload."@type" = "type.googleapis.com/google.cloud.audit.AuditLog"`);
  assert.equal(query.pageToken, "before");
  assert.match(run.result.summary, /creator@\u200b?example.test/u);
  assert.match(run.result.summary, /CreateKey/u);
  assert.match(run.result.summary, new RegExp(uid, "u"));
  assert.match(run.result.summary, /not necessarily inference callers/u);
  assert.match(run.result.summary, /next-audit/u);
  for (const secret of ["secret-sa-key", "secret-ip", "secret-agent", "secret-request", "secret-response"]) assert.ok(!run.result.summary.includes(secret));
  const empty = await fetched([{ body: {} }], () => actions.query_audit_activity.execute(context, input));
  assert.match(empty.result.summary, /absence does not prove no use/u);
  await fetched([{ body: { entries: [{ protoPayload: { serviceName: "other.googleapis.com" } }] } }], () => assert.rejects(actions.query_audit_activity.execute(context, input), /another service/u));
});
