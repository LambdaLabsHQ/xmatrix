CREATE TABLE control.authority_migration_receipts (
  receipt_id TEXT PRIMARY KEY,
  domain TEXT NOT NULL,
  stage TEXT NOT NULL CHECK (stage IN (
    'snapshot', 'catchup', 'verified', 'source_fenced',
    'target_authoritative', 'source_read_only', 'source_retired'
  )),
  source_store TEXT NOT NULL,
  target_store TEXT NOT NULL,
  source_boundary_json JSONB NOT NULL CHECK (jsonb_typeof(source_boundary_json) = 'object'),
  row_counts_json JSONB NOT NULL CHECK (jsonb_typeof(row_counts_json) = 'object'),
  ordered_digest_sha256 TEXT NOT NULL CHECK (ordered_digest_sha256 ~ '^[0-9a-f]{64}$'),
  previous_receipt_sha256 TEXT UNIQUE
    REFERENCES control.authority_migration_receipts (receipt_sha256),
  receipt_sha256 TEXT NOT NULL UNIQUE CHECK (receipt_sha256 ~ '^[0-9a-f]{64}$'),
  app_revision TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CHECK (length(receipt_id) BETWEEN 1 AND 300),
  CHECK (length(domain) BETWEEN 1 AND 160),
  CHECK (length(source_store) BETWEEN 1 AND 300),
  CHECK (length(target_store) BETWEEN 1 AND 300),
  CHECK (length(app_revision) BETWEEN 1 AND 200)
);

CREATE INDEX authority_migration_receipts_domain_idx
  ON control.authority_migration_receipts (domain, created_at, receipt_id);

CREATE TABLE control.auth_users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  email_verified BOOLEAN NOT NULL DEFAULT FALSE,
  image TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  handle TEXT,
  bio TEXT,
  profile_version BIGINT NOT NULL DEFAULT 0 CHECK (profile_version >= 0),
  profile_completed_at TIMESTAMPTZ,
  CHECK (length(id) BETWEEN 1 AND 300),
  CHECK (length(email) BETWEEN 1 AND 320)
);

CREATE UNIQUE INDEX auth_users_email_key ON control.auth_users (lower(email));
CREATE UNIQUE INDEX auth_users_handle_key
  ON control.auth_users (lower(handle)) WHERE handle IS NOT NULL;

CREATE TABLE control.auth_sessions (
  id TEXT PRIMARY KEY,
  expires_at TIMESTAMPTZ NOT NULL,
  token TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  ip_address TEXT,
  user_agent TEXT,
  user_id TEXT NOT NULL REFERENCES control.auth_users (id) ON DELETE CASCADE,
  CHECK (length(id) BETWEEN 1 AND 300),
  CHECK (length(user_id) BETWEEN 1 AND 300)
);

CREATE INDEX auth_sessions_user_id_idx ON control.auth_sessions (user_id);
CREATE INDEX auth_sessions_expiry_idx ON control.auth_sessions (expires_at, id);

CREATE TABLE control.auth_accounts (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES control.auth_users (id) ON DELETE CASCADE,
  access_token TEXT,
  refresh_token TEXT,
  id_token TEXT,
  access_token_expires_at TIMESTAMPTZ,
  refresh_token_expires_at TIMESTAMPTZ,
  scope TEXT,
  password TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  CHECK (length(id) BETWEEN 1 AND 300),
  CHECK (length(account_id) BETWEEN 1 AND 300),
  CHECK (length(provider_id) BETWEEN 1 AND 160),
  CHECK (length(user_id) BETWEEN 1 AND 300)
);

CREATE INDEX auth_accounts_user_id_idx ON control.auth_accounts (user_id);
CREATE INDEX auth_accounts_provider_idx
  ON control.auth_accounts (provider_id, account_id, id);

CREATE TABLE control.auth_verifications (
  id TEXT PRIMARY KEY,
  identifier TEXT NOT NULL,
  value TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  CHECK (length(id) BETWEEN 1 AND 300)
);

CREATE INDEX auth_verifications_identifier_idx
  ON control.auth_verifications (identifier, id);
CREATE INDEX auth_verifications_expiry_idx
  ON control.auth_verifications (expires_at, id);

CREATE TABLE control.auth_jwks (
  id TEXT PRIMARY KEY,
  public_key TEXT NOT NULL,
  private_key TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ,
  CHECK (length(id) BETWEEN 1 AND 300)
);

CREATE TABLE control.signup_invite_codes (
  code TEXT PRIMARY KEY,
  note TEXT,
  max_uses INTEGER NOT NULL DEFAULT 1 CHECK (max_uses >= 1),
  expires_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  CHECK (length(code) BETWEEN 1 AND 300)
);

CREATE TABLE control.signup_invite_claims (
  email TEXT PRIMARY KEY,
  code TEXT NOT NULL REFERENCES control.signup_invite_codes (code),
  claimed_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  user_id TEXT,
  CHECK (length(email) BETWEEN 1 AND 320)
);

CREATE INDEX signup_invite_claims_code_idx
  ON control.signup_invite_claims (code, email);
CREATE INDEX signup_invite_claims_expiry_idx
  ON control.signup_invite_claims (expires_at, email)
  WHERE consumed_at IS NULL;

CREATE TABLE control.retired_human_handles (
  handle TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  retired_at TIMESTAMPTZ NOT NULL,
  CHECK (length(handle) BETWEEN 1 AND 300),
  CHECK (length(user_id) BETWEEN 1 AND 300)
);

CREATE UNIQUE INDEX retired_human_handles_casefold_key
  ON control.retired_human_handles (lower(handle));
CREATE INDEX retired_human_handles_user_id_idx
  ON control.retired_human_handles (user_id, retired_at);
