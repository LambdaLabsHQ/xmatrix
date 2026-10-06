CREATE TABLE data.platform_focus_review_prompt (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
  version BIGINT NOT NULL CHECK (version >= 1),
  template_version INTEGER NOT NULL CHECK (template_version >= 1),
  template TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  updated_by_user_id TEXT NOT NULL
);

CREATE TABLE data.platform_focus_review_prompt_revisions (
  version BIGINT PRIMARY KEY CHECK (version >= 1),
  template_version INTEGER NOT NULL CHECK (template_version >= 1),
  template TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  updated_by_user_id TEXT NOT NULL
);

CREATE TABLE control.platform_focus_prompt_migration (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
  contract TEXT NOT NULL CHECK (contract = 'platform-focus-prompt-postgres-migration-v1'),
  target_revision TEXT NOT NULL CHECK (target_revision ~ '^[0-9a-f]{40}$'),
  source_snapshot_sha256 TEXT NOT NULL CHECK (source_snapshot_sha256 ~ '^[0-9a-f]{64}$'),
  source_version BIGINT NOT NULL CHECK (source_version >= 0),
  revision_count INTEGER NOT NULL CHECK (revision_count BETWEEN 0 AND 100),
  source_fenced_at TIMESTAMPTZ NOT NULL,
  imported_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL CHECK (status = 'authoritative'),
  CHECK ((source_version = 0 AND revision_count = 0) OR source_version >= 1)
);
