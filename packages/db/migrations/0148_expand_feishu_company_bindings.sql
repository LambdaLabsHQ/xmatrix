-- Company store-app lifecycle and explicitly confirmed rooms. No tenant keys
-- are inferred from profiles, names, manual credentials, or existing messages.
SET LOCAL lock_timeout = '5s';
CREATE TABLE data.app_feishu_tickets (
  app_identity TEXT PRIMARY KEY CHECK (length(app_identity) BETWEEN 1 AND 600),
  version BIGINT NOT NULL CHECK (version >= 1),
  encrypted_value_json JSONB NOT NULL,
  event_id TEXT NOT NULL CHECK (length(event_id) BETWEEN 1 AND 128),
  event_time TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE data.app_feishu_tenant_lifecycle (
  app_identity TEXT NOT NULL CHECK (length(app_identity) BETWEEN 1 AND 600),
  tenant_key TEXT NOT NULL CHECK (tenant_key ~ '^[A-Za-z0-9_-]{1,64}$'),
  active BOOLEAN NOT NULL,
  retired_at TIMESTAMPTZ,
  event_id TEXT NOT NULL CHECK (length(event_id) BETWEEN 1 AND 128),
  event_time TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (app_identity,tenant_key)
);
CREATE TABLE data.app_feishu_link_attempts (
  connection_id TEXT PRIMARY KEY REFERENCES data.app_connector_connections(connection_id) ON DELETE CASCADE,
  space_id TEXT NOT NULL,
  app_identity TEXT NOT NULL CHECK (length(app_identity) BETWEEN 1 AND 600),
  chat_space TEXT NOT NULL CHECK (chat_space ~ '^[A-Za-z0-9_-]{1,64}/oc_[A-Za-z0-9]{4,64}$'),
  nonce_digest TEXT NOT NULL UNIQUE CHECK (nonce_digest ~ '^[a-f0-9]{64}$'),
  actor_user_id TEXT NOT NULL,
  connection_version BIGINT NOT NULL CHECK (connection_version >= 1),
  credential_version BIGINT NOT NULL CHECK (credential_version >= 0),
  connection_generation TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  CHECK (connection_id = space_id || ':feishu'),
  CHECK (expires_at = started_at + interval '3 minutes')
);
CREATE INDEX app_feishu_attempt_room_idx ON data.app_feishu_link_attempts (app_identity,chat_space);
CREATE INDEX app_feishu_attempt_expiry_idx ON data.app_feishu_link_attempts (expires_at);
CREATE TABLE data.app_feishu_room_bindings (
  connection_id TEXT NOT NULL REFERENCES data.app_connector_connections(connection_id) ON DELETE CASCADE,
  space_id TEXT NOT NULL,
  app_identity TEXT NOT NULL CHECK (length(app_identity) BETWEEN 1 AND 600),
  chat_space TEXT NOT NULL CHECK (chat_space ~ '^[A-Za-z0-9_-]{1,64}/oc_[A-Za-z0-9]{4,64}$'),
  grant_generation UUID NOT NULL DEFAULT gen_random_uuid(),
  connection_generation TEXT NOT NULL,
  confirmed_at TIMESTAMPTZ NOT NULL,
  active BOOLEAN NOT NULL DEFAULT true,
  PRIMARY KEY (connection_id,chat_space),
  CHECK (connection_id = space_id || ':feishu')
);
CREATE UNIQUE INDEX app_feishu_active_room_idx ON data.app_feishu_room_bindings
  (app_identity,chat_space) WHERE active;
CREATE INDEX app_feishu_room_lookup_idx ON data.app_feishu_room_bindings (app_identity,chat_space);
CREATE TABLE data.app_feishu_room_lifecycle (
  app_identity TEXT NOT NULL CHECK (length(app_identity) BETWEEN 1 AND 600),
  chat_space TEXT NOT NULL CHECK (chat_space ~ '^[A-Za-z0-9_-]{1,64}/oc_[A-Za-z0-9]{4,64}$'),
  removed_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (app_identity,chat_space)
);
CREATE INDEX app_feishu_removal_expiry_idx ON data.app_feishu_room_lifecycle (removed_at);
