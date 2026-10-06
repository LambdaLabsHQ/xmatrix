import assert from "node:assert/strict";
import { test } from "node:test";

import {
  RelayR2PrivateApiError,
  handleRelayV2MessageAttachmentProductMedia,
} from "../src/relay-r2-private-api.ts";

function request(channelId = "channel-1") {
  return new Request(
    "https://hub.example/api/relay-v2/message-attachments/product-media",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        channelId,
        messageId: "message-1",
        attachmentId: "attachment-1",
      }),
    },
  );
}

/**
 * Read attachment-1 of message-1 as owner-1's Agent bound to `requiredChannelId`:
 * the Authority grants it on `boundChannelId` and R2 holds its immutable PNG
 * bytes. Returns the response and the request the Authority received.
 */
async function readGrantedPng({ requested, requiredChannelId, boundChannelId, contentHash }) {
  const bytes = new Uint8Array([137, 80, 78]);
  let authorityRequest;
  const response = await handleRelayV2MessageAttachmentProductMedia({
    request: request(requested),
    userId: "owner-1",
    requiredChannelId,
    async attachmentAuthority(input) {
        authorityRequest = input;
        return Response.json({
          channelId: boundChannelId,
          messageId: "message-1",
          visibilityScopeId: "space:space-1",
          attachment: {
            id: "attachment-1",
            mimeType: "image/png",
            name: "screen.png",
            size: bytes.byteLength,
            version: 1,
          },
          object: {
            checksum: contentHash,
            contentHash,
            encodedBytes: bytes.byteLength,
            objectKey: `objects/${contentHash}`,
          },
        });
    },
    bucket: {
      async get(objectKey) {
        assert.equal(objectKey, `objects/${contentHash}`);
        return {
          body: bytes,
          size: bytes.byteLength,
          customMetadata: { sha256: contentHash },
          checksums: {},
          etag: "etag-1",
        };
      },
    },
  });
  return { response, authorityRequest, bytes };
}

test("Agent product-media read re-scopes an outside channel to the run birth Channel", async () => {
  let authorityRequest;
  await assert.rejects(
    handleRelayV2MessageAttachmentProductMedia({
      request: request("channel-other"),
      userId: "owner-1",
      requiredChannelId: "channel-1",
      // Authority sees only the birth Channel, so a message that is not readable
      // through it (thread root or otherwise) stays fail-closed.
      async attachmentAuthority(input) {
        authorityRequest = input;
        return Response.json(
          { error: "Message attachment is not available" },
          { status: 404 },
        );
      },
      bucket: {
        async get() {
          throw new Error("R2 must not be reached");
        },
      },
    }),
    (error) => {
      assert.ok(error instanceof RelayR2PrivateApiError);
      assert.equal(error.code, "not_authorized");
      assert.equal(error.status, 403);
      return true;
    },
  );
  assert.equal(authorityRequest.channelId, "channel-1");
  assert.equal(authorityRequest.messageId, "message-1");
});

test("Agent product-media read serves a thread-root attachment through the birth Channel", async () => {
  // Authority resolves the birth thread's parent-channel root message and
  // answers with a binding on the requested (birth) channel.
  const { response, authorityRequest, bytes } = await readGrantedPng({ requested: "channel-parent",
    requiredChannelId: "thread-1", boundChannelId: "thread-1", contentHash: "b".repeat(64) });

  assert.equal(authorityRequest.channelId, "thread-1");
  assert.equal(response.status, 200);
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes);
});

test("Agent product-media read uses owner ACL authority and streams immutable bytes", async () => {
  const { response, authorityRequest, bytes } = await readGrantedPng({ requiredChannelId: "channel-1",
    boundChannelId: "channel-1", contentHash: "a".repeat(64) });

  assert.deepEqual(authorityRequest, {
    channelId: "channel-1",
    messageId: "message-1",
    attachmentId: "attachment-1",
    principal: { kind: "user", id: "owner-1" },
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "image/png");
  assert.equal(response.headers.get("content-length"), String(bytes.byteLength));
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes);
});
