ALTER TABLE data.messages ADD COLUMN sender_profile_erased_at TIMESTAMPTZ;
ALTER TABLE control.account_deletion_requests ADD COLUMN historical_profile_cleanup_done BOOLEAN;
CREATE INDEX messages_account_profile_erasure_idx ON data.messages(author_kind,author_id,space_id,message_id)
  WHERE sender_profile_erased_at IS NULL;
CREATE INDEX messages_agent_owner_profile_erasure_idx ON data.messages((preview_json#>>'{senderSnapshot,userId}'),space_id,message_id)
  WHERE author_kind='agent' AND sender_profile_erased_at IS NULL;
CREATE INDEX message_receipt_profile_erasure_idx ON data.idempotency_keys(space_id,(result_json->>'messageId'))
  WHERE result_json ? 'senderSnapshot';
CREATE INDEX message_outbox_profile_erasure_idx ON data.outbox(space_id,(payload_json->>'messageId'))
  WHERE payload_json ? 'senderSnapshot';

CREATE FUNCTION data.fence_deleted_message_profile() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE account_id TEXT;
BEGIN
  account_id := CASE WHEN NEW.author_kind='user' THEN NEW.author_id
    WHEN NEW.author_kind='agent' THEN NEW.preview_json#>>'{senderSnapshot,userId}' END;
  IF account_id IS NULL THEN RETURN NEW; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('account-deletion:' || account_id,0));
  IF EXISTS (SELECT 1 FROM data.account_deletion_fences WHERE user_id=account_id
    AND (committed OR expires_at>clock_timestamp()))
    AND (TG_OP='INSERT' OR NEW.sender_profile_erased_at IS NULL) THEN
    RAISE EXCEPTION 'Account is closing or deleted' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER account_profile_fence BEFORE INSERT
  ON data.messages FOR EACH ROW EXECUTE FUNCTION data.fence_deleted_message_profile();
