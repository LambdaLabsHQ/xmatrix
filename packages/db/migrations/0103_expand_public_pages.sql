-- Public pages (docs/strategy/go-to-market-2026-09.md §4): a Space owner or
-- admin publishes a page, and anyone can read it without signing in, at
-- /p/<space>/<page>, while its effective access stays open. published_at is
-- when it was published; NULL is not published.
ALTER TABLE data.pages ADD COLUMN published_at TIMESTAMPTZ;
