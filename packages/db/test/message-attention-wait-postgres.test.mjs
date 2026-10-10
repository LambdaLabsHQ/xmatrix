import assert from "node:assert/strict";
import { Client } from "pg";
import { releaseDeclaredWaits } from "../dist/channel-stop-fence.js";
import { beginTestSchema, boundedPostgresTransaction, connectionString, integration } from "./postgres-database.fixture.mjs";

integration("only someone else's speech lets an asker move on from a declared wait", async () => {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    const schema = `wait_speech_${process.pid}`;
    const rewrite = await beginTestSchema(client, schema);
    await client.query(`CREATE TABLE ${schema}.messages (space_id text,channel_id text,message_id text,
      author_kind text,author_id text,timeline_sequence bigint,message_kind text,deleted_at timestamptz)`);
    await client.query(`CREATE TABLE ${schema}.message_attention (space_id text,channel_id text,message_id text,
      subject_id text,timeline_sequence bigint,awaiting_response boolean)`);
    await client.query(`CREATE TABLE ${schema}.message_attention_revisions (space_id text,subject_id text,
      channel_id text,revision bigint,updated_at timestamptz,PRIMARY KEY (space_id,subject_id,channel_id))`);
    await client.query(`INSERT INTO ${schema}.messages VALUES
      ('space','channel','question','agent','asker',1,'xmatrix.message.text',NULL),
      ('space','channel','intervening','user','other',2,'xmatrix.system.secret-request',NULL)`);
    await client.query(`INSERT INTO ${schema}.message_attention VALUES
      ('space','channel','question','user:target',1,TRUE),
      ('space','elsewhere','question-elsewhere','user:target',1,TRUE)`);
    const tx = boundedPostgresTransaction(client, rewrite);
    const release = () => releaseDeclaredWaits(tx, { spaceId: "space", channelId: "channel",
      authorKind: "agent", authorIds: ["asker"], movedOnAt: 3, at: "2026-10-10T20:00:00Z" });
    // A card carries its display author's identity; it is not that person speaking.
    for (const [authorKind, authorId, messageKind, deleted, answered] of [
      ["user", "other", "xmatrix.system.secret-request", false, false],
      ["user", "other", "xmatrix.system.cross-space-read", false, false],
      ["agent", "other", "xmatrix.activity", false, false],
      ["system", "other", "xmatrix.message.text", false, false],
      ["agent", "asker", "xmatrix.message.text", false, false],
      ["user", "other", "xmatrix.message.text", true, false],
      ["user", "other", "xmatrix.message.text", false, true],
      ["agent", "other", "xmatrix.message.text", false, true],
    ]) {
      await client.query(`UPDATE ${schema}.message_attention SET awaiting_response=TRUE`);
      await client.query(`UPDATE ${schema}.messages SET author_kind=$1,author_id=$2,message_kind=$3,
        deleted_at=CASE WHEN $4 THEN now() ELSE NULL END WHERE message_id='intervening'`,
      [authorKind, authorId, messageKind, deleted]);
      await release();
      const rows = (await client.query(`SELECT channel_id,awaiting_response FROM ${schema}.message_attention`)).rows;
      assert.equal(rows.find(row => row.channel_id === "channel").awaiting_response, !answered,
        `${authorKind}/${authorId}/${messageKind}/${deleted}: only another's live speech releases the wait`);
      assert.equal(rows.find(row => row.channel_id === "elsewhere").awaiting_response, true);
    }
    assert.equal((await client.query(`SELECT revision FROM ${schema}.message_attention_revisions`)).rows[0].revision, "2",
      "only actual releases revise attention");
  } finally {
    await client.query("ROLLBACK");
    await client.end();
  }
});
