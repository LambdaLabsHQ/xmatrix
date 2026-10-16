-- Permanent settlement receipts prevent duplicate credits even after normal
-- command/webhook replay records expire. Purchases move and purge with a Space.
CREATE TABLE data.space_credit_purchases (
  purchase_id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  command_id TEXT NOT NULL,
  credits BIGINT NOT NULL CHECK (credits > 0),
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  currency TEXT NOT NULL CHECK (currency = 'usd'),
  provider_session_id TEXT UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('pending','created','completed')),
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  UNIQUE (space_id,command_id),
  CHECK (length(purchase_id) BETWEEN 1 AND 300),
  CHECK (length(command_id) BETWEEN 1 AND 300),
  CHECK (updated_at >= created_at)
);
CREATE INDEX space_credit_purchases_space_idx
  ON data.space_credit_purchases (space_id,created_at);
