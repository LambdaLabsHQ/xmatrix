-- Native installation requests and signed retirement serialize on one row.
-- No provider payload, authorization code, token or actor profile is retained.
SET LOCAL lock_timeout = '5s';
CREATE TABLE data.app_sentry_installation_lifecycle (
  app_client_id TEXT NOT NULL CHECK (length(app_client_id) BETWEEN 1 AND 256),
  app_uuid UUID NOT NULL,
  installation_uuid UUID NOT NULL,
  attempt_id UUID,
  attempt_space_id TEXT CHECK (length(attempt_space_id) BETWEEN 1 AND 300),
  attempt_expires_at TIMESTAMPTZ,
  retired_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (app_client_id,app_uuid,installation_uuid),
  CHECK ((attempt_id IS NULL) = (attempt_space_id IS NULL)),
  CHECK ((attempt_id IS NULL) = (attempt_expires_at IS NULL)),
  CHECK (retired_at IS NULL OR attempt_id IS NULL),
  CHECK (attempt_expires_at IS NULL OR expires_at >= attempt_expires_at)
);
CREATE INDEX app_sentry_installation_lifecycle_expiry_idx ON data.app_sentry_installation_lifecycle
  (app_client_id,app_uuid,expires_at);
