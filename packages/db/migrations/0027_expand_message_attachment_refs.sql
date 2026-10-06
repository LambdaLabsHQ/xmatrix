CREATE TABLE data.message_attachment_refs (
  space_id TEXT NOT NULL,
  attachment_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  owner_user_id TEXT,
  object_key TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  encoded_bytes BIGINT NOT NULL CHECK (encoded_bytes >= 0),
  mime_type TEXT NOT NULL,
  name TEXT NOT NULL,
  presentation_residual_json JSONB,
  version BIGINT NOT NULL CHECK (version >= 1),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (space_id, message_id, attachment_id),
  CHECK (length(space_id) BETWEEN 1 AND 300),
  CHECK (length(attachment_id) BETWEEN 1 AND 300),
  CHECK (length(message_id) BETWEEN 1 AND 300),
  CHECK (length(channel_id) BETWEEN 1 AND 300),
  CHECK (length(object_key) BETWEEN 1 AND 2000),
  CHECK (length(content_hash) BETWEEN 1 AND 300),
  CHECK (length(mime_type) BETWEEN 1 AND 300),
  CHECK (length(name) BETWEEN 1 AND 1000),
  CHECK (presentation_residual_json IS NULL OR jsonb_typeof(presentation_residual_json) = 'object'),
  CHECK (updated_at >= created_at)
);

CREATE INDEX message_attachment_refs_message_idx
  ON data.message_attachment_refs (space_id, message_id, created_at, attachment_id);

CREATE INDEX message_attachment_refs_object_key_idx
  ON data.message_attachment_refs (object_key);

INSERT INTO data.message_attachment_refs
  (space_id, attachment_id, message_id, channel_id, owner_user_id, object_key,
   content_hash, encoded_bytes, mime_type, name, presentation_residual_json,
   version, created_at, updated_at)
SELECT space_id, attachment_id, message_id, channel_id, owner_user_id, object_key,
  content_hash, encoded_bytes, mime_type, name, presentation_residual_json,
  version, created_at, updated_at
FROM data.message_attachments
WHERE message_id IS NOT NULL
ON CONFLICT (space_id, message_id, attachment_id) DO NOTHING;
