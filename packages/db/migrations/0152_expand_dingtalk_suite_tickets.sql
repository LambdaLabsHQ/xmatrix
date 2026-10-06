-- Private application tickets are independent of company and Space authorization.
SET LOCAL lock_timeout = '5s';
CREATE TABLE data.app_dingtalk_suite_tickets (
  app_identity TEXT PRIMARY KEY CHECK (length(app_identity) BETWEEN 1 AND 600),
  ambiguous BOOLEAN NOT NULL DEFAULT false,
  version BIGINT NOT NULL CHECK (version >= 1),
  encrypted_value_json JSONB NOT NULL CHECK (jsonb_typeof(encrypted_value_json) = 'object'),
  event_id TEXT NOT NULL CHECK (length(event_id) BETWEEN 1 AND 128),
  event_time TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);
