-- Who used a Space's allowance (docs/design/agent-credits.md#who-used-it): one
-- row per month, meter, author and kind of write, advanced in the statement
-- that counts the write, so the itemized total never drifts from the counters.
-- `credit` rows are a paid Space's Agent and app writes, also recorded when the
-- deployment waives the Space's credits; `free` rows are a Free Space's writes.
-- An Agent is named by its registration's name and its owner; an app by its id;
-- a person by their user id alone.
CREATE TABLE data.space_credit_usage (
  space_id TEXT NOT NULL CHECK (length(space_id) BETWEEN 1 AND 300),
  period_start DATE NOT NULL,
  meter TEXT NOT NULL CHECK (meter IN ('credit','free')),
  author_kind TEXT NOT NULL CHECK (author_kind IN ('user','agent','app')),
  owner_user_id TEXT NOT NULL CHECK (length(owner_user_id) <= 300),
  author_name TEXT NOT NULL CHECK (length(author_name) <= 200),
  write_kind TEXT NOT NULL CHECK (write_kind IN ('message','page_revision')),
  units BIGINT NOT NULL CHECK (units >= 0),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (space_id,period_start,meter,author_kind,owner_user_id,author_name,write_kind),
  CHECK (updated_at >= created_at)
);
