import assert from "node:assert/strict";
import { Client } from "pg";
import { createAuthorityDatabase, databaseFailureEvidence, PostgresMessageRepository } from "../dist/index.js";
import { integration, isolatedPostgres, seedTestSpacePlacement } from "./postgres-database.fixture.mjs";

// HUB-B3 enters append without a Run proof. The existing execution-owner and
// Agent Channel-lock cases never execute this combined authorization preflight.
integration("message append preflight retains its live blocker and preserves admission on diagnostic failure", async () => {
  const fixture = await isolatedPostgres("message_preflight", { shard: true });
  const holder = fixture.client;
  let samples = 0, unavailable = false;
  const database = createAuthorityDatabase({ connectionString: fixture.url.toString(), shardId: "shard-0",
    applicationName: "xmatrix-hub-message-authority", lockTimeoutMs: 1500,
    clientFactory: config => {
      if (config.application_name === "xmatrix-lock-diagnostic") {
        samples++;
        if (unavailable) throw new Error("private-diagnostic-failure");
      }
      return new Client(config);
    } });
  const repository = new PostgresMessageRepository(database);
  const input = {
    requestId: "private-request", commandId: "private-command", messageId: "private-message",
    spaceId: "private-space", channelId: "private-channel", sequence: 1,
    principal: { kind: "user", id: "private-owner" }, senderKind: "user", senderId: "private-owner",
    messageKind: "xmatrix.message.text", sentAt: new Date().toISOString(), requestDigest: "a".repeat(64),
    prepared: { bodyHash: "b".repeat(64), recordDigest: "c".repeat(64), senderSnapshotDigest: "d".repeat(64),
      codecId: "canonical-clone-cbor-v1", payloadSchemaVersion: 1, recordEncodedBytes: 2,
      fieldPresenceBase64: "AA", payloadBundleBase64: "AA",
      preview: { bodyPreview: "Private text", senderSnapshot: { kind: "user", label: "Private name" } } },
    placement: { spaceId: "private-space", shardId: "shard-0", placementEpoch: 1 },
  };
  try {
    await seedTestSpacePlacement(holder, input.spaceId, input.sentAt);
    await holder.query(`INSERT INTO data.spaces
      (space_id,owner_user_id,name,search_rank_sequence,version,created_at,updated_at)
      VALUES ($1,$2,'Preflight wait',$1,1,now(),now());`, [input.spaceId, input.senderId]);
    await holder.query(`INSERT INTO data.space_members(space_id,user_id,role,version,created_at,updated_at)
      VALUES ($1,$2,'owner',1,now(),now())`, [input.spaceId, input.senderId]);
    await holder.query(`INSERT INTO data.channels
      (channel_id,space_id,name,name_key,mode,search_rank_sequence,version,created_at,updated_at)
      VALUES ($1,$2,'Preflight wait',$1,'open',$1,1,now(),now())`, [input.channelId, input.spaceId]);
    await repository.reserveAppendSequence({ ...input, observedPostgresHead: 0 });
    await holder.query("BEGIN; SET LOCAL application_name='xmatrix-agent-launch-coordinator'");
    await holder.query("SELECT 1 FROM data.channels WHERE channel_id=$1 FOR UPDATE", [input.channelId]);
    for (unavailable of [false, true]) {
      await assert.rejects(repository.append(input), error => {
        assert.equal(error.code, "55P03", "diagnostics preserve the original lock rejection");
        const [evidence] = databaseFailureEvidence(error);
        assert.equal(evidence.queryName, "message_append_preflight_v4");
        assert.equal(evidence.lockWait?.status, unavailable ? "unavailable" : "sampled");
        if (!unavailable) {
          assert.equal(evidence.lockWait.waiter.owner, "message");
          assert.equal(evidence.lockWait.waiter.wait, "Lock");
          assert.equal(evidence.lockWait.blockers[0].owner, "launch");
          assert.equal(evidence.lockWait.blockers[0].state, "idle in transaction");
          assert.ok(evidence.lockWait.blockers[0].ageMs > 0);
        }
        assert.doesNotMatch(JSON.stringify(evidence), /private-|Private|SELECT|postgres:\/\//u);
        return true;
      });
    }
    assert.equal(samples, 2, "each blocked append samples once without replay");
    assert.equal((await holder.query("SELECT count(*) FROM data.messages")).rows[0].count, "0");
    await holder.query("ROLLBACK");
    assert.equal((await repository.append(input)).sequence, 1);
    assert.equal(samples, 2, "a successful uncontended append opens no diagnostic connection");
  } finally {
    await holder.query("ROLLBACK").catch(() => {});
    await fixture.close();
  }
});
