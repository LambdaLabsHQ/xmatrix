-- xmatrix:online-indexes
-- Build private-record expiry indexes without blocking existing writers.
CREATE INDEX CONCURRENTLY private_record_upload_expiry_idx ON data.blob_upload_intents (space_id,purpose,expires_at,intent_id)
  WHERE purpose IS NOT NULL;
CREATE INDEX CONCURRENTLY private_record_ref_expiry_idx ON data.content_refs (space_id,owner_kind,created_at,ref_id)
  WHERE generation = 0 AND owner_kind IN ('summon_decision','connector_result');
