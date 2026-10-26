-- Positive evidence of an unaddressed Human publication. Missing evidence is
-- unknown, never a failed delivery. Choices remain owned by the existing
-- per-message launch-choice authority and its durable summon coordinator.
SET LOCAL lock_timeout = '5s';
CREATE TABLE data.message_asks (
  space_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  author_user_id TEXT NOT NULL,
  input_version BIGINT NOT NULL CHECK (input_version >= 1),
  body_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (channel_id, message_id),
  CHECK (length(space_id) BETWEEN 1 AND 300),
  CHECK (length(channel_id) BETWEEN 1 AND 300),
  CHECK (length(message_id) BETWEEN 1 AND 300),
  CHECK (length(author_user_id) BETWEEN 1 AND 300)
);
CREATE INDEX message_asks_space_idx ON data.message_asks (space_id);
ALTER TABLE data.first_message_launch_choices ADD COLUMN source_input_version BIGINT;
ALTER TABLE data.first_message_launch_choices ADD COLUMN source_body_hash TEXT;
ALTER TABLE data.first_message_launch_choices ADD CONSTRAINT launch_choice_source_pair CHECK (
  (source_input_version IS NULL) = (source_body_hash IS NULL)
  AND (source_input_version IS NULL OR source_input_version >= 1)) NOT VALID;
ALTER TABLE data.first_message_launch_choices VALIDATE CONSTRAINT launch_choice_source_pair;
CREATE INDEX message_ask_pending_choice_idx ON data.first_message_launch_choices (space_id,channel_id)
  WHERE source_input_version IS NOT NULL AND summoned_at IS NULL AND failure_code IS NULL;
