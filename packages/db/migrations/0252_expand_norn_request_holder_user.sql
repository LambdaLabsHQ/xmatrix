-- A request a Norn program made of a person: who holds it, resolved from the
-- name when it was delivered. The request stays open while that person can
-- read the conversation; nothing has to be working on it.
SET LOCAL lock_timeout = '5s';
ALTER TABLE data.norn_requests ADD COLUMN holder_user_id TEXT;
