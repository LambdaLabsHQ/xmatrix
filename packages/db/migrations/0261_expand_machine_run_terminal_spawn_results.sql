-- A start a connected machine was handed and never answered is ended by the
-- Hub. In the transaction that ends it, the Hub records the failed-spawn
-- report the machine never made, so the coordinator finalizes that Run like
-- any other terminal report: the failure is said on the summon, an `@auto`
-- summon goes to the next Agent, and the start breaker sees it. Old Hubs
-- finalize such a row the same way; they just never write one.

-- Fail fast instead of queueing reports behind this transaction.
SET LOCAL lock_timeout = '5s';

ALTER TABLE data.machine_run_terminal_reports
  DROP CONSTRAINT machine_run_terminal_reports_event_type_check,
  ADD CONSTRAINT machine_run_terminal_reports_event_type_check
    CHECK (event_type IN ('machine_run_exited','machine_stop_result','machine_spawn_result')) NOT VALID;
ALTER TABLE data.machine_run_terminal_reports
  VALIDATE CONSTRAINT machine_run_terminal_reports_event_type_check;
