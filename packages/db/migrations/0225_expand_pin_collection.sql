-- Replace the two pin checks with their existing array-type invariant. Count
-- is not a product quota. Both old checks proved all existing rows are arrays;
-- NOT VALID avoids rescanning them while still checking every new write.
-- This only widens accepted arrays and keeps old writers compatible. No rows
-- are rewritten or deleted, and the migration ledger owns replay.
SET LOCAL lock_timeout = '5s';
ALTER TABLE data.user_space_channel_view_preferences
  DROP CONSTRAINT user_space_channel_view_preferenc_pinned_channel_ids_json_check,
  DROP CONSTRAINT user_space_channel_view_preferen_pinned_channel_ids_json_check1,
  ADD CONSTRAINT user_space_channel_view_preferences_pins_array
    CHECK (jsonb_typeof(pinned_channel_ids_json) = 'array') NOT VALID;
