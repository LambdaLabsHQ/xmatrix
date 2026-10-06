CREATE TABLE data.messages (
  space_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  timeline_sequence BIGINT NOT NULL CHECK (timeline_sequence >= 1),
  entity_version BIGINT NOT NULL CHECK (entity_version >= 1),
  author_kind TEXT NOT NULL CHECK (author_kind IN ('user', 'agent', 'app', 'system')),
  author_id TEXT NOT NULL,
  message_kind TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  payload_kind TEXT NOT NULL,
  payload_ref TEXT NOT NULL,
  archive_source_json JSONB,
  reactions_json JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(reactions_json) = 'array'),
  annotations_json JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(annotations_json) = 'array'),
  attachments_json JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(attachments_json) = 'array'),
  sent_at TIMESTAMPTZ NOT NULL,
  edited_at TIMESTAMPTZ,
  recalled_at TIMESTAMPTZ,
  deleted_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL,
  search_rank_sequence TEXT NOT NULL,
  codec_id TEXT,
  payload_schema_version INTEGER CHECK (payload_schema_version IS NULL OR payload_schema_version >= 1),
  field_presence_base64 TEXT,
  payload_bundle_base64 TEXT,
  legacy_body TEXT,
  body_hash TEXT,
  sender_snapshot_digest TEXT,
  record_digest TEXT,
  record_encoded_bytes BIGINT CHECK (record_encoded_bytes IS NULL OR record_encoded_bytes >= 1),
  source_family_sequence BIGINT,
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (space_id, message_id),
  CHECK (length(space_id) BETWEEN 1 AND 300),
  CHECK (length(channel_id) BETWEEN 1 AND 300),
  CHECK (length(message_id) BETWEEN 1 AND 300),
  CHECK (length(author_id) BETWEEN 1 AND 300),
  CHECK (length(content_hash) BETWEEN 1 AND 300),
  CHECK (length(payload_ref) BETWEEN 1 AND 2000),
  CHECK (archive_source_json IS NULL OR jsonb_typeof(archive_source_json) = 'object'),
  CHECK (updated_at >= created_at),
  UNIQUE (space_id, channel_id, timeline_sequence),
  UNIQUE (space_id, search_rank_sequence),
  UNIQUE (space_id, source_family_sequence)
);

CREATE INDEX messages_channel_history_idx
  ON data.messages (space_id, channel_id, timeline_sequence DESC);

CREATE INDEX messages_author_idx
  ON data.messages (space_id, author_kind, author_id, sent_at DESC, message_id);

CREATE TABLE data.message_reactions (
  space_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  emoji TEXT NOT NULL,
  reactor_user_id TEXT NOT NULL,
  reactor_label TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (space_id, message_id, emoji, reactor_user_id),
  CHECK (length(space_id) BETWEEN 1 AND 300),
  CHECK (length(channel_id) BETWEEN 1 AND 300),
  CHECK (length(message_id) BETWEEN 1 AND 300),
  CHECK (length(emoji) BETWEEN 1 AND 80),
  CHECK (length(reactor_user_id) BETWEEN 1 AND 300),
  CHECK (updated_at >= created_at)
);

CREATE INDEX message_reactions_channel_idx
  ON data.message_reactions (space_id, channel_id, message_id, emoji, reactor_user_id);

CREATE TABLE data.message_annotations (
  space_id TEXT NOT NULL,
  annotation_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  message_id TEXT,
  namespace TEXT NOT NULL,
  target_kind TEXT NOT NULL DEFAULT 'message'
    CHECK (target_kind IN ('channel', 'message', 'message_range')),
  payload_json JSONB NOT NULL,
  author_user_id TEXT NOT NULL,
  author_label TEXT NOT NULL,
  version BIGINT NOT NULL CHECK (version >= 1),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (space_id, annotation_id),
  CHECK (length(space_id) BETWEEN 1 AND 300),
  CHECK (length(annotation_id) BETWEEN 1 AND 300),
  CHECK (length(channel_id) BETWEEN 1 AND 300),
  CHECK (message_id IS NULL OR length(message_id) BETWEEN 1 AND 300),
  CHECK (length(namespace) BETWEEN 1 AND 160),
  CHECK (pg_column_size(payload_json) <= 262144),
  CHECK (updated_at >= created_at)
);

CREATE INDEX message_annotations_message_idx
  ON data.message_annotations (space_id, message_id, created_at, annotation_id);

CREATE INDEX message_annotations_channel_idx
  ON data.message_annotations (space_id, channel_id, created_at, annotation_id);

CREATE TABLE data.message_attachments (
  space_id TEXT NOT NULL,
  attachment_id TEXT NOT NULL,
  message_id TEXT,
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
  PRIMARY KEY (space_id, attachment_id),
  CHECK (length(space_id) BETWEEN 1 AND 300),
  CHECK (length(attachment_id) BETWEEN 1 AND 300),
  CHECK (message_id IS NULL OR length(message_id) BETWEEN 1 AND 300),
  CHECK (length(channel_id) BETWEEN 1 AND 300),
  CHECK (length(object_key) BETWEEN 1 AND 2000),
  CHECK (length(content_hash) BETWEEN 1 AND 300),
  CHECK (length(mime_type) BETWEEN 1 AND 300),
  CHECK (length(name) BETWEEN 1 AND 1000),
  CHECK (presentation_residual_json IS NULL OR jsonb_typeof(presentation_residual_json) = 'object'),
  CHECK (updated_at >= created_at),
  UNIQUE (object_key)
);

CREATE INDEX message_attachments_message_idx
  ON data.message_attachments (space_id, message_id, created_at, attachment_id);

CREATE TABLE data.message_mutations (
  space_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  entity_version BIGINT NOT NULL CHECK (entity_version >= 1),
  mutation_kind TEXT NOT NULL CHECK (mutation_kind IN (
    'create', 'edit', 'recall', 'delete', 'reaction', 'annotation', 'attachment'
  )),
  mutation_json JSONB NOT NULL CHECK (jsonb_typeof(mutation_json) = 'object'),
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('user', 'agent', 'app', 'system')),
  actor_id TEXT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (space_id, message_id, entity_version),
  CHECK (length(space_id) BETWEEN 1 AND 300),
  CHECK (length(channel_id) BETWEEN 1 AND 300),
  CHECK (length(message_id) BETWEEN 1 AND 300),
  CHECK (length(actor_id) BETWEEN 1 AND 300),
  CHECK (pg_column_size(mutation_json) <= 262144)
);

CREATE INDEX message_mutations_channel_idx
  ON data.message_mutations (space_id, channel_id, occurred_at, message_id, entity_version);

CREATE TABLE data.delivery_cursors (
  space_id TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  acknowledged_sequence BIGINT NOT NULL CHECK (acknowledged_sequence >= 0),
  version BIGINT NOT NULL CHECK (version >= 1),
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (space_id, subject_id, channel_id),
  CHECK (length(space_id) BETWEEN 1 AND 300),
  CHECK (length(subject_id) BETWEEN 1 AND 300),
  CHECK (length(channel_id) BETWEEN 1 AND 300)
);

CREATE INDEX delivery_cursors_channel_idx
  ON data.delivery_cursors (space_id, channel_id, acknowledged_sequence, subject_id);

CREATE TABLE data.message_attention (
  space_id TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('mention', 'reply', 'broadcast')),
  timeline_sequence BIGINT NOT NULL CHECK (timeline_sequence >= 1),
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (space_id, subject_id, channel_id, message_id, kind),
  CHECK (length(space_id) BETWEEN 1 AND 300),
  CHECK (length(subject_id) BETWEEN 1 AND 300),
  CHECK (length(channel_id) BETWEEN 1 AND 300),
  CHECK (length(message_id) BETWEEN 1 AND 300)
);

CREATE INDEX message_attention_subject_idx
  ON data.message_attention (space_id, subject_id, channel_id, timeline_sequence);

CREATE TABLE data.message_attention_revisions (
  space_id TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  revision BIGINT NOT NULL CHECK (revision >= 1),
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (space_id, subject_id, channel_id),
  CHECK (length(space_id) BETWEEN 1 AND 300),
  CHECK (length(subject_id) BETWEEN 1 AND 300),
  CHECK (length(channel_id) BETWEEN 1 AND 300)
);

CREATE TABLE data.channel_content_counters (
  space_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  content_revision BIGINT NOT NULL CHECK (content_revision >= 0),
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (space_id, channel_id),
  CHECK (length(space_id) BETWEEN 1 AND 300),
  CHECK (length(channel_id) BETWEEN 1 AND 300)
);
