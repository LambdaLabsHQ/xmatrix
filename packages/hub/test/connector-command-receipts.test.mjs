import assert from "node:assert/strict";
import { test } from "node:test";
import * as protocol from "@xmatrix/protocol";
import { GMAIL_ACTIONS } from "../src/connectors/actions/gmail.ts";
import { parseActionCommand } from "../src/connectors/action-parse.ts";
import { connectorActionCatalog } from "../src/connectors/action-catalog.ts";
import * as subscriptionParse from "../src/connectors/subscription-parse.ts";
import { loadCommonJsSourceModule } from "./support/commonjs-source-module.mjs";
import { withProviderResponses } from "./support/fetch-responses.mjs";
import { ConnectorRemedy, ProviderRequestError } from "../src/connectors/http.ts";
import * as metering from "../src/usage-cost-metering.ts";
import { AppControlError } from "../../db/src/app-control.ts";
import { ControlError } from "../../db/src/control-error.ts";
import { connectionCredentialsDouble } from "./support/connection-credentials-double.mjs";

const mailbox = { address: "mailbox@example.test", account: "ca_mailbox", owner: "user:owner" };
const id = "18f2a9c0d1e2b3a4";
const mailText = "Subject: App Review, code SYNTHETIC-ALPHA9";
const gmail = data => ({ body: { status: 200, data } });

// A public command runs from a Channel message, and everyone in the Channel,
// its sender included, reads the result in the receipt that replies to it.
async function harness(credentials = { mailboxes: JSON.stringify([mailbox]), composioApiKey: "fixture-key" }) {
  const persisted = [], receipts = [];
  const support = await loadCommonJsSourceModule(new URL("../src/connectors/command-support.ts", import.meta.url), name => {
    if (name === "@xmatrix/protocol") return protocol;
    if (name === "@xmatrix/db") return { ControlError };
    if (name === "../apps") return {
      appCommand: async (_env, command, input) => { persisted.push({ command, input }); },
      usableAppConnections: async () => [{ id: "space:gmail", providerId: "gmail", status: "configured" }],
    };
    if (name === "../spaces") return { getChannel: async () => ({ channel: { spaceId: "space" } }) };
    if (name === "../product-message-append") return {
      dispatchProductMessageAppend: async (_env, _channel, input) => { receipts.push(input); return new Response(null, { status: 200 }); },
    };
    if (name === "./agent-caller") return { callingAgentOf: async () => ({ name: "claude", harness: "claude" }) };
    assert.fail(`unexpected support import ${name}`);
  });
  const dependencies = {
    "@xmatrix/protocol": protocol,
    "@xmatrix/db": { AppControlError },
    "../app-connectors": { getAppConnectorProvider: provider => protocol.APP_CONNECTOR_PROVIDER_MANIFESTS.find(p => p.id === provider) },
    "./command-support": support,
    "./action-parse": { parseActionCommand },
    "./action-catalog": { connectorActionCatalog },
    "./subscription-parse": subscriptionParse,
    "./connection-credentials": connectionCredentialsDouble(async () => credentials),
    "./credentials": { connectorPermissionRepository: () => ({ mode: async () => "write" }) },
    "./agent-caller": { agentRegistrationOf: async () => ({ ownerUserId: "owner", machineId: "machine", harnessId: "codex" }) },
    "./http": { ConnectorRemedy, ProviderRequestError },
    "../usage-cost-metering": metering,
  };
  const commands = await loadCommonJsSourceModule(new URL("../src/connectors/connector-commands.ts", import.meta.url), name => dependencies[name] ?? {});
  return { persisted, receipts, commands };
}

const agentMessage = (messageId, body) => ({ env: {}, channelId: "channel", messageId, actorUserId: "owner",
  senderKind: "agent", senderId: "instance", body });

test("an Agent's Gmail search and read reply to its message with what they found", async () => {
  for (const [body, responses] of [
    ["@gmail:search:* subject:review", [gmail({ messages: [{ id }] }), gmail({ id, snippet: mailText,
      payload: { headers: [{ name: "Subject", value: mailText }, { name: "From", value: mailbox.address }] } })]],
    [`@gmail:read:${id}`, [gmail({ payload: { mimeType: "text/plain", headers: [{ name: "Subject", value: mailText }],
      body: { data: Buffer.from(mailText).toString("base64url") } } })]],
  ]) {
    const h = await harness();
    await withProviderResponses(responses, () => h.commands.connectorCommands("gmail", GMAIL_ACTIONS).run(agentMessage("command-1", body)));
    assert.equal(h.receipts.length, 1);
    assert.match(h.receipts[0].body, /Gmail (search|read): completed;/u);
    assert.ok(h.receipts[0].body.includes("SYNTHETIC-ALPHA9"), body);
    assert.equal(h.receipts[0].residual.replyToMessageId, "command-1");
    assert.equal(h.receipts[0].residual.appMetadata.xmatrixConnectorRequesterInstanceId, "instance");
    const finalized = h.persisted.find(p => p.command === "finalize-execution").input;
    assert.equal(finalized.status, "completed");
    assert.ok(finalized.resultSummary.length > 0);
  }
});

test("a failure explains itself in the receipt, and a bad search names the command's shape", async () => {
  const failed = await harness();
  await withProviderResponses([{ body: { status: 403, data: { error: { message: "Gmail refused" } } } }],
    () => failed.commands.connectorCommands("gmail", GMAIL_ACTIONS).run(agentMessage("command-2", `@gmail:read:${id}`)));
  assert.match(failed.receipts[0].body, /Gmail read: failed;/u);

  const invalid = await harness();
  await invalid.commands.connectorCommands("gmail", GMAIL_ACTIONS).run(agentMessage("command-3", "@gmail:search:inbox from:a"));
  assert.match(invalid.receipts[0].body, /use @gmail:search:\* <Gmail query>/u);
  assert.doesNotMatch(invalid.receipts[0].body, /MCP/u);
  assert.equal(invalid.persisted.length, 0, "an invalid statement never reaches execution storage");
});

test("an approved request's receipt replies to the message that asked for it", async () => {
  const h = await harness();
  await withProviderResponses([gmail({ payload: { mimeType: "text/plain", headers: [],
    body: { data: Buffer.from(mailText).toString("base64url") } } })],
  () => h.commands.runConnectorAction("gmail", { ...agentMessage("command-4:approved", ""), commandMessageId: "command-4" },
    "read", GMAIL_ACTIONS.read, { target: id, text: "" }));
  assert.equal(h.receipts[0].residual.replyToMessageId, "command-4");
  assert.equal(h.receipts[0].messageId, "system:command-4:approved:gmail");
  assert.equal(h.receipts[0].residual.appMetadata.xmatrixConnectorRequesterInstanceId, "instance");
});

test("a statement a person can fix carries its fix in the receipt's Hub-only metadata", async () => {
  const actions = {
    read: { effect: "read", requires: [], parse: () => ({}),
      execute: async () => { throw new ConnectorRemedy(401, "connect Gmail again", { kind: "reconnect" }); } },
  };
  const h = await harness();
  await h.commands.connectorCommands("gmail", actions).run(agentMessage("command-fix", `@gmail:read:${id}`));
  assert.match(h.receipts[0].body, /Gmail read: failed;/u);
  const fixes = h.receipts[0].residual.appMetadata.xmatrixConnectorFixes;
  assert.equal(fixes.length, 1);
  assert.deepEqual({ ...fixes[0], executionId: undefined }, { providerId: "gmail", actionId: "read", executionId: undefined,
    remedy: { kind: "reconnect" } });
  assert.equal(fixes[0].executionId, h.persisted.find(p => p.command === "finalize-execution").input.executionId);
  assert.deepEqual(protocol.connectorReceiptFixesOf(h.receipts[0].residual.appMetadata), fixes, "the Web reads the same fix back");

  const fine = await harness();
  await withProviderResponses([gmail({ payload: { mimeType: "text/plain", headers: [], body: { data: "" } } })],
    () => fine.commands.connectorCommands("gmail", GMAIL_ACTIONS).run(agentMessage("command-ok", `@gmail:read:${id}`)));
  assert.equal(fine.receipts[0].residual.appMetadata.xmatrixConnectorFixes, undefined, "a completed command offers no fix");
});

test("a receipt's fixes are read only for a known App and a field a person types", () => {
  const fix = (overrides) => ({ providerId: "appstoreconnect", actionId: "sales", executionId: "app-execution:m:appstoreconnect:sales",
    remedy: { kind: "credential", field: "webSession" }, ...overrides });
  const read = (...fixes) => protocol.connectorReceiptFixesOf({ xmatrixConnectorFixes: fixes });
  assert.deepEqual(read(fix()), [fix()]);
  assert.deepEqual(read(fix({ remedy: { kind: "reconnect", field: "x" } })), [fix({ remedy: { kind: "reconnect" } })]);
  for (const bad of [fix({ providerId: "nope" }), fix({ remedy: { kind: "credential", field: "webhookSecret" } }),
    fix({ remedy: { kind: "credential", field: "unknown" } }), fix({ actionId: "has space" }), fix({ executionId: 7 }), "fix", null]) {
    assert.deepEqual(read(bad), [], JSON.stringify(bad));
  }
  assert.deepEqual(protocol.connectorReceiptFixesOf(undefined), []);
});
