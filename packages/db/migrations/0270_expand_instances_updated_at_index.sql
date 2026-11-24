-- xmatrix:online-indexes
-- Registration catalog reads (`registration_catalog_page_v10`) scan Instances
-- updated in the last 48 hours to select each registration's latest model and
-- parameter catalogs once per page instead of probing every historical
-- `run_agent_registrations` row per registration.
CREATE INDEX CONCURRENTLY instances_updated_at_idx
  ON data.instances (updated_at DESC);
