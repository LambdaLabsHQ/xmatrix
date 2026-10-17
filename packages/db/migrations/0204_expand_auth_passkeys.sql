-- Passkeys: Better Auth's passkey model. A person who adds a passkey holds one
-- row per credential: its public key, the authenticator's signature counter
-- and how it may be reached. The private key never leaves the authenticator.
--
-- Expand only. An account without a passkey signs in as before.
SET LOCAL lock_timeout = '5s';

CREATE TABLE control.auth_passkeys (
  id TEXT PRIMARY KEY,
  name TEXT,
  public_key TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES control.auth_users (id) ON DELETE CASCADE,
  credential_id TEXT NOT NULL,
  counter BIGINT NOT NULL,
  device_type TEXT NOT NULL,
  backed_up BOOLEAN NOT NULL,
  transports TEXT,
  created_at TIMESTAMPTZ,
  aaguid TEXT,
  CHECK (length(id) BETWEEN 1 AND 300),
  CHECK (name IS NULL OR length(name) <= 200),
  CHECK (length(public_key) <= 4000),
  CHECK (length(credential_id) BETWEEN 1 AND 2000),
  CHECK (length(device_type) <= 40),
  CHECK (transports IS NULL OR length(transports) <= 200),
  CHECK (aaguid IS NULL OR length(aaguid) <= 64)
);

CREATE INDEX auth_passkeys_user_idx ON control.auth_passkeys (user_id);
CREATE UNIQUE INDEX auth_passkeys_credential_idx ON control.auth_passkeys (credential_id);
