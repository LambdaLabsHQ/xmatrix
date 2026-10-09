-- Each Automation occurrence now runs in a conversation of its own
-- (docs/design/pages-live-document.md §6.1), so the Automation records the
-- conversation its last occurrence ran in, for the page chip and Schedules
-- to open. NULL until an occurrence is delivered this way.

-- Fail fast instead of queueing Automation writes behind this transaction.
SET LOCAL lock_timeout = '5s';

ALTER TABLE data.automations ADD COLUMN last_channel_id TEXT
  CHECK (last_channel_id IS NULL OR length(last_channel_id) <= 300);
