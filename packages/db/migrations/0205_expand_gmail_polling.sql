SET LOCAL lock_timeout = '5s';
-- Additive: existing native watches keep their current processing contract.
ALTER TABLE data.app_gmail_routes
  ADD COLUMN notification_mode TEXT DEFAULT 'native' CHECK (notification_mode IN ('native','poll')),
  ADD COLUMN next_poll_at TIMESTAMPTZ,
  ADD COLUMN next_search_at TIMESTAMPTZ,
  ADD COLUMN inbox_fingerprint TEXT CHECK (length(inbox_fingerprint)<=128);
CREATE INDEX app_gmail_routes_poll_idx ON data.app_gmail_routes(next_poll_at)
  WHERE enabled AND notification_mode='poll';
