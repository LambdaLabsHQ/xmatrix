import { uploadAdmittedTestBlob, bindFreshTestMessageAttachment, prepareAttachmentAgentRun, admitTestAttachment } from "./support/message-attachment-upload.mjs";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { test } from "node:test";

import {
  prepareFreshCodexRun,
} from "./e2e-utils.mjs";
import { startMockUserHubWorker } from "./agent-launch-postgres.fixture.mjs";

const MOCK_TOKEN = "persistent-agent-run-permissions-token";
const PERMISSION = "channel.attachments.write";

function tokenPermissions(token) {
  const [, payload] = token.split(".");
  return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"))
    .xmatrixAgentRun.permissions;
}

function intentBody(channelId, contentHash = "a".repeat(64), encodedSize = 12, visibilityScopeId = `channel:${channelId}`) {
  return {
    requestId: `request-${randomUUID()}`,
    intentId: `intent-${randomUUID()}`,
    visibilityScopeId,
    contentHash,
    encodedSize,
    expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
  };
}

test("a registered Run uploads into any Channel it may write to, and only there", async () => {
  const userId = `persistent-agent-permission-${randomUUID()}`;
  const worker = await startMockUserHubWorker({ id: userId, email: "persistent-agent-permission@example.com", name: "Persistent Agent Permission", token: MOCK_TOKEN });
  try {
    const { prepared, channelId, agentHeaders } = await prepareAttachmentAgentRun(worker, `permission-agent-${randomUUID()}`, MOCK_TOKEN);

    assert.deepEqual(tokenPermissions(prepared.token), [PERMISSION]);

    const wrongScope = await worker.fetch("/api/relay-v2/private-r2/upload-intents", {
      method: "POST",
      headers: agentHeaders,
      body: JSON.stringify(intentBody("another-channel")),
    });
    assert.equal(wrongScope.status, 403);

    const file = Buffer.from("# Deployment guide\n");
    const contentHash = createHash("sha256").update(file).digest("hex");
    const admittedPayload = await admitTestAttachment(worker, agentHeaders, intentBody(channelId, contentHash, file.length));

    await uploadAdmittedTestBlob(worker, prepared.token, admittedPayload.upload, file, contentHash, "text/markdown");

    const { clientMessageId, attachmentId } = await bindFreshTestMessageAttachment(worker, agentHeaders, {
      intentId: admittedPayload.intentId, channelId,
    });

    const message = await worker.fetch(
      `/api/channels/${encodeURIComponent(channelId)}/messages`,
      {
        method: "POST",
        headers: agentHeaders,
        body: JSON.stringify({
          body: "Deployment guide",
          clientMessageId,
          attachments: [{
            attachmentId,
            objectKey: `objects/${contentHash}`,
            contentHash,
            encodedBytes: file.length,
            mimeType: "text/markdown",
            name: "deployment-guide.md",
          }],
        }),
      },
    );
    const messagePayload = await message.json();
    assert.equal(message.status, 200, JSON.stringify(messagePayload));
    assert.equal(messagePayload.message.attachments?.[0]?.name, "deployment-guide.md");

    const history = await worker.fetch(
      `/api/channels/${encodeURIComponent(channelId)}/history?limit=10`,
      { headers: { Authorization: `Bearer ${prepared.token}` } },
    );
    const historyPayload = await history.json();
    assert.equal(history.status, 200, JSON.stringify(historyPayload));
    const committedMessage = historyPayload.messages.find(
      (candidate) => candidate.messageId === clientMessageId,
    );
    assert.equal(committedMessage?.attachments?.[0]?.name, "deployment-guide.md");
    assert.equal(committedMessage?.attachments?.[0]?.mimeType, "text/markdown");

    // An open Channel of its Space shares the Space scope: the Run attaches files there too.
    const ownerHeaders = { Authorization: `Bearer ${MOCK_TOKEN}`, "content-type": "application/json" };
    const catalog = await (await worker.fetch("/api/channels", { headers: ownerHeaders })).json();
    const spaceId = catalog.channels.find((channel) => channel.id === channelId).spaceId;
    const openResponse = await worker.fetch("/api/channels", { method: "POST", headers: ownerHeaders,
      body: JSON.stringify({ spaceId, mode: "open", name: `Open uploads ${randomUUID()}` }) });
    const openChannelId = (await openResponse.json()).channel.id;
    const openFile = Buffer.from("# Open notes\n");
    const openHash = createHash("sha256").update(openFile).digest("hex");
    const openIntent = await worker.fetch("/api/relay-v2/private-r2/upload-intents", { method: "POST",
      headers: agentHeaders, body: JSON.stringify(intentBody(openChannelId, openHash, openFile.length, `space:${spaceId}`)) });
    const openIntentPayload = await openIntent.json();
    assert.equal(openIntent.status, 200, JSON.stringify(openIntentPayload));
    const openUploaded = await worker.fetch(openIntentPayload.upload.finalPath, { method: "PUT",
      headers: { Authorization: `Bearer ${prepared.token}`, "content-type": "text/markdown",
        "content-length": String(openFile.length), "x-xmatrix-content-sha256": openHash },
      body: openFile });
    assert.equal(openUploaded.status, 200, await openUploaded.text());
    const openMessageId = randomUUID();
    const openAttachmentId = randomUUID();
    const openRef = await worker.fetch("/api/relay-v2/private-r2/blob-refs", { method: "POST", headers: agentHeaders,
      body: JSON.stringify({ requestId: `ref-${randomUUID()}`, intentId: openIntentPayload.intentId, refId: openAttachmentId,
        ownerKind: "message_attachment", ownerId: openMessageId, visibilityScopeId: `space:${spaceId}` }) });
    assert.equal(openRef.status, 200, await openRef.text());
    const openMessage = await worker.fetch(`/api/channels/${encodeURIComponent(openChannelId)}/messages`, {
      method: "POST", headers: agentHeaders, body: JSON.stringify({ body: "Open notes", clientMessageId: openMessageId,
        attachments: [{ attachmentId: openAttachmentId, objectKey: `objects/${openHash}`, contentHash: openHash,
          encodedBytes: openFile.length, mimeType: "text/markdown", name: "open-notes.md" }] }) });
    const openMessagePayload = await openMessage.json();
    assert.equal(openMessage.status, 200, JSON.stringify(openMessagePayload));
    assert.equal(openMessagePayload.message.attachments?.[0]?.name, "open-notes.md");

    // The owner's Machines are readable with the Run's token, as the owner reads them.
    const machines = await worker.fetch("/api/machine-daemons", { headers: agentHeaders });
    assert.equal(machines.status, 200, await machines.clone().text());
    assert.ok(Array.isArray((await machines.json()).daemons));

  } finally {
    await worker.stop();
  }
});

test("an Agent Run reads open Channels across its Space and writes where it and its owner have access", async () => {
  const userId = `agent-open-channel-history-${randomUUID()}`;
  const worker = await startMockUserHubWorker({ id: userId, email: "agent-open-channel-history@example.com", name: "Agent Open Channel History", token: MOCK_TOKEN });
  try {
    const prepared = await prepareFreshCodexRun(worker, `open-history-agent-${randomUUID()}`, MOCK_TOKEN);
    const birthChannelId = prepared.body.metadata.autoJoinChannelId;
    const ownerHeaders = {
      Authorization: `Bearer ${MOCK_TOKEN}`,
      "content-type": "application/json",
    };
    const ownerCatalogResponse = await worker.fetch("/api/channels", {
      headers: ownerHeaders,
    });
    const ownerCatalog = await ownerCatalogResponse.json();
    assert.equal(ownerCatalogResponse.status, 200, JSON.stringify(ownerCatalog));
    const birthChannel = ownerCatalog.channels.find((channel) => channel.id === birthChannelId);
    assert.ok(birthChannel, "the Agent birth Channel must be in the owner catalog");

    const createOpenResponse = await worker.fetch("/api/channels", {
      method: "POST",
      headers: ownerHeaders,
      body: JSON.stringify({
        spaceId: birthChannel.spaceId,
        mode: "open",
        name: `Open history ${randomUUID()}`,
      }),
    });
    const createOpen = await createOpenResponse.json();
    assert.equal(createOpenResponse.status, 200, JSON.stringify(createOpen));
    const openChannelId = createOpen.channel.id;

    const messageId = randomUUID();
    const appendResponse = await worker.fetch(
      `/api/channels/${encodeURIComponent(openChannelId)}/messages`,
      {
        method: "POST",
        headers: ownerHeaders,
        body: JSON.stringify({ body: "readable public history", clientMessageId: messageId }),
      },
    );
    assert.equal(appendResponse.status, 200, await appendResponse.text());

    const agentHeaders = {
      Authorization: `Bearer ${prepared.token}`,
      "content-type": "application/json",
    };
    const agentCatalogResponse = await worker.fetch("/api/channels", {
      headers: agentHeaders,
    });
    const agentCatalog = await agentCatalogResponse.json();
    assert.equal(agentCatalogResponse.status, 200, JSON.stringify(agentCatalog));
    assert.ok(
      agentCatalog.channels.some((channel) => channel.id === openChannelId),
      "the Agent catalog must include open Channels in its Space",
    );

    const historyResponse = await worker.fetch(
      `/api/channels/${encodeURIComponent(openChannelId)}/history?limit=10`,
      { headers: agentHeaders },
    );
    const history = await historyResponse.json();
    assert.equal(historyResponse.status, 200, JSON.stringify(history));
    assert.ok(history.messages.some((message) => message.messageId === messageId));

    const writeResponse = await worker.fetch(
      `/api/channels/${encodeURIComponent(openChannelId)}/messages`,
      {
        method: "POST",
        headers: agentHeaders,
        body: JSON.stringify({
          body: "collaborates in an open Channel of its Space",
          clientMessageId: randomUUID(),
        }),
      },
    );
    assert.equal(writeResponse.status, 200, await writeResponse.text());

    const otherSpaceResponse = await worker.fetch("/api/spaces", {
      method: "POST",
      headers: ownerHeaders,
      body: JSON.stringify({ name: `Other space ${randomUUID()}` }),
    });
    const otherSpace = await otherSpaceResponse.json();
    assert.equal(otherSpaceResponse.status, 200, JSON.stringify(otherSpace));
    const otherOpenResponse = await worker.fetch("/api/channels", {
      method: "POST",
      headers: ownerHeaders,
      body: JSON.stringify({
        spaceId: otherSpace.space.id,
        mode: "open",
        name: `Other public ${randomUUID()}`,
      }),
    });
    const otherOpen = await otherOpenResponse.json();
    assert.equal(otherOpenResponse.status, 200, JSON.stringify(otherOpen));

    const otherHistoryResponse = await worker.fetch(
      `/api/channels/${encodeURIComponent(otherOpen.channel.id)}/history?limit=10`,
      { headers: agentHeaders },
    );
    assert.equal(otherHistoryResponse.status, 403, await otherHistoryResponse.text());
  } finally {
    await worker.stop();
  }
});
