-- Lower end of the entity-version interval that represents the same invocation
-- input. Reactions extend that interval; every other mutation starts a new one.
-- NULL retains the legacy exact-version rule. No history is guessed/backfilled.
ALTER TABLE data.messages ADD COLUMN invocation_input_version BIGINT;
ALTER TABLE data.messages ADD CONSTRAINT message_invocation_input_version_bound
  CHECK (invocation_input_version IS NULL OR invocation_input_version BETWEEN 1 AND entity_version) NOT VALID;
