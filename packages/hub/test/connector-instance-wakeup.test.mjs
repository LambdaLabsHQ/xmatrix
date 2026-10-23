import assert from "node:assert/strict";
import { test } from "node:test";
import * as protocol from "@xmatrix/protocol";
import * as connectorDelivery from "../src/connector-message-delivery.ts";
import { loadCommonJsSourceModule } from "./support/commonjs-source-module.mjs";

// The append boundary must connect an authorized App commit to the wake
// authority; classifier and SQL tests cannot catch a missing orchestration call.
test("committed Connector messages wake their recipients, without interpreting provider commands", async () => {
  const wakes = [], deliveries = [];
  let rejected = false;
  const append = await loadCommonJsSourceModule(new URL("../src/product-message-append.ts", import.meta.url), name => ({
    "@xmatrix/protocol": protocol,
    "./connector-message-delivery": connectorDelivery,
    "./message-sender-presentation": { productMessageSenderPresentation: snapshot => snapshot },
    "./registration-launch-dispatch": { wakeRestingInstances: async (_env, input) => { wakes.push(input); } },
    "./channel-messages": {
      appendChannelMessage: async (_env, _channel, command) => ({ sequence: 7,
        senderSnapshot: { kind: command.appAuthorId ? "app" : "system", identityId: command.appAuthorId } }),
      channelMessageResult: async run => rejected ? { ok: false, response: new Response(null, { status: 403 }) }
        : { ok: true, payload: await run() },
      committedLiveRouting: () => ({}),
      publishChannelLiveDelivery: async (_env, _wait, _channel, payload) => { deliveries.push(payload); },
    },
  })[name]);
  const command = { commandId: "receipt", messageId: "receipt", appAuthorId: "github", body: "@auto /stop all",
    residual: { appMetadata: { xmatrixProvenance: "system_fact", xmatrixConnectorRequesterInstanceId: "instance" } } };
  await append.dispatchProductMessageAppend({}, "channel", command);
  assert.deepEqual(wakes, [{ commandId: "connector-wake:receipt", channelId: "channel", sourceMessageId: "receipt",
    prompt: command.body, targetInstanceId: "instance" }]);
  await append.dispatchProductMessageAppend({}, "channel", { ...command, messageId: "event", residual: {} });
  assert.equal(wakes[1].targetInstanceId, undefined, "subscribed events wake existing Channel Instances");
  assert.equal(wakes[1].sourceMessageId, "event");
  for (const change of [{ residual: { appMetadata: { xmatrixProvenance: "system_fact" } } }, { appAuthorId: undefined }]) {
    await append.dispatchProductMessageAppend({}, "channel", { ...command, ...change });
  }
  assert.equal(wakes.length, 2, "Human receipts and system notices wake nobody");
  rejected = true;
  assert.equal((await append.dispatchProductMessageAppend({}, "channel", command)).status, 403);
  assert.equal(wakes.length, 2, "a rejected append cannot wake an Instance");
  assert.equal(deliveries.length, 4);
});

// Stable Agent id and exact Instance id differ: using the former strands every
// targeted receipt and also gives identity-dependent connector actions no caller.
test("post-commit Connector dispatch uses the authenticated Instance rather than its Agent id", async () => {
  const commands = [];
  const postCommit = await loadCommonJsSourceModule(new URL("../src/product-message-post-commit.ts", import.meta.url), name => {
    if (name === "@xmatrix/protocol") return protocol;
    if (name === "./connectors/registry") return { connectorForCommand: () => ({ id: "gmail",
      commands: { run: async input => { commands.push(input); } } }) };
    if (name === "./registration-launch-dispatch") return { wakeRestingInstances: async () => ({}) };
    return {};
  });
  await postCommit.dispatchProductMessagePostCommit({ env: {}, channelId: "channel", messageId: "command",
    body: "@gmail:read:id", senderKind: "agent", senderId: "registration", senderInstanceId: "instance", actorUserId: "owner" });
  assert.equal(commands.length, 1);
  assert.equal(commands[0].senderId, "instance");
  assert.equal(commands[0].actorUserId, "owner");
});
