CREATE TABLE control.domain_authority_state (
  domain TEXT PRIMARY KEY,
  phase TEXT NOT NULL CHECK (phase IN ('shadow', 'fenced', 'authoritative', 'retired')),
  source_store TEXT NOT NULL,
  target_store TEXT NOT NULL,
  app_revision TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  CHECK (length(domain) BETWEEN 1 AND 160),
  CHECK (length(source_store) BETWEEN 1 AND 300),
  CHECK (length(target_store) BETWEEN 1 AND 300),
  CHECK (app_revision IS NULL OR length(app_revision) BETWEEN 1 AND 200),
  CHECK (updated_at >= created_at),
  CHECK ((phase = 'shadow' AND app_revision IS NULL) OR phase <> 'shadow')
);

CREATE TABLE control.user_preference_shadow_sources (
  source_object_name TEXT PRIMARY KEY,
  source_user_id TEXT NOT NULL,
  contract TEXT NOT NULL,
  phase TEXT NOT NULL CHECK (phase IN ('shadow', 'verified', 'fenced', 'authoritative')),
  last_applied_event BIGINT NOT NULL DEFAULT 0 CHECK (last_applied_event >= 0),
  snapshot_complete BOOLEAN NOT NULL DEFAULT FALSE,
  verified_event BIGINT CHECK (verified_event IS NULL OR verified_event >= 0),
  verified_digest_sha256 TEXT CHECK (
    verified_digest_sha256 IS NULL OR verified_digest_sha256 ~ '^[0-9a-f]{64}$'
  ),
  source_counts_json JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (
    jsonb_typeof(source_counts_json) = 'object'
  ),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  CHECK (length(source_object_name) BETWEEN 1 AND 300),
  CHECK (length(source_user_id) BETWEEN 1 AND 300),
  CHECK (length(contract) BETWEEN 1 AND 160),
  CHECK (updated_at >= created_at),
  CHECK ((phase = 'verified' AND verified_event IS NOT NULL AND verified_digest_sha256 IS NOT NULL)
    OR phase <> 'verified')
);

CREATE INDEX user_preference_shadow_sources_phase_idx
  ON control.user_preference_shadow_sources (phase, source_object_name);

CREATE INDEX user_preference_shadow_sources_user_idx
  ON control.user_preference_shadow_sources (source_user_id, source_object_name);

CREATE TABLE control.user_preference_shadow_backfill_progress (
  source_object_name TEXT NOT NULL
    REFERENCES control.user_preference_shadow_sources (source_object_name) ON DELETE CASCADE,
  source_table TEXT NOT NULL CHECK (source_table IN (
    'user_space_locale_preferences', 'user_space_channel_view_preferences'
  )),
  after_space_id TEXT,
  after_user_id TEXT,
  copied_rows BIGINT NOT NULL DEFAULT 0 CHECK (copied_rows >= 0),
  complete BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (source_object_name, source_table),
  CHECK ((after_space_id IS NULL AND after_user_id IS NULL) OR
    (after_space_id IS NOT NULL AND after_user_id IS NOT NULL)),
  CHECK ((complete AND after_space_id IS NULL AND after_user_id IS NULL) OR NOT complete)
);
