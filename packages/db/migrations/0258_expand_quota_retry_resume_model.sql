-- The model a dispatched continuation resumes on instead of the one whose
-- quota stopped it ('' is the runtime's default; NULL resumes on its own
-- model). Written once as the retry is dispatched, so a redelivery resumes
-- on the same model with the same notice.

-- Fail fast instead of queueing launches behind this transaction.
SET LOCAL lock_timeout = '5s';

ALTER TABLE data.agent_quota_retries ADD COLUMN resume_model TEXT
  CHECK (resume_model IS NULL OR length(resume_model) <= 160);
