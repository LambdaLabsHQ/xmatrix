-- The operator's own addresses that no domain rule catches (for example a
-- personal Gmail). Campaigns skip them and grants refuse them. Kept in the
-- database, not the public repository or its configuration.
CREATE TABLE control.internal_email_addresses (
  email TEXT PRIMARY KEY CHECK (email = lower(email) AND length(email) BETWEEN 3 AND 320 AND position('@' in email) > 1),
  added_by TEXT NOT NULL CHECK (length(added_by) BETWEEN 1 AND 300),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
