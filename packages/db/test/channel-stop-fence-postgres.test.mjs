import { connectionString as url, integration, postgresConnections } from "./postgres-database.fixture.mjs";
import assert from "node:assert/strict";
import { Client } from "pg";
import { fenceChannelRunsForStop } from "../dist/channel-stop-fence.js";
import { PostgresRuntimeRepository } from "../dist/runtime-control.js";

// Runs against a fully migrated database (`scripts/migrate.mjs apply`).

const database = () => postgresConnections(10_000);
async function seed(sql, id) {
  const space = `space-${id}`, channel = `channel-${id}`, other = `other-${id}`;
  await sql(`INSERT INTO control.postgres_shards VALUES ('shard-0','active','shard-0',now(),now())
    ON CONFLICT DO NOTHING`);
  await sql(`INSERT INTO control.space_placement (space_id,shard_id,placement_epoch,state,plan_class,created_at,updated_at)
    VALUES ($1,'shard-0',1,'active','standard',now(),now())`, [space]);
  await sql(`INSERT INTO control.channel_space_directory (channel_id,space_id,updated_at)
    VALUES ($1,$3,now()),($2,$3,now())`, [channel, other, space]);
  await sql(`INSERT INTO data.space_control_heads (space_id,commit_sequence,updated_at) VALUES ($1,0,now())`, [space]);
  await sql(`INSERT INTO data.channels (channel_id,space_id,name,name_key,mode,search_rank_sequence,version,created_at,updated_at,metadata_json)
    VALUES ($1,$3,$1,$1,'open',$1,1,now(),now(),'{}'),($2,$3,$2,$2,'open',$2,1,now(),now(),'{}')`,
  [channel, other, space]);
  await sql(`INSERT INTO data.space_members (space_id,user_id,role,version,created_at,updated_at)
    VALUES ($1,$2,'member',1,now(),now()),($1,$3,'viewer',1,now(),now())`, [space, `human-${id}`, `viewer-${id}`]);
  const host = { machineId: "machine-1", hostId: "host-1" };
  const runs = [
    ["live", channel, "running", "online", host],
    ["spawning", channel, "starting", "offline", host],
    ["done", channel, "stopped", "offline", host],
    ["about", channel, "running", "online", { ...host, routedAs: "management_channel_about" }],
    ["elsewhere", other, "running", "online", host],
  ];
  const ids = {};
  // Every Run executes under its Space Agent registration.
  await sql(`INSERT INTO data.agent_registrations VALUES ($1,'machine-1','codex',1,now(),now())`, [`human-${id}`]);
  await sql(`INSERT INTO data.space_agent_registrations VALUES ($1,$2,'machine-1','codex','codex','{}',1,now(),now())`,
    [space, `human-${id}`]);
  for (const [index, [name, channelId, status, instanceStatus, metadata]] of runs.entries()) {
    // Natural identities: `<channel>:<ordinal>` and its first Run `#1`.
    const instanceId = `${channelId}:${index + 1}`, runId = `${instanceId}#1`;
    ids[name] = { runId, instanceId };
    await sql(`INSERT INTO data.runs (run_id,owner_user_id,channel_id,status,version,metadata_json,created_at,updated_at)
      VALUES ($1,$2,$3,$4,1,$5::jsonb,now(),now())`, [runId, `human-${id}`, channelId, status,
      JSON.stringify({ ...metadata, executionKey: `execution-${name}-${id}` })]);
    await sql(`INSERT INTO data.instances (instance_id,run_id,channel_id,channel_instance_id,status,version,created_at,updated_at)
      VALUES ($1,$2,$3,$4,$5,1,now(),now())`, [instanceId, runId, channelId, index + 1, instanceStatus]);
    await sql(`INSERT INTO data.run_agent_registrations (run_id,space_id,owner_user_id,machine_id,harness,actor_user_id,
        allocation_id,authorization_digest,grant_revision,grant_execution_revision,policy_revision,
        policy_execution_revision,requested_json)
      VALUES ($1,$2,$3,'machine-1','codex',$3,$4,repeat('a',64),1,1,1,1,'{}')`,
    [runId, space, `human-${id}`, `allocation:${runId}`]);
  }
  await sql(`INSERT INTO data.agent_launches (launch_id,space_id,channel_id,trigger_id,launch_kind,owner_user_id,run_id,
      instance_id,execution_key,control_id,machine_id,hostname,state,spawn_payload_json,next_attempt_at,created_at,updated_at)
    VALUES ($1,$2,$3,'trigger','mention',$4,$5,$6,$7,$8,'machine-1','host-1','admitted','{}',now(),now(),now())`,
  [`launch-${id}`, space, channel, `human-${id}`, ids.spawning.runId, ids.spawning.instanceId,
    `execution-spawning-${id}`, `control-${id}`]);
  return { space, channel, ids };
}

integration("handoff resolves an exited source and stops only its exact rest before a successor replies", async () => {
  const setup = new Client({ connectionString: url }); await setup.connect();
  const sql = (text, values) => setup.query(text, values);
  const id = `handoff-rest-${process.pid}-${Date.now()}`;
  try {
    const { channel, ids } = await seed(sql, id);
    const repository = new PostgresRuntimeRepository(database());
    const handoffSource = ids.done;
    const input = { requestId: `handoff-${id}`, channelId: channel, actorUserId: `human-${id}` };
    for (const target of [ids.done, ids.spawning]) {
      await sql("UPDATE data.runs SET status='exited' WHERE run_id=$1", [target.runId]);
      await sql("UPDATE data.instances SET status='offline',rest_state='sleeping' WHERE instance_id=$1", [target.instanceId]);
    }
    const ordinary = await repository.listChannelAgentKillTargets(input);
    assert.equal(ordinary.targets.some(target => target.instanceId === handoffSource.instanceId), false);
    const handoff = await repository.listChannelAgentKillTargets({ ...input, handoffSource });
    assert.deepEqual(handoff.targets.map(target => ({ instanceId: target.instanceId, runId: target.runId })), [handoffSource]);
    assert.deepEqual((await repository.listChannelAgentKillTargets({ ...input, handoffSource: ids.elsewhere })).targets, []);
    await assert.rejects(repository.listChannelAgentKillTargets({ ...input, actorUserId: `viewer-${id}`, handoffSource }),
      error => error.status === 403 || error.status === 404);
    await assert.rejects(repository.stopRestingInstances({ ...input,
      handoffSource: { ...handoffSource, runId: ids.live.runId } }), error => error.code === "reborn_source_changed");
    const stopped = await repository.stopRestingInstances({ ...input, handoffSource });
    assert.deepEqual(stopped.stopped.map(target => target.instanceId), [handoffSource.instanceId]);
    const states = (await sql("SELECT instance_id,rest_state FROM data.instances WHERE instance_id=ANY($1::text[])",
      [[ids.done.instanceId, ids.spawning.instanceId]])).rows;
    assert.equal(states.find(row => row.instance_id === ids.done.instanceId).rest_state, "stopped");
    assert.equal(states.find(row => row.instance_id === ids.spawning.instanceId).rest_state, "sleeping");
    assert.deepEqual((await repository.stopRestingInstances({ ...input, handoffSource })).stopped, [], "stop replay is idempotent");
    assert.equal((await repository.listChannelAgentKillTargets({ ...input, handoffSource })).targets.length, 1,
      "the source remains addressable for stop/export replay");
  } finally {
    await setup.end();
  }
});

integration("a /kill all append fences every live Run in its Channel, including one still spawning", async () => {
  const setup = new Client({ connectionString: url }); await setup.connect();
  const sql = (text, values) => setup.query(text, values);
  const id = `fence-${process.pid}-${Date.now()}`;
  try {
    const { space, channel, ids } = await seed(sql, id);
    const db = database();
    const at = new Date().toISOString();
    // A viewer cannot terminalize Runs: the message may commit, but nothing is fenced.
    assert.equal(await db.transaction({}, tx => fenceChannelRunsForStop(tx, { spaceId: space, channelId: channel,
      actorUserId: `viewer-${id}`, sourceMessageId: `message-viewer-${id}`, at, scope: { kind: "channel" } })), 0);
    assert.equal(await db.transaction({}, tx => fenceChannelRunsForStop(tx, { spaceId: space, channelId: channel,
      actorUserId: `human-${id}`, sourceMessageId: `message-${id}`, at, scope: { kind: "channel" } })), 2);

    const { rows } = await sql(`SELECT run_id,status,version,metadata_json->'stopRequest' AS stop FROM data.runs
      WHERE run_id = ANY($1::text[])`, [Object.values(ids).map(value => value.runId)]);
    const byName = Object.fromEntries(Object.entries(ids).map(([name, value]) =>
      [name, rows.find(row => row.run_id === value.runId)]));
    for (const name of ["live", "spawning"]) {
      assert.equal(byName[name].status, "stopping", name);
      assert.equal(Number(byName[name].version), 2, name);
      assert.deepEqual(byName[name].stop, { sourceMessageId: `message-${id}`, actorUserId: `human-${id}`, requestedAt: at });
    }
    assert.equal(byName.done.status, "stopped");
    assert.equal(byName.about.status, "running");
    assert.equal(byName.elsewhere.status, "running");
    const launch = (await sql(`SELECT state,retryable FROM data.agent_launches WHERE launch_id=$1`, [`launch-${id}`])).rows[0];
    assert.deepEqual(launch, { state: "cancelled", retryable: false });
    const outbox = (await sql(`SELECT aggregate_id,payload_json FROM data.outbox WHERE space_id=$1 ORDER BY aggregate_sequence`,
      [space])).rows;
    assert.deepEqual(outbox.map(row => [row.aggregate_id, row.payload_json.status, row.payload_json.entityVersion]),
      [[ids.live.runId, "stopping", 2], [ids.spawning.runId, "stopping", 2]]);

    // The Hub then stops both on their host; the spawning Run's Instance is
    // still offline, and it remains a target because the append fenced it.
    const listed = await new PostgresRuntimeRepository(db).listChannelAgentKillTargets({
      requestId: `targets-${id}`, channelId: channel, actorUserId: `human-${id}` });
    assert.deepEqual(listed.targets.map(target => [target.runId, target.stopRequestSourceMessageId]).sort(),
      [[ids.live.runId, `message-${id}`], [ids.spawning.runId, `message-${id}`]]);

    // A second /kill all finds nothing left to fence.
    assert.equal(await db.transaction({}, tx => fenceChannelRunsForStop(tx, { spaceId: space, channelId: channel,
      actorUserId: `human-${id}`, sourceMessageId: `message-again-${id}`, at, scope: { kind: "channel" } })), 0);
  } finally {
    await setup.end();
  }
});

integration("the fence waits for an in-flight Agent append's Run lock instead of racing past it", async () => {
  const setup = new Client({ connectionString: url }); await setup.connect();
  const sql = (text, values) => setup.query(text, values);
  const id = `race-${process.pid}-${Date.now()}`;
  const agent = new Client({ connectionString: url }); await agent.connect();
  try {
    const { space, channel, ids } = await seed(sql, id);
    // What an Agent append holds from its Run proof until it commits.
    await agent.query("BEGIN");
    await agent.query(`SELECT r.status FROM data.runs r JOIN data.instances i ON i.run_id=r.run_id
      WHERE r.run_id=$1 LIMIT 1 FOR SHARE OF r`, [ids.live.runId]);
    let fenced = false;
    const fence = database().transaction({}, tx => fenceChannelRunsForStop(tx, { spaceId: space, channelId: channel,
      actorUserId: `human-${id}`, sourceMessageId: `message-${id}`, at: new Date().toISOString(),
      scope: { kind: "channel" } }))
      .then((count) => { fenced = true; return count; });
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(fenced, false, "the fence must not commit while the Agent append holds its Run");
    await agent.query("COMMIT");
    assert.equal(await fence, 2);
    // After the fence commits, the same Run proof reads a Run that may not write.
    const after = (await sql(`SELECT status FROM data.runs WHERE run_id=$1`, [ids.live.runId])).rows[0];
    assert.equal(after.status, "stopping");
  } finally {
    await agent.end().catch(() => {});
    await setup.end();
  }
});

integration("an exact stop fences only its Run; a Channel stop then takes the rest but never About", async () => {
  const setup = new Client({ connectionString: url }); await setup.connect();
  const sql = (text, values) => setup.query(text, values);
  const id = `exact-${process.pid}-${Date.now()}`;
  try {
    const { space, channel, ids } = await seed(sql, id);
    const db = database();
    const fence = (scope, message) => db.transaction({}, tx => fenceChannelRunsForStop(tx, { spaceId: space,
      channelId: channel, actorUserId: `human-${id}`, sourceMessageId: message, at: new Date().toISOString(), scope }));
    const status = async () => Object.fromEntries((await sql(`SELECT run_id,status FROM data.runs WHERE run_id=ANY($1::text[])`,
      [Object.values(ids).map(value => value.runId)])).rows.map(row => [row.run_id, row.status]));

    // Another Channel's Run cannot be named by this Channel's stop.
    assert.equal(await fence({ kind: "run", runId: ids.elsewhere.runId }, `message-other-${id}`), 0);
    assert.equal(await fence({ kind: "run", runId: ids.live.runId }, `message-exact-${id}`), 1);
    let current = await status();
    assert.equal(current[ids.live.runId], "stopping");
    assert.equal(current[ids.spawning.runId], "starting");
    assert.equal(current[ids.elsewhere.runId], "running");

    assert.equal(await fence({ kind: "channel" }, `message-all-${id}`), 1);
    current = await status();
    assert.equal(current[ids.spawning.runId], "stopping");
    assert.equal(current[ids.about.runId], "running", "About is never a stop target");
    assert.equal(current[ids.elsewhere.runId], "running");
  } finally {
    await setup.end();
  }
});

integration("an Agent's stop fences its own Run in the append that holds that Run's lock", async () => {
  const setup = new Client({ connectionString: url }); await setup.connect();
  const sql = (text, values) => setup.query(text, values);
  const id = `self-${process.pid}-${Date.now()}`;
  try {
    const { space, channel, ids } = await seed(sql, id);
    // The Agent append's Run proof share lock, then the fence, in one transaction.
    const count = await database().transaction({}, async tx => {
      await tx.query({ name: "proof", text: `SELECT r.status FROM data.runs r WHERE r.run_id=$1 FOR SHARE OF r`,
        values: [ids.live.runId], maxRows: 1 });
      return fenceChannelRunsForStop(tx, { spaceId: space, channelId: channel, actorUserId: `human-${id}`,
        sourceMessageId: `message-${id}`, at: new Date().toISOString(), scope: { kind: "channel" } });
    });
    assert.equal(count, 2);
    const own = (await sql(`SELECT status FROM data.runs WHERE run_id=$1`, [ids.live.runId])).rows[0];
    assert.equal(own.status, "stopping");
  } finally {
    await setup.end();
  }
});
