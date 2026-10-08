-- Provider identity is explicit; existing subscriptions and intents remain Stripe.
ALTER TABLE data.space_billing_subscriptions ADD COLUMN billing_provider TEXT DEFAULT 'stripe'
  CHECK (billing_provider IN ('stripe','apple'));
ALTER TABLE data.space_billing_checkout_intents ADD COLUMN billing_provider TEXT DEFAULT 'stripe'
  CHECK (billing_provider IN ('stripe','apple'));

-- Global immutable purchase ownership, independent of a Space's physical shard.
-- Entitlement state remains in the Space's canonical billing row.
CREATE TABLE control.apple_account_tokens (
  app_account_token UUID PRIMARY KEY,
  space_id TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (space_id, owner_user_id)
);
CREATE TABLE control.apple_subscription_bindings (
  environment TEXT NOT NULL CHECK (environment IN ('Production','Sandbox')),
  original_transaction_id TEXT NOT NULL CHECK (length(original_transaction_id) BETWEEN 1 AND 100),
  app_account_token UUID NOT NULL REFERENCES control.apple_account_tokens(app_account_token),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (environment, original_transaction_id)
);
CREATE INDEX apple_subscription_bindings_account_idx
  ON control.apple_subscription_bindings(app_account_token);
