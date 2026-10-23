import assert from "node:assert/strict";
import test from "node:test";

import { channelHeadPreview } from "../src/channel-head-preview.ts";
import { pageConversation } from "../src/page-conversations.ts";

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

test("a discussion's first message previews as what was written, not the passage it quotes", () => {
  const preview = channelHeadPreview({ ...head, preview: null, payloadBundleBase64: null,
    legacyBody: "> In progress\n\n— [Relay › Status](https://xmatrix.sh/app/s/pages?page=p#status)\n\nIs this still\n accurate?" });
  assert.equal(preview.bodyPreview, "Is this still accurate?");
});

test("a page's conversation preview names who wrote it by the ids its message carried, which give its face", () => {
  const conversation = { conversationId: "c-1", name: "Upkeep", activityAt: head.sentAt, headSequence: 7,
    readSequence: 7, agents: [] };
  const registration = { ownerUserId: "owner-1", machineId: "machine-1", harness: "grok" };
  const agent = pageConversation({ ...conversation, head: { ...head, payloadBundleBase64: null, legacyBody: null,
    preview: { bodyPreview: "Done", senderSnapshot: { label: "grok:1", agentName: "grok", instanceId: "c-1:1",
      registration, avatarUrl: "/agent-vendors/grok.svg" } } } });
  assert.deepEqual(agent.lastMessage.from, { kind: "agent", label: "grok:1", userId: "", identityId: "agent:agent-1",
    instanceId: "c-1:1", registration, avatarUrl: "/agent-vendors/grok.svg" });
  const person = pageConversation({ ...conversation, head: { ...head, authorKind: "user", authorId: "u-1",
    payloadBundleBase64: null, legacyBody: "hi", preview: null } });
  assert.deepEqual(person.lastMessage.from, { kind: "user", label: "u-1", userId: "u-1", identityId: "user:u-1" });
});
