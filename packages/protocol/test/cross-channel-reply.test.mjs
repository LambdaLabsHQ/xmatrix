import assert from "node:assert/strict";
import { test } from "node:test";

import { loadTypescriptModule } from "./load-typescript-module.mjs";
import { sourceOffenders } from "./repository-sources.mjs";

const {
  crossChannelReplyMetadata,
  crossChannelReplyRelay,
} = await loadTypescriptModule(new URL("../src/cross-channel-reply.ts", import.meta.url));

test("a relayed cross-Channel reply reads back what the Hub wrote", () => {
  const relay = {
    sourceChannelId: "c2", sourceMessageId: "r1", linkMessageId: "l1",
    replierKind: "agent", replierAgentId: "c1:6", replierInstanceId: "c1:6",
  };
  assert.deepEqual(crossChannelReplyRelay(crossChannelReplyMetadata(relay)), relay);
  assert.deepEqual(
    crossChannelReplyRelay(crossChannelReplyMetadata({ sourceChannelId: " c2 ", replierKind: "user" })),
    { sourceChannelId: "c2", replierKind: "user" },
  );
});

test("only an Agent replier names an Instance, and only a relay is read", () => {
  const metadata = (relay) => ({ xmatrixProvenance: "cross_channel_reply", crossChannelReply: relay });
  assert.equal(
    crossChannelReplyRelay(metadata({ sourceChannelId: "c2", replierKind: "user", replierInstanceId: "i1" }))
      .replierInstanceId,
    undefined,
  );
  assert.equal(crossChannelReplyRelay(metadata({ replierKind: "agent", replierInstanceId: "i1" })), undefined);
  assert.equal(crossChannelReplyRelay({ crossChannelReply: { sourceChannelId: "c2" } }), undefined);
  assert.equal(crossChannelReplyRelay(undefined), undefined);
});

test("no package reads or writes the relay metadata by hand", () => {
  const offenders = sourceOffenders(["packages/db/src/", "packages/hub/src/", "apps/web/src/"],
    (source) => source.includes('"cross_channel_reply"'));
  assert.deepEqual(offenders, [], "use crossChannelReplyMetadata / crossChannelReplyRelay from @xmatrix/protocol");
});
