CREATE TABLE data.extension_records (
  namespace TEXT NOT NULL,
  record_id TEXT NOT NULL,
  scope_kind TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  kind TEXT,
  schema_version BIGINT,
  codec_id TEXT,
  entity_version BIGINT NOT NULL CHECK (entity_version >= 1),
  change_sequence BIGINT NOT NULL CHECK (change_sequence >= 1),
  field_presence BYTEA,
  business_status TEXT,
  inline_payload BYTEA,
  immutable_payload_ref_id TEXT,
  record_digest TEXT NOT NULL,
  record_encoded_bytes BIGINT NOT NULL CHECK (record_encoded_bytes >= 0),
  created_at_ms BIGINT NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms BIGINT NOT NULL CHECK (updated_at_ms >= created_at_ms),
  expires_at_ms BIGINT,
  deleted_at_ms BIGINT,
  PRIMARY KEY (namespace, record_id),
  CHECK ((deleted_at_ms IS NULL AND kind IS NOT NULL AND schema_version IS NOT NULL
      AND codec_id IS NOT NULL AND field_presence IS NOT NULL
      AND ((inline_payload IS NULL) <> (immutable_payload_ref_id IS NULL)))
    OR (deleted_at_ms IS NOT NULL AND kind IS NULL AND schema_version IS NULL
      AND codec_id IS NULL AND field_presence IS NULL AND business_status IS NULL
      AND inline_payload IS NULL AND immutable_payload_ref_id IS NULL AND expires_at_ms IS NULL))
);

CREATE INDEX extension_records_scope_idx
  ON data.extension_records (namespace, scope_kind, scope_id, record_id);

CREATE INDEX extension_records_expiry_idx
  ON data.extension_records (namespace, expires_at_ms, scope_kind, scope_id, record_id)
  WHERE deleted_at_ms IS NULL AND expires_at_ms IS NOT NULL;

CREATE TABLE data.extension_index_entries (
  namespace TEXT NOT NULL,
  index_name TEXT NOT NULL,
  index_version BIGINT NOT NULL CHECK (index_version >= 1),
  scope_kind TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  generation BIGINT NOT NULL CHECK (generation >= 1),
  entry_type TEXT NOT NULL,
  encoded_key BYTEA NOT NULL,
  record_id TEXT NOT NULL,
  entity_version BIGINT NOT NULL CHECK (entity_version >= 1),
  tombstoned BOOLEAN NOT NULL,
  logical_bytes BIGINT NOT NULL CHECK (logical_bytes >= 0),
  entry_hash BYTEA NOT NULL CHECK (octet_length(entry_hash) = 32),
  PRIMARY KEY (namespace,index_name,index_version,scope_kind,scope_id,generation,
    entry_type,encoded_key,record_id)
);

CREATE TABLE data.extension_index_heads (
  namespace TEXT NOT NULL,
  index_name TEXT NOT NULL,
  scope_kind TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  published_index_version BIGINT NOT NULL CHECK (published_index_version >= 1),
  published_generation BIGINT NOT NULL CHECK (published_generation >= 1),
  applied_source_change_head BIGINT NOT NULL CHECK (applied_source_change_head >= 0),
  row_count BIGINT NOT NULL CHECK (row_count >= 0),
  logical_bytes BIGINT NOT NULL CHECK (logical_bytes >= 0),
  index_accumulator BYTEA NOT NULL CHECK (octet_length(index_accumulator) = 32),
  index_digest TEXT NOT NULL CHECK (length(index_digest) = 64),
  ordered_digest TEXT NOT NULL CHECK (length(ordered_digest) = 64),
  version BIGINT NOT NULL CHECK (version >= 1),
  updated_at_ms BIGINT NOT NULL CHECK (updated_at_ms >= 0),
  PRIMARY KEY (namespace,index_name,scope_kind,scope_id)
);

CREATE TABLE data.projection_manifest_authority (
  user_id TEXT PRIMARY KEY,
  authorization_epoch BIGINT NOT NULL CHECK (authorization_epoch >= 0),
  entitlement_digest TEXT NOT NULL,
  catalog_current_revision BIGINT NOT NULL CHECK (catalog_current_revision >= 0),
  catalog_exported_revision BIGINT NOT NULL CHECK (catalog_exported_revision >= 0),
  version BIGINT NOT NULL CHECK (version >= 1),
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE data.projection_manifest_grants (
  user_id TEXT NOT NULL,
  visibility_scope_id TEXT NOT NULL,
  grant_version BIGINT NOT NULL CHECK (grant_version >= 1),
  status TEXT NOT NULL,
  authorization_epoch BIGINT NOT NULL CHECK (authorization_epoch >= 0),
  history_floor BIGINT NOT NULL CHECK (history_floor >= 0),
  history_tail BIGINT NOT NULL CHECK (history_tail >= 0),
  archive_epoch BIGINT NOT NULL CHECK (archive_epoch >= 0),
  estimated_text_bytes BIGINT NOT NULL CHECK (estimated_text_bytes >= 0),
  estimated_index_bytes BIGINT NOT NULL CHECK (estimated_index_bytes >= 0),
  estimated_media_bytes BIGINT NOT NULL CHECK (estimated_media_bytes >= 0),
  version BIGINT NOT NULL CHECK (version >= 1),
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (user_id, visibility_scope_id)
);

CREATE INDEX projection_manifest_grants_scope_idx
  ON data.projection_manifest_grants (visibility_scope_id, status, user_id);

CREATE TABLE data.projection_scope_heads (
  visibility_scope_id TEXT PRIMARY KEY,
  published_snapshot_epoch BIGINT NOT NULL,
  published_root TEXT,
  published_change_head BIGINT NOT NULL,
  change_head BIGINT NOT NULL,
  exported_change_head BIGINT NOT NULL,
  replay_floor BIGINT NOT NULL,
  redaction_epoch BIGINT NOT NULL,
  redaction_head BIGINT NOT NULL,
  redaction_floor BIGINT NOT NULL,
  purge_epoch BIGINT NOT NULL,
  root_redaction_head BIGINT NOT NULL,
  base_reset_required BOOLEAN NOT NULL,
  pending_build_epoch BIGINT,
  build_start_change_sequence BIGINT,
  build_state TEXT NOT NULL,
  build_purge_epoch BIGINT,
  build_checkpoint_cursor TEXT,
  build_checkpoint_hash TEXT,
  build_checkpoint_version BIGINT,
  build_checkpoint_scanned_rows BIGINT,
  build_checkpoint_scanned_bytes BIGINT,
  cutover_change_head BIGINT,
  cutover_redaction_head BIGINT,
  cutover_purge_epoch BIGINT,
  version BIGINT NOT NULL CHECK (version >= 1),
  updated_at TIMESTAMPTZ NOT NULL
);
