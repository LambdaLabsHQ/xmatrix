-- Secrets belong to a Space. Each holds its value and one access setting:
-- 'auto' gives it to any live Run in the Space that asks; 'ask' gives it to a
-- Run only after a Space admin approves that Run (run_secret_approvals).
-- Nothing is injected when a Run starts and registrations no longer list
-- secrets; a Run reads one when it needs it.

-- Fail fast instead of queueing secret traffic behind this transaction.
SET LOCAL lock_timeout = '5s';

CREATE TABLE data.space_secrets (
  space_id TEXT NOT NULL CHECK (length(space_id) BETWEEN 1 AND 300),
  secret_ref TEXT NOT NULL CHECK (length(secret_ref) BETWEEN 1 AND 160),
  env_name TEXT NOT NULL CHECK (env_name ~ '^[A-Za-z_][A-Za-z0-9_]{0,119}$'),
  description TEXT CHECK (description IS NULL OR length(description) BETWEEN 1 AND 600),
  access TEXT NOT NULL CHECK (access IN ('auto', 'ask')),
  -- The envelope's keyId names what its ciphertext is bound to:
  -- 'space-secret:v1' binds (space_id, secret_ref, value_version);
  -- 'secret-authority:v1', copied from an owner's catalog below, binds
  -- (created_by_user_id, secret_ref, value_version) until the value is next set.
  encrypted_value_json JSONB NOT NULL CHECK (jsonb_typeof(encrypted_value_json) = 'object'),
  value_version BIGINT NOT NULL CHECK (value_version >= 1),
  value_digest TEXT NOT NULL CHECK (length(value_digest) BETWEEN 1 AND 128),
  created_by_user_id TEXT NOT NULL CHECK (length(created_by_user_id) BETWEEN 1 AND 300),
  updated_by_user_id TEXT NOT NULL CHECK (length(updated_by_user_id) BETWEEN 1 AND 300),
  version BIGINT NOT NULL CHECK (version >= 1),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (space_id, secret_ref),
  CHECK (updated_at >= created_at)
);

CREATE TABLE data.run_secret_approvals (
  run_id TEXT NOT NULL CHECK (length(run_id) BETWEEN 1 AND 300),
  secret_ref TEXT NOT NULL CHECK (length(secret_ref) BETWEEN 1 AND 160),
  space_id TEXT NOT NULL CHECK (length(space_id) BETWEEN 1 AND 300),
  approved_by_user_id TEXT NOT NULL CHECK (length(approved_by_user_id) BETWEEN 1 AND 300),
  approved_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (run_id, secret_ref)
);

CREATE INDEX run_secret_approvals_space_idx ON data.run_secret_approvals (space_id, secret_ref);

-- Owners' saved secrets move into Spaces. A secret an Agent registration
-- already uses goes to that registration's Space as 'auto', so those Agents
-- keep reading it. Any other goes, as 'ask', to each Space its owner
-- administers. The first owner to claim an alias in a Space keeps it.
-- Internal OAuth sessions and expired values stay where they are.
INSERT INTO data.space_secrets (space_id, secret_ref, env_name, description, access,
  encrypted_value_json, value_version, value_digest, created_by_user_id, updated_by_user_id,
  version, created_at, updated_at)
SELECT target.space_id, catalog.secret_ref,
  COALESCE(NULLIF(catalog.default_env_name, ''),
    left(CASE WHEN catalog.secret_ref ~ '^[A-Za-z_]' THEN '' ELSE '_' END
      || upper(regexp_replace(catalog.secret_ref, '[^A-Za-z0-9_]', '_', 'g')), 120)),
  NULLIF(catalog.description, ''), target.access, value.encrypted_value_json,
  value.authority_version, value.value_digest, catalog.owner_user_id, catalog.owner_user_id, 1,
  catalog.created_at, GREATEST(catalog.updated_at, catalog.created_at)
FROM data.secret_catalog catalog
JOIN data.secret_values value ON value.owner_user_id = catalog.owner_user_id
  AND value.secret_ref = catalog.secret_ref AND value.authority_ref = catalog.authority_ref
  AND value.authority_version = catalog.authority_version
  AND (value.expires_at IS NULL OR value.expires_at > clock_timestamp())
CROSS JOIN LATERAL (
  SELECT used.space_id, 'auto' AS access FROM (
    SELECT registration.space_id FROM data.space_agent_registrations registration
      WHERE registration.owner_user_id = catalog.owner_user_id
        AND registration.configuration_json -> 'secretReferences' ? catalog.secret_ref
    UNION
    SELECT access.space_id FROM data.space_agent_registration_access access
      WHERE access.owner_user_id = catalog.owner_user_id
        AND access.grant_limits -> 'secrets' ? catalog.secret_ref
  ) used
  UNION ALL
  SELECT member.space_id, 'ask' FROM data.space_members member
    WHERE member.user_id = catalog.owner_user_id AND member.role IN ('owner', 'admin')
      AND NOT EXISTS (SELECT 1 FROM data.space_agent_registrations registration
        WHERE registration.owner_user_id = catalog.owner_user_id
          AND registration.configuration_json -> 'secretReferences' ? catalog.secret_ref)
      AND NOT EXISTS (SELECT 1 FROM data.space_agent_registration_access access
        WHERE access.owner_user_id = catalog.owner_user_id
          AND access.grant_limits -> 'secrets' ? catalog.secret_ref)
) target
JOIN data.spaces space ON space.space_id = target.space_id
WHERE catalog.authority_ref IS NOT NULL AND catalog.secret_ref NOT LIKE 'internal/oauth/%'
  AND length(catalog.secret_ref) <= 160
ORDER BY catalog.created_at, catalog.owner_user_id, catalog.secret_ref
ON CONFLICT (space_id, secret_ref) DO NOTHING;
