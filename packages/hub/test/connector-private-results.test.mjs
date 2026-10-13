import assert from "node:assert/strict";
import { test } from "node:test";
import * as protocol from "@xmatrix/protocol";
import { GMAIL_ACTIONS } from "../src/connectors/actions/gmail.ts";
import { parseActionCommand } from "../src/connectors/action-parse.ts";
import { connectorActionCatalog } from "../src/connectors/action-catalog.ts";
import { handleConnectorMcp } from "../src/connectors/mcp.ts";
import { loadCommonJsSourceModule } from "./support/commonjs-source-module.mjs";
import { withProviderResponses } from "./support/fetch-responses.mjs";
import { ProviderRequestError } from "../src/connectors/http.ts";

const caller = { ownerUserId: "owner", agentId: "instance", channelId: "channel", runId: "run", spaceId: "space" };
const mailbox = { address: "private-mailbox@example.test", account: "ca_private", owner: "user:owner" };
const id = "18f2a9c0d1e2b3a4";
const secret = "SYNTHETIC-LOGIN-ALPHA9";
const privateText = `Private subject, code ${secret}; https://example.test/verify?token=${secret}`;
const gmail = data => ({ body: { status: 200, data } });

// The real executor, persistence and Channel append must keep mail available to
// its caller without copying it to either durable sink, including on failure.
async function harness(credentials = { mailboxes: JSON.stringify([mailbox]), composioApiKey: "fixture-key" }) {
  const persisted = [], receipts = [];
  const support = await loadCommonJsSourceModule(new URL("../src/connectors/command-support.ts", import.meta.url), name => {
    if (name === "@xmatrix/protocol") return protocol;
    if (name === "../apps") return {
      appCommand: async (_env, command, input) => { persisted.push({ command, input }); },
      listAppConnections: async () => [{ id: "space:gmail", providerId: "gmail", status: "configured" }],
    };
    if (name === "../spaces") return { getChannel: async () => ({ channel: { spaceId: "space" } }) };
    if (name === "../product-message-append") return {
      dispatchProductMessageAppend: async (_env, _channel, input) => { receipts.push(input); return new Response(null, { status: 200 }); },
    };
    assert.fail(`unexpected support import ${name}`);
  });
  const dependencies = {
    "@xmatrix/protocol": protocol,
    "../app-connectors": { getAppConnectorProvider: provider => protocol.APP_CONNECTOR_PROVIDER_MANIFESTS.find(p => p.id === provider) },
    "./command-support": support,
    "./action-parse": { parseActionCommand },
    "./action-catalog": { connectorActionCatalog },
    "./connection-credentials": { connectionCredentials: async () => credentials },
    "./credentials": { connectorActionPolicyRepository: () => ({ mode: async () => "allow" }) },
    "./agent-caller": { agentRegistrationOf: async () => ({ ownerUserId: "owner", machineId: "machine", harnessId: "codex" }) },
    "./http": { ProviderRequestError },
  };
  const commands = await loadCommonJsSourceModule(new URL("../src/connectors/connector-commands.ts", import.meta.url), name => dependencies[name] ?? {});
  return { persisted, receipts, commands };
}

function assertPrivate({ persisted, receipts }, status) {
  assert.equal(receipts.length, 1);
  assert.match(receipts[0].body, new RegExp(`Gmail (search|read): ${status};`));
  const durable = JSON.stringify({ persisted, receipts });
  for (const value of [secret, "Private subject", "verify?token=", mailbox.address, id, "subject:private-query"]) {
    assert.ok(!durable.includes(value), `${value} must not enter Channel messages or execution history`);
  }
  assert.equal(persisted.find(p => p.command === "finalize-execution")?.input.status, status);
  assert.equal(receipts[0].residual.appMetadata.xmatrixProvenance, "system_fact");
}

test("Gmail MCP search/read preserve private mail answers without persisting or broadcasting them", async () => {
  for (const actionId of ["search", "read"]) {
    const h = await harness();
    const responses = actionId === "search" ? [gmail({ messages: [{ id }] }), gmail({ id, snippet: privateText,
      payload: { headers: [{ name: "Subject", value: privateText }, { name: "From", value: mailbox.address }] } })]
      : [gmail({ payload: { mimeType: "text/plain", headers: [{ name: "Subject", value: privateText }],
        body: { data: Buffer.from(privateText).toString("base64url") } } })];
    const args = actionId === "search" ? { target: "*", text: "subject:private-query" } : { target: id };
    const { result } = await withProviderResponses(responses, async () => (await handleConnectorMcp({}, caller,
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: `gmail__${actionId}`, arguments: args } },
      h.commands.runConnectorAction)).json());
    assert.equal(result.result.isError, false);
    assert.ok(result.result.content[0].text.includes(secret), "the private caller still gets the login content");
    assertPrivate(h, "completed");
  }
});

test("Gmail failure details and blocked mailbox context remain private too", async () => {
  for (const status of ["failed", "blocked"]) {
    const h = await harness(status === "blocked" ? {} : undefined);
    const responses = status === "failed" ? [{ body: { status: 403, data: { error: { message: privateText } } } }] : [];
    const { result } = await withProviderResponses(responses, () => h.commands.runConnectorAction("gmail", {
      env: {}, channelId: caller.channelId, messageId: "mcp:failure", actorUserId: caller.ownerUserId,
      senderKind: "agent", senderId: caller.agentId,
    }, "read", GMAIL_ACTIONS.read, { target: id, text: "" }));
    assert.match(result, new RegExp(`: ${status};`));
    if (status === "failed") assert.ok(result.includes(secret));
    assertPrivate(h, status);
  }
});

test("typed Gmail commands publish status only, and invalid MCP search explains target/text", async () => {
  const h = await harness();
  await withProviderResponses([gmail({ messages: [{ id }] }), gmail({ id, snippet: privateText })],
    () => h.commands.connectorCommands("gmail", GMAIL_ACTIONS).run({ env: {}, channelId: caller.channelId,
      messageId: "channel-command", actorUserId: caller.ownerUserId, senderKind: "user", body: "@gmail:search:*" }));
  assertPrivate(h, "completed");
  const invalid = await harness();
  const response = await (await handleConnectorMcp({}, caller, { jsonrpc: "2.0", id: 2, method: "tools/call",
    params: { name: "gmail__search", arguments: { target: `* ${secret}`, text: "" } } }, invalid.commands.runConnectorAction)).json();
  assert.equal(response.result.isError, true);
  assert.match(response.result.content[0].text, /MCP.*"target":"\*","text":/u);
  assert.equal(invalid.persisted.length, 0, "invalid statements never reach execution storage");
  assert.ok(!JSON.stringify(invalid.receipts).includes(secret));
});

test("listed Gmail search tool explains where the MCP query goes", async () => {
  const listed = await (await handleConnectorMcp({}, caller, { jsonrpc: "2.0", id: 3, method: "tools/list" },
    undefined, async () => new Set(["gmail"]))).json();
  const search = listed.result.tools.find(t => t.name === "gmail__search");
  assert.match(search.description, /"target":"\*","text":"is:unread newer_than:1h"/u);
  assert.match(search.inputSchema.properties.text.description, /search queries/u);
});
