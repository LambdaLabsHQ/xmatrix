-- Hostname is a mutable observation; the Machine is keyed by owner + machine_id.
-- Retain the legacy columns while released clients still read and write them.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE data.machine_daemons ADD COLUMN hostname TEXT;

-- Space secret reads historically placed a Space id in the legacy host_id
-- audit column. Preserve that evidence in its actual domain before contraction.
ALTER TABLE data.secret_grant_audit ADD COLUMN space_id TEXT;
-- Backfill existing observations and audit evidence in bounded batches after
-- deployment, before the separately authorized contract migration.
