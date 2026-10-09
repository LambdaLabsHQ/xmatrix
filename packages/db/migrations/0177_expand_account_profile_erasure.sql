-- Locate private profile copies without scanning every Space's shared work.
CREATE INDEX space_join_requests_private_profile_user_idx
  ON data.space_join_requests(user_id)
  WHERE email IS NOT NULL OR display_name IS NOT NULL OR avatar_url IS NOT NULL;
CREATE INDEX space_deletions_member_snapshot_idx
  ON data.space_deletions USING GIN(members_json jsonb_path_ops)
  WHERE state='scheduled';

-- An in-flight sign-in or profile projection cannot restore erased fields.
CREATE TRIGGER account_fence BEFORE INSERT ON data.space_join_requests FOR EACH ROW
  EXECUTE FUNCTION data.fence_deleted_account_insert('user_id');
CREATE TRIGGER account_fence BEFORE INSERT ON data.human_profiles FOR EACH ROW
  EXECUTE FUNCTION data.fence_deleted_account_insert('user_id','committed-only');
