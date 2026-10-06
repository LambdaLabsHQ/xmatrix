CREATE TABLE data.content_objects (
  space_id TEXT NOT NULL,
  object_id TEXT NOT NULL,
  object_kind TEXT NOT NULL,
  storage_key TEXT NOT NULL,
  checksum TEXT NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'),
  byte_length BIGINT NOT NULL CHECK (byte_length BETWEEN 0 AND 1073741824),
  direct_child_count INTEGER NOT NULL CHECK (direct_child_count >= 0),
  direct_child_bytes BIGINT NOT NULL CHECK (direct_child_bytes >= 0),
  direct_children_digest TEXT NOT NULL CHECK (direct_children_digest ~ '^[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL,
  gc_not_before TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (space_id, object_id),
  UNIQUE (space_id, storage_key),
  CHECK (length(space_id) BETWEEN 1 AND 300),
  CHECK (length(object_id) BETWEEN 1 AND 300),
  CHECK (length(object_kind) BETWEEN 1 AND 160),
  CHECK (length(storage_key) BETWEEN 1 AND 2000)
);

CREATE TABLE data.content_refs (
  space_id TEXT NOT NULL,
  root_set_id TEXT NOT NULL,
  generation BIGINT NOT NULL CHECK (generation >= 0),
  ref_id TEXT NOT NULL,
  owner_kind TEXT,
  owner_id TEXT,
  parent_object_id TEXT,
  child_object_id TEXT NOT NULL,
  edge_ordinal INTEGER,
  edge_key BYTEA,
  parent_manifest_digest TEXT,
  child_checksum TEXT NOT NULL CHECK (child_checksum ~ '^[0-9a-f]{64}$'),
  child_bytes BIGINT NOT NULL CHECK (child_bytes >= 0),
  logical_bytes BIGINT NOT NULL CHECK (logical_bytes >= 0),
  owner_descriptor BYTEA,
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (space_id, root_set_id, generation, ref_id),
  CHECK (length(space_id) BETWEEN 1 AND 300),
  CHECK (length(root_set_id) BETWEEN 1 AND 300),
  CHECK (length(ref_id) BETWEEN 1 AND 300),
  CHECK (length(child_object_id) BETWEEN 1 AND 300),
  CHECK (owner_descriptor IS NULL OR octet_length(owner_descriptor) <= 262144),
  CHECK (
    (generation = 0 AND owner_kind IS NOT NULL AND owner_id IS NOT NULL AND
      parent_object_id IS NULL AND edge_ordinal IS NULL AND edge_key IS NULL AND
      parent_manifest_digest IS NULL)
    OR
    (generation > 0 AND owner_kind IS NULL AND owner_id IS NULL AND
      owner_descriptor IS NULL AND parent_object_id IS NOT NULL AND
      edge_ordinal IS NOT NULL AND edge_ordinal >= 0 AND edge_key IS NOT NULL AND
      parent_manifest_digest ~ '^[0-9a-f]{64}$')
  )
);

CREATE UNIQUE INDEX content_refs_generation_edge_idx
  ON data.content_refs (space_id, root_set_id, generation, parent_object_id, edge_ordinal)
  WHERE generation > 0;

CREATE INDEX content_refs_generation_child_idx
  ON data.content_refs (space_id, root_set_id, generation, child_object_id);

CREATE INDEX content_refs_owner_idx
  ON data.content_refs (space_id, owner_kind, owner_id, root_set_id, ref_id)
  WHERE generation = 0;

CREATE UNIQUE INDEX content_refs_owner_object_idx
  ON data.content_refs (space_id, child_object_id, owner_kind, owner_id)
  WHERE generation = 0;

CREATE TABLE data.content_closure_heads (
  space_id TEXT NOT NULL,
  root_set_id TEXT NOT NULL,
  published_generation BIGINT NOT NULL CHECK (published_generation >= 1),
  retained_root_set_digest TEXT NOT NULL CHECK (retained_root_set_digest ~ '^[0-9a-f]{64}$'),
  edge_count BIGINT NOT NULL CHECK (edge_count >= 0),
  logical_bytes BIGINT NOT NULL CHECK (logical_bytes >= 0),
  closure_digest TEXT NOT NULL CHECK (closure_digest ~ '^[0-9a-f]{64}$'),
  version BIGINT NOT NULL CHECK (version >= 1),
  published_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (space_id, root_set_id)
);

CREATE TABLE data.blob_upload_intents (
  space_id TEXT NOT NULL,
  intent_id TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  content_hash TEXT NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  object_key TEXT NOT NULL,
  encoded_bytes BIGINT NOT NULL CHECK (encoded_bytes BETWEEN 1 AND 67108864),
  checksum TEXT NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'),
  status TEXT NOT NULL CHECK (status IN ('pending','committed','expired')),
  version BIGINT NOT NULL CHECK (version >= 1),
  created_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (space_id, intent_id),
  UNIQUE (intent_id),
  CHECK (length(scope_id) BETWEEN 1 AND 300),
  CHECK (length(object_key) BETWEEN 1 AND 2000),
  CHECK (expires_at > created_at)
);

CREATE INDEX blob_upload_intents_expiry_idx
  ON data.blob_upload_intents (status, expires_at, space_id, intent_id);

CREATE TABLE data.content_gc_candidates (
  space_id TEXT NOT NULL,
  object_id TEXT NOT NULL,
  storage_key TEXT NOT NULL,
  content_hash TEXT NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  reason TEXT NOT NULL,
  unreferenced_at TIMESTAMPTZ NOT NULL,
  not_before TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','leased','deleted','retained','failed')),
  version BIGINT NOT NULL CHECK (version >= 1),
  lease_until TIMESTAMPTZ,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 100),
  last_checked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (space_id, object_id),
  UNIQUE (space_id, storage_key),
  CHECK ((status = 'leased' AND lease_until IS NOT NULL) OR status <> 'leased'),
  CHECK (updated_at >= created_at)
);

CREATE INDEX content_gc_candidates_due_idx
  ON data.content_gc_candidates (status, not_before, space_id, object_id);
