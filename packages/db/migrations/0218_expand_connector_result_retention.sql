-- Owner-readable connector results reuse restricted content and its bounded collector.
SET LOCAL lock_timeout = '5s';
ALTER TABLE data.blob_upload_intents
  DROP CONSTRAINT blob_upload_intents_purpose_check,
  ADD CONSTRAINT blob_upload_intents_purpose_check
    CHECK (purpose IS NULL OR purpose IN ('summon_decision','connector_result')) NOT VALID;
