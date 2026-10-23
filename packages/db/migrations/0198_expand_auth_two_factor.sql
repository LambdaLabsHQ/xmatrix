-- Optional two-step verification: Better Auth's two-factor model. A person
-- who turns it on holds one row with an encrypted authenticator secret and
-- encrypted backup codes; the flag on the account is what holds a new
-- sign-in back until the second code arrives.
--
-- Expand only. Every existing account reads FALSE (NULL counts as off) and signs in as before.

ALTER TABLE control.auth_users ADD COLUMN two_factor_enabled BOOLEAN DEFAULT FALSE;

CREATE TABLE control.auth_two_factors (
  id TEXT PRIMARY KEY,
  secret TEXT NOT NULL,
  backup_codes TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES control.auth_users (id) ON DELETE CASCADE,
  verified BOOLEAN DEFAULT TRUE,
  failed_verification_count INTEGER DEFAULT 0,
  locked_until TIMESTAMPTZ,
  CHECK (length(id) BETWEEN 1 AND 300),
  CHECK (length(secret) <= 1000),
  CHECK (length(backup_codes) <= 10000)
);

CREATE INDEX auth_two_factors_user_idx ON control.auth_two_factors (user_id);
