SET LOCAL lock_timeout = '5s';
-- Primary App authority. Only opaque identities, cursors and encrypted setup data.
CREATE TABLE data.app_gmail_routes (
  route_id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  credential_version BIGINT NOT NULL,
  connection_generation TEXT NOT NULL,
  created_by TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  mailbox_digest TEXT NOT NULL,
  token_digest TEXT NOT NULL,
  oauth_nonce_digest TEXT NOT NULL,
  oauth_consumed BOOLEAN NOT NULL DEFAULT false,
  expires_at TIMESTAMPTZ,
  renew_at TIMESTAMPTZ,
  encrypted_value_json JSONB NOT NULL,
  history_id TEXT NOT NULL,
  page_token TEXT,
  enabled BOOLEAN NOT NULL DEFAULT false,
  last_signal_at TIMESTAMPTZ,
  last_verified_at TIMESTAMPTZ,
  wake_version BIGINT NOT NULL DEFAULT 0,
  processed_version BIGINT NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  lease_id UUID,
  lease_until TIMESTAMPTZ,
  error_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX app_gmail_routes_active_mailbox_idx ON data.app_gmail_routes(connection_id,mailbox_digest) WHERE enabled;
CREATE INDEX app_gmail_routes_identity_idx ON data.app_gmail_routes(token_digest);
CREATE INDEX app_gmail_routes_renew_idx ON data.app_gmail_routes(renew_at) WHERE enabled;
CREATE INDEX app_gmail_routes_space_idx ON data.app_gmail_routes(space_id);
CREATE INDEX app_gmail_routes_due_idx ON data.app_gmail_routes(available_at)
  WHERE enabled AND wake_version > processed_version;
CREATE TABLE data.app_gmail_notifications (
  route_id TEXT NOT NULL REFERENCES data.app_gmail_routes(route_id) ON DELETE CASCADE,
  message_id TEXT NOT NULL,
  delivered_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (route_id,message_id)
);
