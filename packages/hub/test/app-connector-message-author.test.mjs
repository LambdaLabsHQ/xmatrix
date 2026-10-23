import assert from "node:assert/strict";

import { test } from "node:test";

import {
  APP_CONNECTOR_PROVIDER_MANIFESTS,
} from "../../protocol/src/app-connector-manifests.ts";
import {
  appConnectorMessageSenderSnapshot,
} from "../src/app-connectors.ts";
import {
  agentChannelMessageDeliveryIntent,
  agentChannelMessageRequestsInterrupt,
  channelMessage,
} from "../src/runtime-transport/channel-message-frame.ts";

test("every connector provider resolves one stable App message author", () => {
  assert.ok(APP_CONNECTOR_PROVIDER_MANIFESTS.length > 0);
  for (const provider of APP_CONNECTOR_PROVIDER_MANIFESTS) {
    const snapshot = appConnectorMessageSenderSnapshot(provider.id);
    assert.deepEqual(snapshot, {
      identityId: `app:${provider.id}`,
      kind: "app",
      label: provider.name,
      name: provider.name,
      userId: "",
      email: "",
      avatarUrl: `/app-connectors/${encodeURIComponent(provider.id)}.svg`,
    });
  }
});

test("unknown providers cannot mint App message authors", () => {
  assert.throws(
    () => appConnectorMessageSenderSnapshot("not-a-provider"),
    /provider is unsupported/u,
  );
});

test("a receipt without a retained Agent caller remains context", () => {
  const receipt = channelMessage({ channelId: "ch-1", messageId: "system:command:openconnector", sequence: 9,
    from: { kind: "app", label: "OpenConnector", appId: "openconnector" }, body: "Result",
    sentAt: "2026-10-02T19:34:41.169Z", metadata: { xmatrixProvenance: "system_fact" } });
  assert.equal(agentChannelMessageDeliveryIntent(receipt, { agentName: "codex", instanceId: "instance" }), "context");
});

test("a subscribed App event queues for existing Instances without interpreting provider text", () => {
  for (const body of ["CI passed", "@auto", "@codex:3:stop", "@codex:3 /model example"]) {
    const event = channelMessage({ channelId: "ch-1", messageId: "app:event", sequence: 10,
      from: { kind: "app", label: "GitHub", appId: "github" }, body, sentAt: "2026-10-02T19:34:41.169Z" });
    const recipient = { agentName: "codex", instanceId: "instance-3", channelInstanceId: "3" };
    assert.equal(agentChannelMessageDeliveryIntent(event, recipient), "work", body);
    assert.equal(agentChannelMessageRequestsInterrupt(event, recipient), false, body);
  }
});
