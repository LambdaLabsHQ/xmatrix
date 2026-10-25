import assert from "node:assert/strict";
import { test } from "node:test";

import { renderAgentTurnMessage } from "../src/agent-turn-message.ts";

const AT = "2026-10-25T22:00:00.000Z";
const base = { messageId: "m1", channelId: "c1", sentAt: AT, body: "  hello  ", from: { kind: "user", label: "Ann" } };

test("a message reads as the runtime has always written it", () => {
  assert.equal(renderAgentTurnMessage(base, {}, AT),
    "xMatrix channel c1 messageId=m1 deliveredAt=2026-10-25T22:00:00.000Z from Ann [user]:hello");
});

test("a reply names its parent and says when it answers this reader", () => {
  const reply = { ...base, replyToMessageId: "p1", replyTo: { messageId: "p1", sentAt: AT,
    bodyPreview: " see data:image/png;base64,AAAA ", from: { kind: "agent", label: "claude:2", identityId: "agent-1" } } };
  assert.equal(renderAgentTurnMessage(reply, { agentId: "agent-1" }, AT),
    "xMatrix channel c1 messageId=m1 replyToMessageId=p1 deliveredAt=2026-10-25T22:00:00.000Z from Ann [user]:\n" +
    "Reply context: Ann replied to your message [claude:2] messageId=p1 preview=\"see [data URL redacted: 26 chars]\"\nhello");
  assert.match(renderAgentTurnMessage(reply, { agentId: "someone-else" }, AT), /Ann replied to \[claude:2\]/);
});

test("attachments, a linked sender and a relayed cross-Channel reply keep their header", () => {
  const files = { ...base, body: "", attachments: [
    { id: "a", kind: "image", name: "shot.png", mimeType: "image/png", size: 9, url: "https://x/a" },
    { id: "b", kind: "", name: "notes.md", mimeType: "text/markdown", size: 3 }] };
  assert.match(renderAgentTurnMessage(files, {}, AT),
    /:Attachments:\n- image shot\.png at https:\/\/x\/a \(9 bytes, image\/png\)\n- file notes\.md \(3 bytes, text\/markdown\)$/);
  const linked = { ...base, from: { kind: "agent", label: "codex:1", originChannelId: "c9" } };
  assert.match(renderAgentTurnMessage(linked, {}, AT), / from codex:1 \[agent\] via Channel c9:hello$/);
  const relayed = { ...base, metadata: { xmatrixProvenance: "cross_channel_reply",
    crossChannelReply: { sourceChannelId: "c7", sourceMessageId: "q1", replierKind: "agent" } } };
  assert.match(renderAgentTurnMessage(relayed, {}, AT), / from Ann \[agent\] replying in Channel c7 to a cross-Channel request from this Channel \(answer there with `xmatrix send c7 --reply-to q1`\):hello$/);
});
