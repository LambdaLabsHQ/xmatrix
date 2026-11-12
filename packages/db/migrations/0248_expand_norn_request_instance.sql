-- The Instance a request was handed to when it went to one already there, instead of starting a new one.
SET LOCAL lock_timeout = '5s';
ALTER TABLE data.norn_requests ADD COLUMN instance_id TEXT;
