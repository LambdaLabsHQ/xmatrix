-- One permission for each connected app; NULL inherits its manifest default.
SET LOCAL lock_timeout = '5s';
ALTER TABLE data.app_connector_connections ADD COLUMN permission_mode TEXT
  CHECK (permission_mode IN ('read', 'ask', 'write'));

-- Snapshot evidence: both production shards were read immediately before this
-- rollout; all seven legacy rows were redundant allow rules. Recheck while
-- holding a write-conflicting lock. Refuse a changed restrictive inventory.
LOCK TABLE data.app_connector_action_policies IN SHARE ROW EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM data.app_connector_action_policies WHERE mode <> 'allow') THEN
    RAISE EXCEPTION 'Channel policy retirement needs a fresh restrictive-rule migration';
  END IF;
END $$;
-- NOT VALID preserves the existing evidence but rejects every future old-rule
-- insert/update. Deletes of redundant allow rows cannot widen authority.
ALTER TABLE data.app_connector_action_policies ADD CONSTRAINT retired_channel_policy_writer
  CHECK (false) NOT VALID;
