import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { PostgresChannelCatalogRepository, PostgresRuntimeRepository, PostgresSpaceControlRepository } from "../dist/index.js";
import { loadChannelInstanceRecords } from "../dist/channel-agent-presence.js";
import { boundedPostgresTransaction, integration } from "./postgres-database.fixture.mjs";
import { spaceSecretFixture } from "./space-secret-postgres.fixture.mjs";

/**
 * The fixture's Channel holds Instance 1 (online, Run running). Add the other
 * states a Channel's Instances can be in, each under the same registration.
 */
async function addInstances(f) {
  const { ids, client } = f;
  const noResources = JSON.stringify({ workspaces: [], models: [], capabilities: [] });
  const add = async (ordinal, { status, restState = null, runStatus }) => {
    const instanceId = `${ids.channel}:${ordinal}`;
    const runId = `${instanceId}#1`;
    await client.query(`INSERT INTO data.runs (run_id,owner_user_id,channel_id,status,version,metadata_json,created_at,updated_at)
      VALUES ($1,$2,$3,$4,1,'{}',now(),now())`, [runId, ids.owner, ids.channel, runStatus]);
    await client.query(`INSERT INTO data.instances
      (instance_id,run_id,channel_id,channel_instance_id,status,rest_state,version,created_at,updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,1,now(),now())`, [instanceId, runId, ids.channel, ordinal, status, restState]);
    await client.query(`INSERT INTO data.run_agent_registrations
      (run_id,space_id,owner_user_id,machine_id,harness,actor_user_id,allocation_id,authorization_digest,
       grant_revision,grant_execution_revision,policy_revision,policy_execution_revision,requested_json)
      VALUES ($1,$2,$3,$4,'claude',$3,$5,repeat('a',64),1,1,1,1,$6::jsonb)`,
    [runId, ids.space, ids.owner, ids.machine, `${runId}:allocation`, noResources]);
    return { instanceId, runId };
  };
  const added = {
    sleeping: await add(2, { status: "offline", restState: "sleeping", runStatus: "exited" }),
    stopped: await add(3, { status: "offline", restState: "stopped", runStatus: "stopped" }),
    gone: await add(4, { status: "offline", runStatus: "exited" }),
    launching: await add(5, { status: "offline", runStatus: "starting" }),
  };
  // Instance 5 was summoned and has not connected yet: its launch is on its way.
  await client.query(`INSERT INTO data.agent_launches
    (launch_id,space_id,channel_id,trigger_id,launch_kind,owner_user_id,run_id,instance_id,execution_key,control_id,
     machine_id,hostname,state,spawn_payload_json,next_attempt_at,created_at,updated_at)
    VALUES ($1,$2,$3,$4,'registration',$5,$6,$7,$8,$9,$10,$11,'queued','{}',now(),now(),now())`,
  [`${added.launching.runId}:launch`, ids.space, ids.channel, `${added.launching.runId}:trigger`, ids.owner,
    added.launching.runId, added.launching.instanceId, `${added.launching.runId}:execution`,
    `${added.launching.runId}:control`, ids.machine, ids.host]);
  return {
    ...added,
    async remove() {
      const runIds = Object.values(added).map((entry) => entry.runId);
      await client.query("DELETE FROM data.agent_launches WHERE run_id=ANY($1::text[])", [runIds]);
      await client.query("DELETE FROM data.run_agent_registrations WHERE run_id=ANY($1::text[])", [runIds]);
      await client.query("DELETE FROM data.instances WHERE run_id=ANY($1::text[])", [runIds]);
      await client.query("DELETE FROM data.runs WHERE run_id=ANY($1::text[])", [runIds]);
    },
  };
}

const states = (records) => Object.fromEntries(records.map((record) => [record.id.split(":").at(-1),
  { status: record.status, ...(record.rest ? { rest: record.rest } : {}), revision: record.revision }]));

integration("a Channel window is self-contained versioned records; its exact read answers for every held id", async () => {
  const f = await spaceSecretFixture();
  const added = await addInstances(f);
  const principal = { kind: "user", id: f.ids.owner };
  try {
    const spaces = new PostgresSpaceControlRepository(f.database, "shard-0");
    const read = (knownInstanceIds) => spaces.getChannel({ requestId: randomUUID(), spaceId: f.ids.space,
      channelId: f.ids.channel, principal, ...(knownInstanceIds ? { knownInstanceIds } : {}) });

    // The window: every live Instance and the resting ones. Stopped and gone
    // Instances are not in it, and nothing there says they left.
    const { channel } = await read();
    const first = { version: 1, sequence: 0 };
    assert.deepEqual(states(channel.instanceRecords), {
      1: { status: "online", revision: first },
      2: { status: "offline", rest: "sleeping", revision: first },
      5: { status: "offline", rest: "waking", revision: first },
    });
    assert.equal(Object.hasOwn(channel, "missingInstanceIds"), false, "only an exact read names misses");
    const record = channel.instanceRecords.find((entry) => entry.id === f.ids.instance);
    assert.deepEqual(record.registration, { ownerUserId: f.ids.owner, machineId: f.ids.machine, harness: "claude" });
    assert.equal(record.channelId, f.ids.channel);
    assert.equal(record.channelInstanceId, "1");
    assert.equal(record.agentName, "claude");
    assert.equal(record.label, "claude:1");
    // The legacy member-keyed shape is derived from the same records.
    assert.deepEqual(Object.keys(channel.memberPresence).sort(),
      channel.instanceRecords.map((entry) => entry.id).sort());
    assert.equal(channel.memberPresence[f.ids.instance].instances[0].revision, undefined);

    // An empty Channel answers with an empty window, not with nothing.
    const empty = await loadChannelInstanceRecords(boundedPostgresTransaction(f.client), f.ids.space,
      [`${f.ids.channel}-empty`]);
    assert.deepEqual([...empty], [[`${f.ids.channel}-empty`, []]]);

    // Held ids are answered exactly, ended ones included. An id of this
    // Channel that no longer exists is named; another Channel's id is not
    // this read's to answer.
    const unknown = `${f.ids.channel}:99`;
    const exact = await read([f.ids.instance, added.stopped.instanceId, added.gone.instanceId, unknown,
      "another-channel:1"]);
    assert.deepEqual(states(exact.channel.instanceRecords), {
      1: { status: "online", revision: first },
      2: { status: "offline", rest: "sleeping", revision: first },
      3: { status: "offline", revision: first },
      4: { status: "offline", revision: first },
      5: { status: "offline", rest: "waking", revision: first },
    });
    assert.deepEqual(exact.channel.missingInstanceIds, [unknown]);

    // Resolve answers the same way, per resolved Channel.
    const catalog = new PostgresChannelCatalogRepository(f.database);
    const resolveInput = { requestId: randomUUID(), spaceId: f.ids.space, principal, channelIds: [f.ids.channel] };
    const resolved = await catalog.resolve({ ...resolveInput,
      knownInstanceIds: [added.stopped.instanceId, unknown] });
    assert.deepEqual(Object.keys(states(resolved.channels[0].instanceRecords)).sort(), ["1", "2", "3", "5"]);
    assert.deepEqual(resolved.channels[0].missingInstanceIds, [unknown]);
    const plain = await catalog.resolve(resolveInput);
    assert.deepEqual(Object.keys(states(plain.channels[0].instanceRecords)).sort(), ["1", "2", "5"]);
    assert.equal(Object.hasOwn(plain.channels[0], "missingInstanceIds"), false);
    const lean = await catalog.resolve({ ...resolveInput, includeParticipants: false, knownInstanceIds: [unknown] });
    assert.equal(Object.hasOwn(lean.channels[0], "instanceRecords"), false);

    // A reader who cannot read the Channel gets none of its ids answered.
    await assert.rejects(spaces.getChannel({ requestId: randomUUID(), spaceId: f.ids.space, channelId: f.ids.channel,
      principal: { kind: "user", id: `${f.ids.owner}-stranger` }, knownInstanceIds: [f.ids.instance] }),
    (error) => error.code === "channel_not_found" || error.code === "space_not_found");
  } finally {
    await added.remove();
    await f.close();
  }
});

integration("a connection's reports are ordered by (version, sequence) and fenced to the row's current version", async () => {
  const f = await spaceSecretFixture();
  const runtime = new PostgresRuntimeRepository(f.database);
  const spaces = new PostgresSpaceControlRepository(f.database, "shard-0");
  const read = async () => {
    const { channel } = await spaces.getChannel({ requestId: randomUUID(), spaceId: f.ids.space,
      channelId: f.ids.channel, principal: { kind: "user", id: f.ids.owner }, knownInstanceIds: [f.ids.instance] });
    return channel.instanceRecords.find((entry) => entry.id === f.ids.instance);
  };
  const current = async () => {
    const record = await read();
    return { status: record.status, ...(record.rest ? { rest: record.rest } : {}), revision: record.revision };
  };
  const report = (fields) => runtime.recordInstancePresentation({ requestId: randomUUID(), actorUserId: f.ids.owner,
    spaceId: f.ids.space, instanceId: f.ids.instance, presentation: { model: "m" }, at: new Date().toISOString(),
    ...fields });
  const ordered = (version, sequence, status, runId = f.ids.run) =>
    report({ status, expectedVersion: version, runId, presenceSequence: sequence });
  // Lifecycle commands commit against the Space's control head.
  await f.client.query("INSERT INTO data.space_control_heads(space_id,commit_sequence,updated_at) VALUES($1,0,now())",
    [f.ids.space]);
  try {
    const written = await ordered(1, 2, "busy");
    assert.equal(written.recorded, true);
    assert.deepEqual(await current(), { status: "busy", revision: { version: 1, sequence: 2 } });
    // The write answers with the record any later read returns at that revision.
    assert.deepEqual(written.record, await read());
    // An overtaken report, a replay, another Run's or another version's: refused, and nothing moves.
    for (const refused of [ordered(1, 1, "idle"), ordered(1, 2, "idle"), ordered(1, 3, "idle", `${f.ids.run}-other`),
      ordered(2, 3, "idle")]) {
      assert.equal((await refused).recorded, false);
    }
    assert.deepEqual(await current(), { status: "busy", revision: { version: 1, sequence: 2 } });
    await assert.rejects(report({ status: "idle", expectedVersion: 1, presenceSequence: 3 }),
      (error) => error.code === "invalid_runtime_request");
    // A report that cannot order itself never overwrites one that did, nor stamps an order.
    assert.equal((await report({ status: "idle", presentation: { model: "m", presenceVersion: 1,
      presenceSequence: 99 } })).recorded, false);
    assert.deepEqual(await current(), { status: "busy", revision: { version: 1, sequence: 2 } });
    assert.equal((await ordered(1, 3, "idle")).recorded, true);

    // A reconnect claims the next version: the row's earlier sequence no
    // longer counts, and the predecessor socket can no longer report.
    const connected = await runtime.mutate({ kind: "instance_connect", instanceId: f.ids.instance,
      actorUserId: f.ids.owner, commandId: randomUUID(), at: new Date().toISOString() });
    assert.equal(connected.entityVersion, 2);
    assert.deepEqual(await current(), { status: "online", revision: { version: 2, sequence: 0 } });
    assert.equal((await ordered(1, 4, "busy")).recorded, false);
    // Until an ordered report claims this version, an unordered one may still
    // write, and stores no sequence (and one it carries is not its to stamp).
    assert.equal((await report({ status: "idle", presentation: { model: "m", presenceVersion: 2,
      presenceSequence: 99 } })).recorded, true);
    assert.deepEqual(await current(), { status: "idle", revision: { version: 2, sequence: 0 } });
    assert.equal((await ordered(2, 1, "busy")).recorded, true);
    assert.deepEqual(await current(), { status: "busy", revision: { version: 2, sequence: 1 } });

    // Its end is a further version, and an explicit terminal record: offline, no rest.
    await runtime.mutate({ kind: "instance_transition", instanceId: f.ids.instance, expectedVersion: 2,
      status: "offline", terminal: true, expectedRunId: f.ids.run, actorUserId: f.ids.owner,
      commandId: randomUUID(), at: new Date().toISOString() });
    assert.deepEqual(await current(), { status: "offline", revision: { version: 3, sequence: 0 } });
    assert.equal((await ordered(2, 2, "busy")).recorded, false, "the ended connection cannot report");
    // Even a report at the current version cannot revive it: liveness is the lifecycle's.
    assert.equal((await ordered(3, 1, "busy")).recorded, true);
    assert.equal((await current()).status, "offline");
  } finally {
    await f.client.query("DELETE FROM control.scoped_control_command_replays WHERE scope_kind='space' AND scope_id=$1",
      [f.ids.space]);
    await f.close();
  }
});
