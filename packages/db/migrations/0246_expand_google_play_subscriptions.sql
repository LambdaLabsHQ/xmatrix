-- Google Play joins Stripe and Apple as a billing provider of the Space's one
-- canonical subscription row. Old Hubs never write 'google'.
SET LOCAL lock_timeout = '5s';
ALTER TABLE data.space_billing_subscriptions
  DROP CONSTRAINT space_billing_subscriptions_billing_provider_check,
  ADD CONSTRAINT space_billing_subscriptions_billing_provider_check
    CHECK (billing_provider IN ('stripe','apple','google')) NOT VALID;
ALTER TABLE data.space_billing_subscriptions
  VALIDATE CONSTRAINT space_billing_subscriptions_billing_provider_check;
ALTER TABLE data.space_billing_checkout_intents
  DROP CONSTRAINT space_billing_checkout_intents_billing_provider_check,
  ADD CONSTRAINT space_billing_checkout_intents_billing_provider_check
    CHECK (billing_provider IN ('stripe','apple','google')) NOT VALID;
ALTER TABLE data.space_billing_checkout_intents
  VALIDATE CONSTRAINT space_billing_checkout_intents_billing_provider_check;

-- Global immutable purchase ownership, independent of a Space's physical shard.
-- The account token travels with the purchase as Play's obfuscated account id.
CREATE TABLE control.google_play_account_tokens (
  account_token UUID PRIMARY KEY,
  space_id TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (space_id, owner_user_id)
);
-- A purchase token, once seen, belongs to the account token it was bought with.
CREATE TABLE control.google_play_purchase_bindings (
  environment TEXT NOT NULL CHECK (environment IN ('Production','Test')),
  purchase_token_digest TEXT NOT NULL CHECK (purchase_token_digest ~ '^[0-9a-f]{64}$'),
  account_token UUID NOT NULL REFERENCES control.google_play_account_tokens(account_token),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (environment, purchase_token_digest)
);
CREATE INDEX google_play_purchase_bindings_account_idx
  ON control.google_play_purchase_bindings(account_token);
-- Serialize purchase admission with account deletion, as for Apple.
CREATE TRIGGER account_fence BEFORE INSERT ON control.google_play_account_tokens FOR EACH ROW
  EXECUTE FUNCTION data.fence_deleted_account_insert('owner_user_id');
