import assert from "node:assert/strict";
import { Client } from "pg";
import { createAuthorityDatabase, PostgresSpaceSecretRepository } from "../dist/index.js";

export const connectionString = process.env.XMATRIX_TEST_POSTGRES_URL;

/** A Space with its owner, an admin, and one live registered Run of the owner's. */
export async function spaceSecretFixture() {
  assert.ok(connectionString, "XMATRIX_TEST_POSTGRES_URL is required");
  const prefix = `space-secret-test:${crypto.randomUUID()}`;
  const ids = Object.fromEntries(["owner", "admin", "space", "channel", "agent", "run", "instance", "machine", "host", "daemon"]
    .map((key) => [key, `${prefix}:${key}`]));
  // Stored Instance and Run ids are their natural keys (0084).
  ids.instance = `${ids.channel}:1`;
  ids.run = `${ids.instance}#1`;
  const client = new Client({ connectionString });
  await client.connect();
  const database = createAuthorityDatabase({ connectionString, shardId: "shard-0",
    applicationName: "xmatrix-space-secret-regression", statementTimeoutMs: 5_000, transactionTimeoutMs: 10_000 });
  const secret = new PostgresSpaceSecretRepository(database, "space-secret-integration-material");
  const context = { runId: ids.run, instanceId: ids.instance, executionKey: `${prefix}:execution` };
  // Space secrets are read on the Space's own shard.
  await client.query(`INSERT INTO control.postgres_shards (shard_id,state,capacity_class,created_at,updated_at)
    VALUES ('shard-0','active','test',now(),now()) ON CONFLICT DO NOTHING`);
  await client.query(`INSERT INTO control.space_placement
    (space_id,shard_id,placement_epoch,state,target_shard_id,plan_class,created_at,updated_at)
    VALUES ($1,'shard-0',1,'active',NULL,'test',now(),now())`, [ids.space]);
  await client.query(`INSERT INTO data.spaces
    (space_id,owner_user_id,name,search_rank_sequence,version,metadata_json,created_at,updated_at)
    VALUES ($1,$2,'Space secret test',$1,1,'{}',now(),now())`, [ids.space, ids.owner]);
  await client.query(`INSERT INTO data.space_members
    (space_id,user_id,role,version,created_at,updated_at) VALUES ($1,$2,'member',1,now(),now()),
    ($1,$3,'admin',1,now(),now())`, [ids.space, ids.owner, ids.admin]);
  await client.query(`INSERT INTO data.channels
    (channel_id,space_id,name,name_key,mode,search_rank_sequence,
      version,metadata_json,created_at,updated_at,activity_at)
    VALUES ($1,$2,'Space secret test',$1,'open',$1,1,'{}',now(),now(),now())`, [ids.channel, ids.space]);
  await client.query(`INSERT INTO control.channel_space_routes
    (channel_id,space_id,shard_id,placement_epoch,entity_version,state,updated_at)
    VALUES ($1,$2,'shard-0',1,1,'active',now())`, [ids.channel, ids.space]);
  await client.query(`INSERT INTO data.runs
    (run_id,owner_user_id,channel_id,status,version,metadata_json,created_at,updated_at)
    VALUES ($1,$2,$3,'running',1,$4::jsonb,now(),now())`,
  [ids.run, ids.owner, ids.channel, JSON.stringify({ executionKey: context.executionKey })]);
  await client.query(`INSERT INTO data.instances
    (instance_id,run_id,channel_id,channel_instance_id,status,version,created_at,updated_at)
    VALUES ($1,$2,$3,1,'online',1,now(),now())`, [ids.instance, ids.run, ids.channel]);
  // Every Run executes under a registration; registrations list no secrets.
  const noResources = JSON.stringify({ workspaces: [], models: [], capabilities: [] });
  await client.query(`INSERT INTO data.agent_registrations VALUES ($1,$2,'claude',1,now(),now())`, [ids.owner, ids.machine]);
  await client.query(`INSERT INTO data.space_agent_registrations
    (space_id,owner_user_id,machine_id,harness,display_name,configuration_json,version,created_at,updated_at)
    VALUES ($1,$2,$3,'claude','claude','{"workspaceReferences":[]}',1,now(),now())`,
  [ids.space, ids.owner, ids.machine]);
  await client.query(`INSERT INTO data.space_agent_registration_access
    (space_id,owner_user_id,machine_id,harness,grant_state,grant_revision,grant_execution_revision,grant_limits,
     policy_state,policy_revision,policy_execution_revision,policy_limits,updated_at)
    VALUES ($1,$2,$3,'claude','active',1,1,$4::jsonb,'enabled',1,1,$4::jsonb,now())`,
  [ids.space, ids.owner, ids.machine, noResources]);
  await client.query(`INSERT INTO data.run_agent_registrations
    (run_id,space_id,owner_user_id,machine_id,harness,actor_user_id,allocation_id,authorization_digest,
     grant_revision,grant_execution_revision,policy_revision,policy_execution_revision,requested_json)
    VALUES ($1,$2,$3,$4,'claude',$3,$5,repeat('a',64),1,1,1,1,$6::jsonb)`,
  [ids.run, ids.space, ids.owner, ids.machine, `${prefix}:allocation`, noResources]);
  await client.query(`INSERT INTO data.machine_run_routes
    (run_id,owner_user_id,machine_id,hostname,channel_id,execution_key,created_at,updated_at)
    VALUES ($1,$2,$3,$4,$5,$6,now(),now())`,
  [ids.run, ids.owner, ids.machine, ids.host, ids.channel, context.executionKey]);
  await client.query(`INSERT INTO data.machine_daemons
    (daemon_id,owner_user_id,owner_email,machine_id,hostname,status,capabilities_json,metadata_json,
      connection_epoch,version,created_at,updated_at)
    VALUES ($1,$2,'space-secret@example.test',$3,$4,'online','[]','{}',1,1,now(),now())`,
  [ids.daemon, ids.owner, ids.machine, ids.host]);

  const run = { runId: ids.run, ownerUserId: ids.owner, spaceId: ids.space, channelId: ids.channel, instanceId: ids.instance,
    executionKey: context.executionKey };
  return { ids, client, context, secret, run,
    async close() {
      try {
        // Exact fixture rows only; never truncate a shared integration database.
        await client.query("DELETE FROM data.run_secret_approvals WHERE space_id=$1", [ids.space]);
        await client.query("DELETE FROM data.space_secrets WHERE space_id=$1", [ids.space]);
        for (const table of ["secret_grant_audit", "machine_run_routes", "machine_daemons",
          "registration_access_changes", "run_agent_registrations", "space_agent_registration_access",
          "space_agent_registrations", "agent_registrations"]) {
          await client.query(`DELETE FROM data.${table} WHERE owner_user_id=$1`, [ids.owner]);
        }
        await client.query("DELETE FROM data.instances WHERE instance_id=$1", [ids.instance]);
        await client.query("DELETE FROM data.runs WHERE run_id=$1", [ids.run]);
        await client.query("DELETE FROM data.channels WHERE channel_id=$1", [ids.channel]);
        await client.query("DELETE FROM data.space_members WHERE space_id=$1", [ids.space]);
        await client.query("DELETE FROM data.spaces WHERE space_id=$1", [ids.space]);
        await client.query("DELETE FROM control.channel_space_routes WHERE channel_id=$1", [ids.channel]);
        await client.query("DELETE FROM control.space_placement WHERE space_id=$1", [ids.space]);
      } finally { await client.end(); }
    },
  };
}
