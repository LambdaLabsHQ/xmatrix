-- Private blobs of any size the upload path can carry. A body larger than one
-- Worker request goes to R2 as a multipart upload in fixed parts; the intent
-- keeps the R2 upload id, the part size, each recorded part's ETag and the
-- SHA-256 state after the recorded parts, so the Hub verifies the whole body
-- part by part before R2 publishes it. The single ceiling is
-- RELAY_V2_BLOB_MAX_BYTES (10,000 parts of 64 MiB = 671088640000 bytes).
SET LOCAL lock_timeout = '5s';
ALTER TABLE data.blob_upload_intents
  DROP CONSTRAINT blob_upload_intents_encoded_bytes_check,
  ADD CONSTRAINT blob_upload_intents_encoded_bytes_check
    CHECK (encoded_bytes BETWEEN 1 AND 671088640000) NOT VALID;
ALTER TABLE data.content_objects
  DROP CONSTRAINT content_objects_byte_length_check,
  ADD CONSTRAINT content_objects_byte_length_check
    CHECK (byte_length BETWEEN 0 AND 671088640000) NOT VALID;
ALTER TABLE data.blob_upload_intents ADD COLUMN multipart_upload_id TEXT
  CHECK (multipart_upload_id IS NULL OR length(multipart_upload_id) BETWEEN 1 AND 1024);
ALTER TABLE data.blob_upload_intents ADD COLUMN multipart_part_bytes BIGINT
  CHECK (multipart_part_bytes IS NULL OR multipart_part_bytes BETWEEN 5242880 AND 104857600);
ALTER TABLE data.blob_upload_intents ADD COLUMN multipart_etags TEXT[]
  CHECK (multipart_etags IS NULL OR cardinality(multipart_etags) <= 10000);
ALTER TABLE data.blob_upload_intents ADD COLUMN multipart_sha256_state BYTEA
  CHECK (multipart_sha256_state IS NULL OR length(multipart_sha256_state) = 32);
