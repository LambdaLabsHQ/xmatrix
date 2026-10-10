import assert from "node:assert/strict";
import { Client } from "pg";
import { PostgresMessageRepository } from "../dist/message-control.js";
import { requireAgentChannelAccess } from "../dist/agent-channel-access.js";
import { boundedPostgresTransaction, integration, isolatedPostgres, postgresDatabase, seedTestSpacePlacement } from "./postgres-database.fixture.mjs";

integration("Agent message reads do not block stops; appends recheck the Run after taking Channel locks", async t => {
  const fixture = await isolatedPostgres("message_run_locks");
  const writer = new Client({ connectionString: fixture.url.toString() });
  const reader = new Client({ connectionString: fixture.url.toString() });
  await Promise.all([writer.connect(), reader.connect()]);
  const sql = (text, values) => fixture.client.query(text, values);
  const placement = { spaceId: "space", shardId: "shard-0", placementEpoch: 1 };
  const input = { requestId: "message-read", spaceId: "space", channelId: "a",
    principal: { kind: "agent", id: "a:1" }, placement,
    runProof: { runId: "a:1#1", instanceId: "a:1", executionKey: "execution" } };
  const appendInput = { ...input, commandId: "append", messageId: "message", sequence: 1,
    requestDigest: "1".repeat(64), senderKind: "agent", senderId: "a:1",
    messageKind: "xmatrix.message.text", sentAt: new Date().toISOString(), prepared: {
      codecId: "canonical-clone-cbor-v1", payloadSchemaVersion: 1, fieldPresenceBase64: "AA",
      payloadBundleBase64: "AA", bodyHash: "2".repeat(64), senderSnapshotDigest: "3".repeat(64),
      recordDigest: "4".repeat(64), recordEncodedBytes: 10,
      preview: { bodyPreview: "Test", senderSnapshot: { kind: "agent", label: "codex" } },
    }, senderSnapshot: { kind: "agent", id: "a:1" } };
  let afterProof;
  const database = postgresDatabase(reader);
  const repository = new PostgresMessageRepository({ ...database,
    transaction: (context, callback) => database.transaction(context, tx => callback({
      async query(query) {
        const result = await tx.query(query);
        if (query.name === "message_append_run_proof_v3") await afterProof?.();
        return result;
      },
    })),
  });
  try {
    await seedTestSpacePlacement(fixture.client, "space", new Date().toISOString());
    await sql(`INSERT INTO data.spaces(space_id,owner_user_id,name,search_rank_sequence,version,created_at,updated_at)
      VALUES ('space','owner','Test','space',1,now(),now())`);
    await sql(`INSERT INTO data.space_members(space_id,user_id,role,version,created_at,updated_at)
      VALUES ('space','owner','owner',1,now(),now())`);
    await sql(`INSERT INTO data.channels(channel_id,space_id,name,name_key,mode,search_rank_sequence,version,created_at,updated_at)
      VALUES ('a','space','A','a','open','a',1,now(),now()),('b','space','B','b','open','b',1,now(),now())`);
    await sql(`INSERT INTO data.agent_registrations VALUES ('owner','machine','codex',1,now(),now())`);
    await sql(`INSERT INTO data.space_agent_registrations
      VALUES ('space','owner','machine','codex','codex','{}',1,now(),now())`);
    const resources = JSON.stringify({ workspaces: [], models: [], capabilities: [] });
    await sql(`INSERT INTO data.space_agent_registration_access(space_id,owner_user_id,machine_id,harness,
      grant_state,grant_revision,grant_execution_revision,grant_limits,policy_state,policy_revision,
      policy_execution_revision,policy_limits,updated_at)
      VALUES ('space','owner','machine','codex','active',1,1,$1,'enabled',1,1,$1,now())`, [resources]);
    await sql(`INSERT INTO data.runs(run_id,owner_user_id,channel_id,status,version,metadata_json,created_at,updated_at)
      VALUES ('a:1#1','owner','a','running',1,'{"executionKey":"execution"}',now(),now()),
        ('b:1#1','owner','b','running',1,'{"executionKey":"execution"}',now(),now())`);
    await sql(`INSERT INTO data.instances(instance_id,run_id,channel_id,channel_instance_id,status,version,created_at,updated_at)
      VALUES ('a:1','a:1#1','a',1,'online',1,now(),now()),('b:1','b:1#1','b',1,'online',1,now(),now())`);
    await sql(`INSERT INTO data.run_agent_registrations(run_id,space_id,owner_user_id,machine_id,harness,
      actor_user_id,allocation_id,authorization_digest,grant_revision,grant_execution_revision,
      policy_revision,policy_execution_revision,requested_json)
      VALUES ('a:1#1','space','owner','machine','codex','owner','allocation-a',repeat('a',64),1,1,1,1,$1),
        ('b:1#1','space','owner','machine','codex','owner','allocation-b',repeat('a',64),1,1,1,1,$1)`, [resources]);
    await reader.query("SET lock_timeout = '250ms'");
    await writer.query("SET lock_timeout = '250ms'");

    await t.test("preflight, cross-Channel preflight, observed head and receipt read past pending lifecycle writes", async () => {
      // A read sees the current snapshot without impeding pending lifecycle writes.
      try {
        for (const status of ["running", "starting"]) {
          // Both admission and continuation preflights must remain reads.
          await writer.query("ROLLBACK");
          await sql("UPDATE data.runs SET status=$1 WHERE run_id='a:1#1'", [status]);
          await writer.query("BEGIN");
          for (const table of ["channels", "runs", "instances", "run_agent_registrations",
            "space_members", "space_agent_registration_access"]) {
            await writer.query(`SELECT 1 FROM data.${table} FOR UPDATE`);
          }
          assert.equal((await repository.prepareAppend(input)).agentRunIdentity.runId, "a:1#1");
          assert.equal((await repository.prepareAppend({ ...input, channelId: "b" })).agentRunIdentity.origin.channelId, "a");
          assert.equal((await repository.observedHead(input)).sequence, 0);
          assert.equal((await repository.httpAppendReceipt({ ...input, messageId: "absent" })).status, "not_found");
          await database.transaction({}, tx => requireAgentChannelAccess(tx, {
            spaceId: "space", channelId: "b", agentId: "a:1", runProof: input.runProof, capability: "content_history_read",
          }));
        }
      } finally { await writer.query("ROLLBACK"); }
    });

    await t.test("a stop commits while preflight is between Run proof and registration admission", async () => {
      await sql("UPDATE data.runs SET status='running' WHERE run_id='a:1#1'");
      await writer.query("BEGIN");
      await writer.query("SELECT 1 FROM data.channels WHERE channel_id='a' FOR UPDATE");
      afterProof = async () => {
        afterProof = undefined;
        await writer.query("UPDATE data.runs SET status='stopping' WHERE run_id='a:1#1'");
        await writer.query("COMMIT");
      };
      try {
        await repository.prepareAppend(input);
        await assert.rejects(repository.prepareAppend(input), error => error.code === "agent_run_forbidden");
      } finally { afterProof = undefined; await writer.query("ROLLBACK"); }
    });

    await t.test("an append waiting behind a stop holds no Run and refuses the stopped Run", async () => {
      await sql("UPDATE data.runs SET status='running' WHERE run_id='a:1#1'");
      await writer.query("BEGIN");
      await writer.query("SELECT 1 FROM data.channels WHERE channel_id='a' FOR UPDATE");
      // Pause after discovery, before the append can acquire the Channel. A
      // Run share here would prevent the stop from committing (HUB-77).
      afterProof = async () => {
        afterProof = undefined;
        await writer.query("UPDATE data.runs SET status='stopping' WHERE run_id='a:1#1'");
        await writer.query("COMMIT");
      };
      try {
        await assert.rejects(repository.append(appendInput), error => error.code === "agent_run_forbidden");
      } finally { afterProof = undefined; await writer.query("ROLLBACK"); }
      assert.equal((await sql("SELECT count(*) AS n FROM data.messages")).rows[0].n, "0");
    });
    await t.test("reciprocal cross-Channel writers serialize and complete lifecycle updates", async () => {
      await sql("UPDATE data.runs SET status='running'");
      const access = (client, source, target) => requireAgentChannelAccess(boundedPostgresTransaction(client), {
        spaceId: "space", channelId: target, agentId: `${source}:1`, capability: "message_append",
        runProof: { runId: `${source}:1#1`, instanceId: `${source}:1`, executionKey: "execution" },
      });
      await writer.query("BEGIN");
      await reader.query("BEGIN");
      try {
        await access(writer, "a", "b");
        await assert.rejects(access(reader, "b", "a"), error => error.code === "55P03");
        await reader.query("ROLLBACK");
        // The queued writer retained no Run that could block this lifecycle write.
        await writer.query("UPDATE data.runs SET version=version+1 WHERE run_id='b:1#1'");
        await writer.query("UPDATE data.channels SET activity_at=now() WHERE channel_id='b'");
        await writer.query("COMMIT");
        await reader.query("BEGIN");
        await access(reader, "b", "a");
        await reader.query("UPDATE data.channels SET activity_at=now() WHERE channel_id='a'");
        await reader.query("COMMIT");
      } finally { await Promise.all([reader.query("ROLLBACK"), writer.query("ROLLBACK")]); }
    });

    await t.test("preparation cannot authorize a later append after the registration is revoked", async () => {
      await sql("UPDATE data.runs SET status='running' WHERE run_id='a:1#1'");
      await repository.prepareAppend(input);
      await sql("UPDATE data.space_agent_registration_access SET grant_state='revoked',grant_revision=2,grant_execution_revision=2");
      await assert.rejects(repository.append(appendInput), error => error.code === "registration_revoked");
      await assert.rejects(repository.prepareAppend({ ...input, channelId: "b" }), error => error.code === "registration_revoked");
      assert.equal((await sql("SELECT count(*) AS n FROM data.messages")).rows[0].n, "0");
    });
  } finally {
    await writer.query("ROLLBACK").catch(() => {});
    await Promise.all([writer.end(), reader.end()]);
    await fixture.close();
  }
});
