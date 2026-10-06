import assert from "node:assert/strict";
import test from "node:test";

import { loadTypescriptModule } from "./load-typescript-module.mjs";

const protocol = await loadTypescriptModule(new URL("../src/relay-v2/message-attachment.ts", import.meta.url));

const hash = "a".repeat(64);

test("Authority attachment authority rejects noncanonical client-shaped object metadata", () => {
  const authority = diagramAttachment({ objectKey: `objects/${hash}`, contentHash: hash });
  assert.equal(
    protocol.parseRelayV2MessageAttachmentAuthority(authority).object.checksum,
    hash,
  );
  assert.deepEqual(
    protocol.parseRelayV2MessageAttachmentAuthority(authority).attachment,
    diagramAttachment(),
  );
  assert.throws(
    () => protocol.parseRelayV2MessageAttachmentAuthority({
      ...authority,
      objectKey: `objects/${"b".repeat(64)}`,
    }),
    (error) => error.code === "integrity_mismatch",
  );
  assert.throws(
    () => protocol.parseRelayV2MessageAttachmentAuthority({
      ...authority,
      thumbnailUrl: "https://example.test/private-thumbnail?token=secret",
    }),
    (error) => error.code === "invalid_envelope",
  );
});

function diagramAttachment(overrides = {}) {
  return { id: "attachment-1", name: "diagram.png", mimeType: "image/png", size: 12, version: 1, durationMs: 7_512, width: 1_206, height: 2_622, transcodingStatus: "future_status", ...overrides };
}
