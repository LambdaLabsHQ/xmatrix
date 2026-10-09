-- An edit now records the write-back on the claims of the sections it changes
-- (docs/design/pages-live-document.md §5.2), and what a section owes is read
-- from those claims alone. Claims that ended before that were judged against
-- the page's last 30 revisions, so a section whose write-back had scrolled out
-- of them owed an update again. Every one of them has been through the
-- goal-page follow-up rounds since; settle them so only claims ending from here on count.
-- Bounded and idempotent: a second run finds no row to settle.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $$
DECLARE
  pending BIGINT;
BEGIN
  -- Refuse an unexpectedly large operation before any row is rewritten.
  SELECT count(*) INTO pending FROM data.page_claims WHERE written_back_at IS NULL;
  IF pending > 100000 THEN RAISE EXCEPTION 'Page claim write-back backfill exceeds 100000 rows'; END IF;
END $$;

UPDATE data.page_claims SET written_back_at = now()
  WHERE written_back_at IS NULL
    AND (state IN ('completed', 'released') OR (state = 'active' AND expires_at <= now()));
