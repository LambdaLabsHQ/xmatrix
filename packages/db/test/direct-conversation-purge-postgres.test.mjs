import { integration, migrationFixture } from "./postgres-database.fixture.mjs";
import assert from "node:assert/strict";

// 0138 removes every direct conversation and every fact keyed
// by it, keeps ordinary conversations, refuses to run under a live Instance, and
// drops the index that kept one conversation per participant pair.
const MIGRATION = "0138_contract_purge_direct_conversations";

const direct = (...participants) => JSON.stringify({
  kind: "direct",
  participantKey: participants.map(([kind, id]) => `${kind}:${id}`).sort().join("\n"),
  participants: participants.map(([kind, id]) => ({ kind, id })),
});

integration("0138 purges every direct conversation and nothing else", async () => {
  const fixture = await migrationFixture("retired_direct", MIGRATION);
  const { client, run, source } = fixture;
  try {
    const apply = async () => {
      await run("BEGIN");
      try {
        await client.query(source);
        await run("COMMIT");
      } catch (error) {
        await run("ROLLBACK");
        throw error;
      }
    };

    // Every table keyed by a Channel or conversation is purged, except the purge record itself.
    const keyed = (await run(`SELECT DISTINCT c.table_schema||'.'||c.table_name AS name
      FROM information_schema.columns c JOIN information_schema.tables t USING (table_schema,table_name)
      WHERE t.table_type='BASE TABLE' AND c.table_schema IN ('data','control')
        AND c.column_name IN ('channel_id','conversation_id') ORDER BY 1`)).map((row) => row.name);
    assert.deepEqual(keyed.filter((table) => table !== "data.retired_agent_dm_purges" &&
      table !== "data.retired_direct_conversation_purges" &&
      !new RegExp(`DELETE FROM ${table.replace(".", "\\.")}\\s`, "u").test(source)), []);

    const space = "space-1";
    const channels = {
      humanDm: ["human-dm", direct(["user", "ada"], ["user", "grace"])],
      otherDm: ["other-dm", direct(["user", "grace"], ["user", "linus"])],
      ordinary: ["general", JSON.stringify({})],
    };
    for (const [index, [channelId, metadata]] of Object.values(channels).entries()) {
      await run(`INSERT INTO data.channels (channel_id,space_id,name,name_key,mode,search_rank_sequence,version,
          metadata_json,created_at,updated_at)
        VALUES ($1,$2,$1,$1,'closed',$4,1,$3::jsonb,now(),now())`, [channelId, space, metadata, `c${index}`]);
      await run(`INSERT INTO control.channel_space_directory (channel_id,space_id,updated_at) VALUES ($1,$2,now())`,
        [channelId, space]);
      await run(`INSERT INTO control.channel_space_routes (channel_id,space_id,shard_id,placement_epoch,entity_version,
          state,updated_at) VALUES ($1,$2,'shard-0',1,1,'active',now())`, [channelId, space]);
      await run(`INSERT INTO data.channel_access (space_id,channel_id,subject_kind,subject_id,grant_version,
          created_at,updated_at) VALUES ($1,$2,'user','ada',1,now(),now())`, [space, channelId]);
      await run(`INSERT INTO data.messages (space_id,channel_id,message_id,timeline_sequence,entity_version,author_kind,
          author_id,message_kind,content_hash,payload_kind,payload_ref,sent_at,updated_at,search_rank_sequence,created_at)
        VALUES ($1,$2,$2||'-m1',1,1,'user','ada','message',repeat('a',64),'hot-inline','inline',now(),now(),$3,now())`,
      [space, channelId, `m${index}`]);
      await run(`INSERT INTO data.runs (run_id,owner_user_id,channel_id,status,version,created_at,updated_at)
        VALUES ($1||':1#1','ada',$1,'stopped',1,now(),now())`, [channelId]);
      await run(`INSERT INTO data.instances (instance_id,run_id,channel_id,channel_instance_id,status,version,
          created_at,updated_at) VALUES ($1||':1',$1||':1#1',$1,1,'offline',1,now(),now())`, [channelId]);
      await run(`INSERT INTO control.entity_space_routes (entity_kind,entity_id,space_id,shard_id,placement_epoch,
          entity_version,route_version,state,updated_at) VALUES ('channel',$1,$2,'shard-0',1,1,1,'active',now()),
          ('instance',$1||':1',$2,'shard-0',1,1,1,'active',now())`, [channelId, space]);
      await run(`INSERT INTO data.page_links (space_id,link_id,conversation_id,page_id,source,created_by_kind,
          created_by_id,created_at,last_seen_at) VALUES ($1,$2||'-link',$2,'page-1','read','user','ada',now(),now())`,
      [space, channelId]);
    }

    const footprint = async (channelId) => ({
      channels: (await run("SELECT 1 FROM data.channels WHERE channel_id=$1", [channelId])).length,
      directory: (await run("SELECT 1 FROM control.channel_space_directory WHERE channel_id=$1", [channelId])).length,
      routes: (await run("SELECT 1 FROM control.channel_space_routes WHERE channel_id=$1", [channelId])).length,
      access: (await run("SELECT 1 FROM data.channel_access WHERE channel_id=$1", [channelId])).length,
      messages: (await run("SELECT 1 FROM data.messages WHERE channel_id=$1", [channelId])).length,
      runs: (await run("SELECT 1 FROM data.runs WHERE channel_id=$1", [channelId])).length,
      instances: (await run("SELECT 1 FROM data.instances WHERE channel_id=$1", [channelId])).length,
      entityRoutes: (await run(`SELECT 1 FROM control.entity_space_routes
        WHERE entity_id IN ($1, $1||':1')`, [channelId])).length,
      pageLinks: (await run("SELECT 1 FROM data.page_links WHERE conversation_id=$1", [channelId])).length,
    });
    const intact = { channels: 1, directory: 1, routes: 1, access: 1, messages: 1, runs: 1, instances: 1,
      entityRoutes: 2, pageLinks: 1 };

    // A live Instance in a direct conversation is someone's session: nothing moves.
    await run("UPDATE data.instances SET status='online' WHERE channel_id='human-dm'");
    await assert.rejects(apply, /1 live Instance\(s\); stop them first/u);
    assert.deepEqual(await footprint("human-dm"), intact);
    assert.deepEqual(await run("SELECT * FROM data.retired_direct_conversation_purges"), []);

    await run("UPDATE data.instances SET status='offline' WHERE channel_id='human-dm'");
    await apply();
    const gone = Object.fromEntries(Object.keys(intact).map((key) => [key, 0]));
    assert.deepEqual(await footprint("human-dm"), gone);
    assert.deepEqual(await footprint("other-dm"), gone, "one the purging Human is not in goes too");
    assert.deepEqual(await footprint("general"), intact, "an ordinary conversation is untouched");
    assert.deepEqual(await run(`SELECT space_id,channel_id,participant_key,message_count::int
      FROM data.retired_direct_conversation_purges ORDER BY channel_id`), [
      { space_id: space, channel_id: "human-dm", participant_key: "user:ada\nuser:grace", message_count: 1 },
      { space_id: space, channel_id: "other-dm", participant_key: "user:grace\nuser:linus", message_count: 1 },
    ]);
    assert.deepEqual(await run(`SELECT 1 FROM pg_indexes
      WHERE schemaname='data' AND indexname='channels_active_direct_participant_key_idx'`), []);

    // Idempotent: applying again finds nothing and keeps the record.
    await apply();
    assert.equal((await run("SELECT 1 FROM data.retired_direct_conversation_purges")).length, 2);
  } finally { await fixture.close(); }
});
