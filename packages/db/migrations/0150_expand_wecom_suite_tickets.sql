-- App-level encrypted tickets; no Space grants or provider credentials are inferred.
SET LOCAL lock_timeout = '5s';
CREATE TABLE data.app_wecom_suite_tickets (
  app_identity TEXT PRIMARY KEY CHECK (length(app_identity) BETWEEN 1 AND 600),
  ambiguous BOOLEAN NOT NULL DEFAULT false,
  version BIGINT NOT NULL CHECK (version >= 1),
  encrypted_value_json JSONB NOT NULL CHECK (jsonb_typeof(encrypted_value_json) = 'object'),
  event_id TEXT NOT NULL CHECK (length(event_id) BETWEEN 1 AND 128),
  event_time TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX app_wecom_suite_ticket_expiry_idx ON data.app_wecom_suite_tickets (event_time);
