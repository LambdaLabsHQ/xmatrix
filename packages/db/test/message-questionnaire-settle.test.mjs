import assert from "node:assert/strict";
import { connectionString, integration, seedTestSpacePlacement, integrationAuthority } from "./postgres-database.fixture.mjs";

import { Client } from "pg";

import { PostgresMessageRepository } from "../dist/index.js";

/**
 * A questionnaire card settles once, as answered or withdrawn: the Hub's own
 * annotation records it and the card's wait on its person ends with it. Only
 * the asking Instance withdraws its card; the first settlement stands.
 */

const now = "2026-10-14T00:00:00.000Z";
const SPACE = "space-questionnaire-settle";
const DIGEST = "b".repeat(64);

async function seed() {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    for (const table of ["data.outbox", "data.message_mutations", "data.idempotency_keys", "data.message_attention",
      "data.message_attention_revisions", "data.message_annotations", "data.messages", "data.channels", "data.spaces"]) {
      await client.query(`DELETE FROM ${table} WHERE space_id=$1`, [SPACE]);
    }
    await client.query(`DELETE FROM control.space_placement WHERE space_id=$1`, [SPACE]);
    await seedTestSpacePlacement(client, SPACE, now);
    await client.query(`INSERT INTO data.spaces
      (space_id,owner_user_id,name,search_rank_sequence,version,metadata_json,created_at,updated_at)
      VALUES ($2,'owner','Questions','space-rank-questions',1,'{}',$1,$1)`, [now, SPACE]);
    await client.query(`INSERT INTO data.channels
      (channel_id,space_id,name,name_key,mode,search_rank_sequence,version,metadata_json,
       created_at,updated_at,activity_at)
      VALUES ('questionnaire-conversation',$2,'Conversation','questionnaire-conversation','open','rank-questionnaire-conv',1,'{}',$1,$1,$1)`,
      [now, SPACE]);
    for (const [messageId, sequence] of [["card", 1], ["other-card", 2]]) {
      await client.query(`INSERT INTO data.messages
        (space_id,channel_id,message_id,timeline_sequence,entity_version,author_kind,author_id,
         message_kind,content_hash,payload_kind,payload_ref,sent_at,updated_at,search_rank_sequence,
         legacy_body,created_at,invocation_input_version)
        VALUES ($1,'questionnaire-conversation',$2,$3,1,'agent','instance-1','xmatrix.message.text','hash','inline',
          'inline',$4,$4,$2,'Codex asks: Which branch?',$4,1)`,
        [SPACE, messageId, sequence, now]);
    }
    await client.query(`INSERT INTO data.message_attention
      (space_id,subject_id,channel_id,message_id,timeline_sequence,kind,created_at,awaiting_response)
      VALUES ($1,'user:owner','questionnaire-conversation','card',1,'mention',$2,TRUE),
        ($1,'user:owner','questionnaire-conversation','card',1,'reply',$2,TRUE)`, [SPACE, now]);
  } finally {
    await client.end();
  }
}

integration("a card settles once, only its asker withdraws it, and its wait ends", async () => {
  await seed();
  const repository = new PostgresMessageRepository(integrationAuthority());
  const settle = (input) => repository.settleQuestionnaire({
    requestId: "settle", spaceId: SPACE, channelId: "questionnaire-conversation", requestDigest: DIGEST, ...input });

  assert.equal(await settle({ messageId: "card", settlement: { state: "cancelled" }, askedByInstanceId: "instance-2" }),
    null, "another Instance cannot withdraw this card");
  assert.deepEqual(await settle({ messageId: "card", settlement: { state: "cancelled" }, askedByInstanceId: "instance-1" }),
    { state: { state: "cancelled" }, changed: true });
  assert.deepEqual(await settle({ messageId: "card", settlement: { state: "answered", answers: { q: ["main"] } } }),
    { state: { state: "cancelled" }, changed: false }, "the first settlement stands");
  assert.deepEqual(await settle({ messageId: "other-card", settlement: { state: "answered", answers: { q: ["main"] } } }),
    { state: { state: "answered", answers: { q: ["main"] } }, changed: true });
  assert.equal(await settle({ messageId: "missing", settlement: { state: "cancelled" } }), null);

  const client = new Client({ connectionString });
  await client.connect();
  try {
    const [card] = (await client.query(`SELECT entity_version,invocation_input_version,annotations_json
      FROM data.messages WHERE space_id=$1 AND message_id='card'`, [SPACE])).rows;
    assert.equal(Number(card.entity_version), 2);
    assert.equal(Number(card.invocation_input_version), 1, "settling a card is not new input to its run");
    assert.equal(card.annotations_json[0].namespace, "xmatrix.questionnaire");
    assert.equal(card.annotations_json[0].authorUserId, "system:xmatrix");
    const waits = (await client.query(`SELECT awaiting_response FROM data.message_attention
      WHERE space_id=$1 AND message_id='card'`, [SPACE])).rows;
    assert.deepEqual(waits.map((wait) => wait.awaiting_response), [false, false],
      "a settled card no longer waits on its person, however it addressed them");
    const [revision] = (await client.query(`SELECT revision FROM data.message_attention_revisions
      WHERE space_id=$1 AND subject_id='user:owner'`, [SPACE])).rows;
    assert.equal(Number(revision.revision), 1);
  } finally {
    await client.end();
  }
});
