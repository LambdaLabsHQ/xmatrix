-- The outside streams a running program waits on, as its last pass left them: how an event finds its programs.
SET LOCAL lock_timeout = '5s';
ALTER TABLE data.norn_programs ADD COLUMN waits_json JSONB;
