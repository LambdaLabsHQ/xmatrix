import assert from "node:assert/strict";
import { connectionString, integration, seedTestSpacePlacement, integrationAuthority } from "./postgres-database.fixture.mjs";

import { Client } from "pg";

import { PostgresChannelCatalogRepository } from "../dist/index.js";

/**
 * Activity entries need no reading (docs/design/conversation-activity.md §3.2):
 * a reader who has read every message before them has read the conversation.
 */

const now = "2026-09-27T00:00:00.000Z";
const SPACE = "space-activity-unread";

async function seed() {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    await client.query(`DELETE FROM data.delivery_cursors WHERE space_id=$1`, [SPACE]);
    await client.query(`DELETE FROM data.messages WHERE space_id=$1`, [SPACE]);
    await client.query(`DELETE FROM data.channels WHERE space_id=$1`, [SPACE]);
    await client.query(`DELETE FROM data.space_control_heads WHERE space_id=$1`, [SPACE]);
    await client.query(`DELETE FROM data.space_members WHERE space_id=$1`, [SPACE]);
    await client.query(`DELETE FROM data.spaces WHERE space_id=$1`, [SPACE]);
    await client.query(`DELETE FROM control.space_placement WHERE space_id=$1`, [SPACE]);
    await seedTestSpacePlacement(client, SPACE, now);
    await client.query(`INSERT INTO data.spaces
      (space_id,owner_user_id,name,search_rank_sequence,version,metadata_json,created_at,updated_at)
      VALUES ($2,'reader','Activity','space-rank-activity',1,'{}',$1,$1)`, [now, SPACE]);
    await client.query(`INSERT INTO data.space_members
      (space_id,user_id,role,version,email,display_name,created_at,updated_at)
      VALUES ($2,'reader','owner',1,'reader@example.test','Reader',$1,$1)`, [now, SPACE]);
    await client.query(`INSERT INTO data.space_control_heads (space_id,commit_sequence,updated_at)
      VALUES ($2,1,$1)`, [now, SPACE]);
    await client.query(`INSERT INTO data.channels
      (channel_id,space_id,name,name_key,mode,search_rank_sequence,version,metadata_json,
       created_at,updated_at,activity_at)
      VALUES ('read-then-activity',$2,'Read then activity','read-then-activity','open','rank-a',1,'{}',$1,$1,$1),
        ('unread-speech',$2,'Unread speech','unread-speech','open','rank-b',1,'{}',$1,$1,$1),
        ('activity-only',$2,'Activity only','activity-only','open','rank-c',1,'{}',$1,$1,$1)`,
      [now, SPACE]);
    const messages = [
      ["read-then-activity", 1, "xmatrix.message.text"],
      ["read-then-activity", 2, "xmatrix.activity"],
      ["read-then-activity", 3, "xmatrix.activity"],
      ["unread-speech", 1, "xmatrix.message.text"],
      ["unread-speech", 2, "xmatrix.activity"],
      ["unread-speech", 3, "xmatrix.message.text"],
      ["activity-only", 1, "xmatrix.activity"],
    ];
    for (const [channelId, sequence, kind] of messages) {
      await client.query(`INSERT INTO data.messages
        (space_id,channel_id,message_id,timeline_sequence,entity_version,author_kind,author_id,
         message_kind,content_hash,payload_kind,payload_ref,sent_at,updated_at,search_rank_sequence,
         legacy_body,created_at)
        VALUES ($1,$2,$3,$4,1,'agent','agent-1',$5,'hash','inline','inline',$6,$6,$3,'body',$6)`,
        [SPACE, channelId, `${channelId}-${sequence}`, sequence, kind, now]);
    }
    await client.query(`INSERT INTO data.delivery_cursors
      (space_id,subject_id,channel_id,acknowledged_sequence,version,updated_at)
      VALUES ($1,'user:reader','read-then-activity',1,1,$2),
        ($1,'user:reader','unread-speech',1,1,$2)`, [SPACE, now]);
  } finally {
    await client.end();
  }
}

integration("activity after a reader's cursor neither makes a conversation unread nor counts", async () => {
  await seed();
  const database = integrationAuthority();
  const session = database.openSession();
  try {
    const repository = new PostgresChannelCatalogRepository(session, true);
    const base = { spaceId: SPACE, principal: { kind: "user", id: "reader" } };
    const unread = await repository.page({ ...base, requestId: "unread", view: "flat", filter: "unread" });
    assert.deepEqual(unread.rows.map((row) => row.channel.id), ["unread-speech"]);
    assert.equal(unread.counts.unread, 1);

    const resolved = await repository.resolve({
      ...base, requestId: "resolve",
      channelIds: ["read-then-activity", "unread-speech", "activity-only"],
    });
    const byId = new Map(resolved.channels.map((channel) => [channel.id, channel]));
    // Caught up but for activity: read through the head.
    assert.equal(byId.get("read-then-activity").historyHeadSequence, 3);
    assert.equal(byId.get("read-then-activity").readSequence, 3);
    // Unread speech at 3 behind activity at 2: read up to just before it.
    assert.equal(byId.get("unread-speech").readSequence, 2);
    // Never opened, nothing but activity: nothing to read.
    assert.equal(byId.get("activity-only").readSequence, 1);

    const flat = await repository.page({ ...base, requestId: "flat", view: "flat", filter: "all" });
    const pageById = new Map(flat.rows.map((row) => [row.channel.id, row.channel]));
    assert.equal(pageById.get("read-then-activity").readSequence, 3);
    assert.equal(pageById.get("unread-speech").readSequence, 2);
  } finally {
    await session.close();
  }
});
