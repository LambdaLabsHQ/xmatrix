-- A conversation can follow one GitHub Actions workflow run, as it follows one
-- pull request: the run's verdict comes back as a message when it completes
-- and the relation ends then, so an Agent waits on the webhook instead of
-- polling GitHub (`gh run watch` spends the shared REST quota).
--
-- Expand only: a new allowed `source_kind`. Readers before this change select
-- only 'repository' and 'issue' and never see a 'workflow_run' row.
ALTER TABLE data.app_source_relations
  DROP CONSTRAINT app_source_relations_source_kind_check,
  ADD CONSTRAINT app_source_relations_source_kind_check
    CHECK (source_kind IN ('repository', 'issue', 'workflow_run')) NOT VALID;
