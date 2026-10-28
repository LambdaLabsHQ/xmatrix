-- Platform-admin activity reads settled per-day rollups instead of rescanning
-- every message. A UTC day settles two days after it began, from the messages
-- then present; the days after it are read from data.messages directly.
SET LOCAL lock_timeout = '5s';

-- One Space's messages on one UTC send day, by author kind and the person they
-- count for: the author for people, the send-time owner for Agents, '' when
-- nobody is attributed. `own_messages` are text a member typed themselves.
CREATE TABLE data.admin_activity_days (
  space_id TEXT NOT NULL,
  day DATE NOT NULL,
  author_kind TEXT NOT NULL,
  user_id TEXT NOT NULL,
  messages INTEGER NOT NULL CHECK (messages > 0),
  own_messages INTEGER NOT NULL CHECK (own_messages >= 0 AND own_messages <= messages),
  last_sent_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (space_id, day, author_kind, user_id),
  CHECK (length(space_id) BETWEEN 1 AND 300),
  CHECK (length(author_kind) BETWEEN 1 AND 40)
);
CREATE INDEX admin_activity_days_day_idx ON data.admin_activity_days (day);

-- The last UTC day this shard has settled; NULL until its first roll-up.
CREATE TABLE data.admin_activity_rollup (
  singleton BOOLEAN PRIMARY KEY DEFAULT true CHECK (singleton),
  settled_through DATE,
  updated_at TIMESTAMPTZ NOT NULL
);
INSERT INTO data.admin_activity_rollup (singleton, settled_through, updated_at)
  VALUES (true, NULL, clock_timestamp());
