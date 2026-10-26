-- Only the canonical append can certify that no conversation receiver existed
-- when a publication committed. Old post-commit observations remain unknown;
-- never backfill this flag from present-day Instance state.
SET LOCAL lock_timeout = '5s';
ALTER TABLE data.message_asks ADD COLUMN commit_certified BOOLEAN;
