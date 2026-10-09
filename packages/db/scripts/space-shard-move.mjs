#!/usr/bin/env node

import { createHash } from "node:crypto";
import process from "node:process";

import { Client } from "pg";

import { runIfInvoked } from "./cli.mjs";

const TERMINAL_PHASES = new Set(["completed", "aborted"]);
const SYNC_PHASES = new Set(["copying", "catching_up", "caught_up", "frozen"]);
const VERIFY_PHASES = new Set(["caught_up", "final_copied"]);

// Every table in data must be deliberately classified. A newly added table makes
// the classification test fail until its shard semantics are decided.
export const MOVABLE_SPACE_TABLES = Object.freeze([
  "agent_message_executions",
  "blob_upload_intents",
  "channel_access",
  "channel_content_counters",
  "channel_message_sequences",
  "channels",
  "channel_metadata_revisions",
  "channel_about_inputs",
  "content_closure_heads",
  "content_gc_candidates",
  "content_objects",
  "content_refs",
  "cross_space_read_grants",
  "cross_space_read_notices",
  "delivery_cursors",
  "first_message_launch_choices",
  "idempotency_keys",
  "message_annotations",
  "message_attachment_refs",
  "message_attachments",
  "message_attention",
  "message_attention_revisions",
  "message_mutations",
  "message_reactions",
  "message_sequence_reservations",
  "messages",
  "outbox",
  "page_access",
  "page_block_competitions",
  "page_claims",
  "page_links",
  "page_migrations",
  "page_reads",
  "page_revisions",
  "pages",
  "retired_agent_dm_purges",
  "retired_direct_conversation_purges",
  "space_action_claims",
  "space_billing_checkout_intents",
  "space_billing_subscriptions",
  "space_billing_usage",
  "space_billing_webhook_events",
  "space_control_heads",
  "space_invites",
  "space_join_requests",
  "space_member_creation_policies",
  "space_members",
  "space_secrets",
  "space_storage_usage",
  "spaces",
  "user_space_channel_view_preferences",
  "user_space_locale_preferences",
]);

export const INDIRECT_MOVABLE_SPACE_TABLES = Object.freeze([
]);

// These facts are Space-related but their authorities are not yet fleet-routed.
// A Space with matching rows is rejected instead of being split across shards.
export const BLOCKING_SPACE_TABLES = Object.freeze([
  "channel_transfer_proposals",
  "agent_launches",
  "agent_reborn_intents",
  "agent_registration_commands",
  "space_agent_registrations",
  "space_agent_registration_access",
  "registration_access_changes",
  "registration_stop_intents",
  "registration_launch_intents",
  "run_agent_registrations",
  // An approval lets one Run read a secret; it stays with the Runs.
  "run_secret_approvals",
  "app_connector_action_policies",
  "app_connector_channel_bindings",
  "app_connector_connections",
  "app_connector_credentials",
  "app_connector_oauth_installations",
  "app_wecom_install_attempts",
  "app_wecom_installations",
  "app_dingtalk_company_attempts",
  "app_dingtalk_company_grants",
  "app_dingtalk_inbound_attempts",
  "app_dingtalk_inbound_scopes",
  "app_feishu_link_attempts",
  "app_feishu_room_bindings",
  "app_teams_link_attempts",
  "app_teams_room_bindings",
  "app_telegram_link_attempts",
  "app_telegram_room_bindings",
  "app_googlechat_link_attempts",
  "app_googlechat_room_bindings",
  "app_connector_executions",
  "app_source_relations",
  "automation_occurrences",
  "automations",
  "control_intents",
  "extension_index_entries",
  "extension_index_heads",
  "extension_records",
  "instances",
  "machine_run_snapshot_heads",
  "natural_key_counters",
  "natural_key_reservations",
  "runs",
  // A Space being deleted, or its completed audit record, stays on its shard.
  "space_deletions",
  "trace_access_grants",
  "workspaces",
]);

export const GLOBAL_DATA_TABLES = Object.freeze([
  // Identity admission fences stay on every physical shard, independent of Spaces.
  "account_deletion_fences",
  // Application-wide signed retirement survives removal of all Space bindings.
  // App connections themselves remain movement blockers on the primary shard.
  "app_sentry_installation_lifecycle",
  "app_googlechat_room_lifecycle",
  "app_feishu_room_lifecycle",
  "app_teams_room_lifecycle",
  "app_telegram_room_lifecycle",
  "app_feishu_tenant_lifecycle",
  "app_feishu_tickets",
  "app_dingtalk_suite_tickets",
  "app_discord_revocations",
  "app_dingtalk_company_fences",
  "app_dingtalk_company_visibility",
  "app_dingtalk_company_tokens",
  "app_dingtalk_inbound_receipts",
  "app_dingtalk_inbound_jobs",
  "app_wecom_suite_tickets",
  "app_wecom_company_lifecycle",
  "app_wecom_suite_tokens",
  "app_sentry_event_jobs",
  "app_sentry_event_receipts",
  "agent_registrations",
  "assistant_memory_snapshots",
  "dangerous_action_requests",
  "durable_object_fact_archive",
  "human_profiles",
  "machine_daemon_activations",
  "machine_daemon_commands",
  "machine_daemon_control_audit",
  "machine_daemons",
  "machine_resource_hourly",
  "machine_resource_samples",
  "machine_run_routes",
  "machine_run_terminal_reports",
  "machines",
  "platform_focus_review_prompt",
  "platform_focus_review_prompt_revisions",
  "projection_manifest_authority",
  "projection_manifest_grants",
  "projection_scope_heads",
  "roles",
  "secret_grant_audit",
  "shared_memory_entries",
  "shared_memory_workspace_entries",
  "slack_oauth_sessions",
]);

const BLOCKER_QUERIES = Object.freeze({
  channel_transfer_proposals: "space_id = $1 OR target_space_id = $1",
  agent_launches: "space_id = $1",
  agent_reborn_intents: "space_id = $1",
  app_connector_action_policies: "space_id = $1",
  app_connector_channel_bindings: "space_id = $1",
  app_connector_connections: "space_id = $1",
  app_connector_credentials: "space_id = $1",
  app_connector_oauth_installations: "space_id = $1",
  app_wecom_install_attempts: "space_id = $1",
  app_wecom_installations: "space_id = $1",
  app_dingtalk_company_attempts: "space_id = $1",
  app_dingtalk_company_grants: "space_id = $1",
  app_dingtalk_inbound_attempts: "space_id = $1",
  app_dingtalk_inbound_scopes: "space_id = $1",
  app_feishu_link_attempts: "space_id = $1",
  app_feishu_room_bindings: "space_id = $1",
  app_teams_link_attempts: "space_id = $1",
  app_teams_room_bindings: "space_id = $1",
  app_telegram_link_attempts: "space_id = $1",
  app_telegram_room_bindings: "space_id = $1",
  app_googlechat_link_attempts: "space_id = $1",
  app_googlechat_room_bindings: "space_id = $1",
  app_connector_executions: "space_id = $1",
  app_source_relations: "space_id = $1",
  automation_occurrences:
    "automation_id IN (SELECT automation_id FROM data.automations WHERE channel_id IN (SELECT channel_id FROM data.channels WHERE space_id = $1))",
  automations: "channel_id IN (SELECT channel_id FROM data.channels WHERE space_id = $1)",
  control_intents: "scope_id = $1 OR scope_id IN (SELECT channel_id FROM data.channels WHERE space_id = $1)",
  extension_index_entries: "scope_id = $1 OR scope_id IN (SELECT channel_id FROM data.channels WHERE space_id = $1)",
  extension_index_heads: "scope_id = $1 OR scope_id IN (SELECT channel_id FROM data.channels WHERE space_id = $1)",
  extension_records: "scope_id = $1 OR scope_id IN (SELECT channel_id FROM data.channels WHERE space_id = $1)",
  instances: "channel_id IN (SELECT channel_id FROM data.channels WHERE space_id = $1)",
  machine_run_snapshot_heads: "channel_id IN (SELECT channel_id FROM data.channels WHERE space_id = $1)",
  runs: "channel_id IN (SELECT channel_id FROM data.channels WHERE space_id = $1)",
  run_secret_approvals: "space_id = $1",
  natural_key_counters: "channel_id IN (SELECT channel_id FROM data.channels WHERE space_id = $1)",
  natural_key_reservations: "channel_id IN (SELECT channel_id FROM data.channels WHERE space_id = $1)",
  trace_access_grants: "channel_id IN (SELECT channel_id FROM data.channels WHERE space_id = $1)",
  workspaces:
    "workspace_id IN (SELECT workspace_id FROM data.runs WHERE channel_id IN (SELECT channel_id FROM data.channels WHERE space_id = $1) AND workspace_id IS NOT NULL)",
});

const SELECTORS = Object.freeze(
  Object.fromEntries(MOVABLE_SPACE_TABLES.map((table) => [table, "space_id = $1"])),
);

function required(value, name) {
  const result = value?.trim();
  if (!result) throw new Error(`${name} is required`);
  return result;
}

function positiveInteger(value, name, fallback) {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function quoteIdentifier(value) {
  return `"${value.replaceAll('"', '""')}"`;
}

function canonicalValue(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "bigint") return { $bigint: value.toString() };
  if (value instanceof Date) return { $timestamp: value.toISOString() };
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return { $bytes: Buffer.from(value).toString("base64") };
  }
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]));
  }
  return String(value);
}

export function canonicalRow(row) {
  return JSON.stringify(canonicalValue(row));
}

export function digestTableRows(tables) {
  const hash = createHash("sha256");
  let rows = 0;
  let bytes = 0;
  for (const table of tables) {
    hash.update(`${table.name}\n`);
    for (const row of table.rows) {
      const encoded = canonicalRow(row);
      hash.update(encoded);
      hash.update("\n");
      rows += 1;
      bytes += Buffer.byteLength(encoded);
    }
  }
  return Object.freeze({ digest: hash.digest("hex"), rows, bytes });
}

export function nextSyncPhase(phase) {
  if (phase === "copying") return "catching_up";
  if (phase === "catching_up" || phase === "caught_up") return "caught_up";
  if (phase === "frozen") return "final_copied";
  throw new Error(`movement phase ${phase} cannot be synchronized`);
}

export function nextVerifyPhase(phase) {
  if (phase === "caught_up") return "verified";
  if (phase === "final_copied") return "final_verified";
  throw new Error(`movement phase ${phase} cannot be verified`);
}

async function connect(url, label) {
  const client = new Client({ connectionString: required(url, label) });
  await client.connect();
  return client;
}

async function withFreshDirectory(url, operation) {
  const directory = await connect(url, "DIRECTORY_DATABASE_URL");
  try {
    return await operation(directory);
  } finally {
    await directory.end();
  }
}

async function withFreshShard(url, urlLabel, shardId, shardLabel, operation) {
  const client = await connect(url, urlLabel);
  try {
    await assertLocalIdentity(client, shardId, shardLabel);
    return await operation(client);
  } finally {
    await client.end();
  }
}

async function withTransaction(client, operation, begin = "BEGIN") {
  await client.query(begin);
  try {
    const result = await operation();
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function lockSpace(client, spaceId) {
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))", [
    "xmatrix-space-shard-move",
    spaceId,
  ]);
}

async function movementForUpdate(client, movementId) {
  const result = await client.query(
    "SELECT * FROM control.space_shard_movements WHERE movement_id = $1 FOR UPDATE",
    [movementId],
  );
  if (result.rowCount !== 1) throw new Error(`movement ${movementId} does not exist`);
  await lockSpace(client, result.rows[0].space_id);
  return result.rows[0];
}

async function assertLocalIdentity(client, expectedShardId, label) {
  const result = await client.query(
    "SELECT shard_id FROM control.postgres_local_identity WHERE singleton = true",
  );
  if (result.rowCount !== 1 || result.rows[0].shard_id !== expectedShardId) {
    throw new Error(`${label} database is not physical shard ${expectedShardId}`);
  }
}

async function databaseIdentity(client) {
  const result = await client.query(`SELECT current_database() AS database_name,
    COALESCE(inet_server_addr()::text, 'local') AS server_address,
    COALESCE(inet_server_port(), 0) AS server_port`);
  return JSON.stringify(result.rows[0]);
}

async function databasesAreSame(first, second) {
  const [firstIdentity, secondIdentity] = await Promise.all([
    databaseIdentity(first),
    databaseIdentity(second),
  ]);
  return firstIdentity === secondIdentity;
}

async function assertPlacementState(client, movement, state, targetShardId, message) {
  const placement = await client.query(
    `SELECT shard_id, placement_epoch, state, target_shard_id
       FROM control.space_placement WHERE space_id = $1 FOR UPDATE`,
    [movement.space_id],
  );
  const row = placement.rows[0];
  if (placement.rowCount !== 1 || row.shard_id !== movement.source_shard_id ||
      row.placement_epoch !== movement.source_placement_epoch || row.state !== state ||
      row.target_shard_id !== targetShardId) {
    throw new Error(message);
  }
}

async function applyPlacementFence(client, movement, now) {
  await client.query(
    `UPDATE control.space_placement
        SET state = 'moving', target_shard_id = $2, updated_at = $3
      WHERE space_id = $1 AND shard_id = $4 AND placement_epoch = $5
        AND state = 'active' AND target_shard_id IS NULL`,
    [movement.space_id, movement.target_shard_id, now,
      movement.source_shard_id, movement.source_placement_epoch],
  );
  await assertPlacementState(
    client, movement, "moving", movement.target_shard_id,
    "source placement changed before freeze",
  );
}

async function restorePlacementFence(client, movement, now) {
  await client.query(
    `UPDATE control.space_placement
        SET state = 'active', target_shard_id = NULL, updated_at = $2
      WHERE space_id = $1 AND shard_id = $3 AND placement_epoch = $4
        AND state = 'moving' AND target_shard_id = $5`,
    [movement.space_id, now, movement.source_shard_id,
      movement.source_placement_epoch, movement.target_shard_id],
  );
  await assertPlacementState(
    client, movement, "active", null,
    "frozen placement cannot be restored safely",
  );
}

async function loadTableMetadata(client) {
  const tables = [...MOVABLE_SPACE_TABLES, ...INDIRECT_MOVABLE_SPACE_TABLES];
  const [columns, primaryKeys] = await Promise.all([
    client.query(
      `SELECT table_name, column_name, udt_name
         FROM information_schema.columns
        WHERE table_schema = 'data' AND table_name = ANY($1::text[])
        ORDER BY table_name, ordinal_position`,
      [tables],
    ),
    client.query(
      `SELECT c.relname AS table_name, a.attname AS column_name,
              array_position(i.indkey, a.attnum) AS ordinal
         FROM pg_index i
         JOIN pg_class c ON c.oid = i.indrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
        WHERE n.nspname = 'data' AND c.relname = ANY($1::text[]) AND i.indisprimary
        ORDER BY c.relname, ordinal`,
      [tables],
    ),
  ]);
  const metadata = new Map(tables.map((table) => [table, {
    columns: [],
    primaryKey: [],
    jsonColumns: new Set(),
  }]));
  for (const row of columns.rows) {
    const value = metadata.get(row.table_name);
    value?.columns.push(row.column_name);
    if (row.udt_name === "json" || row.udt_name === "jsonb") value?.jsonColumns.add(row.column_name);
  }
  for (const row of primaryKeys.rows) metadata.get(row.table_name)?.primaryKey.push(row.column_name);
  for (const [table, value] of metadata) {
    if (value.columns.length === 0 || value.primaryKey.length === 0) {
      throw new Error(`data.${table} must exist and have a primary key`);
    }
    Object.freeze(value.columns);
    Object.freeze(value.primaryKey);
    Object.freeze(value);
  }
  return metadata;
}

async function readClosure(client, spaceId, limits, suppliedMetadata) {
  const metadataByTable = suppliedMetadata ?? await loadTableMetadata(client);
  const tables = [];
  let totalRows = 0;
  let totalBytes = 0;
  for (const table of [...MOVABLE_SPACE_TABLES, ...INDIRECT_MOVABLE_SPACE_TABLES]) {
    const metadata = metadataByTable.get(table);
    const order = metadata.primaryKey.map(quoteIdentifier).join(", ");
    const result = await client.query(
      `SELECT * FROM data.${quoteIdentifier(table)} WHERE ${SELECTORS[table]} ORDER BY ${order}`,
      [spaceId],
    );
    const measured = digestTableRows([{ name: table, rows: result.rows }]);
    totalRows += measured.rows;
    totalBytes += measured.bytes;
    if (totalRows > limits.rows || totalBytes > limits.bytes) {
      throw new Error(`Space closure exceeds copy limits (${totalRows} rows, ${totalBytes} bytes)`);
    }
    tables.push(Object.freeze({ name: table, rows: result.rows, ...metadata }));
  }
  return Object.freeze(tables);
}

export async function blockingSpaceTables(client, spaceId) {
  const blocking = [];
  for (const table of BLOCKING_SPACE_TABLES) {
    const result = await client.query(
      `SELECT EXISTS (SELECT 1 FROM data.${quoteIdentifier(table)} WHERE ${BLOCKER_QUERIES[table]}) AS present`,
      [spaceId],
    );
    if (result.rows[0].present) blocking.push(table);
  }
  return Object.freeze(blocking);
}

async function assertNoBlockingFacts(client, spaceId) {
  const blocking = await blockingSpaceTables(client, spaceId);
  if (blocking.length > 0) {
    throw new Error(`Space has facts whose authorities are not shard-movable: ${blocking.join(", ")}`);
  }
}

async function replaceClosure(client, spaceId, tables, batchRows) {
  for (const table of [...tables].reverse()) {
    await client.query(
      `DELETE FROM data.${quoteIdentifier(table.name)} WHERE ${SELECTORS[table.name]}`,
      [spaceId],
    );
  }
  for (const table of tables) {
    const columnsSql = table.columns.map(quoteIdentifier).join(", ");
    const maximumBatch = Math.max(1, Math.min(batchRows, Math.floor(60_000 / table.columns.length)));
    for (let offset = 0; offset < table.rows.length; offset += maximumBatch) {
      const rows = table.rows.slice(offset, offset + maximumBatch);
      const values = [];
      const tuples = rows.map((row) => {
        const placeholders = table.columns.map((column) => {
          values.push(table.jsonColumns.has(column) && row[column] !== null
            ? JSON.stringify(row[column])
            : row[column]);
          return `$${values.length}`;
        });
        return `(${placeholders.join(", ")})`;
      });
      await client.query(
        `INSERT INTO data.${quoteIdentifier(table.name)} (${columnsSql}) VALUES ${tuples.join(", ")}`,
        values,
      );
    }
  }
}

async function loadHeadSequence(client, spaceId) {
  const result = await client.query(
    "SELECT commit_sequence FROM data.space_control_heads WHERE space_id = $1",
    [spaceId],
  );
  return result.rowCount === 0 ? 0n : BigInt(result.rows[0].commit_sequence);
}

function runtimeOptions(env = process.env) {
  return Object.freeze({
    directoryUrl: required(env.DIRECTORY_DATABASE_URL, "DIRECTORY_DATABASE_URL"),
    sourceUrl: required(env.SOURCE_DATABASE_URL, "SOURCE_DATABASE_URL"),
    targetUrl: required(env.TARGET_DATABASE_URL, "TARGET_DATABASE_URL"),
    limits: Object.freeze({
      rows: positiveInteger(env.SPACE_MOVE_MAX_ROWS, "SPACE_MOVE_MAX_ROWS", 1_000_000),
      bytes: positiveInteger(env.SPACE_MOVE_MAX_BYTES, "SPACE_MOVE_MAX_BYTES", 1024 ** 3),
    }),
    batchRows: positiveInteger(env.SPACE_MOVE_BATCH_ROWS, "SPACE_MOVE_BATCH_ROWS", 250),
  });
}

function parseArguments(argv) {
  const [command, ...rest] = argv;
  const values = {};
  for (let index = 0; index < rest.length; index += 1) {
    const key = rest[index];
    if (!key.startsWith("--") || index + 1 >= rest.length) throw new Error(`invalid argument ${key}`);
    values[key.slice(2)] = rest[index + 1];
    index += 1;
  }
  return Object.freeze({ command: required(command, "command"), values });
}

async function validateMovementEndpoints(
  directory,
  source,
  target,
  spaceId,
  targetShardId,
  lockPlacement = false,
) {
  const placement = await directory.query(
    `SELECT * FROM control.space_placement WHERE space_id = $1${lockPlacement ? " FOR UPDATE" : ""}`,
    [spaceId],
  );
  if (placement.rowCount !== 1) throw new Error(`Space ${spaceId} has no placement`);
  const current = placement.rows[0];
  if (current.state !== "active" || current.target_shard_id !== null) {
    throw new Error(`Space ${spaceId} placement is not active`);
  }
  const activeMovement = await directory.query(
    `SELECT movement_id, phase FROM control.space_shard_movements
      WHERE space_id = $1 AND phase <> ALL($2::text[])`,
    [spaceId, [...TERMINAL_PHASES]],
  );
  if (activeMovement.rowCount !== 0) {
    throw new Error(
      `Space ${spaceId} already has active movement ${activeMovement.rows[0].movement_id}`,
    );
  }
  if (current.shard_id === targetShardId) throw new Error("source and target shard must differ");
  const targetShard = await directory.query(
    "SELECT state, capacity_class FROM control.postgres_shards WHERE shard_id = $1",
    [targetShardId],
  );
  if (targetShard.rowCount !== 1 || targetShard.rows[0].state !== "active") {
    throw new Error(`target shard ${targetShardId} is not active`);
  }
  await assertLocalIdentity(source, current.shard_id, "source");
  await assertLocalIdentity(target, targetShardId, "target");
  if (await databasesAreSame(source, target)) {
    throw new Error("source and target database must differ");
  }
  return Object.freeze({ current, targetShard: targetShard.rows[0] });
}

export async function preflightMovement(directory, source, target, values, options) {
  const spaceId = required(values.space, "--space");
  const targetShardId = required(values.target, "--target");
  const { current, targetShard } = await validateMovementEndpoints(
    directory, source, target, spaceId, targetShardId,
  );
  const blockingTables = await blockingSpaceTables(source, spaceId);
  if (blockingTables.length > 0) {
    throw new Error(
      `Space has facts whose authorities are not shard-movable: ${blockingTables.join(", ")}`,
    );
  }
  const closure = await readClosure(source, spaceId, options.limits);
  const measured = digestTableRows(closure);
  return Object.freeze({
    eligible: true,
    space_id: spaceId,
    source_shard_id: current.shard_id,
    target_shard_id: targetShardId,
    source_placement_epoch: current.placement_epoch,
    target_placement_epoch: BigInt(current.placement_epoch) + 1n,
    target_capacity_class: targetShard.capacity_class,
    copied_rows: measured.rows,
    copied_bytes: measured.bytes,
    source_digest_sha256: measured.digest,
    limits: options.limits,
  });
}

async function beginMovement(directory, source, target, values) {
  const movementId = required(values.movement, "--movement");
  const spaceId = required(values.space, "--space");
  const targetShardId = required(values.target, "--target");
  const rollbackSeconds = positiveInteger(values["rollback-seconds"], "--rollback-seconds", 86_400);
  if (rollbackSeconds < 3_600) throw new Error("--rollback-seconds must be at least 3600");
  return withTransaction(directory, async () => {
    await lockSpace(directory, spaceId);
    const { current } = await validateMovementEndpoints(
      directory, source, target, spaceId, targetShardId, true,
    );
    const now = new Date();
    const inserted = await directory.query(
      `INSERT INTO control.space_shard_movements (
         movement_id, space_id, source_shard_id, target_shard_id,
         source_placement_epoch, target_placement_epoch, phase,
         rollback_window_seconds, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5::bigint, $5::bigint + 1, 'copying', $6, $7, $7)
       RETURNING *`,
      [movementId, spaceId, current.shard_id, targetShardId, current.placement_epoch, rollbackSeconds, now],
    );
    return inserted.rows[0];
  });
}

async function synchronize(directory, source, target, movementId, options) {
  const movement = await withTransaction(directory, async () => movementForUpdate(directory, movementId));
  if (!SYNC_PHASES.has(movement.phase)) throw new Error(`movement phase ${movement.phase} cannot be synchronized`);
  await assertLocalIdentity(source, movement.source_shard_id, "source");
  await assertLocalIdentity(target, movement.target_shard_id, "target");
  await Promise.all([directory.end(), target.end()]);

  let sourceTables;
  let sourceDigest;
  let commitSequence;
  await withTransaction(source, async () => {
    await assertNoBlockingFacts(source, movement.space_id);
    sourceTables = await readClosure(source, movement.space_id, options.limits);
    sourceDigest = digestTableRows(sourceTables);
    commitSequence = await loadHeadSequence(source, movement.space_id);
  }, "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");

  const targetDigest = await withFreshShard(
    options.targetUrl, "TARGET_DATABASE_URL", movement.target_shard_id, "target",
    async (copyTarget) => withTransaction(copyTarget, async () => {
      await replaceClosure(copyTarget, movement.space_id, sourceTables, options.batchRows);
      const targetMetadata = new Map(sourceTables.map((table) => [table.name, table]));
      const targetTables = await readClosure(
        copyTarget, movement.space_id, options.limits, targetMetadata,
      );
      const digest = digestTableRows(targetTables);
      if (digest.digest !== sourceDigest.digest || digest.rows !== sourceDigest.rows) {
        throw new Error("target digest differs after copy");
      }
      return digest;
    }),
  );

  return withFreshDirectory(options.directoryUrl, async (updateDirectory) =>
    withTransaction(updateDirectory, async () => {
      const current = await movementForUpdate(updateDirectory, movementId);
      if (current.version !== movement.version || current.phase !== movement.phase) {
        throw new Error("movement changed while synchronization was running; rerun status");
      }
      const nextPhase = nextSyncPhase(current.phase);
      const sequenceColumn = current.phase === "copying"
        ? "snapshot_commit_sequence"
        : current.phase === "frozen" ? "final_commit_sequence" : "caught_up_commit_sequence";
      const result = await updateDirectory.query(
        `UPDATE control.space_shard_movements
            SET phase = $2, ${sequenceColumn} = $3,
                source_digest_sha256 = $4, target_digest_sha256 = $5,
                copied_rows = $6, copied_bytes = $7,
                last_error = NULL, version = version + 1, updated_at = $8
          WHERE movement_id = $1 AND version = $9
          RETURNING *`,
        [movementId, nextPhase, commitSequence.toString(), sourceDigest.digest, targetDigest.digest,
          sourceDigest.rows, sourceDigest.bytes, new Date(), current.version],
      );
      if (result.rowCount !== 1) throw new Error("movement synchronization lost its version fence");
      return result.rows[0];
    }));
}

async function verifyMovement(directory, source, target, movementId, options) {
  const movement = await withTransaction(directory, async () => movementForUpdate(directory, movementId));
  if (!VERIFY_PHASES.has(movement.phase)) throw new Error(`movement phase ${movement.phase} cannot be verified`);
  await assertLocalIdentity(source, movement.source_shard_id, "source");
  await assertLocalIdentity(target, movement.target_shard_id, "target");
  await Promise.all([directory.end(), target.end()]);
  const sourceTables = await withTransaction(source, async () =>
    readClosure(source, movement.space_id, options.limits), "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  const targetTables = await withFreshShard(
    options.targetUrl, "TARGET_DATABASE_URL", movement.target_shard_id, "target",
    async (verifyTarget) => withTransaction(verifyTarget, async () =>
      readClosure(verifyTarget, movement.space_id, options.limits),
    "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY"),
  );
  const sourceDigest = digestTableRows(sourceTables);
  const targetDigest = digestTableRows(targetTables);
  if (sourceDigest.digest !== targetDigest.digest || sourceDigest.rows !== targetDigest.rows) {
    throw new Error(`verification digest mismatch: source=${sourceDigest.digest} target=${targetDigest.digest}`);
  }
  return withFreshDirectory(options.directoryUrl, async (updateDirectory) =>
    withTransaction(updateDirectory, async () => {
      const current = await movementForUpdate(updateDirectory, movementId);
      if (current.version !== movement.version || current.phase !== movement.phase) {
        throw new Error("movement changed while verification was running; retry");
      }
      const result = await updateDirectory.query(
        `UPDATE control.space_shard_movements
            SET phase = $2, source_digest_sha256 = $3, target_digest_sha256 = $3,
                copied_rows = $4, copied_bytes = $5, last_error = NULL,
                version = version + 1, updated_at = $6
          WHERE movement_id = $1 AND version = $7 RETURNING *`,
        [movementId, nextVerifyPhase(current.phase), sourceDigest.digest,
          sourceDigest.rows, sourceDigest.bytes, new Date(), current.version],
      );
      return result.rows[0];
    }));
}

async function freezeMovement(directory, source, movementId) {
  const movement = await withTransaction(directory, async () => movementForUpdate(directory, movementId));
  if (movement.phase === "frozen") return movement;
  if (movement.phase !== "verified") throw new Error(`movement phase ${movement.phase} cannot be frozen`);
  await assertLocalIdentity(source, movement.source_shard_id, "source");
  const sameDatabase = await databasesAreSame(directory, source);
  const now = new Date();
  if (!sameDatabase) {
    await withTransaction(source, async () => applyPlacementFence(source, movement, now));
  }
  return withTransaction(directory, async () => {
    const current = await movementForUpdate(directory, movementId);
    if (current.phase === "frozen") return current;
    if (current.version !== movement.version || current.phase !== "verified") {
      throw new Error("movement changed before freeze");
    }
    await applyPlacementFence(directory, current, now);
    const result = await directory.query(
      `UPDATE control.space_shard_movements
          SET phase = 'frozen', frozen_at = $2, last_error = NULL,
              version = version + 1, updated_at = $2
        WHERE movement_id = $1 AND version = $3 RETURNING *`,
      [movementId, now, current.version],
    );
    return result.rows[0];
  });
}

async function cutoverMovement(directory, source, target, movementId) {
  const movement = await withTransaction(directory, async () => movementForUpdate(directory, movementId));
  if (movement.phase === "rollback_window") return movement;
  if (movement.phase !== "final_verified") throw new Error(`movement phase ${movement.phase} cannot be cut over`);
  await assertLocalIdentity(source, movement.source_shard_id, "source");
  await assertLocalIdentity(target, movement.target_shard_id, "target");
  const sourceSequence = await withTransaction(source, async () =>
    loadHeadSequence(source, movement.space_id), "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  if (sourceSequence !== BigInt(movement.final_commit_sequence)) {
    throw new Error("source commit sequence advanced after final copy");
  }
  const placementResult = await directory.query(
    "SELECT plan_class FROM control.space_placement WHERE space_id = $1",
    [movement.space_id],
  );
  if (placementResult.rowCount !== 1) throw new Error("source placement disappeared");
  await withTransaction(target, async () => {
    await target.query(
      `INSERT INTO control.space_placement (
         space_id, shard_id, placement_epoch, state, target_shard_id,
         plan_class, created_at, updated_at
       ) VALUES ($1, $2, $3, 'active', NULL, $4, $5, $5)
       ON CONFLICT (space_id) DO UPDATE SET
         shard_id = EXCLUDED.shard_id,
         placement_epoch = EXCLUDED.placement_epoch,
         state = 'active', target_shard_id = NULL,
         plan_class = EXCLUDED.plan_class, updated_at = EXCLUDED.updated_at`,
      [movement.space_id, movement.target_shard_id, movement.target_placement_epoch,
        placementResult.rows[0].plan_class, new Date()],
    );
  });
  return withTransaction(directory, async () => {
    const current = await movementForUpdate(directory, movementId);
    if (current.phase === "rollback_window") return current;
    if (current.version !== movement.version || current.phase !== "final_verified") {
      throw new Error("movement changed before directory cutover");
    }
    const now = new Date();
    const expiresAt = new Date(now.getTime() + Number(current.rollback_window_seconds) * 1000);
    const placement = await directory.query(
      `UPDATE control.space_placement
          SET shard_id = $2, placement_epoch = $3, state = 'active',
              target_shard_id = NULL, updated_at = $4
        WHERE space_id = $1 AND shard_id = $5 AND placement_epoch = $6
          AND state = 'moving' AND target_shard_id = $2`,
      [current.space_id, current.target_shard_id, current.target_placement_epoch,
        now, current.source_shard_id, current.source_placement_epoch],
    );
    if (placement.rowCount !== 1) throw new Error("frozen placement changed before cutover");
    for (const table of ["channel_space_routes", "user_space_membership_routes", "entity_space_routes"]) {
      await directory.query(
        `UPDATE control.${quoteIdentifier(table)}
            SET shard_id = $2, placement_epoch = $3, updated_at = $4
          WHERE space_id = $1 AND shard_id = $5 AND placement_epoch = $6`,
        [current.space_id, current.target_shard_id, current.target_placement_epoch,
          now, current.source_shard_id, current.source_placement_epoch],
      );
    }
    const result = await directory.query(
      `UPDATE control.space_shard_movements
          SET phase = 'rollback_window', cutover_at = $2,
              rollback_expires_at = $3, last_error = NULL,
              version = version + 1, updated_at = $2
        WHERE movement_id = $1 AND version = $4 RETURNING *`,
      [movementId, now, expiresAt, current.version],
    );
    return result.rows[0];
  });
}

async function abortMovement(directory, source, movementId) {
  const movement = await withTransaction(directory, async () => movementForUpdate(directory, movementId));
  if (movement.phase === "aborted") return movement;
  if (movement.phase === "rollback_window" || movement.phase === "completed") {
    throw new Error("post-cutover movement cannot be aborted; use forward recovery");
  }
  const now = new Date();
  const wasFrozen = ["frozen", "final_copied", "final_verified"].includes(movement.phase);
  const sameDatabase = await databasesAreSame(directory, source);
  if (wasFrozen && !sameDatabase) {
    await assertLocalIdentity(source, movement.source_shard_id, "source");
    await withTransaction(source, async () => restorePlacementFence(source, movement, now));
  }
  return withTransaction(directory, async () => {
    const current = await movementForUpdate(directory, movementId);
    if (current.phase === "aborted") return current;
    if (current.version !== movement.version || current.phase !== movement.phase) {
      throw new Error("movement changed before abort");
    }
    if (wasFrozen) await restorePlacementFence(directory, current, now);
    const result = await directory.query(
      `UPDATE control.space_shard_movements
          SET phase = 'aborted', aborted_at = $2, last_error = NULL,
              version = version + 1, updated_at = $2
        WHERE movement_id = $1 AND version = $3 RETURNING *`,
      [movementId, now, movement.version],
    );
    return result.rows[0];
  });
}

async function completeMovement(directory, movementId) {
  return withTransaction(directory, async () => {
    const movement = await movementForUpdate(directory, movementId);
    if (movement.phase === "completed") return movement;
    if (movement.phase !== "rollback_window") throw new Error(`movement phase ${movement.phase} cannot be completed`);
    const now = new Date();
    if (new Date(movement.rollback_expires_at) > now) throw new Error("rollback observation window has not expired");
    const result = await directory.query(
      `UPDATE control.space_shard_movements
          SET phase = 'completed', completed_at = $2, last_error = NULL,
              version = version + 1, updated_at = $2
        WHERE movement_id = $1 AND version = $3 RETURNING *`,
      [movementId, now, movement.version],
    );
    return result.rows[0];
  });
}

function publicMovement(row) {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [
    key,
    typeof value === "bigint" ? value.toString() : value,
  ]));
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const { command, values } = parseArguments(argv);
  const options = runtimeOptions(env);
  const directory = await connect(options.directoryUrl, "DIRECTORY_DATABASE_URL");
  let source;
  let target;
  try {
    const movementId = values.movement;
    let result;
    if (command === "preflight") {
      source = await connect(options.sourceUrl, "SOURCE_DATABASE_URL");
      target = await connect(options.targetUrl, "TARGET_DATABASE_URL");
      result = await preflightMovement(directory, source, target, values, options);
    } else if (command === "begin") {
      source = await connect(options.sourceUrl, "SOURCE_DATABASE_URL");
      target = await connect(options.targetUrl, "TARGET_DATABASE_URL");
      result = await beginMovement(directory, source, target, values);
    } else if (command === "status") {
      const status = await directory.query(
        "SELECT * FROM control.space_shard_movements WHERE movement_id = $1",
        [required(movementId, "--movement")],
      );
      if (status.rowCount !== 1) throw new Error(`movement ${movementId} does not exist`);
      result = status.rows[0];
    } else if (command === "freeze") {
      source = await connect(options.sourceUrl, "SOURCE_DATABASE_URL");
      result = await freezeMovement(directory, source, required(movementId, "--movement"));
    } else if (command === "abort") {
      source = await connect(options.sourceUrl, "SOURCE_DATABASE_URL");
      result = await abortMovement(directory, source, required(movementId, "--movement"));
    } else if (command === "complete") {
      result = await completeMovement(directory, required(movementId, "--movement"));
    } else {
      source = await connect(options.sourceUrl, "SOURCE_DATABASE_URL");
      target = await connect(options.targetUrl, "TARGET_DATABASE_URL");
      if (command === "sync") result = await synchronize(directory, source, target, required(movementId, "--movement"), options);
      else if (command === "verify") result = await verifyMovement(directory, source, target, required(movementId, "--movement"), options);
      else if (command === "cutover") result = await cutoverMovement(directory, source, target, required(movementId, "--movement"));
      else throw new Error(`unknown command ${command}`);
    }
    process.stdout.write(`${JSON.stringify(publicMovement(result), null, 2)}\n`);
  } catch (error) {
    if (values.movement) {
      const errorDirectory = await connect(options.directoryUrl, "DIRECTORY_DATABASE_URL")
        .catch(() => null);
      if (errorDirectory) {
        try {
          await errorDirectory.query(
            `UPDATE control.space_shard_movements
                SET last_error = $2, updated_at = clock_timestamp()
              WHERE movement_id = $1 AND phase <> ALL($3::text[])`,
            [values.movement,
              (error instanceof Error ? error.message : String(error)).slice(0, 2_000),
              [...TERMINAL_PHASES]],
          );
        } catch {
          // The original operator failure remains the actionable error.
        } finally {
          await errorDirectory.end().catch(() => undefined);
        }
      }
    }
    throw error;
  } finally {
    await Promise.allSettled([source?.end(), target?.end(), directory.end()]);
  }
}

runIfInvoked(import.meta.url, main);
