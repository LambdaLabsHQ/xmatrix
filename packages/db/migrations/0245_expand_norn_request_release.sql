-- When the Run a request started was let go after the request ended.
SET LOCAL lock_timeout = '5s';
ALTER TABLE data.norn_requests ADD COLUMN released_at TIMESTAMPTZ;
