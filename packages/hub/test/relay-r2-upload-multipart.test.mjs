import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { test } from "node:test";

import { immutableContentObjectKey, ResumableSha256 } from "@xmatrix/protocol";
import {
  completeRelayR2Multipart,
  startRelayR2Multipart,
  uploadRelayR2MultipartPart,
} from "../src/relay-r2-upload-gateway.ts";

const PART = 128;
const SCOPE = "space:space-1";
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/**
 * R2's multipart semantics as the gateway relies on them: parts are invisible
 * until `complete`, a later upload of a part number replaces it, and
 * `complete` takes only the ETags R2 holds.
 */
function memoryBucket() {
  const objects = new Map();
  const uploads = new Map();
  let next = 0;
  const metadata = (object) => ({
    size: object.bytes.byteLength,
    checksumSha256: object.customMetadata["xmatrix-content-hash"],
    etag: object.etag,
    customMetadata: object.customMetadata,
  });
  return {
    objects,
    uploads,
    async head(key) {
      const object = objects.get(key);
      return object ? metadata(object) : null;
    },
    async createMultipart(key, customMetadata) {
      const uploadId = `upload-${++next}`;
      uploads.set(uploadId, { key, customMetadata: { ...customMetadata }, parts: new Map() });
      return uploadId;
    },
    async uploadPart(key, uploadId, partNumber, body, length) {
      const upload = uploads.get(uploadId);
      assert.equal(upload?.key, key);
      const bytes = new Uint8Array(await new Response(body).arrayBuffer());
      assert.equal(bytes.byteLength, length, "R2 takes a part of exactly its declared length");
      const etag = createHash("md5").update(bytes).digest("hex");
      upload.parts.set(partNumber, { etag, bytes });
      return etag;
    },
    async completeMultipart(key, uploadId, etags) {
      const upload = uploads.get(uploadId);
      assert.equal(upload?.key, key);
      const parts = etags.map((etag, index) => {
        const part = upload.parts.get(index + 1);
        if (part?.etag !== etag) throw new Error("InvalidPart");
        return part.bytes;
      });
      uploads.delete(uploadId);
      const object = { bytes: Buffer.concat(parts), customMetadata: upload.customMetadata, etag: `multipart-${uploadId}` };
      objects.set(key, object);
      return metadata(object);
    },
    async abortMultipart(_key, uploadId) {
      if (!uploads.delete(uploadId)) throw new Error("NoSuchUpload");
    },
  };
}

/** The content authority's record of the intent's multipart upload. */
function recordedProgress(intent) {
  return {
    async begin(uploadId, partBytes) {
      intent.multipart ??= { uploadId, partBytes, etags: [], sha256State: null };
      return intent.multipart;
    },
    async record(uploadId, partNumber, etag, sha256State) {
      assert.equal(intent.multipart.uploadId, uploadId);
      assert.equal(intent.multipart.etags.length, partNumber - 1);
      intent.multipart = { ...intent.multipart, etags: [...intent.multipart.etags, etag], sha256State };
      return intent.multipart;
    },
    async reset(uploadId) {
      if (intent.multipart?.uploadId === uploadId) delete intent.multipart;
    },
  };
}

function liveIntent(bytes, contentHash = sha256(bytes)) {
  return {
    intentId: "intent-1", visibilityScopeId: SCOPE, contentHash, checksumSha256: contentHash,
    encodedSize: bytes.byteLength, finalKey: immutableContentObjectKey(SCOPE, contentHash),
    expiresAt: Date.now() + 60_000, state: "pending", allowStaging: true,
  };
}

function partRequest(body) {
  return new Request("https://hub.example/part", {
    method: "PUT", body, headers: { "content-length": String(body.byteLength) }, duplex: "half",
  });
}

function uploader(bytes, intent = liveIntent(bytes)) {
  const bucket = memoryBucket();
  const progress = recordedProgress(intent);
  const common = () => ({ now: Date.now(), visibilityScopeId: SCOPE, intent, bucket, progress });
  return {
    intent, bucket,
    start: () => startRelayR2Multipart({ ...common(), partBytes: PART }),
    part: (partNumber, body = bytes.subarray((partNumber - 1) * PART, partNumber * PART)) =>
      uploadRelayR2MultipartPart({ ...common(), request: partRequest(body), partNumber }),
    complete: () => completeRelayR2Multipart(common()),
  };
}

test("a body larger than one request is published only once its parts' SHA-256 matches the intent", async () => {
  const bytes = randomBytes(PART * 2 + 44);
  const upload = uploader(bytes);
  assert.deepEqual(await upload.start(), { partBytes: PART, partCount: 3, uploadedParts: 0, complete: false });
  assert.equal((await upload.part(1)).uploadedParts, 1);
  // A replayed part is answered from the record and not stored again.
  assert.equal((await upload.part(1)).uploadedParts, 1);
  await assert.rejects(upload.part(3), { code: "multipart_part_conflict", status: 409 });
  // A resumed upload is told where it stands.
  assert.equal((await upload.start()).uploadedParts, 1);
  await assert.rejects(upload.complete(), { code: "multipart_part_conflict" });
  await upload.part(2);
  assert.equal(await upload.bucket.head(upload.intent.finalKey), null, "no byte is visible before the digest is checked");
  assert.equal((await upload.part(3)).uploadedParts, 3);

  const verified = await upload.complete();
  assert.equal(verified.disposition, "created");
  assert.equal(verified.objectKey, upload.intent.finalKey);
  assert.deepEqual(upload.bucket.objects.get(upload.intent.finalKey).bytes, bytes);
  // A completion whose answer was lost finds the object it published.
  assert.equal((await upload.complete()).disposition, "existing");
});

test("bytes that do not match the intent's SHA-256 are dropped, never published", async () => {
  const bytes = randomBytes(PART + 10);
  const upload = uploader(bytes, liveIntent(bytes, sha256(Buffer.from("other bytes"))));
  await upload.start();
  await upload.part(1);
  await assert.rejects(upload.part(2), { code: "content_mismatch", status: 409 });
  assert.equal(upload.bucket.uploads.size, 0, "the R2 upload is aborted");
  assert.equal(upload.intent.multipart, undefined, "the intent can start over");
  assert.equal(await upload.bucket.head(upload.intent.finalKey), null);
  await assert.rejects(upload.complete(), { code: "multipart_required" });
});

test("a part of the wrong length is refused before any byte is stored", async () => {
  const bytes = randomBytes(PART + 10);
  const upload = uploader(bytes);
  await upload.start();
  await assert.rejects(upload.part(1, bytes.subarray(0, PART - 1)), { code: "invalid_request", status: 400 });
  await assert.rejects(upload.part(2, bytes.subarray(0, PART)), { code: "invalid_request", status: 400 });
  assert.equal([...upload.bucket.uploads.values()][0].parts.size, 0);
});

test("bytes the Space already stores are not uploaded again", async () => {
  const bytes = randomBytes(PART * 2);
  const first = uploader(bytes);
  await first.start();
  await first.part(1);
  await first.part(2);
  await first.complete();
  const second = uploader(bytes);
  second.bucket.objects.set(second.intent.finalKey, first.bucket.objects.get(first.intent.finalKey));
  assert.equal((await second.start()).complete, true);
  assert.equal(second.bucket.uploads.size, 0);
});

test("a SHA-256 resumed from saved block-boundary states equals one pass over the whole body", () => {
  const bytes = randomBytes(64 * 41 + 17);
  for (const boundary of [0, 64, 64 * 20, 64 * 41]) {
    const first = new ResumableSha256();
    // Uneven chunks cross block edges inside one request.
    for (let offset = 0; offset < boundary; offset += 37) first.update(bytes.subarray(offset, Math.min(boundary, offset + 37)));
    const resumed = boundary === 0 ? first : new ResumableSha256({ state: first.save(), processedBytes: boundary });
    for (let offset = boundary; offset < bytes.byteLength; offset += 1000) {
      resumed.update(bytes.subarray(offset, Math.min(bytes.byteLength, offset + 1000)));
    }
    assert.equal(resumed.digest(), sha256(bytes));
  }
  assert.equal(new ResumableSha256().digest(), sha256(Buffer.alloc(0)));
});
