-- An Agent delegated a Norn request it held, and the Instance its delivery
-- had started for it no longer holds anything here: the coordinator lets it
-- go as it would once the request had ended, and clears this.
SET LOCAL lock_timeout = '5s';
ALTER TABLE data.norn_requests ADD COLUMN delegated_away_instance_id TEXT;
