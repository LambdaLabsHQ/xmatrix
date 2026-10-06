import assert from "node:assert/strict";
import { test } from "node:test";
import { hmacHex, sha256Hex } from "@xmatrix/protocol";
import { validateSentryEventIdentity } from "@xmatrix/db";
import { hmacMatches } from "../src/connectors/hmac.ts";
import { connectorEvent, parseJsonObject, record } from "../src/connectors/event-format.ts";
import { sentryInstallationClient, validateSentryInstallationCredentials } from "../src/connectors/sentry-installation.ts";
import { compileCommonJsSourceModule } from "./support/commonjs-source-module.mjs";

const env = { CONNECTOR_SENTRY_CLIENT_ID: "fixture-client", CONNECTOR_SENTRY_CLIENT_SECRET: "fixture-secret",
  CONNECTOR_SENTRY_APP_UUID: "11111111-2222-4333-8444-555555555555", CONNECTOR_SENTRY_APP_SLUG: "xmatrix" };
const installationId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const base = { action: "created", installation: { uuid: installationId }, actor: { email: "PRIVATE_ACTOR" },
  data: { issue: { id: "42", project: { id: "7", slug: "test-project" }, title: "PRIVATE_TITLE",
    request: { token: "PRIVATE_TOKEN" }, exception: "PRIVATE_EXCEPTION" } } };
const identityModule = await compileCommonJsSourceModule(new URL("../src/connectors/sentry-event-identity.ts", import.meta.url));
const { sentryEventIdentity } = identityModule(name => ({ "@xmatrix/db": { validateSentryEventIdentity },
  "./event-format": { record } })[name]);
const lifecycleModule = await compileCommonJsSourceModule(new URL("../src/connectors/sentry-app-lifecycle.ts", import.meta.url));
const drainModule = await compileCommonJsSourceModule(new URL("../src/connectors/sentry-event-drain.ts", import.meta.url));
const ingressModule = await compileCommonJsSourceModule(new URL("../src/connectors/event-ingress.ts", import.meta.url));

function receiver() {
  const accepted = [], wakes = [];
  let committed = false, failure;
  const imports = { "@xmatrix/protocol": { sha256Hex }, "../index-shared": { readBoundedRequestBody: async request => request.arrayBuffer() },
    "./sentry-installation": { sentryInstallationClient }, "./hmac": { hmacMatches }, "./event-format": { parseJsonObject },
    "./sentry-event-identity": { sentryEventIdentity }, "./sentry-event-drain": { drainSentryEvents: async () => {
      assert.equal(committed, true, "wake follows receipt commit"); wakes.push(true);
    } }, "./credentials": { connectorSentryEventRepository: () => ({ accept: async input => {
      if (failure) throw failure; accepted.push(input); committed = true;
    } }) } };
  const { handleSentryInstallationDelivery } = lifecycleModule(name => imports[name]);
  return { accepted, wakes, fail: error => { failure = error; }, async deliver(body = base, { signature = true, headers = {} } = {}) {
    const raw = JSON.stringify(body);
    return handleSentryInstallationDelivery(env, new Request("https://hub.test/api/connectors/sentry/events", {
      method: "POST", body: raw, headers: { "sentry-hook-signature": signature ? await hmacHex("SHA-256", env.CONNECTOR_SENTRY_CLIENT_SECRET, raw) : "bad", ...headers },
    }), promise => wakes.push(promise));
  } };
}
test("signed Sentry issue ACK follows durable acceptance; unsigned headers cannot change identity", async () => {
  const run = receiver();
  assert.equal((await run.deliver(base, { signature: false })).status, 401);
  assert.equal(run.accepted.length, 0);
  assert.equal((await run.deliver()).status, 204);
  assert.equal((await run.deliver(base, { headers: { "request-id": "evil-replay", "sentry-hook-resource": "installation", "sentry-hook-timestamp": "0" } })).status, 204);
  assert.equal(run.accepted[0].deliveryDigest, run.accepted[1].deliveryDigest);
  assert.doesNotMatch(JSON.stringify(run.accepted), /PRIVATE_|"request":|"exception":|"title":|"actor":/u);
  assert.deepEqual(run.accepted[0].identity, { kind: "issue", action: "created", objectId: "42", projectId: "7", projectSlug: "test-project" });
  run.fail(new Error("commit failed"));
  await assert.rejects(run.deliver(), /commit failed/);
  assert.equal(run.accepted.length, 2);
});
test("Sentry identity allowlist rejects ambiguous shapes, unsafe ids and payload URL redirection", () => {
  const event = { action: "triggered", data: { event: { project: 7, event_id: "a".repeat(32),
    url: `https://sentry.io/api/0/projects/company/test-project/events/${"a".repeat(32)}/`, user: "PRIVATE" } } };
  assert.equal(sentryEventIdentity(event).kind, "event_alert");
  const metric = { action: "resolved", data: { metric_alert: { id: "3", organization_id: "9", projects: ["project-b", "project-a"],
    title: "PRIVATE", alert_rule: { query: "PRIVATE" } } } };
  assert.deepEqual(sentryEventIdentity(metric).projects, ["project-a", "project-b"]);
  for (const body of [{ ...base, data: { ...base.data, event: event.data.event } }, { ...base, action: "unknown" },
    { ...base, data: { issue: { ...base.data.issue, id: Number.MAX_SAFE_INTEGER+1 } } },
    { ...event, data: { event: { ...event.data.event, url: event.data.event.url.replace("sentry.io", "evil.test") } } },
    { ...event, data: { event: { ...event.data.event, url: event.data.event.url+"?token=private" } } },
    { ...metric, data: { metric_alert: { ...metric.data.metric_alert, projects: Array(11).fill("a") } } }]) {
    assert.equal(sentryEventIdentity(body), undefined);
  }
});

function drainer() {
  const job = { appClientId: env.CONNECTOR_SENTRY_CLIENT_ID, appUuid: env.CONNECTOR_SENTRY_APP_UUID, installationId,
    deliveryDigest: "f".repeat(64), connectionId: "space:sentry", spaceId: "space", grantGeneration: crypto.randomUUID(),
    leaseId: crypto.randomUUID(), identity: sentryEventIdentity(base) };
  const fields = { oauthToken: "private-access", oauthRefreshToken: "private-refresh", oauthExpiresAt: String(Date.now()+28800000),
    oauthScopes: "event:read event:write org:read project:read", oauthClientId: job.appClientId, oauthAppUuid: job.appUuid,
    oauthAppSlug: "xmatrix", oauthInstallationId: installationId, oauthOrganization: "company", oauthOrganizationId: "9" };
  const calls = { appended: [], automation: [], finish: [], provider: [], routes: [] };
  const state = { current: true, version: 2, resolvedVersion: 2, failAppend: false, failAutomation: false, revokeAtProvider: false,
    rotateAfterAppend: false, wrongProject: false };
  const receipts = { claim: async () => [job], current: async () => state.current ? { credentialVersion: state.version } : null,
    finish: async input => calls.finish.push(input) };
  const apps = { connectorEventRoutes: async input => { calls.routes.push(input); return input.sourceRef.endsWith("*") ? [] :
    [{ channelId: "channel", authorityRootUserId: "owner", features: ["issue.created", "alert"] }]; } };
  const { deliverEvent } = ingressModule(name => ({ "../app-connectors": {}, "../index-shared": {},
    "../automation-triggers": {}, "../product-message-append": {}, "./credentials": {}, "@xmatrix/protocol": {},
    "./oauth": {}, "./event-format": {} })[name]);
  const dependencies = { receipts: () => receipts, credentials: () => ({ resolve: async () => ({ connectionId: job.connectionId,
    status: "configured", version: state.resolvedVersion, values: fields }) }), refresh: async () => fields,
    verify: async () => {}, request: async url => { calls.provider.push(url); if (state.revokeAtProvider) state.current = false;
      return { id: state.wrongProject ? "8" : "7", slug: "test-project", organization: { id: "9", slug: "company" } }; },
    apps: () => apps, append: async (_env, channelId, command) => { calls.appended.push({ channelId, command });
      if (state.rotateAfterAppend) state.version += 1;
      return new Response(null, { status: state.failAppend ? 503 : 200 }); }, automations: async (_env, input) => {
      calls.automation.push(input); if (state.failAutomation) throw new Error("private-provider-error"); return 0; } };
  const imports = { "@xmatrix/protocol": { sha256Hex }, "../automation-triggers": {}, "../product-message-append": {},
    "./credentials": {}, "./connection-credentials": {}, "./event-format": { connectorEvent, record },
    "./event-ingress": { deliverEvent }, "./http": {}, "./sentry-installation": { sentryInstallationClient, validateSentryInstallationCredentials } };
  const { drainSentryEvents } = drainModule(name => imports[name]);
  return { calls, state, job, fields, run: () => drainSentryEvents(env, dependencies) };
}
test("Sentry drain proves current organization/project and routes only its current grant", async () => {
  const run = drainer();
  await run.run();
  assert.equal(run.calls.finish[0].outcome, "done");
  assert.deepEqual(run.calls.provider, ["https://sentry.io/api/0/projects/company/test-project/"]);
  assert.equal(run.calls.appended.length, 1);
  assert.equal(run.calls.routes[0].oauthBinding.grantGeneration, run.job.grantGeneration);
  assert.equal(run.calls.routes[0].oauthBinding.credentialVersion, 2);
  assert.match(run.calls.appended[0].command.body, /Issue 42 created/);
  assert.doesNotMatch(JSON.stringify(run.calls.appended), /private-|PRIVATE_/);
});
test("Sentry rejected project or concurrent uninstall causes no effects; changed token retries", async () => {
  for (const flag of ["wrongProject", "revokeAtProvider", "disconnected", "rotated"]) {
    const run = drainer();
    if (flag === "disconnected") run.state.current = false;
    else if (flag === "rotated") run.state.resolvedVersion = 1;
    else run.state[flag] = true;
    await run.run();
    assert.equal(run.calls.appended.length, 0);
    assert.equal(run.calls.automation.length, 0);
    assert.equal(run.calls.finish[0].outcome, flag === "rotated" ? "retry" : "obsolete");
  }
});
test("Sentry partial delivery and Automation failures stay retryable with identical message ids", async () => {
  for (const failure of ["failAppend", "failAutomation"]) {
    const run = drainer();
    run.state[failure] = true;
    await run.run();
    assert.equal(run.calls.finish[0].outcome, "retry");
    run.state[failure] = false;
    await run.run();
    assert.equal(run.calls.finish[1].outcome, "done");
    assert.equal(run.calls.appended[0].command.messageId, run.calls.appended[1].command.messageId);
  }
});
test("a token rotated after Channel append retries before Automation with the same event id", async () => {
  const run = drainer();
  run.state.rotateAfterAppend = true;
  await run.run();
  assert.equal(run.calls.finish[0].outcome, "retry");
  assert.equal(run.calls.automation.length, 0);
  run.state.rotateAfterAppend = false;
  run.state.resolvedVersion = run.state.version;
  await run.run();
  assert.equal(run.calls.finish[1].outcome, "done");
  assert.equal(run.calls.automation.length, 1);
  assert.equal(run.calls.appended[0].command.messageId, run.calls.appended[1].command.messageId);
});
