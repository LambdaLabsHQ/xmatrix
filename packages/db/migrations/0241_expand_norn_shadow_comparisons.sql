-- Dormant, explicitly admitted comparison records. No production work owner.
SET LOCAL lock_timeout = '5s';
CREATE TABLE data.norn_shadow_comparisons (
  space_id TEXT NOT NULL,
  comparison_id UUID NOT NULL,
  channel_id TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  owner_generation TEXT NOT NULL,
  placement_epoch BIGINT NOT NULL,
  source_binding_id TEXT NOT NULL,
  source_generation TEXT NOT NULL,
  source_message_id TEXT NOT NULL,
  source_run_id TEXT NOT NULL,
  source_instance_id TEXT NOT NULL,
  code_id TEXT NOT NULL,
  admission_digest TEXT NOT NULL CHECK (length(admission_digest)=64),
  machine_abi TEXT NOT NULL,
  host_version TEXT NOT NULL,
  mapping_version TEXT NOT NULL,
  revision BIGINT NOT NULL DEFAULT 0,
  state TEXT NOT NULL CHECK (state IN ('ready','waiting','completed','failed','incomplete','revoked')),
  reason TEXT NOT NULL,
  next_due_at TIMESTAMPTZ,
  encrypted_value_json JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp()+interval '24 hours',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(space_id,comparison_id),
  CHECK (revision >= 0 AND placement_epoch > 0),
  CHECK (expires_at > created_at AND expires_at <= created_at+interval '24 hours')
);
CREATE INDEX norn_shadow_comparisons_channel_idx ON data.norn_shadow_comparisons(space_id,channel_id,comparison_id);
CREATE INDEX norn_shadow_comparisons_expiry_idx ON data.norn_shadow_comparisons(expires_at,space_id,comparison_id);
CREATE TABLE data.norn_shadow_observations (
  space_id TEXT NOT NULL,
  comparison_id UUID NOT NULL,
  channel_id TEXT NOT NULL,
  observation_id TEXT NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  disposition TEXT NOT NULL CHECK (disposition IN ('observed','consumed','late','obsolete')),
  PRIMARY KEY(space_id,comparison_id,observation_id),
  FOREIGN KEY(space_id,comparison_id) REFERENCES data.norn_shadow_comparisons(space_id,comparison_id) ON DELETE CASCADE
);
CREATE TABLE data.norn_shadow_transitions (
  space_id TEXT NOT NULL,
  comparison_id UUID NOT NULL,
  channel_id TEXT NOT NULL,
  revision BIGINT NOT NULL,
  kind TEXT NOT NULL,
  classification TEXT NOT NULL CHECK (classification IN ('equivalent','intentional_difference','unexpected','incomplete')),
  reason TEXT NOT NULL,
  observation_id TEXT,
  outcome_tag TEXT,
  operation TEXT,
  intent_digest TEXT,
  due_at TIMESTAMPTZ,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(space_id,comparison_id,revision),
  FOREIGN KEY(space_id,comparison_id) REFERENCES data.norn_shadow_comparisons(space_id,comparison_id) ON DELETE CASCADE
);
