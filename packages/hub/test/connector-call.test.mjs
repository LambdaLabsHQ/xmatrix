import assert from "node:assert/strict";
import { test } from "node:test";
import { Hono } from "hono";
import * as protocol from "@xmatrix/protocol";
import { ControlError } from "@xmatrix/db";
import { AuthFailure, PermissionFailure } from "../src/index-shared.ts";
import { readBoundedRequestBody } from "../src/request-body.ts";
import { privateResponse } from "../src/private-response.ts";
import { parseActionCommand } from "../src/connectors/action-parse.ts";
import { connectorActionCatalog } from "../src/connectors/action-catalog.ts";
import { connectorForCommand } from "../src/connectors/registry.ts";
import { ConnectorRemedy, ProviderRequestError } from "../src/connectors/http.ts";
import * as metering from "../src/usage-cost-metering.ts";
import { runCliCommand } from "../src/cli-commands.ts";
import { CONNECTOR_CALL_COMMAND } from "../src/cli-commands-call.ts";
import { compileCommonJsSourceModule } from "./support/commonjs-source-module.mjs";
import { withProviderResponses as fetched } from "./support/fetch-responses.mjs";

const loadRoute = await compileCommonJsSourceModule(new URL("../src/index-routes-connector-call.ts", import.meta.url));
const loadExecutor = await compileCommonJsSourceModule(new URL("../src/connectors/connector-commands.ts", import.meta.url));
const loadSupport = await compileCommonJsSourceModule(new URL("../src/connectors/command-support.ts", import.meta.url));
const id = "18f2a9c0d1e2b3a4";
const privateText = "private mail code 654321 https://example.test/verify?token=fixture-private";
const gmail = text => ({ body: { status: 200, data: { payload: { mimeType: "text/plain",
  body: { data: Buffer.from(text).toString("base64url") } } } } });

// This boundary runs the actual Gmail executor. Authorities are explicit ports:
// their own PostgreSQL tests own membership, registration and grant validation.
// Here we protect private response delivery, policy admission, and masking
// before result persistence, which public Channel-command tests cannot see.
function fixture({ mode = null, failAtAuthorization, otherMailbox = false, noMailbox = false, changeConnection = false } = {}) {
  const checks = [], reports = [], policies = [], appends = [], persisted = [], privateRecords = [];
  let scopes = 0;
  const run = { runId: "run-alpha", instanceId: "instance-alpha", agentId: "agent-alpha", channelId: "channel-alpha",
    ownerUserId: "member", spaceId: "space", executionKey: "execution-alpha" };
  const credentials = { composioApiKey: "fixture-key", ...(noMailbox ? {} : { mailboxes: JSON.stringify([
    { account: "ca_fixture", address: "me@example.com", owner: otherMailbox ? "user:other" : "user:member" },
  ]) }) };
  const append = async (_env, channelId, command) => {
    assert.equal(channelId, run.channelId); appends.push(command); return Response.json({});
  };
  const support = loadSupport(name => ({
    "@xmatrix/protocol": protocol,
    "../apps": { appCommand: async (_env, kind, input) => { persisted.push({ kind, input }); },
      usableAppConnections: async (_env, input) => {
        assert.equal(input.channelId, run.channelId); assert.equal(input.actorUserId, run.ownerUserId);
        return [{ providerId: "gmail", status: "configured", id: changeConnection && ++scopes >= 3 ? "replaced" : "connection" }];
      } },
    "../spaces": { getChannel: async () => ({ channel: { spaceId: "space" } }) },
    "../product-message-append": { dispatchProductMessageAppend: append },
  })[name]);
  const executor = loadExecutor(name => ({
    "@xmatrix/protocol": protocol,
    "./action-catalog": { connectorActionCatalog },
    "./agent-caller": { agentRegistrationOf: async () => ({ ownerUserId: "member", machineId: "machine", harness: "codex" }) },
    "../app-connectors": { getAppConnectorProvider: providerId => protocol.APP_CONNECTOR_PROVIDER_MANIFESTS.find(p => p.id === providerId) },
    "./command-support": support,
    "./credentials": { connectorPermissionRepository: () => ({ mode: async input => { policies.push(input); return mode; } }) },
    "./connection-credentials": { connectionCredentials: async () => credentials },
    "./http": { ConnectorRemedy, ProviderRequestError },
    "../usage-cost-metering": metering,
  })[name] ?? {});
  const app = new Hono();
  loadRoute(name => ({
    "@xmatrix/protocol": protocol, "@xmatrix/db": { ControlError },
    "./private-response": { privateResponse },
    "./index-shared": { AuthFailure, PermissionFailure, readBoundedRequestBody,
      requireAuth: async request => request.headers.get("authorization") === "Bearer human" ? { id: "member" }
        : { id: "member", agentRun: run },
      requestErrorResponse: (c, error) => { reports.push(error.message); return c.json({ error: error.message }, 403); } },
    "./agent-run-channel-delegation": { requireAgentRunChannelDelegation: async (_env, caller, channels) => {
      assert.equal(caller, run); assert.deepEqual(channels, []); checks.push(caller.runId);
      if (checks.length === failAtAuthorization) throw new PermissionFailure("Run access revoked");
    } },
    "./connectors/action-parse": { parseActionCommand },
    "./connectors/action-catalog": { connectorActionCatalog },
    "./connectors/registry": { connectorForCommand },
    "./connectors/connector-commands": executor,
    "./connectors/http": { ConnectorRemedy, ProviderRequestError },
    "./connectors/command-support": support,
    "./connectors/private-result-content": { writeConnectorPrivateResult: async (_env, record) => { privateRecords.push(record); } },
    "./product-message-append": { dispatchProductMessageAppend: append },
    "./app-connectors": { getAppConnectorProvider: providerId => protocol.APP_CONNECTOR_PROVIDER_MANIFESTS.find(p => p.id === providerId) },
  })[name]).registerConnectorCallRoutes(app);
  return { checks, reports, policies, appends, persisted, privateRecords, request: (body, token = "agent") => app.request(protocol.HUB_ROUTES.connector_call,
    { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify({ resultVisibility: "private", ...body }) }, {}) };
}

test("private CLI call sends arguments directly and prints only its own result", async () => {
  const calls = [];
  const call = async (...args) => { calls.push(args); return { summary: privateText }; };
  const output = await runCliCommand([CONNECTOR_CALL_COMMAND], {}, ["call", `@gmail:read:${id}`, "--private", "--json"], call);
  assert.deepEqual(calls, [["POST", protocol.HUB_ROUTES.connector_call, { command: `@gmail:read:${id}`, resultVisibility: "private" }]]);
  assert.equal(JSON.parse(output.stdout).summary, privateText);
  assert.match((await runCliCommand([CONNECTOR_CALL_COMMAND], {}, ["call", "--help"], call)).stdout, /calling Agent and its Human owner/);
  assert.equal(calls.length, 1, "help never runs an action");
  for (const flags of [[], ["--private", "--public"]]) {
    const invalid = await runCliCommand([CONNECTOR_CALL_COMMAND], {}, ["call", `@gmail:read:${id}`, ...flags], call);
    assert.equal(invalid.exitCode, 2);
  }
  assert.equal(calls.length, 1, "old bare calls cannot silently start publishing parameters or results");
});

test("normal and private calls record the same invocation; only the private Channel/history result is masked", async () => {
  for (const visibility of ["public", "private"]) {
    const f = fixture();
    const command = `@gmail:read:${id}`;
    const { result } = await fetched([gmail(privateText)], () => f.request({ command, resultVisibility: visibility }));
    assert.equal(result.status, 200, await result.clone().text());
    assert.match((await result.json()).summary, /654321.*fixture-private/);
    assert.equal(f.checks.length, 4, "Run access is rechecked after provider I/O and owner-only storage, before return");
    assert.equal(result.headers.get("cache-control"), "private, no-store");
    assert.equal(f.appends.length, 2);
    assert.equal(f.appends[0].body, command);
    assert.deepEqual(f.appends[0].principal, { kind: "agent", id: "agent-alpha", agentSpaceId: "space" });
    assert.equal(f.appends[0].agentRunProof.runId, "run-alpha");
    const receipt = f.appends[1];
    assert.equal(receipt.residual.replyToMessageId, f.appends[0].messageId);
    assert.equal(receipt.residual.appMetadata.xmatrixConnectorRequesterInstanceId, undefined,
      "a synchronous return must not resume the caller a second time");
    assert.equal(f.privateRecords.length, visibility === "private" ? 1 : 0);
    if (visibility === "private") {
      assert.equal(f.privateRecords[0].ownerUserId, "member");
      assert.equal(f.privateRecords[0].messageId, receipt.messageId);
      assert.match(f.privateRecords[0].detail, /654321.*fixture-private/);
      assert.equal(receipt.residual.appMetadata.xmatrixPrivateConnectorResultOwner, "member");
    }
    const history = f.persisted.find(row => row.kind === "finalize-execution").input;
    assert.equal(history.status, "completed");
    for (const output of [receipt.body, JSON.stringify(f.persisted)]) {
      if (visibility === "private") {
        assert.match(output, /Result: \[hidden — private call\]/);
        assert.doesNotMatch(output, /654321|fixture-private|example\.test\/verify/);
      } else assert.match(output, /654321.*fixture-private/);
    }
  }
});

test("private failure details reach the caller while Channel and execution history retain a masked failure", async () => {
  const f = fixture();
  const { result } = await fetched([{ body: { status: 403, data: { error: { message: privateText } } } }],
    () => f.request({ command: `@gmail:read:${id}`, resultVisibility: "private" }));
  assert.equal(result.status, 403);
  assert.match(await result.text(), /654321/);
  assert.equal(f.appends.length, 2);
  assert.match(f.appends[1].body, /blocked; Result: \[hidden — private call\]/);
  assert.doesNotMatch(JSON.stringify([f.appends, f.persisted, f.reports]), /654321|fixture-private/);
  assert.equal(f.persisted.find(row => row.kind === "finalize-execution").input.status, "blocked");
});

test("a private failure keeps the Hub's own next step, which carries no provider data", async () => {
  const f = fixture({ noMailbox: true });
  const { result, calls } = await fetched([], () => f.request({ command: `@gmail:read:${id}`, resultVisibility: "private" }));
  assert.equal(result.status, 403); assert.equal(calls.length, 0);
  assert.match(f.appends[1].body, /blocked; save mailboxes in Apps → Gmail → Credentials\./);
  assert.equal(f.persisted.find(row => row.kind === "finalize-execution").input.reason, "save mailboxes in Apps → Gmail → Credentials");
  assert.doesNotMatch(JSON.stringify([f.appends, f.persisted]), /hidden — private call/);
});

test("result visibility is strictly typed and cannot be coerced into a public result", async () => {
  for (const resultVisibility of [["private"], null, true, "invalid", undefined]) {
    const f = fixture();
    const { result, calls } = await fetched([], () => f.request({ command: `@gmail:read:${id}`, resultVisibility }));
    assert.equal(result.status, 400); assert.equal(calls.length, 0); assert.deepEqual(f.appends, []);
  }
});

test("private reads stay available in every app mode, never write, and respect mailbox ownership", async () => {
  for (const mode of ["read", "ask", "write"]) {
    const f = fixture({ mode });
    const { result, calls } = await fetched([gmail(privateText)], () => f.request({ command: `@gmail:read:${id}` }));
    assert.equal(result.status, 200); assert.equal(calls.length, 1);
  }
  for (const command of ["@gmail:send:other@example.com Subject\nBody", "@gmail:policy:read allow", "@gmail:subscribe:*"]) {
    const f = fixture();
    const { result, calls } = await fetched([], () => f.request({ command }));
    assert.ok(result.status >= 400); assert.equal(calls.length, 0);
  }
  const { result, calls } = await fetched([], () => fixture({ otherMailbox: true }).request({ command: `@gmail:read:${id}` }));
  assert.equal(result.status, 403); assert.equal(calls.length, 0);
});

test("Run or connection revocation withholds both successful and failed in-flight private reads", async () => {
  for (const options of [{ failAtAuthorization: 3 }, { failAtAuthorization: 4 }, { changeConnection: true }]) {
    for (const response of [gmail(privateText), { body: { status: 403, data: { error: { message: privateText } } } }]) {
      const f = fixture(options);
      const { result, calls } = await fetched([response], () => f.request({ command: `@gmail:read:${id}` }));
      assert.equal(result.status, 403); assert.equal(calls.length, 1);
      assert.doesNotMatch(await result.text(), /654321|fixture-private/);
    }
  }
});

test("caller scope is server-owned; human, spoofed identity, malformed and oversized requests never reach a provider", async () => {
  for (const [body, token, status] of [[{ command: `@gmail:read:${id}` }, "human", 403],
    [{ command: `@gmail:read:${id}`, channelId: "other-channel" }, "agent", 400],
    [{ command: `@gmail:read:${id}`, runId: "run-beta" }, "agent", 400],
    ["not JSON", "agent", 400], [{ command: "x".repeat(33 * 1024) }, "agent", 413]]) {
    const { result, calls } = await fetched([], () => fixture().request(body, token));
    assert.equal(result.status, status); assert.equal(calls.length, 0);
    assert.equal(result.headers.get("cache-control"), "private, no-store");
  }
});

test("provider failures remain caller-only; unexpected errors cannot enter error reports with private content", async () => {
  for (const response of [{ body: { status: 403, data: { error: { message: privateText } } } }, { error: new Error(privateText) }]) {
    const f = fixture();
    const { result } = await fetched([response], () => f.request({ command: `@gmail:read:${id}` }));
    assert.ok(result.status >= 400);
    assert.equal(result.headers.get("cache-control"), "private, no-store");
    assert.ok(f.reports.every(report => !report.includes("654321") && !report.includes("fixture-private")));
  }
});
