import { bearerJsonRequest } from "./support/bearer-json-request.mjs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import { createFileScopedHubWorker } from "./e2e-utils.mjs";
import { startPgHubWorker, inTestTransaction } from "./agent-launch-postgres.fixture.mjs";

const TOKEN = "channel-family-authority-admin-token";
const MEMBER_TOKEN = "channel-family-authority-member-token";
const EMAIL = "channel-family-authority-admin@example.com";

const workerFixture = createFileScopedHubWorker({
  vars: {
    PLATFORM_ADMIN_EMAILS: EMAIL,
    XMATRIX_MOCK_AUTH_USERS: JSON.stringify({
      [TOKEN]: {
        id: "channel-family-authority-admin",
        email: EMAIL,
        name: "Channel Family Shadow Admin",
      },
      [MEMBER_TOKEN]: {
        id: "channel-family-authority-member",
        email: "channel-family-authority-member@example.com",
        name: "Channel Family Shadow Member",
      },
    }),
  },
}, startPgHubWorker);

async function requestJson(worker, path, init = {}, token = TOKEN) {
  return bearerJsonRequest(worker, token, path, init);
}

test("every fresh Channel uses PostgreSQL authority before its first append", async () => {
  const worker = await workerFixture.get();
  const createdSpace = await requestJson(worker, "/api/spaces", {
    method: "POST",
    body: JSON.stringify({ name: "Fresh root registration" }),
  });
  assert.equal(createdSpace.response.status, 200, JSON.stringify(createdSpace.payload));
  const spaceId = createdSpace.payload.space.id;
  const originalRoot = await requestJson(worker, "/api/channels", {
    method: "POST",
    body: JSON.stringify({ spaceId, name: "existing-root", mode: "open" }),
  });
  assert.equal(originalRoot.response.status, 200, JSON.stringify(originalRoot.payload));
  const secondRoot = await requestJson(worker, "/api/channels", {
    method: "POST",
    body: JSON.stringify({ spaceId, name: "second-root", mode: "open" }),
  });
  assert.equal(secondRoot.response.status, 200, JSON.stringify(secondRoot.payload));
  for (const rootId of [originalRoot.payload.channel.id, secondRoot.payload.channel.id]) {
    const placement = await inTestTransaction(tx => tx.query({
      text: "SELECT c.space_id, p.shard_id, p.state FROM data.channels c JOIN control.space_placement p USING (space_id) WHERE c.channel_id=$1",
      values: [rootId],
    }));
    assert.equal(placement.length, 1);
    assert.equal(placement[0].space_id, spaceId);
    assert.equal(placement[0].shard_id, "shard-0");
    assert.equal(placement[0].state, "active");
    const appended = await requestJson(
      worker,
      `/api/channels/${encodeURIComponent(rootId)}/messages`,
      {
        method: "POST",
        body: JSON.stringify({ body: "first authoritative append", clientMessageId: crypto.randomUUID() }),
      },
    );
    assert.equal(appended.response.status, 200, JSON.stringify(appended.payload));
  }
});

test("PostgreSQL serves Channel message mutations, attachments and membership revocation", async () => {
  const worker = await workerFixture.get();
  const createdSpace = await requestJson(worker, "/api/spaces", {
    method: "POST",
    body: JSON.stringify({ name: "Authoritative Channel family" }),
  });
  assert.equal(createdSpace.response.status, 200, JSON.stringify(createdSpace.payload));
  const createdChannel = await requestJson(worker, "/api/channels", {
    method: "POST",
    body: JSON.stringify({
      spaceId: createdSpace.payload.space.id,
      name: "root",
      mode: "open",
    }),
  });
  assert.equal(createdChannel.response.status, 200, JSON.stringify(createdChannel.payload));
  const channelId = createdChannel.payload.channel.id;

  const baselineMessage = await requestJson(
    worker,
    `/api/channels/${encodeURIComponent(channelId)}/messages`,
    {
      method: "POST",
      body: JSON.stringify({ body: "copy me", clientMessageId: crypto.randomUUID() }),
    },
  );
  assert.equal(baselineMessage.response.status, 200, JSON.stringify(baselineMessage.payload));

  const recalledBaseline = await requestJson(
    worker,
    `/api/channels/${encodeURIComponent(channelId)}/messages`,
    {
      method: "POST",
      body: JSON.stringify({ body: "recall before copy", clientMessageId: crypto.randomUUID() }),
    },
  );
  assert.equal(recalledBaseline.response.status, 200, JSON.stringify(recalledBaseline.payload));
  const recalled = await requestJson(
    worker,
    `/api/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(recalledBaseline.payload.message.messageId)}`,
    { method: "DELETE" },
  );
  assert.equal(recalled.response.status, 200, JSON.stringify(recalled.payload));
  assert.equal(typeof recalled.payload.message.recalledAt, "string");

  const appended = await requestJson(
    worker,
    `/api/channels/${encodeURIComponent(channelId)}/messages`,
    {
      method: "POST",
      body: JSON.stringify({ body: "authoritative message", clientMessageId: crypto.randomUUID() }),
    },
  );
  assert.equal(appended.response.status, 200, JSON.stringify(appended.payload));

  const appendedAfterCopy = await requestJson(
    worker,
    `/api/channels/${encodeURIComponent(channelId)}/messages`,
    {
      method: "POST",
      body: JSON.stringify({ body: "authoritative follow-up", clientMessageId: crypto.randomUUID() }),
    },
  );
  assert.equal(
    appendedAfterCopy.response.status,
    200,
    JSON.stringify(appendedAfterCopy.payload),
  );

  const renamedAfterCopy = await requestJson(
    worker,
    `/api/channels/${encodeURIComponent(channelId)}`,
    {
      method: "PATCH",
      body: JSON.stringify({ name: "root-after-copy" }),
    },
  );
  assert.equal(renamedAfterCopy.response.status, 200, JSON.stringify(renamedAfterCopy.payload));

  const capacityChannel = await requestJson(worker, "/api/channels", {
    method: "POST",
    body: JSON.stringify({
      spaceId: createdSpace.payload.space.id,
      name: "capacity-stress",
      mode: "open",
    }),
  });
  assert.equal(capacityChannel.response.status, 200, JSON.stringify(capacityChannel.payload));
  const capacityChannelId = capacityChannel.payload.channel.id;
  for (let index = 0; index < 20; index += 1) {
    const capacityAppend = await requestJson(
      worker,
      `/api/channels/${encodeURIComponent(capacityChannelId)}/messages`,
      {
        method: "POST",
        body: JSON.stringify({
          body: `${index}:${"x".repeat(63 * 1024)}`,
          clientMessageId: crypto.randomUUID(),
        }),
      },
    );
    assert.equal(capacityAppend.response.status, 200, JSON.stringify(capacityAppend.payload));
  }
  const growthHistory = await requestJson(worker,
    `/api/channels/${encodeURIComponent(capacityChannelId)}/history?limit=50`);
  assert.equal(growthHistory.response.status, 200, JSON.stringify(growthHistory.payload));
  assert.equal(growthHistory.payload.messages.length, 20);
  assert.equal(new Set(growthHistory.payload.messages.map(message => message.sequence)).size, 20);

  const attachmentBytes = Buffer.from("channel-family-attachment");
  const attachmentHash = createHash("sha256").update(attachmentBytes).digest("hex");
  const attachmentMessageId = crypto.randomUUID();
  const attachmentId = crypto.randomUUID();
  const admitted = await requestJson(worker, "/api/relay-v2/private-r2/upload-intents", {
    method: "POST",
    body: JSON.stringify({
      requestId: `request-${crypto.randomUUID()}`,
      intentId: `intent-${crypto.randomUUID()}`,
      visibilityScopeId: `space:${createdSpace.payload.space.id}`,
      contentHash: attachmentHash,
      encodedSize: attachmentBytes.length,
      expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
    }),
  });
  assert.equal(admitted.response.status, 200, JSON.stringify(admitted.payload));
  const uploaded = await worker.fetch(admitted.payload.upload.finalPath, {
    method: "PUT",
    headers: {
      authorization: `Bearer ${TOKEN}`,
      "content-type": "application/octet-stream",
      "content-length": String(attachmentBytes.length),
      "x-xmatrix-content-sha256": attachmentHash,
    },
    body: attachmentBytes,
  });
  assert.equal(uploaded.status, 200, await uploaded.text());
  const bound = await requestJson(worker, "/api/relay-v2/private-r2/blob-refs", {
    method: "POST",
    body: JSON.stringify({
      requestId: `ref-${crypto.randomUUID()}`,
      intentId: admitted.payload.intentId,
      refId: attachmentId,
      ownerKind: "message_attachment",
      ownerId: attachmentMessageId,
      visibilityScopeId: `space:${createdSpace.payload.space.id}`,
    }),
  });
  assert.equal(bound.response.status, 200, JSON.stringify(bound.payload));
  const attachedMessage = await requestJson(
    worker,
    `/api/channels/${encodeURIComponent(channelId)}/messages`,
    {
      method: "POST",
      body: JSON.stringify({
        body: "direct attachment",
        clientMessageId: attachmentMessageId,
        attachments: [{
          attachmentId,
          objectKey: `objects/${attachmentHash}`,
          contentHash: attachmentHash,
          encodedBytes: attachmentBytes.length,
          mimeType: "application/octet-stream",
          name: "family.bin",
        }],
      }),
    },
  );
  assert.equal(attachedMessage.response.status, 200, JSON.stringify(attachedMessage.payload));
  assert.equal(attachedMessage.payload.message.attachments[0].name, "family.bin");
  const parentMedia = await worker.fetch(
    "/api/relay-v2/message-attachments/product-media",
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ channelId, messageId: attachmentMessageId, attachmentId }),
    },
  );
  assert.equal(parentMedia.status, 200, await parentMedia.clone().text());
  assert.deepEqual(Buffer.from(await parentMedia.arrayBuffer()), attachmentBytes);

  const directMessageId = crypto.randomUUID();
  const direct = await requestJson(
    worker,
    `/api/channels/${encodeURIComponent(channelId)}/messages`,
    {
      method: "POST",
      body: JSON.stringify({ body: "direct authority", clientMessageId: directMessageId }),
    },
  );
  assert.equal(direct.response.status, 200, JSON.stringify(direct.payload));
  assert.equal(direct.payload.message.messageId, directMessageId);

  let projectedCatalog;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    projectedCatalog = await requestJson(
      worker,
      `/api/channels/page?spaceId=${encodeURIComponent(createdSpace.payload.space.id)}&view=flat&filter=all`,
    );
    const projected = projectedCatalog.payload.rows?.map(row => row.channel)?.find((entry) => entry.id === channelId);
    if (projected?.lastMessage?.messageId === directMessageId) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(projectedCatalog.response.status, 200, JSON.stringify(projectedCatalog.payload));
  const projectedChannel = projectedCatalog.payload.rows?.map(row => row.channel).find((entry) => entry.id === channelId);
  assert.ok(projectedChannel.lastMessage, JSON.stringify(projectedCatalog.payload));
  assert.equal(projectedChannel.lastMessage.messageId, directMessageId);
  assert.equal(projectedChannel.lastMessage.bodyPreview, "direct authority");
  assert.equal(projectedChannel.historyHeadSequence, direct.payload.message.sequence);

  const edited = await requestJson(
    worker,
    `/api/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(directMessageId)}`,
    { method: "PATCH", body: JSON.stringify({ body: "edited direct authority" }) },
  );
  assert.equal(edited.response.status, 200, JSON.stringify(edited.payload));

  let editedCatalog;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    editedCatalog = await requestJson(
      worker,
      `/api/channels/page?spaceId=${encodeURIComponent(createdSpace.payload.space.id)}&view=flat&filter=all`,
    );
    const projected = editedCatalog.payload.rows?.map(row => row.channel)?.find((entry) => entry.id === channelId);
    if (projected?.lastMessage?.bodyPreview === "edited direct authority") break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const editedProjectedChannel = editedCatalog.payload.rows?.map(row => row.channel).find((entry) => entry.id === channelId);
  assert.equal(editedProjectedChannel.lastMessage.bodyPreview, "edited direct authority");
  const editedHistory = await requestJson(
    worker,
    `/api/channels/${encodeURIComponent(channelId)}/history?limit=20`,
  );
  assert.equal(
    editedProjectedChannel.contentAuthority.contentRevision,
    editedHistory.payload.contentAuthority.contentRevision,
  );
  const resolvedCatalog = await requestJson(worker, "/api/channels/resolve", {
    method: "POST",
    body: JSON.stringify({ spaceId: createdSpace.payload.space.id, channelIds: [channelId] }),
  });
  assert.equal(resolvedCatalog.response.status, 200, JSON.stringify(resolvedCatalog.payload));
  assert.equal(resolvedCatalog.payload.channels[0].contentAuthority.contentRevision,
    editedHistory.payload.contentAuthority.contentRevision);

  const reacted = await requestJson(
    worker,
    `/api/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(directMessageId)}/reactions`,
    { method: "POST", body: JSON.stringify({ emoji: "✅" }) },
  );
  assert.equal(reacted.response.status, 200, JSON.stringify(reacted.payload));

  const annotationId = crypto.randomUUID();
  const annotated = await requestJson(
    worker,
    `/api/channels/${encodeURIComponent(channelId)}/annotations`,
    {
      method: "POST",
      body: JSON.stringify({
        id: annotationId,
        namespace: "test.channel-family",
        target: { kind: "message", messageId: directMessageId },
        payload: { migrated: true },
      }),
    },
  );
  assert.equal(annotated.response.status, 201, JSON.stringify(annotated.payload));

  const listedAnnotations = await requestJson(
    worker,
    `/api/channels/${encodeURIComponent(channelId)}/annotations?messageId=${encodeURIComponent(directMessageId)}`,
  );
  assert.equal(listedAnnotations.response.status, 200, JSON.stringify(listedAnnotations.payload));
  assert.deepEqual(listedAnnotations.payload.annotations.map((entry) => entry.id), [annotationId]);

  const acknowledged = await requestJson(
    worker,
    `/api/channels/${encodeURIComponent(channelId)}/read`,
    { method: "POST", body: JSON.stringify({ sequence: direct.payload.message.sequence }) },
  );
  assert.equal(acknowledged.response.status, 200, JSON.stringify(acknowledged.payload));
  assert.equal(acknowledged.payload.readSequence, direct.payload.message.sequence);

  const history = await requestJson(
    worker,
    `/api/channels/${encodeURIComponent(channelId)}/history?limit=20`,
  );
  assert.equal(history.response.status, 200, JSON.stringify(history.payload));
  assert.deepEqual(
    history.payload.messages.map((entry) => entry.body),
    ["copy me", "", "authoritative message", "authoritative follow-up", "direct attachment", "edited direct authority"],
  );
  assert.equal(
    history.payload.messages.find((entry) => entry.messageId === recalledBaseline.payload.message.messageId).recalledAt,
    recalled.payload.message.recalledAt,
  );
  assert.equal(
    history.payload.messages.find((entry) => entry.messageId === attachmentMessageId).attachments[0].name,
    "family.bin",
  );
  const directHistory = history.payload.messages.at(-1);
  assert.equal(directHistory.reactions[0].emoji, "✅");
  assert.equal(directHistory.annotations[0].id, annotationId);
  assert.equal(history.payload.principalAckedSequence, direct.payload.message.sequence);

  const addedMember = await requestJson(
    worker,
    `/api/spaces/${encodeURIComponent(createdSpace.payload.space.id)}/members`,
    {
      method: "POST",
      body: JSON.stringify({ userId: "channel-family-authority-member", role: "member" }),
    },
  );
  assert.equal(addedMember.response.status, 200, JSON.stringify(addedMember.payload));

  const memberMessage = await requestJson(
    worker,
    `/api/channels/${encodeURIComponent(channelId)}/messages`,
    {
      method: "POST",
      body: JSON.stringify({ body: "authorized after epoch sync", clientMessageId: crypto.randomUUID() }),
    },
    MEMBER_TOKEN,
  );
  assert.equal(memberMessage.response.status, 200, JSON.stringify(memberMessage.payload));

  const removedMember = await requestJson(
    worker,
    `/api/spaces/${encodeURIComponent(createdSpace.payload.space.id)}/members/channel-family-authority-member`,
    { method: "DELETE" },
  );
  assert.equal(removedMember.response.status, 200, JSON.stringify(removedMember.payload));

  const revokedWrite = await requestJson(
    worker,
    `/api/channels/${encodeURIComponent(channelId)}/messages`,
    {
      method: "POST",
      body: JSON.stringify({ body: "must be rejected", clientMessageId: crypto.randomUUID() }),
    },
    MEMBER_TOKEN,
  );
  assert.equal(revokedWrite.response.status, 404, JSON.stringify(revokedWrite.payload));
  assert.equal(revokedWrite.payload.code, "channel_not_found");

});
