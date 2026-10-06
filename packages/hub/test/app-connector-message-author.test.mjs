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

test("a connector receipt is a system fact: context for every Instance, never a turn", async () => {

  // An Agent's connector tool call already has its answer in the tool result;
  // a receipt delivered as work cancelled the very turn waiting on that call.

  // One receipt writer: no adapter appends its own status message.
  const receipt = channelMessage({
    channelId: "ch-1", messageId: "system:mcp:ch-1:run:id:openconnector", sequence: 9,
    from: { kind: "app", label: "OpenConnector", appId: "openconnector" },
    body: "App connector command status:\n- OpenConnector search: blocked.",
    sentAt: "2026-10-02T19:34:41.169Z", metadata: { xmatrixProvenance: "system_fact" },
  });
  const caller = { agentName: "claude", channelInstanceId: "3" };
  assert.equal(agentChannelMessageDeliveryIntent(receipt, caller), "context");
  assert.equal(agentChannelMessageRequestsInterrupt(receipt, caller), false);
});
