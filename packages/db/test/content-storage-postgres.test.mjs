import assert from "node:assert/strict";
import { spaceBilling } from "@xmatrix/billing";
import { createAuthorityDatabase, PostgresContentRepository } from "../dist/index.js";
import { integration, isolatedPostgres, seedOwnedTestSpace } from "./postgres-database.fixture.mjs";

const GIB = 1024 ** 3;

// Storage metering and multipart progress live in the content authority's own
// transactions; only real PostgreSQL proves the counter, the widened checks and
// the intent's row-locked progress together.
integration("a Space's held blob storage and multipart uploads are recorded by the content authority", async t => {
  const f = await isolatedPostgres("content_storage", { shard: true });
  const database = createAuthorityDatabase({ connectionString: f.url.toString(), shardId: "shard-0" });
  const changes = [];
  let refuseUploads = false;
  const billing = { ...spaceBilling,
    async storageUpload(_tx, input) {
      return refuseUploads ? { code: "storage_limit", status: 402, message: `no room for ${input.bytes} bytes` } : null;
    },
    async storageChanged(_tx, change) { changes.push({ deltaBytes: change.deltaBytes, totalBytes: change.totalBytes }); },
  };
  const content = new PostgresContentRepository(database, "shard-0", billing);
  const principal = { kind: "user", id: "storage-owner" };
  const spaceId = "storage-space", scopeId = `space:${spaceId}`;
  const intent = async (id, { encodedBytes = 100, hash }) => {
    await content.createIntent({ requestId: id, commandId: `create:${id}`, intentId: id, scopeId, contentHash: hash,
      encodedBytes, expiresAt: new Date(Date.now() + 60_000).toISOString(), principal });
    return { requestId: `commit:${id}`, commandId: `commit:${id}`, intentId: id, expectedIntentVersion: 1,
      refId: `ref:${id}`, ownerKind: "message_attachment", ownerId: `message:${id}`, scopeId,
      objectKey: `objects/${hash}`, checksum: hash, encodedBytes, verifiedAt: new Date().toISOString(), principal };
  };
  const release = (refId) => content.releaseRef({ requestId: `release:${refId}`, commandId: `release:${refId}`,
    refId, expectedRefVersion: 1, principal });
  const usage = async () => (await f.run(`SELECT logical_rows::int AS objects,logical_bytes::bigint AS bytes
    FROM data.space_storage_usage WHERE space_id=$1 AND category='attachments'`, [spaceId]))[0];
  try {
    await seedOwnedTestSpace(f.client, spaceId, principal.id);

    await t.test("the first metered change counts what the Space already held, then each object once", async () => {
      // A blob held before metering existed.
      const held = await intent("held", { hash: "1".repeat(64), encodedBytes: 40 });
      await content.commitRef(held);
      await f.run("DELETE FROM data.space_storage_usage WHERE space_id=$1", [spaceId]);
      changes.length = 0;

      // Larger than the old 1 GiB object ceiling.
      const large = await intent("large", { hash: "2".repeat(64), encodedBytes: 70 * GIB });
      await content.commitRef(large);
      assert.deepEqual(await usage(), { objects: 2, bytes: String(70 * GIB + 40) });
      const again = await intent("again", { hash: "2".repeat(64), encodedBytes: 70 * GIB });
      await content.commitRef(again);
      assert.deepEqual(await usage(), { objects: 2, bytes: String(70 * GIB + 40) }, "shared bytes are held once");

      await release(large.refId);
      assert.equal((await usage()).objects, 2, "another ref still holds the object");
      await release(again.refId);
      assert.deepEqual(await usage(), { objects: 1, bytes: "40" });
      assert.deepEqual(changes, [
        { deltaBytes: 70 * GIB, totalBytes: 70 * GIB + 40 },
        { deltaBytes: -70 * GIB, totalBytes: 40 },
      ]);
    });

    await t.test("the billing policy can refuse an upload before any byte is sent", async () => {
      refuseUploads = true;
      try {
        await assert.rejects(intent("refused", { hash: "3".repeat(64) }), { code: "storage_limit", status: 402 });
      } finally { refuseUploads = false; }
      assert.equal((await f.run("SELECT 1 FROM data.blob_upload_intents WHERE intent_id='refused'")).length, 0);
    });

    await t.test("multipart progress is recorded in part order on the live intent", async () => {
      const hash = "4".repeat(64);
      await intent("parts", { hash, encodedBytes: 20 * 1024 * 1024 });
      const step = { requestId: "step", intentId: "parts", principal };
      const begun = await content.beginMultipartUpload({ ...step, uploadId: "r2-upload", partBytes: 8 * 1024 * 1024 });
      assert.deepEqual(begun.multipart, { uploadId: "r2-upload", partBytes: 8 * 1024 * 1024, etags: [], sha256State: null });
      // A concurrent start that lost sees the upload recorded first.
      assert.equal((await content.beginMultipartUpload({ ...step, uploadId: "late", partBytes: 8 * 1024 * 1024 }))
        .multipart.uploadId, "r2-upload");
      const record = (partNumber, etag, uploadId = "r2-upload") => content.recordMultipartPart({ ...step, uploadId,
        partNumber, etag, sha256State: String(partNumber).repeat(64) });
      await assert.rejects(record(2, "etag-2"), { code: "multipart_part_conflict" });
      await assert.rejects(record(1, "etag-1", "late"), { code: "multipart_upload_conflict" });
      await record(1, "etag-1");
      assert.deepEqual((await record(1, "etag-1")).multipart.etags, ["etag-1"], "a replayed part is recorded once");
      const recorded = await record(2, "etag-2");
      assert.deepEqual(recorded.multipart, { uploadId: "r2-upload", partBytes: 8 * 1024 * 1024,
        etags: ["etag-1", "etag-2"], sha256State: "2".repeat(64) });
      assert.ok(Date.parse(recorded.expiresAt) > Date.now() + 50 * 60_000, "each part keeps the intent live");
      assert.deepEqual((await content.readIntent(step)).multipart, recorded.multipart);
      assert.equal((await content.resetMultipartUpload({ ...step, uploadId: "r2-upload" })).multipart, undefined);
    });
  } finally { await f.close(); }
});
