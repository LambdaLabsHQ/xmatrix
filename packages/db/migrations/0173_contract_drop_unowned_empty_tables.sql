-- Nothing reads or writes these tables: they appear only in their own
-- migrations and in the shard and purge classifications. Both production
-- shards held no rows in any of them (count(*), 2026-10-09), and no Space or
-- account purge was in progress, so the Hub still serving the previous lists
-- has nothing to purge from them before the release that drops those lists.

SET LOCAL lock_timeout = '5s';

DROP TABLE control.domain_authority_state;
DROP TABLE control.durable_object_compactions;
DROP TABLE control.durable_object_empty_shell_retirement_receipts;
DROP TABLE control.durable_object_retirement_receipts;
DROP TABLE control.legacy_postgres_sync_conflicts;
DROP TABLE control.user_preference_shadow_backfill_progress;
DROP TABLE control.user_preference_shadow_sources;
DROP TABLE data.content_closure_heads;
DROP TABLE data.control_intents;
DROP TABLE data.dangerous_action_requests;
DROP TABLE data.extension_index_entries;
DROP TABLE data.extension_index_heads;
DROP TABLE data.shared_memory_entries;
