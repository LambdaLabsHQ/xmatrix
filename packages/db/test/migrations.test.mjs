import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  assertExpandOnlyPostgresMigration,
  assertPostgresRuntimeRole,
  assertExistingExpandTarget,
  loadMigrationManifest,
  parseMigrationArgs,
  reconcileMigrationState,
} from "../scripts/migrate.mjs";

test("existing release migration mode cannot bootstrap or authorize contract work", async () => {
  const revision = "a".repeat(40);
  assert.equal(parseMigrationArgs(["apply", "--existing-expand-only", `--revision=${revision}`])
    .existingExpandOnly, true);
  for (const args of [
    ["apply", "--revision=local"], ["check", `--revision=${revision}`],
    ["apply", `--revision=${revision}`, "--allow-contract"],
  ]) assert.throws(() => parseMigrationArgs([...args, "--existing-expand-only"]), /Existing expand/u);

  const checkedIn = await loadMigrationManifest();
  // The release path only ever sees a ledger whose pending tail is expand work;
  // exercise it against the expand prefix before the first contract migration.
  const firstContract = checkedIn.findIndex(({ phase }) => phase === "contract");
  const manifest = firstContract < 0 ? checkedIn : checkedIn.slice(0, firstContract);
  const rows = manifest.slice(0, -1).map((m) => ({
    migration_id: m.id, checksum_sha256: m.checksumSha256, phase: m.phase,
  }));
  let reads = 0;
  const client = { query: async () => { reads += 1; return { rows: [{ shard_id: "shard-0" }] }; } };
  assert.deepEqual((await assertExistingExpandTarget(client, manifest, rows, "shard-0"))
    .map(({ id }) => id), [manifest.at(-1).id]);
  assert.equal(reads, 1);
  // A checked-in contract migration left pending is never applied by the release path.
  const expandApplied = manifest.map((m) => ({
    migration_id: m.id, checksum_sha256: m.checksumSha256, phase: m.phase,
  }));
  await assert.rejects(assertExistingExpandTarget(client, checkedIn, expandApplied, "shard-0"),
    /pending contract migration/u);
  await assert.rejects(assertExistingExpandTarget(client, manifest, [], "shard-0"), /empty ledger/u);
  await assert.rejects(assertExistingExpandTarget(client,
    [...manifest.slice(0, -1), { ...manifest.at(-1), phase: "contract" }], rows, "shard-0"), /contract/u);
  await assert.rejects(assertExistingExpandTarget(client, manifest, rows, "shard-1"), /identity differs/u);
  await assert.rejects(assertExistingExpandTarget(client, manifest, rows, undefined), /POSTGRES_SHARD_ID/u);
  await assert.rejects(assertExistingExpandTarget(client, manifest,
    [{ ...rows[0], checksum_sha256: "0".repeat(64) }, ...rows.slice(1)], "shard-0"), /checksum changed/u);
});

test("runtime role for migration apply is explicit and safe to interpolate", () => {
  assert.equal(assertPostgresRuntimeRole("xmatrix_next_runtime"), "xmatrix_next_runtime");
  for (const role of [undefined, "", "xmatrix-next-runtime", "XmatrixRuntime", "0runtime"]) {
    assert.throws(() => assertPostgresRuntimeRole(role), /POSTGRES_RUNTIME_ROLE/u);
  }
});

test("checked-in PostgreSQL migration manifest is contiguous and names every contract migration", async () => {
  const manifest = await loadMigrationManifest();
  assert.deepEqual(manifest.map(({ id, phase }) => ({ id, phase })), [
    { id: "0000_expand_migration_ledger", phase: "expand" },
    { id: "0001_expand_space_placement", phase: "expand" },
    { id: "0002_expand_data_substrate", phase: "expand" },
    { id: "0003_expand_auth_control_facts", phase: "expand" },
    { id: "0004_expand_auth_shadow_state", phase: "expand" },
    { id: "0005_expand_user_space_preferences", phase: "expand" },
    { id: "0006_expand_user_preference_shadow_state", phase: "expand" },
    { id: "0007_expand_space_control_facts", phase: "expand" },
    { id: "0008_expand_message_facts", phase: "expand" },
    { id: "0009_expand_remaining_control_facts", phase: "expand" },
    { id: "0010_expand_durable_object_fact_archive", phase: "expand" },
    { id: "0011_expand_space_control_authority", phase: "expand" },
    { id: "0012_expand_content_authority", phase: "expand" },
    { id: "0013_expand_extension_projection_facts", phase: "expand" },
    { id: "0014_expand_current_control_fact_shapes", phase: "expand" },
    { id: "0015_expand_user_agent_control_facts", phase: "expand" },
    { id: "0016_expand_scoped_control_command_replays", phase: "expand" },
    { id: "0017_expand_app_execution_authority", phase: "expand" },
    { id: "0018_expand_secret_value_authority", phase: "expand" },
    { id: "0019_expand_machine_command_authority", phase: "expand" },
    { id: "0020_expand_scheduled_occurrence_authority", phase: "expand" },
    { id: "0021_expand_trace_access_authority", phase: "expand" },
    { id: "0022_expand_secret_broker_authority", phase: "expand" },
    { id: "0023_expand_compatibility_authority", phase: "expand" },
    { id: "0024_expand_global_space_routing", phase: "expand" },
    { id: "0025_expand_entity_space_routes", phase: "expand" },
    { id: "0026_expand_space_shard_movements", phase: "expand" },
    { id: "0027_expand_message_attachment_refs", phase: "expand" },
    { id: "0028_expand_durable_object_retirement_receipts", phase: "expand" },
    { id: "0029_expand_durable_object_compactions", phase: "expand" },
    { id: "0030_expand_durable_object_empty_shell_retirements", phase: "expand" },
    { id: "0031_expand_durable_object_retirement_completion", phase: "expand" },
    { id: "0032_expand_main_compatibility", phase: "expand" },
    { id: "0033_expand_channel_catalog_paging", phase: "expand" },
    { id: "0034_expand_direct_channel_identity", phase: "expand" },
    { id: "0035_expand_thread_history_lookup", phase: "expand" },
    { id: "0036_expand_agent_launches", phase: "expand" },
    { id: "0037_expand_agent_launch_timeline", phase: "expand" },
    { id: "0038_expand_machine_run_snapshot_causality", phase: "expand" },
    { id: "0039_expand_runtime_relation_grants", phase: "expand" },
    { id: "0040_expand_platform_focus_prompt_authority", phase: "expand" },
    { id: "0041_expand_legacy_postgres_sync_control", phase: "expand" },
    { id: "0042_expand_message_append_hot_path", phase: "expand" },
    { id: "0043_expand_postgres_message_sequence_coordination", phase: "expand" },
    { id: "0044_expand_channel_transfer_proposals", phase: "expand" },
    { id: "0045_expand_machine_request_status_index", phase: "expand" },
    { id: "0046_expand_run_invocation_sources", phase: "expand" },
    { id: "0047_expand_agent_message_executions", phase: "expand" },
    { id: "0048_expand_message_agent_targets", phase: "expand" },
    { id: "0049_expand_invocation_input_version", phase: "expand" },
    { id: "0050_expand_launch_initial_source", phase: "expand" },
    { id: "0051_expand_message_final_reply", phase: "expand" },
    { id: "0052_expand_reply_recovery_commands", phase: "expand" },
    { id: "0053_expand_extension_record_identity_note", phase: "expand" },
    { id: "0054_expand_instance_presentation", phase: "expand" },
    { id: "0055_expand_human_time_zone", phase: "expand" },
    { id: "0056_expand_agent_routing", phase: "expand" },
    { id: "0057_expand_agent_display_names", phase: "expand" },
    { id: "0058_expand_reborn_intents", phase: "expand" },
    { id: "0059_expand_agent_registration_keys", phase: "expand" },
    { id: "0060_expand_registration_access", phase: "expand" },
    { id: "0061_expand_registration_commands", phase: "expand" },
    { id: "0062_expand_registration_execution_revision", phase: "expand" },
    { id: "0063_expand_registration_authority", phase: "expand" },
    { id: "0064_expand_registration_enrollments", phase: "expand" },
    { id: "0065_expand_registration_environment", phase: "expand" },
    { id: "0066_expand_registration_allocations", phase: "expand" },
    { id: "0067_expand_registration_grant_execution_revision", phase: "expand" },
    { id: "0068_expand_registration_run_bindings", phase: "expand" },
    { id: "0069_expand_registration_stop_intents", phase: "expand" },
    { id: "0070_expand_registration_launch_intents", phase: "expand" },
    { id: "0071_expand_registration_quota_observations", phase: "expand" },
    { id: "0072_expand_quota_probe_commands", phase: "expand" },
    { id: "0073_expand_reborn_failure_notice", phase: "expand" },
    { id: "0074_expand_registration_launch_request", phase: "expand" },
    { id: "0075_expand_decision_upload_retention", phase: "expand" },
    { id: "0076_expand_nullable_profile_references", phase: "expand" },
    { id: "0077_expand_request_without_profile", phase: "expand" },
    { id: "0078_expand_registration_launch_input", phase: "expand" },
    { id: "0079_expand_registration_optional_model", phase: "expand" },
    // Renames the Automation tables and leaves compatibility views for the
    // previously deployed Hub; applied only with --allow-contract.
    { id: "0080_contract_automation_storage_names", phase: "contract" },
    // Rewrites pre-rename Automation stored values and drops 0080's views.
    { id: "0081_contract_automation_stored_values", phase: "contract" },
    // Rewrites persisted model lists that carry their own row's harness name;
    // a data rewrite, so it is contract work applied with --allow-contract.
    { id: "0082_contract_remove_harness_named_models", phase: "contract" },
    // Counters and creation-key reservations that derive Instance and Run ids
    // from their natural keys.
    { id: "0083_expand_natural_key_reservations", phase: "expand" },
    // Discards every Run and Instance and pins stored ids to their natural
    // keys; applied only with --allow-contract.
    { id: "0084_contract_natural_instance_run_ids", phase: "contract" },
    { id: "0085_expand_machines", phase: "expand" },
    { id: "0086_expand_machine_identity_adoptions", phase: "expand" },
    { id: "0087_expand_machine_parent", phase: "expand" },
    // Where a cross-Channel link came from; NULL for every other message.
    { id: "0088_expand_message_origin", phase: "expand" },
    // Which kind of principal reacted; NULL is a legacy Human row.
    { id: "0089_expand_message_reactor_kind", phase: "expand" },
    // Reads a reborn's intent by the message that asked for it.
    { id: "0090_expand_reborn_intent_source", phase: "expand" },
    // What a failed reborn step reported, for its failure notice.
    { id: "0091_expand_reborn_failure_detail", phase: "expand" },
    // A daemon's terminal Run report, recorded before it is acknowledged.
    { id: "0092_expand_machine_run_terminal_reports", phase: "expand" },
    { id: "0093_expand_cross_space_read_grants", phase: "expand" },
    { id: "0094_expand_cross_space_read_notices", phase: "expand" },
    // Drops the retired Free-limit notice queue and usage notice columns.
    { id: "0095_contract_drop_billing_notice", phase: "contract" },
    // Each Channel coordinator's own due work, read by (channel_id, due time).
    { id: "0096_expand_channel_coordinator_indexes", phase: "expand" },
    // Selects Automations by Channel for each Channel coordinator.
    { id: "0097_expand_automation_channel_index", phase: "expand" },
    // An owner's restorable Space deletion and, after the purge, its audit record.
    { id: "0098_expand_space_deletions", phase: "expand" },
    // Pages: the markdown page tree, its revisions, access, conversation links and repository mounts.
    { id: "0099_expand_pages", phase: "expand" },
    // A Space's confirmed plan for moving from the Channel tree to pages, and its report.
    { id: "0100_expand_page_migrations", phase: "expand" },
    // The published Role Package version a Space registration runs as.
    { id: "0101_expand_registration_role", phase: "expand" },
    // One-command Agent creation is audited beside offer and configure.
    { id: "0102_contract_registration_create_command", phase: "contract" },
    // Public pages: when a page was published.
    { id: "0103_expand_public_pages", phase: "expand" },
    { id: "0104_expand_registration_only", phase: "expand" },
    { id: "0105_contract_registration_only", phase: "contract" },
    // Claims: leases on page blocks, and blocks opened for competition.
    { id: "0106_expand_page_claims", phase: "expand" },
    { id: "0107_contract_registration_only_names", phase: "contract" },
    { id: "0108_expand_page_claim_pull_requests", phase: "expand" },
    { id: "0109_expand_participant_role", phase: "expand" },
    { id: "0110_expand_reads_without_channel_tree", phase: "expand" },
    { id: "0111_contract_purge_retired_agent_dms", phase: "contract" },
    // Every Space moves to pages; the Channel tree, archive state and tree views go.
    { id: "0112_contract_pages_cutover", phase: "contract" },
    { id: "0113_expand_page_discussions", phase: "expand" },
    { id: "0114_expand_page_claim_writeback", phase: "expand" },
    { id: "0115_expand_page_automations", phase: "expand" },
    { id: "0116_expand_automation_triggers", phase: "expand" },
    { id: "0117_expand_instance_rest_state", phase: "expand" },
    { id: "0118_contract_automations_on_pages", phase: "contract" },
    { id: "0119_expand_registration_quota_windows", phase: "expand" },
    { id: "0120_expand_harness_action_commands", phase: "expand" },
    { id: "0121_expand_machine_retirement", phase: "expand" },
    { id: "0122_expand_app_connector_credentials", phase: "expand" },
    { id: "0123_expand_space_secrets", phase: "expand" },
    { id: "0124_expand_app_connector_action_policies", phase: "expand" },
    { id: "0125_expand_slack_oauth_session_token", phase: "expand" },
    { id: "0126_contract_retire_owner_secret_tables", phase: "contract" },
    { id: "0127_expand_github_write_policies", phase: "expand" },
    { id: "0128_contract_drop_signup_invites", phase: "contract" },
    { id: "0129_expand_first_message_launch_choices", phase: "expand" },
    { id: "0130_expand_page_reads", phase: "expand" },
    { id: "0131_expand_machine_hostname", phase: "expand" },
    { id: "0132_contract_copy_machine_hostname", phase: "contract" },
    { id: "0133_expand_optional_stop_hostname", phase: "expand" },
    { id: "0134_expand_optional_legacy_hostname", phase: "expand" },
    { id: "0135_contract_machine_snapshot_scope", phase: "contract" },
    { id: "0136_expand_hostname_storage_observations", phase: "expand" },
    { id: "0137_contract_retire_legacy_hostname", phase: "contract" },
    { id: "0138_contract_purge_direct_conversations", phase: "contract" },
    { id: "0139_contract_drop_page_repository_mounts", phase: "contract" },
    { id: "0140_expand_connector_oauth_installations", phase: "expand" },
    { id: "0141_expand_vercel_event_scope", phase: "expand" },
    { id: "0142_expand_sentry_installation_binding", phase: "expand" },
    { id: "0143_expand_sentry_installation_lifecycle", phase: "expand" },
    { id: "0144_expand_sentry_event_receipts", phase: "expand" },
    { id: "0145_expand_space_kind_optional", phase: "expand" },
    { id: "0146_expand_googlechat_room_bindings", phase: "expand" },
    { id: "0147_contract_drop_space_kind", phase: "contract" },
    { id: "0148_expand_feishu_company_bindings", phase: "expand" },
    { id: "0149_expand_telegram_company_rooms", phase: "expand" },
    { id: "0150_expand_wecom_suite_tickets", phase: "expand" },
    { id: "0151_expand_wecom_company_installations", phase: "expand" },
    { id: "0152_expand_dingtalk_suite_tickets", phase: "expand" },
    { id: "0153_expand_discord_installation_lifecycle", phase: "expand" },
    { id: "0154_expand_teams_company_rooms", phase: "expand" },
    { id: "0155_expand_dingtalk_company_grants", phase: "expand" },
    { id: "0156_expand_dingtalk_inbound_storage", phase: "expand" },
    { id: "0157_expand_dingtalk_effect_coordination", phase: "expand" },
    { id: "0158_expand_registration_quota_account", phase: "expand" },
    { id: "0159_expand_machine_auto_assign", phase: "expand" },
    { id: "0160_expand_instance_wake", phase: "expand" },
    { id: "0161_expand_backfill_legacy_attachment_refs", phase: "expand" },
    { id: "0162_contract_backfill_channel_activity", phase: "contract" },
    { id: "0163_expand_message_preview", phase: "expand" },
    { id: "0164_expand_machine_daemon_command_indexes", phase: "expand" },
    { id: "0165_expand_machine_resource_history", phase: "expand" },
    { id: "0166_expand_admin_audit_events", phase: "expand" },
  ]);
  assert.equal(manifest.every(({ checksumSha256 }) => /^[0-9a-f]{64}$/u.test(checksumSha256)), true);
});

test("expand policy rejects destructive and rewriting PostgreSQL migrations", () => {
  for (const sql of [
    "DROP TABLE data.messages;",
    "ALTER TABLE data.messages DROP COLUMN body;",
    "ALTER TABLE data.messages ADD COLUMN body text NOT NULL;",
    "UPDATE data.messages SET body = '';",
    "CREATE OR REPLACE VIEW data.messages_view AS SELECT 1;",
    "ALTER TABLE data.messages ALTER COLUMN body SET NOT NULL;",
    "ALTER TABLE data.messages ALTER COLUMN body TYPE bigint;",
    "ALTER TABLE data.messages ALTER COLUMN body DROP NOT NULL, DROP COLUMN other;",
  ]) {
    assert.throws(() => assertExpandOnlyPostgresMigration(sql), /not expand-only/u);
  }
  assert.doesNotThrow(() => assertExpandOnlyPostgresMigration(
    "ALTER TABLE data.messages ADD COLUMN body text;",
  ));
  // Relaxing NOT NULL widens the column; running code keeps writing values.
  assert.doesNotThrow(() => assertExpandOnlyPostgresMigration(
    "ALTER TABLE data.runs ALTER COLUMN agent_profile_id DROP NOT NULL;",
  ));
});

test("manifest rejects gaps and invalid filenames", async () => {
  const directory = await mkdtemp(join(tmpdir(), "xmatrix-db-migrations-"));
  await writeFile(join(directory, "0001_expand_gap.sql"), "CREATE TABLE gap (id text);\n");
  await assert.rejects(loadMigrationManifest(directory), /contiguous from 0000/u);
});

test("ledger reconciliation rejects edited history and applied gaps", async () => {
  const manifest = await loadMigrationManifest();
  assert.throws(
    () => reconcileMigrationState(manifest, [{
      migration_id: manifest[0].id,
      checksum_sha256: "0".repeat(64),
      phase: "expand",
    }]),
    /checksum changed/u,
  );
  assert.throws(
    () => reconcileMigrationState(manifest, [{
      migration_id: manifest[1].id,
      checksum_sha256: manifest[1].checksumSha256,
      phase: manifest[1].phase,
    }]),
    /ledger has a gap/u,
  );
});
