-- Automations are retired: schedule lines no longer run (#1681), and since
-- #1682 no code reads or writes their storage. Scheduled work is a Norn
-- program on a page. Apply after the Hub of #1682 is verified.
--
-- Refuses while any Automation would still run: enabled and attached to its
-- page, as 0235 defined running. Paused, finished (a one-time reminder is
-- disabled once it ran) and detached rows are history no one can see, and go
-- with their tables. Occurrences belong to their Automation. Nothing else
-- references these relations: no foreign key names them, and the view and its
-- conversation-id function (0200) serve only them.

SET LOCAL lock_timeout = '5s';

LOCK TABLE data.automations, data.automation_occurrences IN ACCESS EXCLUSIVE MODE;

DO $$
DECLARE
  running BIGINT;
BEGIN
  SELECT count(*) INTO running FROM data.automations WHERE enabled AND detached_at IS NULL;
  IF running > 0 THEN
    RAISE EXCEPTION '% Automation(s) are still enabled; pause or remove them before dropping their storage', running
      USING ERRCODE = 'object_in_use';
  END IF;
END $$;

DROP VIEW data.automation_occurrence_runs;
DROP FUNCTION data.automation_occurrence_conversation_id(TEXT);
DROP TABLE data.automation_occurrences;
DROP TABLE data.automations;
