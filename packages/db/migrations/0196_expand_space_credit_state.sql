-- Agent credits (docs/design/agent-credits.md): one row per paid Space holding
-- the current calendar month's counters, the pack balance that carries across
-- months, and the highest notice level the month has crossed. A write in a new
-- month resets the counters in the same upsert, so the row is the only
-- authority and there is nothing to roll over.
CREATE TABLE data.space_credit_state (
  space_id TEXT PRIMARY KEY CHECK (length(space_id) BETWEEN 1 AND 300),
  period_start DATE NOT NULL,
  included_used BIGINT NOT NULL DEFAULT 0 CHECK (included_used >= 0),
  pack_used BIGINT NOT NULL DEFAULT 0 CHECK (pack_used >= 0),
  grace_used BIGINT NOT NULL DEFAULT 0 CHECK (grace_used >= 0),
  pack_balance BIGINT NOT NULL DEFAULT 0 CHECK (pack_balance >= 0),
  notice_level SMALLINT NOT NULL DEFAULT 0 CHECK (notice_level BETWEEN 0 AND 3),
  -- The version whose write raised notice_level, so that write alone reports it.
  notice_version BIGINT NOT NULL DEFAULT 0 CHECK (notice_version >= 0),
  version BIGINT NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  CHECK (updated_at >= created_at)
);
