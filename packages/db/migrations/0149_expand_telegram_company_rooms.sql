-- Explicitly confirmed company-bot groups. Existing manual credentials are not grants.
SET LOCAL lock_timeout = '5s';
CREATE TABLE data.app_telegram_link_attempts (
  connection_id TEXT PRIMARY KEY REFERENCES data.app_connector_connections(connection_id) ON DELETE CASCADE,
  space_id TEXT NOT NULL,
  app_identity TEXT NOT NULL CHECK (length(app_identity) BETWEEN 1 AND 600),
  chat_space TEXT NOT NULL CHECK (chat_space ~ '^-[1-9][0-9]{0,15}$'),
  nonce_digest TEXT NOT NULL UNIQUE CHECK (nonce_digest ~ '^[a-f0-9]{64}$'),
  actor_user_id TEXT NOT NULL,
  connection_version BIGINT NOT NULL CHECK (connection_version >= 1),
  credential_version BIGINT NOT NULL CHECK (credential_version >= 0),
  connection_generation TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  CHECK (connection_id = space_id || ':telegram'),
  CHECK (expires_at = started_at + interval '3 minutes')
);
CREATE INDEX app_telegram_attempt_room_idx ON data.app_telegram_link_attempts (app_identity,chat_space);
CREATE INDEX app_telegram_attempt_expiry_idx ON data.app_telegram_link_attempts (expires_at);
CREATE TABLE data.app_telegram_room_bindings (
  connection_id TEXT NOT NULL REFERENCES data.app_connector_connections(connection_id) ON DELETE CASCADE,
  space_id TEXT NOT NULL,
  app_identity TEXT NOT NULL CHECK (length(app_identity) BETWEEN 1 AND 600),
  chat_space TEXT NOT NULL CHECK (chat_space ~ '^-[1-9][0-9]{0,15}$'),
  grant_generation UUID NOT NULL DEFAULT gen_random_uuid(),
  connection_generation TEXT NOT NULL,
  confirmed_at TIMESTAMPTZ NOT NULL,
  active BOOLEAN NOT NULL DEFAULT true,
  PRIMARY KEY (connection_id,chat_space),
  CHECK (connection_id = space_id || ':telegram')
);
CREATE UNIQUE INDEX app_telegram_active_room_idx ON data.app_telegram_room_bindings
  (app_identity,chat_space) WHERE active;
CREATE INDEX app_telegram_room_lookup_idx ON data.app_telegram_room_bindings (app_identity,chat_space);
CREATE TABLE data.app_telegram_room_lifecycle (
  app_identity TEXT NOT NULL CHECK (length(app_identity) BETWEEN 1 AND 600),
  chat_space TEXT NOT NULL CHECK (chat_space ~ '^-[1-9][0-9]{0,15}$'),
  removed_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (app_identity,chat_space)
);
CREATE INDEX app_telegram_removal_expiry_idx ON data.app_telegram_room_lifecycle (removed_at);
