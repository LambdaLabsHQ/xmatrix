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
