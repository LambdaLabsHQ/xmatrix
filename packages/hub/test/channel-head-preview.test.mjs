import assert from "node:assert/strict";
import test from "node:test";

import { channelHeadPreview } from "../src/channel-head-preview.ts";

const head = {
  messageId: "m-1", sequence: 7, authorKind: "agent", authorId: "agent-1",
  sentAt: "2026-10-05T00:00:00.000Z", recalledAt: null,
};

test("a stored preview is shown as is, without a payload to decode", () => {
  const preview = channelHeadPreview({ ...head, payloadBundleBase64: null, legacyBody: null,
    preview: { bodyPreview: "Done: merged the fix", senderSnapshot: { label: "Codex", agentName: "Codex" } } });
  assert.equal(preview.bodyPreview, "Done: merged the fix");
  assert.equal(preview.from.label, "Codex");
  assert.equal(preview.from.identityId, "agent:agent-1");
});

test("a message from before previews still shows its legacy body; a recalled one says so", () => {
  const legacy = channelHeadPreview({ ...head, preview: null, payloadBundleBase64: null,
    legacyBody: "  an   older\n message " });
  assert.equal(legacy.bodyPreview, "an older message");
  assert.equal(legacy.from.label, "agent-1");
  const recalled = channelHeadPreview({ ...head, recalledAt: "2026-10-05T00:01:00.000Z", preview: null,
    payloadBundleBase64: null, legacyBody: null });
  assert.equal(recalled.bodyPreview, "Message recalled");
});
