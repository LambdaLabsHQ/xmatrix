-- Shared provider-account quota is a directory observation. It never grants
-- Space access and is unknown when no fresh measurement exists.
CREATE TABLE control.registration_quota_observations (
  owner_user_id TEXT NOT NULL,
  quota_pool_id TEXT NOT NULL,
  remaining DOUBLE PRECISION NOT NULL CHECK (remaining >= 0 AND remaining <= 100),
  observed_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('provider', 'daemon')),
  PRIMARY KEY (owner_user_id, quota_pool_id),
  CHECK (length(quota_pool_id) BETWEEN 1 AND 300),
  CHECK (length(owner_user_id) BETWEEN 1 AND 300),
  CHECK (expires_at > observed_at)
);
