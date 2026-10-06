-- A page's Automation also runs on events (docs/design/pages-live-document.md
-- §6.2): a merged pull request, a failed workflow, a section owing an update.
-- An event makes the next occurrence due and is recorded until an occurrence
-- takes it, so that occurrence can name what fired it. Triggers themselves
-- live in payload_json.triggers; the index finds the Automations a GitHub
-- event concerns.

-- Fail fast instead of queueing Automation traffic behind this transaction.
SET LOCAL lock_timeout = '5s';

-- NULL is no events.
ALTER TABLE data.automations ADD COLUMN trigger_events JSONB
  CHECK (trigger_events IS NULL OR jsonb_typeof(trigger_events) = 'array' AND jsonb_array_length(trigger_events) <= 10);
ALTER TABLE data.automation_occurrences ADD COLUMN trigger_events JSONB
  CHECK (trigger_events IS NULL OR jsonb_typeof(trigger_events) = 'array' AND jsonb_array_length(trigger_events) <= 10);

CREATE INDEX automations_triggers_idx ON data.automations
  USING gin ((payload_json->'triggers') jsonb_path_ops) WHERE page_id IS NOT NULL;
