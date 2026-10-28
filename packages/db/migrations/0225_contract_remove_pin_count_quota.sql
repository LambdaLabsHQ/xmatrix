-- Pin count is not a product quota. Keep the JSON array and version checks;
-- visibility is checked in bounded batches by the preference authority.
-- Metadata-only change: no rows are rewritten or deleted. The migration
-- ledger makes replay harmless and a lock timeout leaves the old rule intact.
SET LOCAL lock_timeout = '5s';
ALTER TABLE data.user_space_channel_view_preferences
  DROP CONSTRAINT IF EXISTS user_space_channel_view_preferen_pinned_channel_ids_json_check1;
