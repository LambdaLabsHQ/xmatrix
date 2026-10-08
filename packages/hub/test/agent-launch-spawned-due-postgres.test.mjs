import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { createAuthorityDatabase } from "../../db/src/index.ts";
import { claim, nextChannelStepDue } from "../src/postgres-agent-launch-coordinator.ts";

const nextChannelDueAt = async (database, shardId, channelId) => {
  const times = Object.values(await nextChannelStepDue(database, shardId, channelId));
  return times.length ? Math.min(...times) : undefined;
};

const url = process.env.XMATRIX_TEST_POSTGRES_URL;
const integration = url || process.env.XMATRIX_REQUIRE_POSTGRES_TEST === "true" ? test : test.skip;

// 2026-10-02: eight Channel About sessions — background Runs that never
// connect an Instance — stayed `spawned` for 6 to 11 hours. Each was re-read
// every 5 seconds, and every re-read ran its Channel's full coordinator pass:
// about 60% of RelayPostgresAgentLaunchChannel's Durable Object duration.
integration("a spawned Launch whose spawn is recorded is not due, so it no longer drives its Channel", async () => {
  assert.ok(url, "XMATRIX_TEST_POSTGRES_URL is required");
  const database = createAuthorityDatabase({ connectionString: url, shardId: "shard-0" }).openSession();
  const id = randomUUID(), space = `space-${id}`, channel = `channel-${id}`;
  const sql = (text, values = [], maxRows = 10) => database.transaction({ requestId: id, operation: "test.launch-spawned-due" },
    tx => tx.query({ name: `test_launch_spawned_due_${randomUUID()}`, text, values, maxRows }));
  try {
    await sql(`INSERT INTO control.postgres_shards VALUES ('shard-0','active','shard-0',now(),now()) ON CONFLICT DO NOTHING`, [], 0);
    await sql(`INSERT INTO control.space_placement (space_id,shard_id,placement_epoch,state,plan_class,created_at,updated_at)
      VALUES ($1,'shard-0',1,'active','standard',now(),now())`, [space], 0);
    await sql(`INSERT INTO data.space_control_heads (space_id,commit_sequence,updated_at) VALUES ($1,0,now())`, [space], 0);
    let ordinal = 0;
    const launch = async (name, state, spawned, durable) => {
      // Natural identities: `<channel>:<ordinal>` and its first Run `#1`.
      const instanceId = `${channel}:${++ordinal}`, runId = `${instanceId}#1`;
      await sql(`INSERT INTO data.runs (run_id,owner_user_id,channel_id,status,version,metadata_json,created_at,updated_at)
        VALUES ($1,'owner',$2,'running',1,'{"routedAs":"management_channel_about"}'::jsonb,now(),now())`, [runId, channel], 0);
      await sql(`INSERT INTO data.agent_launches (launch_id,space_id,channel_id,trigger_id,launch_kind,owner_user_id,run_id,
          instance_id,execution_key,control_id,machine_id,hostname,state,spawn_payload_json,next_attempt_at,
          spawned_at,command_durable_at,created_at,updated_at)
        VALUES ($1,$2,$3,'trigger','registration','owner',$4,$5,$1,$1,'machine','host',$6,'{}',now()-interval '1 minute',
          CASE WHEN $7 THEN now()-interval '1 hour' END,CASE WHEN $8 THEN now()-interval '1 hour' END,
          now()-interval '1 hour',now()-interval '1 hour')`,
      [`launch-${name}-${id}`, space, channel, runId, instanceId, state, spawned, durable], 0);
    };

    // A spawn whose recording is complete: a re-read cannot change it.
    await launch("about", "spawned", true, true);
    assert.equal(await nextChannelDueAt(database, "shard-0", channel), undefined);
    assert.deepEqual(await claim(database, "shard-0", `owner-${id}`, { channelId: channel, launchIds: [] }), []);

    // A spawn still missing its spawn or command time is read once more.
    await launch("unrecorded", "spawned", false, true);
    await launch("undurable", "spawned", true, false);
    assert.ok(await nextChannelDueAt(database, "shard-0", channel) <= Date.now());
    // Only Launch work is due, so a timed pass runs only the Launch steps.
    const due = await nextChannelStepDue(database, "shard-0", channel);
    assert.deepEqual(Object.keys(due), ["launch"]);
    assert.ok(due.launch <= Date.now());
    const claimed = await claim(database, "shard-0", `owner-${id}`, { channelId: channel, launchIds: [] });
    assert.deepEqual(claimed.map(row => row.launch_id).sort(),
      [`launch-undurable-${id}`, `launch-unrecorded-${id}`].sort());
  } finally {
    await database.close();
  }
});
