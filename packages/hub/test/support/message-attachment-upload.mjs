import { prepareFreshCodexRun } from "../e2e-utils.mjs";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

/** Upload bytes using the admission receipt's exact private storage path. */
export async function uploadAdmittedTestBlob(worker, token, upload, file, contentHash, mimeType) {
  const response = await worker.fetch(upload.finalPath, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token}`,
      "content-type": mimeType,
      "content-length": String(file.length),
      "x-xmatrix-content-sha256": contentHash,
    },
    body: file,
  });
  assert.equal(response.status, 200, await response.text());
}

export async function bindTestMessageAttachment(worker, headers, {
  intentId, attachmentId, clientMessageId, channelId,
}) {
  const response = await worker.fetch("/api/relay-v2/private-r2/blob-refs", {
    method: "POST",
    headers,
    body: JSON.stringify({
      requestId: `ref-${randomUUID()}`,
      intentId,
      refId: attachmentId,
      ownerKind: "message_attachment",
      ownerId: clientMessageId,
      visibilityScopeId: `channel:${channelId}`,
    }),
  });
  assert.equal(response.status, 200, await response.text());
}

/** A real registered Run with its birth Channel and bearer-scoped attachment requests. */
export async function prepareAttachmentAgentRun(worker, name, token, metadata) {
  const prepared = await prepareFreshCodexRun(worker, name, token, metadata);
  return { prepared, channelId: prepared.body.metadata.autoJoinChannelId,
    agentHeaders: { Authorization: `Bearer ${prepared.token}`, "content-type": "application/json" } };
}

export async function admitTestAttachment(worker, headers, intent) {
  const response = await worker.fetch("/api/relay-v2/private-r2/upload-intents", {
    method: "POST", headers, body: JSON.stringify(intent),
  });
  const payload = await response.json();
  assert.equal(response.status, 200, JSON.stringify(payload));
  return payload;
}

/** Fresh identifiers bound to the already-admitted intent, in the same allocation order. */
export async function bindFreshTestMessageAttachment(worker, headers, { intentId, channelId }) {
  const clientMessageId = randomUUID();
  const attachmentId = randomUUID();
  await bindTestMessageAttachment(worker, headers, { intentId, attachmentId, clientMessageId, channelId });
  return { clientMessageId, attachmentId };
}
