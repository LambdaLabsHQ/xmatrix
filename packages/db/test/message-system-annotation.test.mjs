import assert from "node:assert/strict";
import { connectionString, integration, seedTestSpacePlacement, integrationAuthority } from "./postgres-database.fixture.mjs";

import { Client } from "pg";

import { PostgresMessageRepository } from "../dist/index.js";

/**
 * The Hub records its own judgment about a message as `system`, never as the
 * author, and without touching what the message invoked
 * (docs/design/conversation-activity.md §3.3).
 */

const now = "2026-09-27T00:00:00.000Z";
const SPACE = "space-system-annotation";
const DIGEST = "a".repeat(64);

async function seed() {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    for (const table of ["data.outbox", "data.message_mutations", "data.idempotency_keys",
      "data.message_annotations", "data.messages", "data.channels", "data.spaces"]) {
      await client.query(`DELETE FROM ${table} WHERE space_id=$1`, [SPACE]);
    }
    await client.query(`DELETE FROM control.space_placement WHERE space_id=$1`, [SPACE]);
    await seedTestSpacePlacement(client, SPACE, now);
    await client.query(`INSERT INTO data.spaces
      (space_id,owner_user_id,name,search_rank_sequence,version,metadata_json,created_at,updated_at)
      VALUES ($2,'owner','Annotations','space-rank-annotations',1,'{}',$1,$1)`, [now, SPACE]);
    await client.query(`INSERT INTO data.channels
      (channel_id,space_id,name,name_key,mode,search_rank_sequence,version,metadata_json,
       created_at,updated_at,activity_at)
      VALUES ('conversation',$2,'Conversation','conversation','open','rank-conv',1,'{}',$1,$1,$1)`,
      [now, SPACE]);
    for (const [messageId, sequence, recalled] of [["status", 1, false], ["recalled", 2, true]]) {
      await client.query(`INSERT INTO data.messages
        (space_id,channel_id,message_id,timeline_sequence,entity_version,author_kind,author_id,
         message_kind,content_hash,payload_kind,payload_ref,sent_at,updated_at,search_rank_sequence,
         legacy_body,created_at,recalled_at,invocation_input_version)
        VALUES ($1,'conversation',$2,$3,1,'agent','agent-1','xmatrix.message.text','hash','inline',
          'inline',$4,$4,$2,'Progress: running tests',$4,$5,1)`,
        [SPACE, messageId, sequence, now, recalled ? now : null]);
    }
  } finally {
    await client.end();
  }
}

integration("a system annotation is the Hub's, idempotent, and leaves the invocation alone", async () => {
  await seed();
  const database = integrationAuthority();
  const repository = new PostgresMessageRepository(database);
  const judgment = {
    requestId: "judge", spaceId: SPACE, channelId: "conversation", messageId: "status",
    namespace: "xmatrix.superseded", annotationId: "xmatrix.superseded:status",
    payload: { supersededBy: "later" }, requestDigest: DIGEST,
  };
  const annotation = await repository.annotateAsSystem(judgment);
  assert.equal(annotation.authorUserId, "system:xmatrix");
  assert.deepEqual(annotation.payload, { supersededBy: "later" });
  assert.equal(await repository.annotateAsSystem({ ...judgment, requestId: "again" }), null,
    "the same judgment twice records nothing new");
  assert.equal(await repository.annotateAsSystem({ ...judgment, messageId: "recalled",
    annotationId: "xmatrix.superseded:recalled" }), null, "a recalled message is left alone");
  await assert.rejects(repository.annotateAsSystem({ ...judgment, namespace: "memory" }),
    /reserved namespace/u);

  const client = new Client({ connectionString });
  await client.connect();
  try {
    const [row] = (await client.query(`SELECT entity_version,invocation_input_version,annotations_json
      FROM data.messages WHERE space_id=$1 AND message_id='status'`, [SPACE])).rows;
    assert.equal(Number(row.entity_version), 2);
    assert.equal(Number(row.invocation_input_version), 1);
    assert.equal(row.annotations_json.length, 1);
    const ledger = (await client.query(`SELECT actor_kind,actor_id,mutation_kind FROM data.message_mutations
      WHERE space_id=$1 AND message_id='status'`, [SPACE])).rows;
    assert.deepEqual(ledger, [{ actor_kind: "system", actor_id: "xmatrix", mutation_kind: "annotation" }]);
    const stored = (await client.query(`SELECT author_user_id,namespace FROM data.message_annotations
      WHERE space_id=$1`, [SPACE])).rows;
    assert.deepEqual(stored, [{ author_user_id: "system:xmatrix", namespace: "xmatrix.superseded" }]);
  } finally {
    await client.end();
  }
});
