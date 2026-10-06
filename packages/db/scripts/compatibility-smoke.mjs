import assert from "node:assert/strict";
import { Client } from "pg";

import {
  createAuthorityDatabase,
  PostgresContentRepository,
  PostgresMessageRepository,
  PostgresSlackOAuthRepository,
} from "../dist/index.js";

const connectionString = process.env.DATABASE_URL;
const material = process.env.XMATRIX_SECRET_CATALOG_KEY;
const shardId = process.env.RELAY_POSTGRES_SHARD_ID || "compatibility-smoke";
if (!connectionString || !material) throw new Error(
  "DATABASE_URL and XMATRIX_SECRET_CATALOG_KEY are required");

const suffix = crypto.randomUUID();
const prefix = `compat-smoke:${suffix}`;
const ids = {
  space: `${prefix}:space`, user: `${prefix}:user`,
  channel: `${prefix}:channel`,
  message: `${prefix}:message`,
  sentMessage: `${prefix}:sent-message`,
  contentIntent: `${prefix}:content-intent`, contentRef: `${prefix}:content-ref`,
};
const grantId = crypto.randomUUID();
const state = `${grantId}.${crypto.randomUUID().replaceAll("-", "")}${crypto.randomUUID().replaceAll("-", "")}`;
const token = `xoxp-compatibility-smoke-${suffix}`;
const client = new Client({ connectionString, application_name: "xmatrix-compatibility-smoke" });
const database = createAuthorityDatabase({ connectionString, shardId,
  applicationName: "xmatrix-compatibility-smoke-repository",
  connectTimeoutMs: 10_000, statementTimeoutMs: 10_000, transactionTimeoutMs: 30_000,
  observer: (observation) => process.stderr.write(
    `compatibility-smoke: query ${observation.queryName} ${observation.outcome}\n`),
});

async function seed() {
  await client.query("BEGIN");
  try {
    await client.query(`INSERT INTO control.postgres_shards
      (shard_id,state,capacity_class,created_at,updated_at)
      VALUES ($1,'active','compatibility-smoke',now(),now()) ON CONFLICT (shard_id) DO NOTHING`,
    [shardId]);
    await client.query(`INSERT INTO control.space_placement
      (space_id,shard_id,placement_epoch,state,target_shard_id,plan_class,created_at,updated_at)
      VALUES ($1,$2,1,'active',NULL,'compatibility-smoke',now(),now())`, [ids.space, shardId]);
    await client.query(`INSERT INTO data.spaces
      (space_id,owner_user_id,name,search_rank_sequence,version,metadata_json,created_at,updated_at)
      VALUES ($1,$2,'Compatibility Smoke',$3,1,'{}'::jsonb,now(),now())`,
    [ids.space, ids.user, `${prefix}:rank:space`]);
    await client.query(`INSERT INTO data.space_members
      (space_id,user_id,role,version,created_at,updated_at) VALUES ($1,$2,'owner',1,now(),now())`,
    [ids.space, ids.user]);
    await client.query(`INSERT INTO data.space_control_heads
      (space_id,commit_sequence,updated_at) VALUES ($1,0,now())`, [ids.space]);
    await client.query(`INSERT INTO data.channels
      (channel_id,space_id,parent_channel_id,name,name_key,mode,archived_at,search_rank_sequence,
       version,metadata_json,created_at,updated_at)
      VALUES ($1,$2,NULL,'General','general','open',NULL,$3,1,'{}'::jsonb,now(),now())`,
    [ids.channel, ids.space, `${prefix}:rank:channel`]);
    await client.query(`INSERT INTO data.space_billing_usage
      (space_id,free_message_count,version,created_at,updated_at)
       VALUES ($1,0,1,now(),now())`, [ids.space]);
    await client.query(`INSERT INTO data.messages
      (space_id,channel_id,message_id,timeline_sequence,entity_version,author_kind,author_id,
       message_kind,content_hash,payload_kind,payload_ref,archive_source_json,reactions_json,
       annotations_json,attachments_json,sent_at,edited_at,recalled_at,deleted_at,updated_at,
       search_rank_sequence,legacy_body,created_at)
      VALUES ($1,$2,$3,1,1,'user',$4,'xmatrix.message.text',$5,'inline',$6,NULL,
        '[]'::jsonb,'[]'::jsonb,'[]'::jsonb,now(),NULL,NULL,NULL,now(),$7,'evidence',now())`,
    [ids.space, ids.channel, ids.message, ids.user, `${prefix}:content`, `${prefix}:payload`,
      `${prefix}:rank:message`]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function cleanup() {
  await client.query("BEGIN");
  try {
    await client.query("DELETE FROM data.slack_oauth_sessions WHERE owner_user_id=$1", [ids.user]);
    await client.query("DELETE FROM data.idempotency_keys WHERE space_id=$1", [ids.space]);
    await client.query("DELETE FROM data.outbox WHERE space_id=$1", [ids.space]);
    await client.query("DELETE FROM data.message_mutations WHERE space_id=$1", [ids.space]);
    await client.query("DELETE FROM data.channel_content_counters WHERE space_id=$1", [ids.space]);
    await client.query("DELETE FROM data.content_refs WHERE space_id=$1", [ids.space]);
    await client.query("DELETE FROM data.content_gc_candidates WHERE space_id=$1", [ids.space]);
    await client.query("DELETE FROM data.content_objects WHERE space_id=$1", [ids.space]);
    await client.query("DELETE FROM data.blob_upload_intents WHERE space_id=$1", [ids.space]);
    await client.query("DELETE FROM control.entity_space_routes WHERE space_id=$1", [ids.space]);
    await client.query("DELETE FROM data.messages WHERE space_id=$1", [ids.space]);
    await client.query("DELETE FROM data.space_billing_usage WHERE space_id=$1", [ids.space]);
    await client.query("DELETE FROM data.channels WHERE channel_id=$1", [ids.channel]);
    await client.query("DELETE FROM data.space_members WHERE space_id=$1", [ids.space]);
    await client.query("DELETE FROM data.space_control_heads WHERE space_id=$1", [ids.space]);
    await client.query("DELETE FROM data.spaces WHERE space_id=$1", [ids.space]);
    await client.query("DELETE FROM control.space_placement WHERE space_id=$1", [ids.space]);
    await client.query(`DELETE FROM control.postgres_shards WHERE shard_id=$1
      AND NOT EXISTS (SELECT 1 FROM control.space_placement WHERE shard_id=$1 OR target_shard_id=$1)`,
    [shardId]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

await client.connect();
try {
  await seed();
  process.stderr.write("compatibility-smoke: seeded\n");
  const slack = new PostgresSlackOAuthRepository(database, material);
  const started = await slack.start({ commandId: `${prefix}:slack:start`, ownerUserId: ids.user,
    grantId, state, clientId: "compatibility-smoke-client",
    redirectUri: "https://xmatrix.sh/compatibility-smoke", interval: 2, ttlMs: 600_000,
    principal: { kind: "user", id: ids.user } });
  assert.equal(started.grantId, grantId);
  process.stderr.write("compatibility-smoke: slack-start\n");
  await slack.approve({ commandId: `${prefix}:slack:approve`, state, slackToken: token,
    team: "Compatibility Smoke" });
  process.stderr.write("compatibility-smoke: slack-approve\n");
  const stored = await client.query(`SELECT position($2 in s.token_json::text) AS plaintext_at
    FROM data.slack_oauth_sessions s WHERE s.grant_id=$1`, [grantId, token]);
  assert.equal(stored.rows[0].plaintext_at, 0);
  assert.equal((await slack.get({ grantId, principal: { kind: "user", id: ids.user } })).status,
    "approved");
  process.stderr.write("compatibility-smoke: slack-get\n");
  const consumed = await slack.consume({ commandId: `${prefix}:slack:consume`, ownerUserId: ids.user,
    grantId, principal: { kind: "user", id: ids.user } });
  assert.equal(consumed.slackToken, token);
  assert.equal((await client.query("SELECT token_json FROM data.slack_oauth_sessions WHERE grant_id=$1",
    [grantId])).rows[0].token_json, null, "consuming clears the token");
  process.stderr.write("compatibility-smoke: slack\n");

  const messages = new PostgresMessageRepository(database);
  // An append names a sequence the Channel reserved for its command.
  const reservation = await messages.reserveAppendSequence({ requestId: `${prefix}:message:reserve`,
    commandId: `${prefix}:message:command`, spaceId: ids.space, channelId: ids.channel, observedPostgresHead: 1 });
  const message = await messages.append({
    requestId: `${prefix}:message:request`, commandId: `${prefix}:message:command`,
    requestDigest: "1".repeat(64), spaceId: ids.space, channelId: ids.channel,
    messageId: ids.sentMessage, sequence: reservation.sequence, principal: { kind: "user", id: ids.user },
    senderKind: "user", senderId: ids.user, messageKind: "xmatrix.message.text",
    sentAt: new Date().toISOString(), prepared: {
      codecId: "canonical-clone-cbor-v1", payloadSchemaVersion: 1,
      fieldPresenceBase64: "AA", payloadBundleBase64: "AA", bodyHash: "2".repeat(64),
      senderSnapshotDigest: "3".repeat(64), recordDigest: "4".repeat(64), recordEncodedBytes: 10,
    }, senderSnapshot: { userId: ids.user },
  });
  assert.equal(message.messageId, ids.sentMessage);
  assert.equal(Number((await client.query(`SELECT free_message_count FROM data.space_billing_usage
    WHERE space_id=$1`, [ids.space])).rows[0].free_message_count), 1);
  process.stderr.write("compatibility-smoke: message\n");

  const content = new PostgresContentRepository(database, shardId);
  const contentHash = "5".repeat(64);
  const scopeId = `space:${ids.space}`;
  const intent = await content.createIntent({
    requestId: `${prefix}:content:create-request`, commandId: `${prefix}:content:create-command`,
    intentId: ids.contentIntent, scopeId, contentHash, encodedBytes: 49,
    expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    principal: { kind: "user", id: ids.user },
  });
  assert.equal(intent.objectKey, `objects/${contentHash}`);
  assert.equal((await content.readIntent({ requestId: `${prefix}:content:read-intent`,
    intentId: ids.contentIntent, principal: { kind: "user", id: ids.user } })).intentId,
  ids.contentIntent);
  const ref = await content.commitRef({
    requestId: `${prefix}:content:commit-request`, commandId: `${prefix}:content:commit-command`,
    intentId: ids.contentIntent, expectedIntentVersion: 1, refId: ids.contentRef,
    ownerKind: "message_attachment", ownerId: ids.sentMessage, scopeId,
    objectKey: `objects/${contentHash}`, checksum: contentHash, encodedBytes: 49,
    verifiedAt: new Date().toISOString(), principal: { kind: "user", id: ids.user },
  });
  assert.equal(ref.refId, ids.contentRef);
  assert.equal((await content.readRef({ requestId: `${prefix}:content:read-ref`,
    refId: ids.contentRef, principal: { kind: "user", id: ids.user } })).refId,
  ids.contentRef);
  process.stderr.write("compatibility-smoke: content\n");

  process.stdout.write(JSON.stringify({ ok: true, slack: true, message: true, content: true }) + "\n");
} finally {
  await cleanup().catch(() => undefined);
  await client.end();
}
