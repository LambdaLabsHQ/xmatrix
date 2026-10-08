-- A Machine's load history. The daemon reports a resource sample when it moves
-- materially and at least once a minute; each accepted sample becomes a row
-- here, so the owner can see how load changed instead of only its latest value.
-- Minute rows are kept for 7 days and hourly rollups for 90 days; Hub
-- maintenance rolls up and prunes both.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '25s';

CREATE TABLE data.machine_resource_samples (
  owner_user_id TEXT NOT NULL,
  machine_id TEXT NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL,
  cpu_usage_percent REAL CHECK (cpu_usage_percent BETWEEN 0 AND 100),
  load_average_1m REAL CHECK (load_average_1m >= 0),
  memory_total_bytes BIGINT CHECK (memory_total_bytes > 0),
  memory_available_bytes BIGINT CHECK (memory_available_bytes >= 0),
  swap_total_bytes BIGINT CHECK (swap_total_bytes > 0),
  swap_free_bytes BIGINT CHECK (swap_free_bytes >= 0),
  disk_total_bytes BIGINT CHECK (disk_total_bytes > 0),
  disk_available_bytes BIGINT CHECK (disk_available_bytes >= 0),
  PRIMARY KEY (owner_user_id, machine_id, observed_at)
);

-- Retention deletes by age across all Machines.
CREATE INDEX machine_resource_samples_observed_idx
  ON data.machine_resource_samples (observed_at);

CREATE TABLE data.machine_resource_hourly (
  owner_user_id TEXT NOT NULL,
  machine_id TEXT NOT NULL,
  hour_start TIMESTAMPTZ NOT NULL,
  sample_count INTEGER NOT NULL CHECK (sample_count > 0),
  cpu_usage_percent_avg REAL,
  cpu_usage_percent_max REAL,
  load_average_1m_avg REAL,
  load_average_1m_max REAL,
  memory_used_percent_avg REAL,
  memory_used_percent_max REAL,
  swap_used_percent_avg REAL,
  disk_used_percent_max REAL,
  PRIMARY KEY (owner_user_id, machine_id, hour_start)
);

CREATE INDEX machine_resource_hourly_hour_idx
  ON data.machine_resource_hourly (hour_start);
