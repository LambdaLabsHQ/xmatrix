-- An Agent message header's tags (goal, branch, model, effort, status chips)
-- are an immutable send-time snapshot, but the presentation they come from has
-- lived only in the Runtime cell's memory. The Worker that serves the REST send
-- path holds no session, so it could only reach them through that single global
-- Durable Object -- and when that read was dropped, every header committed bare.
--
-- Give presentation a row. The append transaction already reads this exact row
-- to authorize the message, so the snapshot becomes transactionally consistent
-- with its own authorization at no extra round trip.
ALTER TABLE data.instances
  ADD COLUMN presentation_json JSONB,
  ADD CONSTRAINT instances_presentation_json_object_check
    CHECK (presentation_json IS NULL OR jsonb_typeof(presentation_json) = 'object') NOT VALID;
