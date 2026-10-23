import { connectionString as url, integration, postgresConnections } from "./postgres-database.fixture.mjs";
import assert from "node:assert/strict";
import { Client } from "pg";
import { PostgresRuntimeRepository } from "../dist/runtime-control.js";

// Runs against a fully migrated database (`scripts/migrate.mjs apply`).

/**
 * Idle sleep is the Hub's decision (docs/instance-sleep.md): a resting Run's
 * sleep falls due a window after it starts resting, keeps that due time while
 * it rests, and is withdrawn the moment it works again. Only a Run the next
 * message can wake may sleep.
 */
integration("a resting Run's sleep falls due once, holds while it rests and is withdrawn when it works", async () => {
  const setup = new Client({ connectionString: url }); await setup.connect();
  const sql = (text, values) => setup.query(text, values);
  const id = `idle-sleep-${process.pid}-${Date.now()}`;
  const space = `space-${id}`, channel = `channel-${id}`, owner = `human-${id}`;
  try {
    await sql(`INSERT INTO control.postgres_shards VALUES ('shard-0','active','shard-0',now(),now()) ON CONFLICT DO NOTHING`);
    await sql(`INSERT INTO control.space_placement (space_id,shard_id,placement_epoch,state,plan_class,created_at,updated_at)
      VALUES ($1,'shard-0',1,'active','standard',now(),now())`, [space]);
    await sql(`INSERT INTO control.channel_space_directory (channel_id,space_id,updated_at) VALUES ($1,$2,now())`, [channel, space]);
    await sql(`INSERT INTO data.space_control_heads (space_id,commit_sequence,updated_at) VALUES ($1,0,now())`, [space]);
    await sql(`INSERT INTO data.channels (channel_id,space_id,name,name_key,mode,search_rank_sequence,version,created_at,updated_at,metadata_json)
      VALUES ($1,$2,$1,$1,'open',$1,1,now(),now(),'{}')`, [channel, space]);
    const resumable = { machineId: "machine-1", executionKey: "execution-1", resumeSessionKey: "session-1" };
    for (const [runId, metadata] of [[`${channel}:1#1`, resumable],
      [`${channel}:2#1`, { machineId: "machine-1", executionKey: "execution-2" }],
      [`${channel}:3#1`, { ...resumable, automationId: "automation-1", automationOccurrenceId: "occurrence-1" }]]) {
      await sql(`INSERT INTO data.runs (run_id,owner_user_id,channel_id,status,version,metadata_json,created_at,updated_at)
        VALUES ($1,$2,$3,'running',1,$4::jsonb,now(),now())`, [runId, owner, channel, JSON.stringify(metadata)]);
    }
    const repository = new PostgresRuntimeRepository(postgresConnections(10_000));
    const mark = (runId, resting) => repository.markRunResting({ requestId: `${id}-${Math.random()}`, actorUserId: owner,
      runId, channelId: channel, resting, windowMs: 30 * 60 * 1000 });

    const first = await mark(`${channel}:1#1`, true);
    assert.equal(first.started, true);
    const dueIn = Date.parse(first.idleSleepAt) - Date.now();
    assert.ok(dueIn > 29 * 60 * 1000 && dueIn <= 30 * 60 * 1000, `due ${dueIn}ms from now`);
    const again = await mark(`${channel}:1#1`, true);
    assert.deepEqual(again, { idleSleepAt: first.idleSleepAt, started: false }, "a Run still resting keeps its due time");
    assert.deepEqual(await mark(`${channel}:1#1`, false), { idleSleepAt: null, started: false });
    const [row] = (await sql(`SELECT idle_sleep_at FROM data.runs WHERE run_id=$1`, [`${channel}:1#1`])).rows;
    assert.equal(row.idle_sleep_at, null, "working again withdraws the sleep");

    for (const runId of [`${channel}:2#1`, `${channel}:3#1`]) {
      assert.deepEqual(await mark(runId, true), { idleSleepAt: null, started: false }, `${runId} cannot be woken, so never sleeps`);
    }
    await sql("UPDATE data.runs SET status='exited' WHERE run_id=$1", [`${channel}:1#1`]);
    assert.deepEqual(await mark(`${channel}:1#1`, true), { idleSleepAt: null, started: false }, "an ended Run does not sleep");
  } finally {
    await setup.end();
  }
});
