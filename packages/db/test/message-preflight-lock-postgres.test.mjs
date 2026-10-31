import assert from "node:assert/strict";
import { Client } from "pg";
import { createAuthorityDatabase, databaseFailureEvidence, DatabaseCommitUnknownError, PostgresMessageRepository } from "../dist/index.js";
import { integration, isolatedPostgres, seedTestSpacePlacement } from "./postgres-database.fixture.mjs";

// HUB-B3 enters append without a Run proof. The existing execution-owner and
// Agent Channel-lock cases never execute this combined authorization preflight.
integration("message append preflight retains its blocker; append recovers pre-COMMIT loss without stale attention or duplicate facts", async () => {
  const fixture = await isolatedPostgres("message_preflight", { shard: true });
  const holder = fixture.client;
  let samples = 0, unavailable = false, fault;
  const attempts = [];
  let pendingClose = Promise.resolve();
  const database = createAuthorityDatabase({ connectionString: fixture.url.toString(), shardId: "shard-0",
    applicationName: "xmatrix-hub-message-authority", lockTimeoutMs: 1500,
    clientFactory: config => {
      if (config.application_name === "xmatrix-lock-diagnostic") {
        samples++;
        if (unavailable) throw new Error("private-diagnostic-failure");
      }
      const client = new Client(config);
      if (config.application_name === "xmatrix-lock-diagnostic") return client;
      const attempt = { queries: [], ended: false };
      attempts.push(attempt);
      const query = client.query.bind(client), end = client.end.bind(client), connect = client.connect.bind(client);
      client.connect = async () => { await pendingClose; return connect(); };
      client.query = async input => {
        const text = typeof input === "string" ? input : input.text;
        attempt.queries.push(text);
        const result = await query(input);
        if (fault?.matches.test(text) && fault.remaining-- > 0) {
          attempt.fault = fault;
          throw fault.errors?.shift() ?? fault.error;
        }
        return result;
      };
      client.end = () => {
        attempt.ended = true;
        pendingClose = end().then(async () => {
          if (attempt.fault?.afterClose) {
            const afterClose = attempt.fault.afterClose;
            delete attempt.fault.afterClose;
            await afterClose();
          }
        });
        return pendingClose;
      };
      return client;
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
          assert.equal(evidence.lockWait.waiter.owner, "op:message.append", "a waiter names its operation");
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

    // HUB-B6 loses the final routing read after every write, before COMMIT.
    // Healthy append/lock tests cannot catch missing recovery or leaked attention
    // from the abandoned callback. Use the real SQL and transaction owner.
    await holder.query(`INSERT INTO data.space_members(space_id,user_id,role,version,created_at,updated_at)
      VALUES ($1,'private-admin','admin',1,now(),now())`, [input.spaceId]);
    const routing = /SELECT DISTINCT r.owner_user_id FROM data.runs/u;
    async function reserved(suffix) {
      const next = { ...input, commandId: `command-${suffix}`, messageId: `message-${suffix}`,
        principal: { kind: "user", id: "private-admin" }, senderId: "private-admin" };
      next.sequence = (await repository.reserveAppendSequence({ ...next, observedPostgresHead: 1 })).sequence;
      return next;
    }
    const recover = await reserved("recover");
    const before = attempts.length;
    fault = { matches: routing, remaining: 1, error: new Error("Connection terminated unexpectedly"),
      afterClose: () => holder.query("UPDATE data.messages SET author_id='private-admin' WHERE message_id=$1", [input.messageId]) };
    const result = await repository.append({ ...recover, replyToMessageId: input.messageId });
    assert.equal(result.attentionTargetCount, 0, "retry recomputes the reply target instead of retaining its old author");
    const retried = attempts.slice(before);
    assert.equal(retried.length, 2);
    assert.ok(retried.every(attempt => attempt.ended));
    assert.equal(retried[0].queries.includes("COMMIT"), false);
    assert.equal(retried[0].queries.includes("ROLLBACK"), false, "never queue rollback behind the lost response");
    assert.equal(retried[1].queries.at(-1), "COMMIT");
    for (const table of ["messages", "message_mutations", "outbox"]) {
      const key = table === "outbox" ? "aggregate_id" : "message_id";
      assert.equal((await holder.query(`SELECT count(*) FROM data.${table} WHERE ${key}=$1`, [recover.messageId])).rows[0].count, "1");
    }
    assert.equal((await holder.query("SELECT count(*) FROM data.message_attention WHERE message_id=$1", [recover.messageId])).rows[0].count, "0");
    assert.equal((await holder.query("SELECT state FROM data.message_sequence_reservations WHERE command_id=$1", [recover.commandId])).rows[0].state, "committed");
    assert.equal((await repository.append(recover)).messageId, recover.messageId, "command replay returns its receipt");

    for (const [suffix, matches, remaining, error] of [
      ["exhausted", routing, 2, new Error("Connection terminated unexpectedly")],
      ["answered", routing, 1, Object.assign(new Error("answered rejection"), { code: "57014" })],
      ["unknown", /^COMMIT$/u, 1, new Error("Connection terminated unexpectedly")],
    ]) {
      fault = undefined;
      const next = await reserved(suffix), start = attempts.length;
      fault = { matches, remaining, error,
        ...(suffix === "exhausted" ? { errors: [new Error(error.message), error] } : {}) };
      await assert.rejects(repository.append(next), failure => {
        if (suffix === "unknown") assert.ok(failure instanceof DatabaseCommitUnknownError);
        else assert.equal(failure, error);
        if (suffix === "exhausted") assert.equal(databaseFailureEvidence(failure).length, 2);
        return true;
      });
      assert.equal(attempts.length - start, suffix === "exhausted" ? 2 : 1);
      assert.ok(attempts.slice(start).every(attempt => attempt.ended));
      assert.equal((await holder.query("SELECT count(*) FROM data.messages WHERE message_id=$1", [next.messageId])).rows[0].count,
        suffix === "unknown" ? "1" : "0", "a lost COMMIT response leaves receipt reconciliation to the caller");
    }
  } finally {
    await holder.query("ROLLBACK").catch(() => {});
    await fixture.close();
  }
});
