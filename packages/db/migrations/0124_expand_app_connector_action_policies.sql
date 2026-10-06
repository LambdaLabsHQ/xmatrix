-- Which connector actions a Channel may run (docs/design/connector-platform.md
-- §3.5). No row is the manifest default: a Human's own command runs any
-- action, an Agent's command runs only read actions. `allow` lets Agents run a
-- write action in the Channel; `deny` blocks the action for everyone there.

SET LOCAL lock_timeout = '5s';

CREATE TABLE data.app_connector_action_policies (
  connection_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  action_id TEXT NOT NULL,
  space_id TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('allow', 'deny')),
  version BIGINT NOT NULL CHECK (version >= 1),
  updated_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (connection_id, channel_id, action_id),
  CHECK (length(action_id) BETWEEN 1 AND 100),
  CHECK (updated_at >= created_at)
);

CREATE INDEX app_connector_action_policies_space_idx ON data.app_connector_action_policies (space_id);
CREATE INDEX app_connector_action_policies_channel_idx ON data.app_connector_action_policies (channel_id);
