-- A delegated Norn request: the person who delegated it, or whose Agent did,
-- by their id, while the ledger says the request is delegated. Only they can
-- take it back, and an Instance of theirs can be delivered it. The ledger
-- keeps the name; the name alone is not an identity.
SET LOCAL lock_timeout = '5s';
ALTER TABLE data.norn_requests ADD COLUMN delegator_user_id TEXT;
