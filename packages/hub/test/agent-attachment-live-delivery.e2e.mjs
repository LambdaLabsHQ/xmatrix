import { uploadAdmittedTestBlob, bindFreshTestMessageAttachment, prepareAttachmentAgentRun, admitTestAttachment } from "./support/message-attachment-upload.mjs";
import { websocketInbox as inboxOf } from "./support/websocket-inbox.mjs";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { test } from "node:test";

import {
  humanWsUrl,
  openWebSocket,
} from "./e2e-utils.mjs";
import { startMockUserHubWorker } from "./agent-launch-postgres.fixture.mjs";

/* An Agent's screenshot has to arrive the moment it is sent, exactly like a
   Human's. The Hub used to strip attachments out of an Agent's append and bind
   them in a second command afterwards, so the frame pushed at commit carried
   none: the image existed on the Hub, was downloadable, showed up in history —
   and never appeared in the reader's client, because nothing ever told the
   client it was there. This drives the real socket rather than the frame
   builder, since the drop happened before the builder was ever called. */

const MOCK_TOKEN = "agent-attachment-live-delivery-token";
const PERMISSION = "channel.attachments.write";


test("an Agent's attachment reaches a live Human socket with the message that carries it", async () => {
  const userId = `agent-attachment-live-${randomUUID()}`;
  const worker = await startMockUserHubWorker({ id: userId, email: "agent-attachment-live@example.com", name: "Agent Attachment Live", token: MOCK_TOKEN });
  let human;
  try {
    const { prepared, channelId, agentHeaders } = await prepareAttachmentAgentRun(worker, `attachment-agent-${randomUUID()}`, MOCK_TOKEN, { agentRunPermissions: [PERMISSION] });

    const file = Buffer.from("screenshot-bytes");
    const contentHash = createHash("sha256").update(file).digest("hex");
    const admittedPayload = await admitTestAttachment(worker, agentHeaders, {
      requestId: `request-${randomUUID()}`, intentId: `intent-${randomUUID()}`,
      visibilityScopeId: `channel:${channelId}`, contentHash, encodedSize: file.length,
      expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
    });

    await uploadAdmittedTestBlob(worker, prepared.token, admittedPayload.upload, file, contentHash, "image/png");

    const { clientMessageId, attachmentId } = await bindFreshTestMessageAttachment(worker, agentHeaders, {
      intentId: admittedPayload.intentId, channelId,
    });

    const ws = await openWebSocket(humanWsUrl(worker));
    human = ws;
    const inbox = inboxOf(ws);
    ws.send(JSON.stringify({
      type: "human_connect",
      token: MOCK_TOKEN,
      device: { client: "desktop", version: "0.16.160", protocolVersion: 2 },
    }));
    await inbox.waitFor((message) => message.type === "human_connected", "human_connected");

    const sent = await worker.fetch(
      `/api/channels/${encodeURIComponent(channelId)}/messages`,
      {
        method: "POST",
        headers: agentHeaders,
        body: JSON.stringify({
          body: "here is the screenshot",
          clientMessageId,
          attachments: [{
            attachmentId,
            objectKey: `objects/${contentHash}`,
            contentHash,
            encodedBytes: file.length,
            mimeType: "image/png",
            name: "thread-lines.png",
          }],
        }),
      },
    );
    const sentPayload = await sent.json();
    assert.equal(sent.status, 200, JSON.stringify(sentPayload));
    assert.equal(sentPayload.message.attachments?.[0]?.name, "thread-lines.png");

    const live = await inbox.waitFor(
      (message) => message.type === "channel_message_received" &&
        message.message?.messageId === clientMessageId,
      "channel_message_received",
    );
    assert.equal(live.message.attachments?.length, 1);
    assert.equal(live.message.attachments[0].name, "thread-lines.png");
    assert.equal(live.message.attachments[0].mimeType, "image/png");
  } finally {
    human?.close();
    await worker.stop();
  }
});
