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

// Decision maintenance runs on a timer while 31 days of pending GC candidates
// and 30 days of private-record refs accumulate per Space. Both next-due and
// due-object reads must stay indexed and bounded as those tables grow.
integration("decision maintenance reads next-due and due GC objects via bounded index probes", async () => {
  const f = await isolatedPostgres("decision_gc_index", { shard: true });
  const rawDatabase = createAuthorityDatabase({ connectionString: f.url.toString(), shardId: "shard-0" });
  const captured = [];
  const wrapTransaction = tx => ({
    ...tx,
    async query(spec) {
      captured.push({ name: spec.name, text: spec.text, values: spec.values });
      return tx.query(spec);
    },
  });
  const database = {
    ...rawDatabase,
    openSession() {
      const session = rawDatabase.openSession();
      return { ...session, transaction: (ctx, fn) => session.transaction(ctx, tx => fn(wrapTransaction(tx))) };
    },
    transaction: (ctx, fn) => rawDatabase.transaction(ctx, tx => fn(wrapTransaction(tx))),
  };
  const content = new PostgresContentRepository(database, "shard-0");
  const spaceId = "decision-space", ownerId = "decision-owner";
  const keyFor = suffix => `restricted/channel-user%3Achan%3A${ownerId}/objects/${suffix}`;
  const hashFor = n => n.toString(16).padStart(64, "0");
  const planNodes = function* (node) { yield node; for (const child of node.Plans ?? []) yield* planNodes(child); };
  const explain = async (entry) => (await f.client.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${entry.text}`, entry.values))
    .rows[0]["QUERY PLAN"][0].Plan;
  try {
    await seedOwnedTestSpace(f.client, spaceId, ownerId);
    // 20k future-dated pending candidates (31-day safety window) plus 10k active private-record refs.
    await f.run(`INSERT INTO data.content_gc_candidates
      (space_id,object_id,storage_key,content_hash,reason,unreferenced_at,not_before,
       status,version,lease_until,attempts,last_checked_at,created_at,updated_at)
      SELECT $1,'obj-future-'||lpad(n::text,5,'0'),
        'restricted/channel-user%3Achan%3A${ownerId}/objects/'||lpad(to_hex(n+1000),64,'0'),
        lpad(to_hex(n+1000),64,'0'),'decision-expired',now(),
        now()+interval '10 days'+(n||' seconds')::interval,'pending',1,NULL,0,NULL,now(),now()
      FROM generate_series(1,20000) n`, [spaceId]);
    await f.run(`INSERT INTO data.content_refs
      (space_id,root_set_id,generation,ref_id,owner_kind,owner_id,child_object_id,
       child_checksum,child_bytes,logical_bytes,created_at)
      SELECT $1,'channel-user:chan:${ownerId}',0,'ref-'||n,
        CASE WHEN n%2=0 THEN 'summon_decision' ELSE 'connector_result' END,'msg-'||n,
        'ref-obj-'||n,lpad(to_hex(n+50000),64,'0'),10,10,now()-interval '1 day'+(n||' seconds')::interval
      FROM generate_series(1,10000) n`, [spaceId]);
    await f.run(`INSERT INTO data.blob_upload_intents
      (space_id,intent_id,scope_id,content_hash,object_key,encoded_bytes,checksum,
       status,version,created_at,expires_at,purpose)
      SELECT $1,'intent-'||n,'channel-user:chan:${ownerId}',lpad(to_hex(n+90000),64,'0'),
        'restricted/channel-user%3Achan%3A${ownerId}/objects/'||lpad(to_hex(n+90000),64,'0'),
        10,lpad(to_hex(n+90000),64,'0'),'pending',1,now(),now()+interval '1 hour'+(n||' seconds')::interval,
        CASE WHEN n%2=0 THEN 'summon_decision' ELSE 'connector_result' END
      FROM generate_series(1,1000) n`, [spaceId]);

    // Edge cases: due pending, due upload-expired, expired lease, active lease, deleted, exhausted, non-decision.
    const duePendingKey = keyFor(hashFor(1));
    const dueUploadKey = keyFor(hashFor(2));
    const expiredLeaseKey = keyFor(hashFor(3));
    const activeLeaseKey = keyFor(hashFor(4));
    await f.run(`INSERT INTO data.content_gc_candidates
      (space_id,object_id,storage_key,content_hash,reason,unreferenced_at,not_before,
       status,version,lease_until,attempts,last_checked_at,created_at,updated_at) VALUES
      ($1,'obj-due-1',$2,$3,'decision-expired',now()-interval '32 days',now()-interval '10 minutes','pending',1,NULL,0,NULL,now(),now()),
      ($1,'obj-due-2',$4,$5,'decision-upload-expired',now()-interval '32 days',now()-interval '5 minutes','pending',1,NULL,0,NULL,now(),now()),
      ($1,'obj-lease-exp',$6,$7,'decision-expired',now()-interval '32 days',now()-interval '1 hour','leased',2,now()-interval '1 minute',1,now(),now(),now()),
      ($1,'obj-lease-live',$8,$9,'decision-expired',now()-interval '32 days',now()-interval '1 hour','leased',2,now()+interval '4 minutes',1,now(),now(),now()),
      ($1,'obj-deleted',$10,$11,'decision-expired',now()-interval '32 days',now()-interval '2 hours','deleted',3,NULL,1,now(),now(),now()),
      ($1,'obj-max-attempts',$12,$13,'decision-expired',now()-interval '32 days',now()-interval '2 hours','pending',1,NULL,100,now(),now(),now()),
      ($1,'obj-other-reason',$14,$15,'blob-unreferenced',now()-interval '32 days',now()-interval '2 hours','pending',1,NULL,0,NULL,now(),now())`,
    [spaceId, duePendingKey, hashFor(1), dueUploadKey, hashFor(2), expiredLeaseKey, hashFor(3),
      activeLeaseKey, hashFor(4), keyFor(hashFor(5)), hashFor(5), keyFor(hashFor(6)), hashFor(6),
      keyFor(hashFor(7)), hashFor(7)]);
    await f.run("ANALYZE data.content_gc_candidates; ANALYZE data.content_refs; ANALYZE data.blob_upload_intents");

    captured.length = 0;
    const due = await content.dueDecisionObjects({ requestId: "due-1", spaceId, limit: 10 });
    assert.deepEqual(due, [duePendingKey, dueUploadKey, expiredLeaseKey],
      "only due pending and lease-expired decision candidates are returned, in effective due order");
    const dueQuery = captured.find(entry => entry.name.startsWith("content_decision_gc_due_"));
    assert.ok(dueQuery, "dueDecisionObjects must run its named query");

    captured.length = 0;
    const nextDue = await content.nextDecisionMaintenance({ requestId: "next-1", spaceId });
    assert.ok(nextDue !== null && nextDue <= Date.now(), "nextDecisionMaintenance sees the earliest due candidate");
    const nextQuery = captured.find(entry => entry.name.startsWith("content_decision_next_maintenance_"));
    assert.ok(nextQuery, "nextDecisionMaintenance must run its named query");

    for (const [label, entry] of [["dueDecisionObjects (due)", dueQuery], ["nextDecisionMaintenance", nextQuery]]) {
      const plan = await explain(entry);
      const nodes = [...planNodes(plan)];
      assert.deepEqual(nodes.filter(node => node["Node Type"] === "Seq Scan").map(node => node["Relation Name"]),
        [], `${label} must not sequentially scan any table`);
      assert.ok(nodes.every(node => node["Node Type"] !== "Sort"), `${label} must not sort candidate history`);
      assert.ok(nodes.some(node => node["Index Name"] === "private_record_gc_due_idx"),
        `${label} must use private_record_gc_due_idx`);
      assert.ok(plan["Shared Hit Blocks"] < 100,
        `${label} must stay bounded independent of 20k pending rows (hit ${plan["Shared Hit Blocks"]} blocks)`);
    }

    // Clear the three due rows: active lease's lease_until (not its older not_before) must now be the next due time,
    // and dueDecisionObjects must return [] via an index probe touching only a handful of blocks.
    await f.run(`UPDATE data.content_gc_candidates SET status='deleted', lease_until=NULL
      WHERE space_id=$1 AND object_id IN ('obj-due-1','obj-due-2','obj-lease-exp')`, [spaceId]);
    const activeLeaseUntil = (await f.run(`SELECT lease_until FROM data.content_gc_candidates
      WHERE space_id=$1 AND object_id='obj-lease-live'`, [spaceId]))[0].lease_until;
    assert.equal(await content.nextDecisionMaintenance({ requestId: "next-2", spaceId }),
      new Date(activeLeaseUntil).getTime(), "an active lease schedules at its lease_until");
    captured.length = 0;
    assert.deepEqual(await content.dueDecisionObjects({ requestId: "due-empty", spaceId, limit: 10 }), []);
    const emptyPlan = await explain(captured.find(entry => entry.name.startsWith("content_decision_gc_due_")));
    assert.ok([...planNodes(emptyPlan)].every(node => node["Node Type"] !== "Seq Scan" && node["Node Type"] !== "Sort"));
    assert.ok(emptyPlan["Shared Hit Blocks"] < 100,
      `empty due probe must stay bounded (hit ${emptyPlan["Shared Hit Blocks"]} blocks)`);
  } finally { await f.close(); }
});
