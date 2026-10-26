-- xmatrix:online-indexes
-- 0137 dropped host_id, and PostgreSQL dropped these two indexes with the
-- column. Since then every daemon report has scanned all Machine Run routes
-- for the Machine's open ones, and every reconnect all Launches for those
-- waiting on it. Rebuild both without the retired column.
CREATE INDEX CONCURRENTLY machine_run_routes_machine_idx ON data.machine_run_routes
  (owner_user_id, machine_id, terminal_at, updated_at, run_id);
CREATE INDEX CONCURRENTLY agent_launches_machine_delivery_idx ON data.agent_launches
  (owner_user_id, machine_id, next_attempt_at, launch_id) WHERE state IN ('prepared', 'queued');
