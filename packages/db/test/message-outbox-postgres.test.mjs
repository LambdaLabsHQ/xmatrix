import { connectionString, integration, deleteSpaceRows } from "./postgres-database.fixture.mjs";
import assert from "node:assert/strict";
import { Client } from "pg";
import { createAuthorityDatabase, PostgresMessageRepository } from "../dist/index.js";
import { convergeRuntimeAccess } from "../scripts/migrate.mjs";


integration("Message events use entity versions for non-first messages and recover legacy append events", async () => {
  assert.ok(connectionString, "XMATRIX_TEST_POSTGRES_URL is required");
  const id = `message-outbox-${crypto.randomUUID()}`;
  const client = new Client({ connectionString });
  await client.connect();
  const role = `message_outbox_${crypto.randomUUID().replaceAll("-", "")}`;
  await client.query(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`);
  await client.query("BEGIN");
  await convergeRuntimeAccess(client, role);
  await client.query("COMMIT");
  const runtimeUrl = new URL(connectionString);
  runtimeUrl.searchParams.set("options", `-c role=${role}`);
  const db = createAuthorityDatabase({ connectionString: runtimeUrl.toString(), shardId: id,
    applicationName: "message-outbox-regression", statementTimeoutMs: 5000 });
  const repository = new PostgresMessageRepository(db);
  const prepared = {
    codecId: "canonical-clone-cbor-v1", payloadSchemaVersion: 1,
    fieldPresenceBase64: "AA", payloadBundleBase64: "AA",
    bodyHash: "2".repeat(64), senderSnapshotDigest: "3".repeat(64),
    recordDigest: "4".repeat(64), recordEncodedBytes: 10,
    preview: { bodyPreview: "outbox", senderSnapshot: { kind: "user", label: "User" } },
  };
  const scope = { spaceId: id, channelId: id, principal: { kind: "user", id } };
  const append = async (sequence) => {
    const input = { ...scope, requestId: `${id}:append:${sequence}`,
      commandId: `${id}:append:${sequence}`, messageId: `${id}:${sequence}`, sequence,
      requestDigest: "1".repeat(64), senderKind: "user", senderId: id,
      messageKind: "xmatrix.message.text", sentAt: new Date().toISOString(),
      prepared, senderSnapshot: { userId: id } };
    const result = await repository.append(input);
    assert.equal(result.sequence, sequence);
    assert.equal(result.entityVersion, 1);
    assert.deepEqual(await repository.append(input), result, "append replay retains timeline sequence");
    return input.messageId;
  };
  const recall = (messageId, expectedEntityVersion = 1, overrides = {}) => repository.tombstone({
    ...scope, requestId: `${messageId}:recall`, commandId: `${messageId}:recall`, messageId,
    expectedEntityVersion, requestDigest: "5".repeat(64), kind: "recall",
    redactedContentHash: "6".repeat(64), ...overrides,
  });
  try {
    await client.query(`INSERT INTO control.postgres_shards
      (shard_id,state,capacity_class,created_at,updated_at) VALUES ($1,'active','test',now(),now())`, [id]);
    await client.query(`INSERT INTO control.space_placement
      (space_id,shard_id,placement_epoch,state,target_shard_id,plan_class,created_at,updated_at)
      VALUES ($1,$1,1,'active',NULL,'test',now(),now())`, [id]);
    await client.query(`INSERT INTO data.spaces
      (space_id,owner_user_id,name,search_rank_sequence,version,metadata_json,created_at,updated_at)
      VALUES ($1,$1,'Synthetic outbox test',$1,1,'{}',now(),now())`, [id]);
    await client.query(`INSERT INTO data.space_members
      (space_id,user_id,role,version,created_at,updated_at) VALUES ($1,$1,'owner',1,now(),now())`, [id]);
    await client.query(`INSERT INTO data.channels
      (channel_id,space_id,name,name_key,mode,search_rank_sequence,version,metadata_json,created_at,updated_at)
      VALUES ($1,$1,'Synthetic',$1,'closed',$1,1,'{}',now(),now())`, [id]);

    await client.query(`INSERT INTO data.space_billing_usage
      (space_id,created_at,updated_at) VALUES ($1,now(),now())`, [id]);
    await append(1);
    const second = await append(2);
    const recalled = await recall(second);
    assert.equal(recalled.entityVersion, 2);
    assert.ok(recalled.recalledAt);
    assert.deepEqual(await recall(second), recalled);
    const events = (await client.query(`SELECT aggregate_sequence,payload_json FROM data.outbox
      WHERE space_id=$1 AND aggregate_id=$2 ORDER BY aggregate_sequence`, [id, second])).rows;
    assert.deepEqual(events.map((row) => Number(row.aggregate_sequence)), [1, 2]);
    assert.equal(events[0].payload_json.sequence, 2);
    assert.equal(events[1].payload_json.sequence, 2);

    const third = await append(3);
    const createId = `message:${id}:${third}:1`;
    // Model a retained pre-fix event, including an in-flight delivery lease.
    await client.query(`UPDATE data.outbox SET aggregate_sequence=3,status='leased',attempts=2,
      lease_until=now()+interval '1 minute' WHERE outbox_id=$1`, [createId]);
    const original = (await client.query("SELECT * FROM data.outbox WHERE outbox_id=$1", [createId])).rows[0];
    await assert.rejects(recall(third, 1, { principal: { kind: "user", id: `${id}:outsider` } }),
      (error) => error.code === "channel_not_found");
    await assert.rejects(recall(third, 99), (error) => error.code === "message_version_conflict");
    assert.deepEqual((await client.query("SELECT * FROM data.outbox WHERE outbox_id=$1", [createId])).rows[0], original);

    // A later failure must roll back both the compatibility correction and the
    // mutation. Never suppress a conflicting non-create event to make it pass.
    await client.query(`INSERT INTO data.outbox
      (outbox_id,space_id,topic,aggregate_kind,aggregate_id,aggregate_sequence,payload_json,
       status,attempts,available_at,created_at,updated_at)
      VALUES ($1,$2,'message','message',$3,2,'{}','pending',0,now(),now(),now())`,
    [`${id}:conflict`, id, third]);
    await assert.rejects(recall(third), (error) => error.code === "23505");
    assert.deepEqual((await client.query("SELECT * FROM data.outbox WHERE outbox_id=$1", [createId])).rows[0], original);
    assert.equal(Number((await client.query("SELECT entity_version FROM data.messages WHERE space_id=$1 AND message_id=$2",
      [id, third])).rows[0].entity_version), 1);
    await client.query("DELETE FROM data.outbox WHERE outbox_id=$1", [`${id}:conflict`]);
    const edited = await repository.updatePrepared({ ...scope, requestId: `${third}:edit`,
      commandId: `${third}:edit`, messageId: third, expectedEntityVersion: 1,
      requestDigest: "7".repeat(64), editedAt: new Date().toISOString(), prepared });
    assert.equal(edited.entityVersion, 2);
    assert.equal((await recall(third, 2)).entityVersion, 3);
    const normalized = (await client.query("SELECT * FROM data.outbox WHERE outbox_id=$1", [createId])).rows[0];
    assert.deepEqual(normalized, { ...original, aggregate_sequence: "1" });
    assert.deepEqual((await client.query(`SELECT aggregate_sequence FROM data.outbox
      WHERE space_id=$1 AND aggregate_id=$2 ORDER BY aggregate_sequence`, [id, third])).rows
      .map((row) => Number(row.aggregate_sequence)), [1, 2, 3]);

    const fourth = await append(4);
    await client.query("UPDATE data.outbox SET aggregate_sequence=4 WHERE outbox_id=$1", [`message:${id}:${fourth}:1`]);
    const decisions = await Promise.allSettled(["a", "b"].map((suffix) => recall(fourth, 1, {
      kind: "delete", commandId: `${fourth}:delete:${suffix}`,
    })));
    assert.equal(decisions.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(decisions.filter((result) => result.status === "rejected").length, 1);
    const deleted = (await client.query(`SELECT entity_version,payload_bundle_base64,deleted_at
      FROM data.messages WHERE space_id=$1 AND message_id=$2`, [id, fourth])).rows[0];
    assert.equal(Number(deleted.entity_version), 2);
    assert.equal(deleted.payload_bundle_base64, null);
    assert.ok(deleted.deleted_at);
    assert.deepEqual((await client.query(`SELECT aggregate_sequence FROM data.outbox
      WHERE space_id=$1 AND aggregate_id=$2 ORDER BY aggregate_sequence`, [id, fourth])).rows
      .map((row) => Number(row.aggregate_sequence)), [1, 2]);

    const fifth = await append(5);
    // A different anomaly is not silently reinterpreted as the known old bug.
    await client.query("UPDATE data.outbox SET aggregate_sequence=2 WHERE outbox_id=$1", [`message:${id}:${fifth}:1`]);
    await assert.rejects(recall(fifth), (error) => error.code === "23505");
    assert.equal(Number((await client.query("SELECT entity_version FROM data.messages WHERE space_id=$1 AND message_id=$2",
      [id, fifth])).rows[0].entity_version), 1);
  } finally {
    await deleteSpaceRows(client, id, ["idempotency_keys", "outbox", "message_mutations", "messages",
      "channel_content_counters", "space_billing_usage",
      "space_storage_usage", "space_members", "channels", "spaces"], { shard: true });
    await client.query(`DROP OWNED BY ${role}`);
    await client.query(`DROP ROLE ${role}`);
    await client.end();
  }
});
