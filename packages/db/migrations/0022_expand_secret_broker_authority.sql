ALTER TABLE data.secret_catalog
  ADD COLUMN authority_ref TEXT,
  ADD COLUMN authority_version BIGINT;

ALTER TABLE data.secret_catalog
  ADD CONSTRAINT secret_catalog_authority_pair_check CHECK (
    (authority_ref IS NULL AND authority_version IS NULL)
    OR (authority_ref IS NOT NULL AND authority_version >= 1)
  ) NOT VALID;

CREATE UNIQUE INDEX secret_catalog_authority_ref_idx
  ON data.secret_catalog (authority_ref)
  WHERE authority_ref IS NOT NULL;

CREATE INDEX machine_secret_requests_expiry_idx
  ON data.machine_secret_requests (expires_at, owner_user_id, request_id);

CREATE INDEX secret_grants_expiry_idx
  ON data.secret_grants (expires_at, owner_user_id, grant_id)
  WHERE status = 'created';

CREATE INDEX secret_grants_secret_refs_idx
  ON data.secret_grants USING GIN (secret_refs_json jsonb_path_ops)
  WHERE status = 'created';
