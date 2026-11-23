-- One frozen action request serves a Norn program's `prepare`, which a Space
-- admin or the app's permission admits, and later its `perform`, which runs it
-- once (docs/architecture/norn-host.md "Asking a connected app").
--
-- `approved` is the state between the two: admitted, not yet run. The old
-- check proved every existing row holds one of the earlier states; NOT VALID
-- avoids rescanning them while still checking every new write. Old writers
-- never write the new state, the new columns are nullable, and no row is
-- rewritten or deleted.
SET LOCAL lock_timeout = '5s';
ALTER TABLE data.app_connector_action_requests
  ADD COLUMN norn_prepare_ref TEXT,
  ADD COLUMN norn_perform_ref TEXT,
  DROP CONSTRAINT app_connector_action_requests_status_check,
  ADD CONSTRAINT app_connector_action_requests_status_check
    CHECK (status IN ('pending', 'approved', 'executing', 'completed', 'failed', 'blocked', 'denied', 'expired')) NOT VALID;
-- A program's request has one action request, found by the reference the program's request is known by.
CREATE UNIQUE INDEX app_connector_action_requests_norn_prepare_idx
  ON data.app_connector_action_requests (space_id, norn_prepare_ref) WHERE norn_prepare_ref IS NOT NULL;
