-- Server-authored decision uploads need orphan cleanup even before a ref exists.
-- NULL leaves existing/general uploads outside the decision collector's scope.
ALTER TABLE data.blob_upload_intents ADD COLUMN purpose TEXT
  CHECK (purpose IS NULL OR purpose = 'summon_decision');
CREATE INDEX decision_upload_expiry_idx ON data.blob_upload_intents (space_id,expires_at,intent_id)
  WHERE purpose = 'summon_decision';
CREATE INDEX decision_ref_expiry_idx ON data.content_refs (space_id,created_at,ref_id)
  WHERE generation = 0 AND owner_kind = 'summon_decision';
