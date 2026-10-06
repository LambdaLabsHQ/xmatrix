-- Channels created before 0033_expand_channel_catalog_paging never had their
-- activity_at filled on this environment, so every catalog read recomputed it
-- from all of their messages. Give each one the later of its update time and
-- its latest non-deleted message, as Channel writers compute it. Every serving
-- Hub writes activity_at on create, configure, move, archive and append; the
-- release that follows this migration reads activity_at without scanning
-- messages. Bounded and idempotent: a second run finds no row to fill.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $$
DECLARE
  pending BIGINT;
BEGIN
  -- Refuse an unexpectedly large operation before any row is rewritten.
  SELECT count(*) INTO pending FROM data.channels WHERE activity_at IS NULL;
  IF pending > 100000 THEN RAISE EXCEPTION 'Channel activity backfill exceeds 100000 rows'; END IF;
END $$;

UPDATE data.channels channel
SET activity_at = GREATEST(channel.updated_at, COALESCE((
  SELECT MAX(message.sent_at) FROM data.messages message
  WHERE message.space_id = channel.space_id AND message.channel_id = channel.channel_id
    AND message.deleted_at IS NULL
), channel.updated_at))
WHERE channel.activity_at IS NULL;
