-- A complimentary month of Pro, given by an operator for helpful feedback.
-- It sits in the Space's one subscription row as billing provider 'grant'
-- and, like an App Store period, ends on its own at current_period_end:
-- nothing renews and nothing is charged. Old Hubs never write 'grant'.
SET LOCAL lock_timeout = '5s';
ALTER TABLE data.space_billing_subscriptions
  DROP CONSTRAINT space_billing_subscriptions_billing_provider_check,
  ADD CONSTRAINT space_billing_subscriptions_billing_provider_check
    CHECK (billing_provider IN ('stripe','apple','google','grant')) NOT VALID;
ALTER TABLE data.space_billing_subscriptions
  VALIDATE CONSTRAINT space_billing_subscriptions_billing_provider_check;

-- The global ledger: one grant per person, one per piece of feedback,
-- independent of which shard the Space lives on.
CREATE TABLE control.billing_grants (
  grant_id UUID PRIMARY KEY,
  user_id TEXT NOT NULL UNIQUE,
  space_id TEXT NOT NULL,
  reference TEXT NOT NULL UNIQUE,
  reason TEXT NOT NULL,
  actor TEXT NOT NULL,
  seat_quantity INTEGER NOT NULL CHECK (seat_quantity BETWEEN 1 AND 10),
  period_end TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CHECK (length(user_id) BETWEEN 1 AND 300),
  CHECK (length(space_id) BETWEEN 1 AND 300),
  CHECK (length(reference) BETWEEN 1 AND 500),
  CHECK (length(reason) BETWEEN 1 AND 1000),
  CHECK (length(actor) BETWEEN 1 AND 300)
);
CREATE INDEX billing_grants_recent_idx ON control.billing_grants (created_at DESC);
