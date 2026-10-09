-- Serialize provider/checkout admission with account deletion. Verified late
-- Apple notifications for committed identities are acknowledged without grants.
CREATE TRIGGER account_fence BEFORE INSERT ON data.space_billing_subscriptions FOR EACH ROW
  EXECUTE FUNCTION data.fence_deleted_account_insert('billing_owner_user_id');
CREATE TRIGGER account_fence BEFORE INSERT ON data.space_billing_checkout_intents FOR EACH ROW
  EXECUTE FUNCTION data.fence_deleted_account_insert('billing_owner_user_id');
CREATE TRIGGER account_fence BEFORE INSERT ON control.apple_account_tokens FOR EACH ROW
  EXECUTE FUNCTION data.fence_deleted_account_insert('owner_user_id');
