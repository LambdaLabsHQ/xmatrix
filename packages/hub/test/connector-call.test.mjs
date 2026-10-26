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
import { ProviderRequestError } from "../src/connectors/http.ts";
import * as metering from "../src/usage-cost-metering.ts";
import { runCliCommand } from "../src/cli-commands.ts";
import { CONNECTOR_CALL_COMMAND } from "../src/cli-commands-call.ts";
import { compileCommonJsSourceModule } from "./support/commonjs-source-module.mjs";
import { withProviderResponses as fetched } from "./support/fetch-responses.mjs";

const loadRoute = await compileCommonJsSourceModule(new URL("../src/index-routes-connector-call.ts", import.meta.url));
const loadExecutor = await compileCommonJsSourceModule(new URL("../src/connectors/connector-commands.ts", import.meta.url));
const id = "18f2a9c0d1e2b3a4";
const privateText = "private mail code 654321 https://example.test/verify?token=fixture-private";
const gmail = text => ({ body: { status: 200, data: { payload: { mimeType: "text/plain",
  body: { data: Buffer.from(text).toString("base64url") } } } } });

// This boundary runs the actual Gmail executor. Authorities are explicit ports:
// their own PostgreSQL tests own membership, registration and grant validation.
// Here we protect private delivery, policy admission, and never persisting or
// logging request/response data, which public Channel-command tests cannot see.
function fixture({ mode = null, failAtAuthorization, otherMailbox = false, changeConnection = false } = {}) {
  const checks = [], reports = [], policies = [];
  let scopes = 0;
  const run = { runId: "run-alpha", instanceId: "instance-alpha", channelId: "channel-alpha",
    ownerUserId: "member", spaceId: "space", executionKey: "execution-alpha" };
  const credentials = { composioApiKey: "fixture-key", mailboxes: JSON.stringify([
    { account: "ca_fixture", address: "me@example.com", owner: otherMailbox ? "user:other" : "user:member" },
  ]) };
  const executor = loadExecutor(name => ({
    "@xmatrix/protocol": protocol,
    "./action-catalog": { connectorActionCatalog },
    "./agent-caller": { agentRegistrationOf: async () => ({ ownerUserId: "member", machineId: "machine", harness: "codex" }) },
    "../app-connectors": { getAppConnectorProvider: providerId => protocol.APP_CONNECTOR_PROVIDER_MANIFESTS.find(p => p.id === providerId) },
    "./command-support": { commandScope: async (_manifest, input) => {
      assert.equal(input.channelId, run.channelId); assert.equal(input.actorUserId, run.ownerUserId);
      return { spaceId: "space", connectionId: changeConnection && ++scopes >= 3 ? "replaced" : "connection" };
    }, withExecution: () => assert.fail("private data must never enter execution history"),
    publishCommandStatus: () => assert.fail("private calls must never post a Channel receipt") },
    "./credentials": { connectorActionPolicyRepository: () => ({ mode: async input => { policies.push(input); return mode; } }) },
    "./connection-credentials": { connectionCredentials: async () => credentials },
    "./http": { ProviderRequestError },
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
    "./connectors/http": { ProviderRequestError },
  })[name]).registerConnectorCallRoutes(app);
  return { checks, reports, policies, request: (body, token = "agent") => app.request(protocol.HUB_ROUTES.connector_call,
    { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body) }, {}) };
}

test("private read returns mail only to the authenticated response, with no Channel or execution-history writes", async () => {
  const f = fixture();
  const { result, calls } = await fetched([gmail(privateText)], () => f.request({ command: `@gmail:read:${id}` }));
  assert.equal(result.status, 200, await result.clone().text());
  assert.equal(result.headers.get("cache-control"), "private, no-store");
  const payload = await result.json();
  assert.match(payload.summary, /654321/);
  assert.match(payload.summary, /fixture-private/);
  assert.equal(calls.length, 1);
  assert.equal(f.checks.length, 3, "exact Run checked at entry, before provider I/O and before returning data");
  assert.deepEqual(f.reports, []);
  assert.ok(f.policies.every(policy => policy.channelId === "channel-alpha"));
});

test("private CLI call sends arguments directly and prints only its own result", async () => {
  const calls = [];
  const call = async (...args) => { calls.push(args); return { summary: privateText }; };
  const output = await runCliCommand([CONNECTOR_CALL_COMMAND], {}, ["call", `@gmail:read:${id}`, "--json"], call);
  assert.deepEqual(calls, [["POST", protocol.HUB_ROUTES.connector_call, { command: `@gmail:read:${id}` }]]);
  assert.equal(JSON.parse(output.stdout).summary, privateText);
  assert.match((await runCliCommand([CONNECTOR_CALL_COMMAND], {}, ["call", "--help"], call)).stdout, /only this caller/);
  assert.equal(calls.length, 1, "help never runs an action");
});

test("private reads cannot bypass ask/disallow, perform writes, or read another member's mailbox", async () => {
  for (const mode of ["ask", "disallow"]) {
    const f = fixture({ mode });
    const { result, calls } = await fetched([], () => f.request({ command: `@gmail:read:${id}` }));
    assert.equal(result.status, 403); assert.equal(calls.length, 0);
  }
  for (const command of ["@gmail:send:other@example.com Subject\nBody", "@gmail:policy:read allow", "@gmail:subscribe:*"]) {
    const f = fixture();
    const { result, calls } = await fetched([], () => f.request({ command }));
    assert.ok(result.status >= 400); assert.equal(calls.length, 0);
  }
  const { result, calls } = await fetched([], () => fixture({ otherMailbox: true }).request({ command: `@gmail:read:${id}` }));
  assert.equal(result.status, 403); assert.equal(calls.length, 0);
});

test("revocation or replaced connection while a provider read is in flight withholds the private response", async () => {
  for (const options of [{ failAtAuthorization: 3 }, { changeConnection: true }]) {
    const f = fixture(options);
    const { result, calls } = await fetched([gmail(privateText)], () => f.request({ command: `@gmail:read:${id}` }));
    assert.equal(result.status, 403); assert.equal(calls.length, 1);
    assert.doesNotMatch(await result.text(), /654321|fixture-private/);
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
