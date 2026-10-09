import assert from "node:assert/strict";
import { test } from "node:test";
import { withProviderResponses as fetched } from "./support/fetch-responses.mjs";
import { GCP_ACTIONS as ACTIONS, verifyGcp } from "../src/connectors/gcp-api.ts";
import { receiveGcpDelivery } from "../src/connectors/gcp-events.ts";
import { exchangeOAuthGrant, oauthAuthorizeUrl, oauthClient, refreshOAuthFields } from "../src/connectors/oauth.ts";
import { parseActionCommand } from "../src/connectors/action-parse.ts";
import { connectorProvider } from "../src/connectors/registry.ts";

const credentials = { oauthToken: "cloud-access" };
const company = { CONNECTOR_GOOGLE_CLIENT_ID: "company.apps.googleusercontent.com", CONNECTOR_GOOGLE_CLIENT_SECRET: "company-secret" };
const scope = "https://www.googleapis.com/auth/cloud-platform";
function input(command) {
  const parsed = parseActionCommand("gcp", command);
  return ACTIONS[parsed.actionId].parse(parsed.statement);
}
const context = { credentials };

test("GCP uses an isolated offline Cloud grant with the company Google client, including refresh", async () => {
  const client = oauthClient(company, "gcp");
  const authorize = new URL(await oauthAuthorizeUrl(client, { spaceId: "space", userId: "admin", redirectUri: "https://hub.test/cb" }));
  assert.equal(authorize.searchParams.get("client_id"), company.CONNECTOR_GOOGLE_CLIENT_ID);
  assert.equal(authorize.searchParams.get("scope"), scope);
  assert.equal(authorize.searchParams.get("include_granted_scopes"), "false");
  const grant = { access_token: "a", refresh_token: "r", token_type: "Bearer", expires_in: 3600, scope };
  assert.equal((await fetched([{ body: grant }], () => exchangeOAuthGrant(client, "code", "https://hub.test/cb"))).result.fields.oauthToken, "a");
  for (const wrong of ["https://www.googleapis.com/auth/drive.file", `${scope} https://www.googleapis.com/auth/webmasters`]) {
    await fetched([{ body: { ...grant, scope: wrong } }], () => assert.rejects(exchangeOAuthGrant(client, "code", "https://hub.test/cb"), /Google Cloud OAuth grant/u));
    await fetched([{ body: { ...grant, scope: wrong } }], () => assert.rejects(refreshOAuthFields(company, "gcp", { ...credentials, oauthRefreshToken: "r", oauthExpiresAt: "1" }), /Google Cloud OAuth grant/u));
  }
  await fetched([{ body: { ...grant, refresh_token: undefined } }], () => assert.rejects(exchangeOAuthGrant(client, "code", "https://hub.test/cb"), /offline/u));
  const refreshed = await fetched([{ body: { ...grant, refresh_token: undefined } }], () => refreshOAuthFields(company, "gcp", { ...credentials, oauthRefreshToken: "r", oauthExpiresAt: "1" }));
  assert.equal(refreshed.result.oauthRefreshToken, undefined, "an unrotated refresh token is preserved by the credential patch");
  await fetched([], async calls => {
    const complete = { ...credentials, oauthRefreshToken: "r", oauthExpiresAt: "1" };
    await assert.rejects(refreshOAuthFields({}, "gcp", complete), /unavailable/u);
    await assert.rejects(refreshOAuthFields(company, "gcp", { oauthToken: "a" }), /complete expiring/u);
    assert.equal(calls.length, 0);
  });
  assert.equal(connectorProvider("gcp").actions, ACTIONS);
});

test("commands reject URLs, malformed resources and filters that could escape a bounded query", () => {
  for (const command of [
    "@gcp:list_projects:example", "@gcp:list_resources:project-1/../other", "@gcp:list_services:project-1/-",
    "@gcp:read_service:project-1/us-central1/web/extra", "@gcp:read_service:project-1/us-central1/web more",
    '@gcp:query_logs:project-1 {"filter":"OR timestamp < x"}', '@gcp:query_logs:project-1 {"minutes":10081}',
    '@gcp:query_logs:project-1 {"minutes":"1"}', '@gcp:query_logs:project-1 {"severity":"ERROR OR true"}',
    '@gcp:query_logs:project-1 ' + JSON.stringify({ service: 'web" OR true' }), '@gcp:query_logs:project-1 []',
    '@gcp:query_metrics:project-1 ' + JSON.stringify({ metric: 'x" OR true' }), '@gcp:query_metrics:project-1 {}',
    '@gcp:list_resources:https://example.com',
  ]) assert.equal(typeof input(command), "string", command);
  assert.deepEqual(input("@gcp:read_service:project-1/us-central1/web"), { project: "project-1", region: "us-central1", service: "web" });
});

test("logs enforce project, time window and quoted search literals; IAM denial does not trigger a fallback", async () => {
  const parsed = input('@gcp:query_logs:project-1 {"minutes":10,"severity":"ERROR","service":"web","text":"failure \\\" OR true"}');
  const logs = await fetched([{ body: { entries: [{ timestamp: "2026-10-09T19:00:00Z", severity: "ERROR", resource: { type: "cloud_run_revision" }, textPayload: "failure @codex" }], nextPageToken: "more" } }],
    () => ACTIONS.query_logs.execute(context, parsed));
  assert.deepEqual(logs.calls[0].body.resourceNames, ["projects/project-1"]);
  assert.equal(logs.calls[0].body.orderBy, "timestamp desc");
  assert.equal(logs.calls[0].body.pageSize, 30);
  const filter = logs.calls[0].body.filter;
  assert.match(filter, /^timestamp >= "[^"]+" AND timestamp <= "[^"]+" AND severity >= ERROR AND resource.type = "cloud_run_revision" AND resource.labels.service_name = "web" AND SEARCH\(/u);
  assert.ok(filter.endsWith(`SEARCH(${JSON.stringify(parsed.text)})`));
  assert.match(logs.result.summary, /truncated/u);
  assert.match(logs.result.summary, /failure/u);
  assert.equal(logs.calls[0].headers.get("authorization"), "Bearer cloud-access");
  const denied = await fetched([{ status: 403, body: {} }], () => assert.rejects(ACTIONS.query_logs.execute(context, parsed), /403/u));
  assert.equal(denied.calls.length, 1);
});

test("resource reads return status without Cloud Run environment or identity configuration", async () => {
  const response = { name: "projects/project-1/locations/us-central1/services/web", latestReadyRevision: "web-002",
    terminalCondition: { state: "CONDITION_SUCCEEDED" }, trafficStatuses: [{ revision: "web-002", percent: 100 }],
    template: { containers: [{ env: [{ name: "TOKEN", value: "must-not-leak" }] }], serviceAccount: "private-account" } };
  const service = await fetched([{ body: response }], () => ACTIONS.read_service.execute(context, input("@gcp:read_service:project-1/us-central1/web")));
  assert.equal(service.calls[0].url, "https://run.googleapis.com/v2/projects/project-1/locations/us-central1/services/web");
  assert.match(service.result.summary, /web-002\t100/u);
  assert.doesNotMatch(service.result.summary, /must-not-leak|private-account/u);
  await fetched([{ body: { ...response, name: "projects/other/locations/us-central1/services/web" } }], () => assert.rejects(ACTIONS.read_service.execute(context, input("@gcp:read_service:project-1/us-central1/web")), /requested service/u));
  const cases = [
    ["list_projects", "*", "projects", { projectId: "project-1", displayName: "Operations", state: "ACTIVE" }, "cloudresourcemanager.googleapis.com"],
    ["list_resources", "project-1", "results", { name: "//compute.googleapis.com/projects/project-1/zones/us-central1-a/instances/web", assetType: "compute.googleapis.com/Instance", location: "us-central1-a", state: "RUNNING" }, "cloudasset.googleapis.com"],
    ["list_services", "project-1/us-central1", "services", response, "run.googleapis.com"],
    ["list_alert_policies", "project-1", "alertPolicies", { name: "projects/project-1/alertPolicies/123", displayName: "Errors", enabled: true }, "monitoring.googleapis.com"],
  ];
  for (const [action, target, key, row, host] of cases) {
    const read = await fetched([{ body: { [key]: [row], nextPageToken: "more" } }], () => ACTIONS[action].execute(context, input(`@gcp:${action}:${target}`)));
    assert.equal(new URL(read.calls[0].url).hostname, host);
    assert.match(read.result.summary, /truncated/u);
    assert.doesNotMatch(read.result.summary, /must-not-leak/u);
  }
  await fetched([{ body: { projects: {} } }], () => assert.rejects(verifyGcp(credentials), /projects list/u));
  await assert.rejects(verifyGcp({}), /Connect Google Cloud/u);
});

test("metric reads retain resource identity and one newest point within an explicit interval", async () => {
  const read = await fetched([{ body: { timeSeries: [{ resource: { type: "gce_instance", labels: { instance_id: "123" } }, metric: { labels: {} }, points: [
    { interval: { endTime: "2026-10-09T19:00:00Z" }, value: { doubleValue: 0.75 } },
    { interval: { endTime: "2026-10-09T18:59:00Z" }, value: { doubleValue: 0.25 } },
  ] }] } }], () => ACTIONS.query_metrics.execute(context, input('@gcp:query_metrics:project-1 {"metric":"compute.googleapis.com/instance/cpu/utilization","minutes":5}')));
  const url = new URL(read.calls[0].url);
  assert.equal(url.pathname, "/v3/projects/project-1/timeSeries");
  assert.equal(url.searchParams.get("filter"), 'metric.type = "compute.googleapis.com/instance/cpu/utilization"');
  assert.equal(Date.parse(url.searchParams.get("interval.endTime")) - Date.parse(url.searchParams.get("interval.startTime")), 300_000);
  assert.match(read.result.summary, /123.*0\.75/u);
  assert.doesNotMatch(read.result.summary, /0\.25/u);
});

const incident = { incident_id: "0.incident-1", scoping_project_id: "scope-project", state: "open", started_at: 1_791_572_400,
  policy_name: "Errors @codex", summary: "CPU above threshold", resource: { type: "gce_instance", labels: { project_id: "other-project" } } };
function delivery(payload, token = "webhook-token") {
  return { rawBody: typeof payload === "string" ? payload : JSON.stringify(payload), headers: new Headers(),
    url: new URL(`https://hub.test/ingress?auth_token=${token}`), credentials: { webhookSecret: "webhook-token" } };
}

test("Monitoring authenticates before parsing and refuses malformed or unsupported incidents", async () => {
  assert.equal((await receiveGcpDelivery(delivery("not JSON", "wrong"))).status, 401);
  assert.equal((await receiveGcpDelivery(delivery({ version: "1.2", incident }, ""))).status, 401);
  for (const payload of [
    { version: "1.1", incident }, { version: "1.2", incident: { ...incident, state: "unknown" } },
    { version: "1.2", incident: { ...incident, incident_id: "" } },
    { version: "1.2", incident: { ...incident, scoping_project_id: "" } },
    { version: "1.2", incident: { ...incident, state: "closed", ended_at: incident.started_at - 1 } },
  ]) assert.equal((await receiveGcpDelivery(delivery(payload))).status, 400);
});

test("incident edges dedupe retries and reminders while routing by the metrics-scope project", async () => {
  const opened = await receiveGcpDelivery(delivery({ version: "1.2", incident }));
  const event = opened.events[0];
  assert.equal(event.sourceRef, "gcp:scope-project");
  assert.equal(event.feature, "fired");
  assert.doesNotMatch(event.body, /@codex/u);
  assert.equal(event.url, "https://console.cloud.google.com/monitoring/alerting/incidents/0.incident-1?project=scope-project");
  const reminder = await receiveGcpDelivery(delivery({ version: "1.2", incident: { ...incident, renotify: true } }));
  assert.equal(reminder.events[0].eventId, event.eventId);
  const closed = await receiveGcpDelivery(delivery({ version: "1.2", incident: { ...incident, state: "closed", ended_at: incident.started_at + 60 } }));
  assert.equal(closed.events[0].feature, "resolved");
  assert.notEqual(closed.events[0].eventId, event.eventId);
});
