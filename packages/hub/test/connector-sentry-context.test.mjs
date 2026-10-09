import assert from "node:assert/strict";
import { test } from "node:test";
import { APP_CONNECTOR_PROVIDER_MANIFESTS } from "../../protocol/src/app-connector-manifests.ts";
import { SENTRY_ACTIONS, verifySentry } from "../src/connectors/actions/sentry.ts";
import { actionRefusal, isPolicyAction } from "../src/connectors/connector-commands.ts";
import { stubFetchResponses } from "./support/fetch-responses.mjs";

const read = SENTRY_ACTIONS.read_issue;
const issue = { id: "123", shortId: "WEB-1A", title: "Payment worker failed", status: "unresolved", culprit: "worker.process",
  assignedTo: { email: "private-assignee" }, permalink: "https://attacker.example/private-link" };
const event = { groupID: "123", eventID: "a".repeat(32), platform: "python",
  user: { email: "private-user" }, contexts: { secret: "private-context" },
  entries: [{ type: "request", data: { headers: { authorization: "private-request-token" } } },
    { type: "breadcrumbs", data: { values: [{ message: "private-breadcrumb" }] } },
    { type: "exception", data: { values: [{ type: "RuntimeError", value: "Retry failed\n```\n~~~",
      stacktrace: { frames: [{ module: "payments", function: "process", filename: "payments.py", lineNo: 42,
        vars: { secret: "private-local" }, context: [[42, "private-source-line"]] }] } }] } }] };

async function run(responses, credentials = { authToken: "test-token", organization: "made-by-robot" }, target = "WEB-1A") {
  const stub = stubFetchResponses(responses);
  try {
    const result = await read.execute({ credentials }, read.parse({ target, text: "" }));
    return { result, calls: stub.calls };
  } finally { stub.restore(); }
}

test("Sentry issue reads use the current read/deny policy independently of resolve permission", () => {
  const manifest = APP_CONNECTOR_PROVIDER_MANIFESTS.find(provider => provider.id === "sentry");
  assert.equal(manifest.actions.find(action => action.id === "read_issue").effect, "read");
  assert.ok(isPolicyAction(manifest, "read_issue"));
  assert.equal(actionRefusal({ providerId: "sentry", actionId: "read_issue", effect: "read", mode: null,
    senderKind: "agent" }), undefined);
  assert.match(actionRefusal({ providerId: "sentry", actionId: "read_issue", effect: "read", mode: "deny",
    senderKind: "agent" }), /denied/);
  assert.equal(actionRefusal({ providerId: "sentry", actionId: "resolve", effect: "write", mode: null,
    senderKind: "agent" }), undefined);
});

test("only one bounded explicit Sentry issue is accepted", () => {
  for (const target of ["", "0", "001", "1".repeat(33), "../WEB-1A", "https://attacker.example/123", "a".repeat(62), "ß"]) {
    assert.equal(typeof read.parse({ target, text: "" }), "string");
  }
  assert.equal(typeof read.parse({ target: "WEB-1A", text: "another issue" }), "string");
  assert.deepEqual(read.parse({ target: "web-1a", text: "" }), { issue: "WEB-1A" });
});

test("short-id read stays in its organization, exposes exception metadata only and follows no payload URLs", async () => {
  const { result, calls } = await run([{ body: { groupId: "123" } }, { body: issue }, { body: event }]);
  assert.deepEqual(calls.map(call => call.url), [
    "https://sentry.io/api/0/organizations/made-by-robot/shortids/WEB-1A/",
    "https://sentry.io/api/0/organizations/made-by-robot/issues/123/",
    "https://sentry.io/api/0/organizations/made-by-robot/issues/123/events/latest/",
  ]);
  for (const call of calls) {
    assert.equal(call.method, "GET");
    assert.equal(call.headers.get("authorization"), "Bearer test-token");
  }
  assert.match(result.summary, /Payment worker failed/);
  assert.match(result.summary, /RuntimeError: Retry failed/);
  assert.match(result.summary, /payments\.py · line 42/);
  assert.match(result.summary, /untrusted:\n````\n/);
  assert.doesNotMatch(result.summary, /private-|test-token|attacker/);
});

test("numeric read uses two GETs and OAuth ignores stale manual token and URL metadata", async () => {
  const { calls } = await run([{ body: issue }, { body: event }], { oauthToken: "oauth-test-token", authToken: "manual-old",
    organization: "made-by-robot", baseUrl: "https://attacker.example" }, "123");
  assert.equal(calls.length, 2);
  assert.ok(calls.every(call => call.url.startsWith("https://sentry.io/api/0/organizations/made-by-robot/issues/123/")));
  assert.ok(calls.every(call => call.headers.get("authorization") === "Bearer oauth-test-token"));
  const stub = stubFetchResponses([{ body: [] }]);
  try {
    await verifySentry({ oauthToken: "oauth-test-token", authToken: "manual-old", baseUrl: "https://attacker.example" });
    assert.equal(stub.calls[0].url, "https://sentry.io/api/0/organizations/");
    assert.equal(stub.calls[0].headers.get("authorization"), "Bearer oauth-test-token");
  } finally { stub.restore(); }
});

test("a stackless event retains bounded provenance without copying private payload metadata", async () => {
  const diagnosticEvent = { ...event, dateCreated: "2026-10-09T09:59:39.498000Z",
    release: { version: "xmatrix-v1.0.149", author: "private-release-author" },
    sdk: { name: "sentry.javascript.browser", version: "11.4.0", integrations: ["private-integration"] },
    tags: [{ key: "component", value: "web" }, { key: "environment", value: "production" },
      { key: "user.email", value: "private-user-tag" }, { key: "request", value: "private-request-tag" }],
    entries: [{ type: "exception", data: { values: [{ type: "Error", value: "Request Canceled",
      mechanism: { type: "auto.browser.global_handlers.onunhandledrejection", handled: false, synthetic: true,
        data: { secret: "private-mechanism-data" }, meta: { secret: "private-mechanism-meta" } } }] } }] };
  const { result, calls } = await run([{ body: issue }, { body: diagnosticEvent }], undefined, "123");
  for (const expected of ["Event time: 2026-10-09T09:59:39.498000Z", "Release: xmatrix-v1.0.149",
    "Component: web", "Environment: production", "SDK: sentry.javascript.browser 11.4.0",
    "Mechanism: auto.browser.global_handlers.onunhandledrejection · handled=false · synthetic=true"]) {
    assert.ok(result.summary.includes(expected), expected);
  }
  assert.doesNotMatch(result.summary, /private-|Frame:/);
  assert.equal(calls.length, 2);
});

test("malformed or oversized diagnostic metadata is omitted and does not fail an issue read", async () => {
  const { result } = await run([{ body: issue }, { body: { ...event, dateCreated: "private-time",
    release: "x".repeat(161), sdk: { name: "private-sdk\nsecret", version: "private-version" },
    tags: [{ key: "component", value: "private-component" }, { key: "environment", value: "private-environment\nsecret" }],
    entries: [{ type: "exception", data: { values: [{ type: "Error", value: "Request Canceled",
      mechanism: { type: "x".repeat(161), handled: "private-handled", synthetic: "private-synthetic" } }] } }],
  } }], undefined, "123");
  assert.match(result.summary, /Request Canceled/);
  assert.doesNotMatch(result.summary, /private-|Event time:|Release:|SDK:|Component:|Environment:|Mechanism:/);
  const stringRelease = await run([{ body: issue }, { body: { ...event, release: "xmatrix-v1.0.149" } }], undefined, "123");
  assert.match(stringRelease.result.summary, /Release: xmatrix-v1.0.149/);
});

test("capture boundary and runtime evidence cannot expose browser action text or arbitrary contexts", async () => {
  const { result } = await run([{ body: issue }, { body: { ...event,
    tags: [{ key: "operation", value: "browser: private-action-text" }],
    contexts: { browser: { name: "Chrome", version: "130.0", userAgent: "private-user-agent" },
      runtime: { name: "cloudflare", version: "private-version\nsecret" },
      secret: { name: "private-context" }, user: { email: "private-user" } },
  } }], undefined, "123");
  assert.match(result.summary, /Capture boundary: browser defect endpoint/);
  assert.match(result.summary, /browser: Chrome 130\.0/);
  assert.match(result.summary, /runtime: cloudflare/);
  assert.doesNotMatch(result.summary, /private-/);
});

test("manual tokens retain configured self-hosted origin without following redirects", async () => {
  const { calls } = await run([{ body: issue }, { body: event }], { authToken: "manual-test", organization: "test",
    baseUrl: "https://errors.example.com" }, "123");
  assert.equal(calls[0].url, "https://errors.example.com/api/0/organizations/test/issues/123/");
  await assert.rejects(run([{ status: 302, body: {} }], { authToken: "manual-test", organization: "test" }, "123"), /302/);
});

test("unconfirmed lookup, issue or event identities cannot become successful context", async () => {
  for (const groupId of [null, "", "0", "../456", "https://attacker.example", "1".repeat(33)]) {
    await assert.rejects(run([{ body: { groupId } }]), /selected issue id/);
  }
  for (const change of [{ id: "456" }, { shortId: "OTHER-1" }, { title: null }, { status: null }]) {
    await assert.rejects(run([{ body: { groupId: "123" } }, { body: { ...issue, ...change } }]), /selected issue/);
  }
  for (const change of [{ groupID: "456" }, { eventID: "../next" }, { entries: null }]) {
    await assert.rejects(run([{ body: issue }, { body: { ...event, ...change } }], undefined, "123"));
  }
});

test("optional exception type and value still return issue title and confirmed frames", async () => {
  const frame = { filename: "index.js", function: "handle", lineNo: 42, colNo: 7, vars: { secret: "private-local" } };
  const cases = [
    { values: [{ type: null, value: "unhandled rejection", stacktrace: { frames: [frame] } }],
      include: [/unhandled rejection/, /index\.js · line 42/, /Payment worker failed/], exclude: /private-local/ },
    { values: [{ type: "Error", value: null, stacktrace: { frames: [frame] } }],
      include: [/Exception 1: Error/, /index\.js/], exclude: /null/ },
    { values: [{ type: { "": "TypeError" }, value: { "": "truncated" }, stacktrace: { frames: [frame] } }],
      include: [/TypeError: truncated/, /index\.js/], exclude: /private-local/ },
    { values: [{ type: null, value: null, rawStacktrace: { frames: [{ filename: "chunk.js", lineno: 9, colno: 3 }] } }],
      include: [/Exception 1\n/, /chunk\.js · line 9 · column 3/], exclude: /null/ },
    { values: [{ type: "Error", value: "kept", stacktrace: { frames: [null, frame] } }],
      include: [/Error: kept/, /index\.js/], exclude: /private-local/ },
    { values: [null, { type: "Error", value: "second", stacktrace: { frames: [frame] } }],
      include: [/Exception 1: Error: second/], exclude: /Exception 2/ },
    { values: null, include: [/Payment worker failed/, /Latest event/], exclude: /Exception/ },
  ];
  for (const { values, include, exclude } of cases) {
    const { result } = await run([{ body: issue }, { body: { ...event, entries: [
      { type: "request", data: { headers: { authorization: "private-request-token" } } },
      { type: "exception", data: { values } },
    ] } }], undefined, "123");
    for (const pattern of include) assert.match(result.summary, pattern);
    assert.doesNotMatch(result.summary, exclude);
    assert.doesNotMatch(result.summary, /private-request-token/);
  }
});

test("exception, frame and character limits mark omissions without fetching more events", async () => {
  const { result, calls } = await run([{ body: issue }, { body: { ...event, entries: [{ type: "exception", data: {
    values: Array.from({ length: 4 }, (_, index) => ({ type: "Error", value: index === 3 ? "exception-omitted" : "x".repeat(4500),
      stacktrace: { frames: Array.from({ length: 21 }, (_, frame) => ({ filename: frame === 0 ? "frame-omitted" : `file-${frame}` })) } })),
  } }] } }], undefined, "123");
  assert.match(result.summary, /rich content omitted or bounded; truncated at 12,000/);
  assert.doesNotMatch(result.summary, /exception-omitted|frame-omitted/);
  assert.ok(result.summary.length < 12_400);
  assert.equal(calls.length, 2);
});

test("revoked, rate-limited, missing and oversized latest events fail without fallback or replay", async () => {
  for (const status of [401, 403, 404, 429, 503]) {
    await assert.rejects(run([{ body: issue }, { status, body: {} }], undefined, "123"), /Provider returned/);
  }
  await assert.rejects(run([{ body: issue }, { body: { ...event, message: "x".repeat(256 * 1024) } }], undefined, "123"),
    /response is too large/);
});

test("resolve uses the same pinned OAuth origin and cannot write after malformed short-id lookup", async () => {
  const action = SENTRY_ACTIONS.resolve;
  const stub = stubFetchResponses([{ body: { groupId: "123" } }, { body: {} }]);
  try {
    await action.execute({ credentials: { oauthToken: "oauth-test", authToken: "old-manual", organization: "test",
      baseUrl: "https://attacker.example" } }, action.parse({ target: "WEB-1A", text: "" }));
    assert.equal(stub.calls[1].url, "https://sentry.io/api/0/organizations/test/issues/123/");
    assert.equal(stub.calls[1].method, "PUT");
    assert.equal(stub.calls[1].headers.get("authorization"), "Bearer oauth-test");
  } finally { stub.restore(); }
  const malformed = stubFetchResponses([{ body: { groupId: "../456" } }]);
  try {
    await assert.rejects(action.execute({ credentials: { authToken: "manual-test", organization: "test" } },
      { issue: "WEB-1A" }), /selected issue id/);
    assert.equal(malformed.calls.length, 1);
  } finally { malformed.restore(); }
});
