-- Nothing reads or writes these tables any more. They hold what earlier work
-- left behind: the one-time raw copy of the retired Durable Object stores and
-- the ledger of their sync into PostgreSQL (authoritative since 2026-09-09),
-- receipts of finished cutovers and purges, and the records of retired
-- extension, client projection, Focus review and connector binding features.
-- The raw copy also kept messages of Spaces and accounts deleted since, which
-- neither purge reaches. No Space or account purge was in progress when this
-- was applied, so the Hub still serving the previous lists has nothing to
-- purge from them before the release that drops those lists.

SET LOCAL lock_timeout = '5s';

DROP TABLE control.auth_shadow_backfill_progress;
DROP TABLE control.auth_shadow_runs;
DROP TABLE control.authority_migration_receipts;
DROP TABLE control.authority_cutovers;
DROP TABLE control.legacy_postgres_sync_rows;
DROP TABLE control.legacy_postgres_sync_runs;
DROP TABLE control.platform_focus_prompt_migration;
DROP TABLE data.platform_focus_review_prompt_revisions;
DROP TABLE data.platform_focus_review_prompt;
DROP TABLE data.durable_object_fact_archive;
DROP TABLE data.extension_records;
DROP TABLE data.projection_manifest_grants;
DROP TABLE data.projection_scope_heads;
DROP TABLE data.projection_manifest_authority;
DROP TABLE data.app_connector_channel_bindings;
DROP TABLE data.retired_agent_dm_purges;
DROP TABLE data.retired_direct_conversation_purges;
