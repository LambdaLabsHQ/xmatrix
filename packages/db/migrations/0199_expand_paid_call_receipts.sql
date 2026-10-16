-- Permanent financial receipts: never re-charge or re-send a paid upstream
-- attempt after the ordinary command-replay retention window has expired.
CREATE TABLE data.paid_call_receipts (
  space_id TEXT NOT NULL,
  call_id TEXT NOT NULL CHECK (length(call_id) BETWEEN 1 AND 200),
  actor_user_id TEXT NOT NULL,
  request_digest TEXT NOT NULL,
  kind TEXT NOT NULL,
  reserved_units INTEGER NOT NULL CHECK (reserved_units BETWEEN 1 AND 10000),
  reserved_credits BIGINT NOT NULL CHECK (reserved_credits >= 0),
  allocation_json JSONB NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('reserved','settled')),
  actual_units INTEGER CHECK (actual_units BETWEEN 0 AND reserved_units),
  actual_credits BIGINT CHECK (actual_credits BETWEEN 0 AND reserved_credits),
  outcome TEXT CHECK (outcome IN ('ok','rejected','uncertain')),
  notice_json JSONB,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (space_id,call_id),
  CHECK (updated_at>=created_at)
);

CREATE INDEX paid_call_receipts_space_created_idx ON data.paid_call_receipts (space_id,created_at);
