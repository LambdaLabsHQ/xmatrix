import assert from "node:assert/strict";
import { createHash, createCipheriv } from "node:crypto";
import { test } from "node:test";

import { APP_CONNECTOR_PROVIDER_MANIFESTS } from "../../protocol/src/app-connector-manifests.ts";
import { hmacHex } from "@xmatrix/protocol";
import { receiveSentryDelivery } from "../src/connectors/sentry-events.ts";
import { receiveLinearDelivery } from "../src/connectors/linear-events.ts";
import { receivePagerDutyDelivery } from "../src/connectors/pagerduty-events.ts";
import { receiveGitLabDelivery } from "../src/connectors/gitlab-events.ts";
import { receiveSlackDelivery } from "../src/connectors/slack-events.ts";
import { receiveJiraDelivery } from "../src/connectors/jira-events.ts";
import { receiveVercelDelivery } from "../src/connectors/vercel-events.ts";
import { receiveCloudflareDelivery } from "../src/connectors/cloudflare-events.ts";
import { receiveFeishuDelivery } from "../src/connectors/feishu-events.ts";
import { connectorForCommand, connectorProvider } from "../src/connectors/registry.ts";
import { parseConnectorSubscription } from "../src/connectors/subscription-parse.ts";
import { handleConnectorDelivery } from "../src/connectors/event-ingress.ts";

function delivery(body, headers = {}, credentials = {}) {
  const rawBody = typeof body === "string" ? body : JSON.stringify(body);
  return { rawBody, headers: new Headers(headers), url: new URL("https://hub.test/ingress"), credentials };
}

function manifest(id) {
  return APP_CONNECTOR_PROVIDER_MANIFESTS.find((provider) => provider.id === id);
}

/* Every event a receiver emits names a feature its manifest declares and a
   source ref the subscription parser could have written. */
function assertEventsMatchManifest(id, result) {
  assert.equal(result.ok, true);
  const events = manifest(id).events;
  for (const event of result.events) {
    assert.ok(events.features.some((feature) => feature.id === event.feature), `${id} feature ${event.feature}`);
    const source = event.sourceRef.slice(id.length + 1);
    assert.ok(event.sourceRef.startsWith(`${id}:`));
    assert.ok(source === "*" || new RegExp(events.source.pattern, "u").test(source), `${id} source ${source}`);
    assert.ok(event.eventId.length <= 160);
    assert.doesNotMatch(event.body, /@[A-Za-z]/u, "mentions in payloads are shielded");
  }
}

test("every event provider is registered with a manifest, credentials, and subscription commands", () => {
  for (const id of ["webhook", "sentry", "linear", "pagerduty", "gitlab", "slack", "jira", "vercel", "cloudflare", "feishu",
    "bitbucket", "circleci", "buildkite", "stripe", "grafana", "opsgenie", "netlify", "telegram"]) {
    const provider = connectorProvider(id);
    assert.ok(provider?.events, `${id} receives events`);
    assert.ok(manifest(id)?.events, `${id} declares events`);
    assert.ok(manifest(id).credentials?.length, `${id} keeps a credential`);
    assert.equal(connectorForCommand(`@${id}:subscribe:*`)?.id, id);
    assert.deepEqual(parseConnectorSubscription(manifest(id), `@${id}:subscribe:*`)?.sourceRef, `${id}:*`);
  }
});

test("Sentry issues are signed with the client secret and routed by project", async () => {
  const body = JSON.stringify({ action: "created", data: { issue: { shortId: "WEB-1A", title: "TypeError @admin",
    culprit: "app/main.ts", level: "error", permalink: "https://sentry.io/issues/1/", project: { slug: "Web" } } } });
  const headers = { "sentry-hook-resource": "issue", "request-id": "req-1",
    "sentry-hook-signature": await hmacHex("SHA-256", "cs", body) };
  const result = await receiveSentryDelivery(delivery(body, headers, { clientSecret: "cs" }));
  assertEventsMatchManifest("sentry", result);
  assert.equal(result.events[0].sourceRef, "sentry:web");
  assert.equal(result.events[0].feature, "issue.created");
  assert.equal(result.events[0].url, "https://sentry.io/issues/1/");
  assert.equal((await receiveSentryDelivery(delivery(body, headers, { clientSecret: "other" }))).status, 401);
  assert.equal((await receiveSentryDelivery(delivery(body, headers, {}))).status, 401);
  const metric = JSON.stringify({ action: "critical", data: { description_title: "p95 high", web_url: "https://sentry.io/a" } });
  const alert = await receiveSentryDelivery(delivery(metric, { "sentry-hook-resource": "metric_alert",
    "sentry-hook-signature": await hmacHex("SHA-256", "cs", metric) }, { clientSecret: "cs" }));
  assertEventsMatchManifest("sentry", alert);
  assert.equal(alert.events[0].sourceRef, "sentry:*");
});

test("Linear deliveries are signed, fresh, and routed by team key", async () => {
  const now = Date.parse("2026-10-02T00:00:00Z");
  const payload = { type: "Issue", action: "create", webhookTimestamp: now - 1_000,
    data: { id: "i1", identifier: "ENG-42", title: "Fix login", url: "https://linear.app/x/issue/ENG-42",
      team: { key: "ENG" }, state: { name: "Todo" }, description: "steps" } };
  const body = JSON.stringify(payload);
  const headers = { "linear-delivery": "d-1", "linear-signature": await hmacHex("SHA-256", "ls", body) };
  const result = await receiveLinearDelivery(delivery(body, headers, { signingSecret: "ls" }), now);
  assertEventsMatchManifest("linear", result);
  assert.equal(result.events[0].sourceRef, "linear:eng");
  assert.equal(result.events[0].eventId, "linear:d-1");
  assert.equal((await receiveLinearDelivery(delivery(body, headers, { signingSecret: "ls" }), now + 120_000)).status, 401);
  assert.equal((await receiveLinearDelivery(delivery(body, headers, { signingSecret: "no" }), now)).status, 401);
});

test("PagerDuty accepts any of its rotating v1 signatures", async () => {
  const body = JSON.stringify({ event: { id: "e1", event_type: "incident.triggered", occurred_at: "t",
    data: { id: "Q1", number: 7, title: "DB down", html_url: "https://pd.test/i/Q1", urgency: "high",
      service: { id: "P1ABC23", summary: "Database" } } } });
  const signature = `v1=${await hmacHex("SHA-256", "pd", body)}`;
  const result = await receivePagerDutyDelivery(delivery(body, { "x-pagerduty-signature": `v1=deadbeef, ${signature}` },
    { webhookSecret: "pd" }));
  assertEventsMatchManifest("pagerduty", result);
  assert.equal(result.events[0].sourceRef, "pagerduty:p1abc23");
  assert.equal(result.events[0].feature, "triggered");
  assert.equal((await receivePagerDutyDelivery(delivery(body, { "x-pagerduty-signature": "v1=deadbeef" },
    { webhookSecret: "pd" }))).status, 401);
});

test("GitLab deliveries carry the generated token and route by project path", async () => {
  const body = { object_kind: "merge_request", project: { path_with_namespace: "Group/App", web_url: "https://gl.test/g/a" },
    object_attributes: { id: 1, iid: 5, title: "Add feature", action: "open", url: "https://gl.test/g/a/-/merge_requests/5",
      source_branch: "feat", target_branch: "main" } };
  const result = await receiveGitLabDelivery(delivery(body, { "x-gitlab-token": "tok", "x-gitlab-event-uuid": "u1" },
    { webhookToken: "tok" }));
  assertEventsMatchManifest("gitlab", result);
  assert.equal(result.events[0].sourceRef, "gitlab:group/app");
  assert.equal(result.events[0].feature, "merge_requests");
  assert.equal((await receiveGitLabDelivery(delivery(body, { "x-gitlab-token": "bad" }, { webhookToken: "tok" }))).status, 401);
  const running = await receiveGitLabDelivery(delivery({ object_kind: "pipeline", project: body.project,
    object_attributes: { id: 2, status: "running", ref: "main" } }, { "x-gitlab-token": "tok" }, { webhookToken: "tok" }));
  assert.deepEqual(running, { ok: true, events: [] }, "only finished pipelines are posted");
});

test("Slack requests are signed over timestamp and body, answer the URL handshake, and drop bot messages", async () => {
  const now = Date.parse("2026-10-02T00:00:00Z");
  const timestamp = String(Math.floor(now / 1_000));
  const sign = async (body) => ({ "x-slack-request-timestamp": timestamp,
    "x-slack-signature": `v0=${await hmacHex("SHA-256", "ss", `v0:${timestamp}:${body}`)}` });
  const challenge = JSON.stringify({ type: "url_verification", challenge: "abc" });
  const handshake = await receiveSlackDelivery(delivery(challenge, await sign(challenge), { signingSecret: "ss" }), now);
  assert.equal(handshake.ok, "respond");
  assert.deepEqual(await handshake.response.json(), { challenge: "abc" });
  const message = JSON.stringify({ type: "event_callback", event_id: "Ev1",
    event: { type: "message", channel: "C0123ABCD", user: "U1", text: "@claude:1 deploy", ts: "1.2" } });
  const result = await receiveSlackDelivery(delivery(message, await sign(message), { signingSecret: "ss" }), now);
  assertEventsMatchManifest("slack", result);
  assert.equal(result.events[0].sourceRef, "slack:c0123abcd");
  const bot = JSON.stringify({ type: "event_callback", event_id: "Ev2",
    event: { type: "message", channel: "C0123ABCD", bot_id: "B1", text: "echo", ts: "1.3" } });
  assert.deepEqual(await receiveSlackDelivery(delivery(bot, await sign(bot), { signingSecret: "ss" }), now),
    { ok: true, events: [] });
  assert.equal((await receiveSlackDelivery(delivery(message, await sign(message), { signingSecret: "ss" }),
    now + 600_000)).status, 401, "a replayed request outside five minutes is refused");
});

test("Jira deliveries are signed with the generated secret and link to the issue", async () => {
  const body = JSON.stringify({ webhookEvent: "jira:issue_created", timestamp: 1,
    issue: { id: "10", key: "ENG-9", self: "https://acme.atlassian.net/rest/api/2/issue/10",
      fields: { summary: "Crash", project: { key: "ENG" }, status: { name: "To Do" } } } });
  const result = await receiveJiraDelivery(delivery(body, { "x-hub-signature": `sha256=${await hmacHex("SHA-256", "js", body)}` },
    { webhookSecret: "js" }));
  assertEventsMatchManifest("jira", result);
  assert.equal(result.events[0].url, "https://acme.atlassian.net/browse/ENG-9");
  assert.equal(result.events[0].sourceRef, "jira:eng");
  assert.equal((await receiveJiraDelivery(delivery(body, {}, { webhookSecret: "js" }))).status, 401);
});

test("Jira issues and comments reach a channel without any Atlassian account they name", async () => {
  const body = JSON.stringify({ webhookEvent: "comment_created", timestamp: 2,
    issue: { id: "10", key: "ENG-9", self: "https://acme.atlassian.net/rest/api/2/issue/10",
      fields: { summary: "Crash seen by [~accountid:test-account-123]", project: { key: "ENG" },
        assignee: { accountId: "test-account-123", displayName: "Sam Lee" } } },
    comment: { body: "[~accountid:5b10a2844c20165700ede21g] and [~jsmith] please look",
      author: { accountId: "5b10a2844c20165700ede21g", displayName: "Jane Smith", emailAddress: "jane@acme.test" } } });
  const result = await receiveJiraDelivery(delivery(body, { "x-hub-signature": `sha256=${await hmacHex("SHA-256", "js", body)}` },
    { webhookSecret: "js" }));
  const message = JSON.stringify(result.events);
  assert.match(message, /@\u200b?user and @\u200b?user please look/u);
  assert.match(message, /Crash seen by @\u200b?user/u, "a mention in the title is anonymized too");
  for (const personal of ["5b10a2844c20165700ede21g", "test-account-123", "jsmith", "Jane Smith", "Sam Lee",
    "jane@acme.test", "accountid"]) {
    assert.doesNotMatch(message, new RegExp(personal, "iu"), `${personal} is not stored`);
  }
  const created = JSON.stringify({ webhookEvent: "jira:issue_created", timestamp: 3,
    issue: { id: "11", key: "ENG-10", self: "https://acme.atlassian.net/rest/api/2/issue/11",
      fields: { summary: "Ask [~accountid:test-account-123]", project: { key: "ENG" }, status: { name: "To Do" },
        reporter: { accountId: "test-account-123", displayName: "Sam Lee", emailAddress: "sam@acme.test" } } } });
  const issue = JSON.stringify((await receiveJiraDelivery(delivery(created,
    { "x-hub-signature": `sha256=${await hmacHex("SHA-256", "js", created)}` }, { webhookSecret: "js" }))).events);
  assert.match(issue, /Ask @\u200b?user/u);
  for (const personal of ["test-account-123", "Sam Lee", "sam@acme.test"]) {
    assert.doesNotMatch(issue, new RegExp(personal, "u"), `${personal} is not stored`);
  }
});

test("Vercel deliveries are SHA-1 signed and classify deployment outcomes", async () => {
  const body = JSON.stringify({ id: "w1", type: "deployment.error", payload: { name: "web", target: "production",
    deployment: { id: "d1", url: "web-abc.vercel.app" }, links: { deployment: "https://vercel.com/acme/web/d1" } } });
  const result = await receiveVercelDelivery(delivery(body, { "x-vercel-signature": await hmacHex("SHA-1", "vs", body) },
    { webhookSecret: "vs" }));
  assertEventsMatchManifest("vercel", result);
  assert.equal(result.events[0].feature, "failed");
  assert.equal(result.events[0].sourceRef, "vercel:web");
  assert.equal((await receiveVercelDelivery(delivery(body, { "x-vercel-signature": "00" }, { webhookSecret: "vs" }))).status, 401);
});

test("Cloudflare notifications carry the registered secret header", async () => {
  const body = { name: "Incident", text: "Cloudflare incident", alert_type: "incident_alert", ts: 1 };
  const result = await receiveCloudflareDelivery(delivery(body, { "cf-webhook-auth": "cf" }, { webhookSecret: "cf" }));
  assertEventsMatchManifest("cloudflare", result);
  assert.equal(result.events[0].sourceRef, "cloudflare:incident_alert");
  assert.equal((await receiveCloudflareDelivery(delivery(body, {}, { webhookSecret: "cf" }))).status, 401);
});

test("Feishu events check the verification token, decrypt with the Encrypt Key, and answer the handshake", async () => {
  const event = { schema: "2.0", header: { event_id: "f1", event_type: "im.message.receive_v1", token: "vt" },
    event: { sender: { sender_type: "user", sender_id: { open_id: "ou_1" } },
      message: { chat_id: "oc_abc123", message_id: "m1", message_type: "text", content: JSON.stringify({ text: "hi" }) } } };
  const plain = await receiveFeishuDelivery(delivery(event, {}, { verificationToken: "vt" }));
  assertEventsMatchManifest("feishu", plain);
  assert.equal(plain.events[0].sourceRef, "feishu:oc_abc123");
  assert.equal((await receiveFeishuDelivery(delivery(event, {}, { verificationToken: "other" }))).status, 401);

  const key = createHash("sha256").update("ek").digest();
  const iv = Buffer.alloc(16, 7);
  const cipher = createCipheriv("aes-256-cbc", key, iv);
  const encrypted = Buffer.concat([iv, cipher.update(JSON.stringify(event)), cipher.final()]).toString("base64");
  const decrypted = await receiveFeishuDelivery(delivery({ encrypt: encrypted }, {}, { verificationToken: "vt", encryptKey: "ek" }));
  assert.equal(decrypted.events[0].eventId, "feishu:f1");
  assert.equal((await receiveFeishuDelivery(delivery({ encrypt: encrypted }, {}, { verificationToken: "vt" }))).status, 401);

  const handshake = await receiveFeishuDelivery(delivery({ type: "url_verification", token: "vt", challenge: "c1" }, {},
    { verificationToken: "vt" }));
  assert.equal(handshake.ok, "respond");
  assert.deepEqual(await handshake.response.json(), { challenge: "c1" });
});

test("ingress delivers once to a Channel subscribed to both the source and *", async () => {
  const appended = [];
  const routes = {
    "webhook:deploys": [{ channelId: "a", authorityRootUserId: "u", features: ["delivery"] }],
    "webhook:*": [{ channelId: "a", authorityRootUserId: "u", features: ["delivery"] },
      { channelId: "b", authorityRootUserId: "u", features: ["delivery"] }],
  };
  const response = await handleConnectorDelivery({ env: {},
    request: new Request("https://hub.test/x?source=deploys", { method: "POST", body: "{}" }),
    provider: connectorProvider("webhook"), spaceId: "s", ingressKey: "k" }, {
    credentials: () => ({ resolve: async () => ({ connectionId: "s:webhook", status: "configured", values: { ingressKey: "k" } }) }),
    apps: () => ({ connectorEventRoutes: async ({ sourceRef }) => routes[sourceRef] ?? [] }),
    append: async (_env, channelId) => { appended.push(channelId); return new Response("{}"); },
  });
  assert.deepEqual(await response.json(), { ok: true, events: 1, delivered: 2 });
  assert.deepEqual(appended.sort(), ["a", "b"]);
});

test("connector events fire page Automations whose event trigger concerns them", async () => {
  const { connectorTriggerMatches } = await import("../src/automation-triggers.ts");
  const { automationTriggersFrom } = await import("../../protocol/src/authority-foundation.ts");
  const event = { provider: "sentry", source: "web", feature: "issue.created" };
  const [any, web, regressed] = automationTriggersFrom([
    { kind: "event", provider: "sentry" },
    { kind: "event", provider: "Sentry", source: "Web", feature: "issue.created" },
    { kind: "event", provider: "sentry", source: "web", feature: "issue.regressed" },
  ]);
  assert.deepEqual(any, { kind: "event", provider: "sentry", source: "*" });
  assert.ok(connectorTriggerMatches(any, event));
  assert.ok(connectorTriggerMatches(web, event));
  assert.ok(!connectorTriggerMatches(regressed, event));
  assert.ok(!connectorTriggerMatches({ kind: "event", provider: "linear", source: "*" }, event));
  assert.throws(() => automationTriggersFrom([{ kind: "event", provider: "github" }]), /delivers events/u);
  assert.throws(() => automationTriggersFrom([{ kind: "event", provider: "sentry", feature: "nope" }]), /Sentry events are/u);
  assert.throws(() => automationTriggersFrom([{ kind: "event", provider: "gitlab", source: "not a path" }]), /source/u);

  const fired = [];
  await handleConnectorDelivery({ env: {},
    request: new Request("https://hub.test/x?source=deploys", { method: "POST", body: "{\"title\":\"hi\"}",
      headers: { "x-request-id": "e-9" } }),
    provider: connectorProvider("webhook"), spaceId: "s", ingressKey: "k" }, {
    credentials: () => ({ resolve: async () => ({ connectionId: "s:webhook", spaceId: "s", status: "configured",
      values: { ingressKey: "k" } }) }),
    apps: () => ({ connectorEventRoutes: async () => [] }),
    append: async () => new Response("{}"),
    automations: async (_env, input) => { fired.push(input); return 1; },
  });
  assert.equal(fired.length, 1);
  assert.equal(fired[0].spaceId, "s");
  assert.equal(fired[0].provider, "webhook");
  assert.equal(fired[0].event.sourceRef, "webhook:deploys");
  assert.equal(fired[0].event.eventId, "e-9");
});

test("second-wave providers verify their documented signatures and route by source", async () => {
  const { receiveBitbucketDelivery, receiveCircleCiDelivery, receiveBuildkiteDelivery, receiveStripeDelivery,
    receiveGrafanaDelivery, receiveOpsgenieDelivery, receiveNetlifyDelivery, receiveTelegramDelivery } =
    await import("../src/connectors/wave2-events.ts");

  const bb = JSON.stringify({ repository: { full_name: "Acme/App" }, actor: { display_name: "Ann" },
    pullrequest: { id: 3, title: "Add @feature", links: { html: { href: "https://bitbucket.org/acme/app/pull-requests/3" } } } });
  const bbOk = await receiveBitbucketDelivery(delivery(bb, { "x-event-key": "pullrequest:created", "x-request-uuid": "u",
    "x-hub-signature": `sha256=${await hmacHex("SHA-256", "bs", bb)}` }, { webhookSecret: "bs" }));
  assertEventsMatchManifest("bitbucket", bbOk);
  assert.equal(bbOk.events[0].sourceRef, "bitbucket:acme/app");
  assert.equal((await receiveBitbucketDelivery(delivery(bb, { "x-hub-signature": "sha256=00" }, { webhookSecret: "bs" }))).status, 401);

  const ci = JSON.stringify({ id: "c1", type: "workflow-completed", project: { slug: "gh/acme/app", name: "app" },
    workflow: { name: "build", status: "failed", url: "https://app.circleci.com/x" }, pipeline: { vcs: { branch: "main" } } });
  const ciOk = await receiveCircleCiDelivery(delivery(ci, { "circleci-signature": `v1=${await hmacHex("SHA-256", "cs", ci)}` },
    { webhookSecret: "cs" }));
  assertEventsMatchManifest("circleci", ciOk);
  assert.equal(ciOk.events[0].feature, "failed");

  const bk = { event: "build.finished", build: { id: "b", number: 4, state: "passed", branch: "main", web_url: "https://buildkite.com/a/b/4" },
    pipeline: { slug: "web", name: "Web" } };
  assertEventsMatchManifest("buildkite", await receiveBuildkiteDelivery(delivery(bk, { "x-buildkite-token": "bt" }, { webhookToken: "bt" })));
  assert.equal((await receiveBuildkiteDelivery(delivery(bk, {}, { webhookToken: "bt" }))).status, 401);

  const now = Date.parse("2026-10-02T00:00:00Z");
  const t = String(Math.floor(now / 1_000));
  const st = JSON.stringify({ id: "evt_1", type: "invoice.payment_failed", data: { object: { id: "in_1", amount: 500, currency: "usd" } } });
  const stOk = await receiveStripeDelivery(delivery(st, { "stripe-signature": `t=${t},v1=${await hmacHex("SHA-256", "whsec", `${t}.${st}`)}` },
    { signingSecret: "whsec" }), now);
  assertEventsMatchManifest("stripe", stOk);
  assert.equal(stOk.events[0].sourceRef, "stripe:invoice");
  assert.equal((await receiveStripeDelivery(delivery(st, { "stripe-signature": `t=${t},v1=${await hmacHex("SHA-256", "whsec", `${t}.${st}`)}` },
    { signingSecret: "whsec" }), now + 3_600_000)).status, 401, "an old Stripe signature is a replay");

  const gf = { status: "firing", title: "[FIRING:1] HighCPU", receiver: "Xmatrix Alerts", externalURL: "https://grafana.acme.io",
    groupKey: "g", alerts: [{ fingerprint: "f", labels: { alertname: "HighCPU" }, annotations: { summary: "cpu" } }] };
  const gfOk = await receiveGrafanaDelivery(delivery(gf, { authorization: "Bearer gt" }, { webhookToken: "gt" }));
  assertEventsMatchManifest("grafana", gfOk);
  assert.equal(gfOk.events[0].sourceRef, "grafana:xmatrix-alerts");

  const og = { action: "Create", integrationName: "xmatrix", alert: { alertId: "a", tinyId: "12", message: "DB down" } };
  assertEventsMatchManifest("opsgenie", await receiveOpsgenieDelivery(delivery(og, { "x-xmatrix-token": "ot" }, { webhookToken: "ot" })));

  const nl = JSON.stringify({ id: "d1", name: "web", state: "error", branch: "main", error_message: "build failed" });
  const b64 = (value) => Buffer.from(value).toString("base64url");
  const head = b64(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const claims = b64(JSON.stringify({ iss: "netlify", sha256: createHash("sha256").update(nl).digest("hex") }));
  const { createHmac } = await import("node:crypto");
  const jws = `${head}.${claims}.${createHmac("sha256", "ns").update(`${head}.${claims}`).digest("base64url")}`;
  const nlOk = await receiveNetlifyDelivery(delivery(nl, { "x-webhook-signature": jws }, { webhookSecret: "ns" }));
  assertEventsMatchManifest("netlify", nlOk);
  assert.equal(nlOk.events[0].feature, "failed");
  assert.equal((await receiveNetlifyDelivery(delivery(`${nl} `, { "x-webhook-signature": jws }, { webhookSecret: "ns" }))).status, 401,
    "the JWS binds the exact body");

  const tg = { update_id: 9, message: { chat: { id: -1001234, title: "Ops" }, from: { username: "ann" }, text: "@bot deploy" } };
  const tgOk = await receiveTelegramDelivery(delivery(tg, { "x-telegram-bot-api-secret-token": "ts" }, { webhookSecret: "ts" }));
  assertEventsMatchManifest("telegram", tgOk);
  assert.equal(tgOk.events[0].sourceRef, "telegram:-1001234");
});
