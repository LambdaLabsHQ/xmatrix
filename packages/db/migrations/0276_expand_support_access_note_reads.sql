-- Every read of a support handoff is shown to the person
-- (docs/cross-space-read-grants.md#support-handoffs): the hour's first read
-- posts a note in their Channel and every later read in that hour updates it.
--
-- access_note_reads: how many reads the note that began at access_noted_at
--   counts. NULL on rows noted before this column; the Hub reads that as 1, the
--   one read the existing note already shows.
SET LOCAL lock_timeout = '5s';
ALTER TABLE data.cross_space_read_grants ADD COLUMN access_note_reads INTEGER;
