-- When xMatrix's `@<harness>` summon for a decided first message finished
-- dispatching. A decision written but never summoned (the request that held it
-- ended first) stays due for the Channel's coordinator, which finishes it.
SET LOCAL lock_timeout = '5s';

ALTER TABLE data.first_message_launch_choices ADD COLUMN summoned_at TIMESTAMPTZ;
ALTER TABLE data.first_message_launch_choices ADD CONSTRAINT first_message_launch_choices_summoned_check
  CHECK (summoned_at IS NULL OR choice = 'start') NOT VALID;
ALTER TABLE data.first_message_launch_choices VALIDATE CONSTRAINT first_message_launch_choices_summoned_check;

CREATE INDEX first_message_launch_choices_unsummoned_idx ON data.first_message_launch_choices (created_at)
  WHERE summoned_at IS NULL AND failure_code IS NULL AND choice IS DISTINCT FROM 'none';
