-- What the failed step itself reported (for example the daemon's refusal to
-- resume a session whose working directory was reclaimed), so the failure
-- notice can say why instead of naming only the step. NULL when the step gave
-- no reason. A nullable column and an unvalidated check keep this
-- metadata-only: no rewrite, no validation scan.
ALTER TABLE data.agent_reborn_intents ADD COLUMN error_detail TEXT;
ALTER TABLE data.agent_reborn_intents ADD CONSTRAINT agent_reborn_intents_error_detail_check
  CHECK (error_detail IS NULL OR char_length(error_detail) <= 1000) NOT VALID;
