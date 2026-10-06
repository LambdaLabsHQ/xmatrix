-- Additive routing observations. Only authenticated daemon activity writes
-- this timestamp; enrollment and owner-authored metadata cannot renew it.
ALTER TABLE data.machine_daemons ADD COLUMN routing_observed_at TIMESTAMPTZ;

-- Logical invocation ownership is separate from immutable per-attempt Launches.
CREATE TABLE data.agent_routing_invocations (
  invocation_id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  source_message_id TEXT NOT NULL,
  actor_user_id TEXT NOT NULL,
  requirements_json JSONB NOT NULL,
  policy TEXT NOT NULL DEFAULT 'deterministic' CHECK (policy IN ('deterministic','jev')),
  current_attempt INTEGER NOT NULL DEFAULT 0 CHECK (current_attempt >= 0),
  current_launch_id TEXT,
  accepted_instance_id TEXT,
  state TEXT NOT NULL CHECK (state IN ('pending','starting','accepted','failed','cancelled')),
  max_attempts INTEGER NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 5),
  version BIGINT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (channel_id,source_message_id)
);
CREATE TABLE data.agent_routing_attempts (
  invocation_id TEXT NOT NULL REFERENCES data.agent_routing_invocations(invocation_id),
  space_id TEXT NOT NULL,
  attempt INTEGER NOT NULL CHECK (attempt > 0),
  launch_id TEXT NOT NULL UNIQUE,
  profile_id TEXT NOT NULL,
  machine_id TEXT NOT NULL,
  instance_id TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK (state IN ('starting','accepted','superseded','failed')),
  reason TEXT,
  decision_json JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (invocation_id,attempt)
);
CREATE INDEX agent_routing_pending_idx ON data.agent_routing_invocations(updated_at,invocation_id)
  WHERE state IN ('pending','starting');
CREATE INDEX agent_routing_active_machine_idx ON data.runs(owner_user_id,(metadata_json->>'machineId'))
  WHERE status IN ('starting','running','stopping');
CREATE INDEX agent_routing_latency_idx ON data.agent_launches(target_profile_id,connected_at DESC)
  WHERE connected_at IS NOT NULL AND prepared_at IS NOT NULL;
