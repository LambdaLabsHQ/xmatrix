-- Secrets belong to Spaces (0123) and the Slack OAuth session keeps its own
-- token (0125). Apply once every serving Hub runs a release with both; then
-- nothing reads or writes an owner's personal catalog or the retired
-- host-command secret grants and requests.
--
-- It refuses while an owner's usable secret has no copy in a Space: that
-- secret would otherwise be lost. Add it to a Space first (Settings ->
-- Secrets), then apply again.

SET LOCAL lock_timeout = '5s';

DO $$
DECLARE
  unmoved INTEGER;
BEGIN
  SELECT count(*) INTO unmoved
  FROM data.secret_catalog catalog
  JOIN data.secret_values value ON value.owner_user_id = catalog.owner_user_id
    AND value.secret_ref = catalog.secret_ref
    AND (value.expires_at IS NULL OR value.expires_at > clock_timestamp())
  WHERE catalog.authority_ref IS NOT NULL AND catalog.secret_ref NOT LIKE 'internal/oauth/%'
    AND NOT EXISTS (SELECT 1 FROM data.space_secrets moved
      WHERE moved.created_by_user_id = catalog.owner_user_id AND moved.secret_ref = catalog.secret_ref);
  IF unmoved > 0 THEN
    RAISE EXCEPTION '% owner secret(s) have no copy in a Space; add them to a Space before retiring the owner catalog', unmoved;
  END IF;
END
$$;

DROP TABLE data.secret_instance_resolutions;
DROP TABLE data.secret_instance_approvals;
DROP TABLE data.machine_secret_requests;
DROP TABLE data.secret_grants;
DROP TABLE data.secret_values;
DROP TABLE data.secret_catalog;
