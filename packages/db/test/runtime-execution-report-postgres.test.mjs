import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";

import { createAuthorityDatabase } from "../dist/index.js";
import { acknowledgeMachineExecution } from "../dist/runtime-message-executions.js";
import { integration, isolatedPostgres, seedTestSpacePlacement } from "./postgres-database.fixture.mjs";

// Every daemon execution report authorizes against its Run. The owner read
// returned the Run's whole metadata, kilobytes, to check one key, and it is
// among the most frequent statements: its result bytes are what PlanetScale
// bills as egress.
integration("an execution report reads its Run's execution key, not the Run's metadata", async () => {
  const fixture = await isolatedPostgres("execution_report_bytes");
  const sql = (text, values) => fixture.client.query(text, values);
  const observations = [];
  const database = createAuthorityDatabase({ connectionString: fixture.url.toString(), shardId: "shard-0",
    observer: (point) => observations.push(point) });
  const placement = { spaceId: "space", shardId: "shard-0", placementEpoch: 1 };
  try {
    await seedTestSpacePlacement(fixture.client, "space", new Date().toISOString());
    await sql(`INSERT INTO data.spaces(space_id,owner_user_id,name,search_rank_sequence,version,created_at,updated_at)
      VALUES ('space','owner','Test','space',1,now(),now())`);
    await sql(`INSERT INTO data.channels(channel_id,space_id,name,name_key,mode,search_rank_sequence,version,created_at,updated_at)
      VALUES ('channel','space','Channel','channel','open','channel',1,now(),now())`);
    await sql(`INSERT INTO data.agent_registrations VALUES ('owner','machine','codex',1,now(),now())`);
    await sql(`INSERT INTO data.space_agent_registrations
      VALUES ('space','owner','machine','codex','codex','{}',1,now(),now())`);
    // A Run's metadata carries its launch and presentation; 64 KB stands for a large one.
    await sql(`INSERT INTO data.runs(run_id,owner_user_id,channel_id,status,version,metadata_json,created_at,updated_at)
      VALUES ('channel:1#1','owner','channel','running',1,
        jsonb_build_object('executionKey','execution-key','machineId','machine','launch',repeat('x',65536)),now(),now())`);
    await sql(`INSERT INTO data.instances(instance_id,run_id,channel_id,channel_instance_id,status,version,created_at,updated_at)
      VALUES ('channel:1','channel:1#1','channel',1,'online',1,now(),now())`);
    await sql(`INSERT INTO data.run_agent_registrations(run_id,space_id,owner_user_id,machine_id,harness,
      actor_user_id,allocation_id,authorization_digest,grant_revision,grant_execution_revision,
      policy_revision,policy_execution_revision,requested_json)
      VALUES ('channel:1#1','space','owner','machine','codex','owner','allocation',repeat('a',64),1,1,1,1,
        '{"workspaces":[],"models":[],"capabilities":[]}')`);
    const now = Date.now();
    const payload = { schemaVersion: 1, requestId: randomUUID(), scope: { channelId: "channel", runId: "channel:1#1",
      instanceId: "channel:1", agentId: "channel:1",
      executionFingerprint: createHash("sha256").update("execution-key").digest("hex") },
      report: { executionId: randomUUID(), revision: 1, sourceCount: 1,
        sources: [{ channelId: "channel", messageId: "source", sequence: 1, entityVersion: 1, bodyHash: "a".repeat(64) }],
        state: "running", startedAtMillis: now, updatedAtMillis: now } };
    const receipt = await database.transaction({ requestId: "execution-report", operation: "runtime.execution-report",
      placement }, (tx) => acknowledgeMachineExecution(tx, { spaceId: "space", channelId: "channel",
      ownerUserId: "owner", machineId: "machine", hostId: "host", payload, at: new Date(now).toISOString() }));
    assert.equal(receipt.runId, "channel:1#1", "the report is authorized against its Run");
    const owner = observations.find((point) => point.queryName.startsWith("runtime_execution_report_owner_"));
    assert.ok(owner, "the owner read is observed");
    assert.ok(owner.resultBytes > 0 && owner.resultBytes < 1024,
      `the owner read returned ${owner.resultBytes} bytes for a Run with 64 KB of metadata`);
  } finally {
    await fixture.close();
  }
});

integration("mid-turn steered sources append to an active execution and terminalize every source", async () => {
  const fixture = await isolatedPostgres("exec_steered");
  const sql = (text, values) => fixture.client.query(text, values);
  const database = createAuthorityDatabase({ connectionString: fixture.url.toString(), shardId: "shard-0" });
  const placement = { spaceId: "space", shardId: "shard-0", placementEpoch: 1 };
  try {
    await seedTestSpacePlacement(fixture.client, "space", new Date().toISOString());
    await sql(`INSERT INTO data.spaces(space_id,owner_user_id,name,search_rank_sequence,version,created_at,updated_at)
      VALUES ('space','owner','Test','space',1,now(),now())`);
    await sql(`INSERT INTO data.channels(channel_id,space_id,name,name_key,mode,search_rank_sequence,version,created_at,updated_at)
      VALUES ('channel','space','Channel','channel','open','channel',1,now(),now())`);
    const bodyHash1 = "1".repeat(64);
    const bodyHash2 = "2".repeat(64);
    const bodyHash3 = "3".repeat(64);
    await sql(`INSERT INTO data.messages(
        space_id,channel_id,message_id,timeline_sequence,entity_version,author_kind,author_id,
        message_kind,content_hash,body_hash,payload_kind,payload_ref,sent_at,updated_at,created_at,search_rank_sequence
      ) VALUES
        ('space','channel','msg-1',1,1,'user','owner','xmatrix.message.text',$1,$1,'inline','fixture',now(),now(),now(),'msg-1'),
        ('space','channel','msg-2',2,1,'user','owner','xmatrix.message.text',$2,$2,'inline','fixture',now(),now(),now(),'msg-2'),
        ('space','channel','msg-3',3,1,'user','owner','xmatrix.message.text',$3,$3,'inline','fixture',now(),now(),now(),'msg-3')`,
      [bodyHash1, bodyHash2, bodyHash3]);
    await sql(`INSERT INTO data.agent_registrations VALUES ('owner','machine','antigravity',1,now(),now())`);
    await sql(`INSERT INTO data.space_agent_registrations
      VALUES ('space','owner','machine','antigravity','antigravity','{}',1,now(),now())`);
    await sql(`INSERT INTO data.runs(run_id,owner_user_id,channel_id,status,version,metadata_json,created_at,updated_at)
      VALUES ('channel:1#1','owner','channel','running',1,
        jsonb_build_object('executionKey','execution-key','machineId','machine'),now(),now())`);
    await sql(`INSERT INTO data.instances(instance_id,run_id,channel_id,channel_instance_id,status,version,created_at,updated_at)
      VALUES ('channel:1','channel:1#1','channel',1,'online',1,now(),now())`);
    await sql(`INSERT INTO data.run_agent_registrations(run_id,space_id,owner_user_id,machine_id,harness,
      actor_user_id,allocation_id,authorization_digest,grant_revision,grant_execution_revision,
      policy_revision,policy_execution_revision,requested_json)
      VALUES ('channel:1#1','space','owner','machine','antigravity','owner','allocation',repeat('a',64),1,1,1,1,
        '{"workspaces":[],"models":[],"capabilities":[]}')`);

    const startedAt = Date.now();
    const executionId = randomUUID();
    const scope = {
      channelId: "channel",
      runId: "channel:1#1",
      instanceId: "channel:1",
      agentId: "channel:1",
      executionFingerprint: createHash("sha256").update("execution-key").digest("hex"),
    };
    const src1 = { channelId: "channel", messageId: "msg-1", sequence: 1, entityVersion: 1, bodyHash: bodyHash1 };
    const src2 = { channelId: "channel", messageId: "msg-2", sequence: 2, entityVersion: 1, bodyHash: bodyHash2 };
    const src3 = { channelId: "channel", messageId: "msg-3", sequence: 3, entityVersion: 1, bodyHash: bodyHash3 };
    const submit = (report) => database.transaction({
      requestId: randomUUID(), operation: "runtime.execution-report", placement,
    }, (tx) => acknowledgeMachineExecution(tx, {
      spaceId: "space", channelId: "channel", ownerUserId: "owner", machineId: "machine", hostId: "host",
      payload: { schemaVersion: 1, requestId: randomUUID(), scope, report },
      at: new Date(report.updatedAtMillis).toISOString(),
    }));

    const r1 = await submit({
      executionId, revision: 1, sourceCount: 1, sources: [src1],
      state: "accepted", startedAtMillis: startedAt, updatedAtMillis: startedAt,
    });
    assert.equal(r1.status, "recorded");

    const r2 = await submit({
      executionId, revision: 2, sourceCount: 2, sources: [src1, src2],
      state: "accepted", startedAtMillis: startedAt, updatedAtMillis: startedAt + 500,
    });
    assert.equal(r2.status, "recorded", "appending a steered source to an active execution must record");

    // Dropping an already-bound source must still be rejected as conflicting evidence.
    const dropped = await submit({
      executionId, revision: 3, sourceCount: 1, sources: [src2],
      state: "accepted", startedAtMillis: startedAt, updatedAtMillis: startedAt + 700,
    });
    assert.equal(dropped.status, "superseded");
    assert.equal(dropped.reason, "conflicting_evidence");

    // Completing the turn must terminalize both the initial and steered sources.
    const r3 = await submit({
      executionId, revision: 3, sourceCount: 2, sources: [src1, src2],
      state: "completed", startedAtMillis: startedAt, updatedAtMillis: startedAt + 1000,
      finishedAtMillis: startedAt + 1000,
    });
    assert.equal(r3.status, "recorded");

    // Appending a source after terminalization must be rejected.
    const afterTerminal = await submit({
      executionId, revision: 4, sourceCount: 3, sources: [src1, src2, src3],
      state: "completed", startedAtMillis: startedAt, updatedAtMillis: startedAt + 1500,
      finishedAtMillis: startedAt + 1500,
    });
    assert.equal(afterTerminal.status, "superseded");
    assert.equal(afterTerminal.reason, "conflicting_evidence");

    const rows = (await sql(
      `SELECT source_message_id,revision,state,source_count,finished_at_millis
       FROM data.agent_message_executions WHERE run_id=$1 AND execution_id=$2 ORDER BY source_sequence`,
      ["channel:1#1", executionId],
    )).rows;
    assert.deepEqual(rows.map(r => ({
      message: r.source_message_id, revision: Number(r.revision), state: r.state,
      sourceCount: Number(r.source_count), finished: r.finished_at_millis !== null,
    })), [
      { message: "msg-1", revision: 3, state: "completed", sourceCount: 2, finished: true },
      { message: "msg-2", revision: 3, state: "completed", sourceCount: 2, finished: true },
    ]);
  } finally {
    await fixture.close();
  }
});
