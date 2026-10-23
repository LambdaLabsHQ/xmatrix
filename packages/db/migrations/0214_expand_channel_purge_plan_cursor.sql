-- A cursor is meaningful only for the exact ordered table/predicate plan.
-- NULL makes an older pending job restart safely under the bounded plan.
ALTER TABLE data.channel_deletions ADD COLUMN row_plan_digest TEXT
  CHECK (row_plan_digest IS NULL OR row_plan_digest ~ '^[a-f0-9]{64}$');
