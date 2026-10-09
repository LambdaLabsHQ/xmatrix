-- The directory owns deletion decisions and minimal permanent revocation receipts.
CREATE TABLE control.account_deletion_requests (
  user_id TEXT PRIMARY KEY CHECK (length(user_id) BETWEEN 1 AND 300),
  request_id TEXT NOT NULL UNIQUE CHECK (length(request_id) BETWEEN 1 AND 200),
  state TEXT NOT NULL CHECK (state IN ('preparing','blocked','committed','completed')),
  receipt_hash TEXT NOT NULL CHECK (receipt_hash ~ '^[0-9a-f]{64}$'),
  requested_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  committed_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  lease_token TEXT,
  lease_until TIMESTAMPTZ,
  fences_cleared BOOLEAN NOT NULL DEFAULT FALSE,
  avatar_sweep_after TIMESTAMPTZ,
  avatar_cleanup_done BOOLEAN NOT NULL DEFAULT FALSE,
  confirmation_version INTEGER NOT NULL DEFAULT 1 CHECK (confirmation_version=1)
);
CREATE INDEX account_deletion_pending_idx ON control.account_deletion_requests(state,updated_at)
  WHERE state IN ('preparing','committed');

-- Shard-local admission fences are not a second account/identity authority.
-- Preparing may be aborted before data is erased; committed fences never reopen.
CREATE TABLE data.account_deletion_fences (
  user_id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL,
  committed BOOLEAN NOT NULL DEFAULT FALSE,
  cleaned BOOLEAN NOT NULL DEFAULT FALSE,
  expires_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()+interval '3 minutes',
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE FUNCTION data.fence_deleted_account_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE account_id TEXT;
BEGIN
  IF TG_NARGS>1 AND TG_ARGV[1]='live-run' AND to_jsonb(NEW)->>'status' NOT IN ('starting','running') THEN RETURN NEW; END IF;
  account_id := to_jsonb(NEW)->>TG_ARGV[0];
  IF account_id IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('account-deletion:' || account_id,0));
    IF EXISTS (SELECT 1 FROM data.account_deletion_fences WHERE user_id=account_id
      AND (committed OR (expires_at>clock_timestamp() AND NOT (TG_NARGS>1 AND TG_ARGV[1]='committed-only')))) THEN
      RAISE EXCEPTION 'Account is closing or deleted' USING ERRCODE='55000';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

-- INSERT fences also cover UPSERT, including stale daemon/session refreshes.
CREATE TRIGGER account_fence BEFORE INSERT ON data.spaces FOR EACH ROW
  EXECUTE FUNCTION data.fence_deleted_account_insert('owner_user_id');
CREATE TRIGGER account_fence BEFORE INSERT ON data.space_members FOR EACH ROW
  EXECUTE FUNCTION data.fence_deleted_account_insert('user_id');
CREATE TRIGGER account_fence BEFORE INSERT ON data.runs FOR EACH ROW
  EXECUTE FUNCTION data.fence_deleted_account_insert('owner_user_id','live-run');
CREATE TRIGGER account_fence BEFORE INSERT ON data.machines FOR EACH ROW
  EXECUTE FUNCTION data.fence_deleted_account_insert('owner_user_id');
CREATE TRIGGER account_fence BEFORE INSERT ON data.machine_daemons FOR EACH ROW
  EXECUTE FUNCTION data.fence_deleted_account_insert('owner_user_id');
CREATE TRIGGER account_fence BEFORE INSERT ON data.user_space_locale_preferences FOR EACH ROW
  EXECUTE FUNCTION data.fence_deleted_account_insert('user_id');
CREATE TRIGGER account_fence BEFORE INSERT ON data.user_space_channel_view_preferences FOR EACH ROW
  EXECUTE FUNCTION data.fence_deleted_account_insert('user_id');
CREATE TRIGGER account_fence BEFORE INSERT ON control.auth_users FOR EACH ROW
  EXECUTE FUNCTION data.fence_deleted_account_insert('id');
CREATE TRIGGER account_fence BEFORE INSERT ON control.auth_sessions FOR EACH ROW
  EXECUTE FUNCTION data.fence_deleted_account_insert('user_id','committed-only');
CREATE TRIGGER account_fence BEFORE INSERT ON control.auth_accounts FOR EACH ROW
  EXECUTE FUNCTION data.fence_deleted_account_insert('user_id','committed-only');
CREATE INDEX account_deletion_receipt_idx ON control.account_deletion_requests(request_id,receipt_hash);

CREATE TRIGGER account_fence BEFORE INSERT ON data.agent_registrations FOR EACH ROW
  EXECUTE FUNCTION data.fence_deleted_account_insert('owner_user_id','committed-only');
CREATE TRIGGER account_fence BEFORE INSERT ON control.agent_registration_environments FOR EACH ROW
  EXECUTE FUNCTION data.fence_deleted_account_insert('owner_user_id','committed-only');
CREATE TRIGGER account_fence BEFORE INSERT ON control.agent_environment_commands FOR EACH ROW
  EXECUTE FUNCTION data.fence_deleted_account_insert('owner_user_id','committed-only');
CREATE TRIGGER account_fence BEFORE INSERT ON control.machine_execution_capacity FOR EACH ROW
  EXECUTE FUNCTION data.fence_deleted_account_insert('owner_user_id','committed-only');
CREATE TRIGGER account_fence BEFORE INSERT ON control.agent_registration_enrollments FOR EACH ROW
  EXECUTE FUNCTION data.fence_deleted_account_insert('owner_user_id','committed-only');
CREATE TRIGGER account_fence BEFORE INSERT ON control.registration_quota_observations FOR EACH ROW
  EXECUTE FUNCTION data.fence_deleted_account_insert('owner_user_id','committed-only');
CREATE TRIGGER account_fence BEFORE INSERT ON data.machine_daemon_commands FOR EACH ROW
  EXECUTE FUNCTION data.fence_deleted_account_insert('owner_user_id');
CREATE TRIGGER account_fence BEFORE INSERT ON data.machine_resource_samples FOR EACH ROW
  EXECUTE FUNCTION data.fence_deleted_account_insert('owner_user_id','committed-only');
CREATE TRIGGER account_fence BEFORE INSERT ON data.machine_resource_hourly FOR EACH ROW
  EXECUTE FUNCTION data.fence_deleted_account_insert('owner_user_id','committed-only');
CREATE TRIGGER account_fence BEFORE INSERT ON data.assistant_memory_snapshots FOR EACH ROW
  EXECUTE FUNCTION data.fence_deleted_account_insert('owner_user_id','committed-only');
CREATE TRIGGER account_fence BEFORE INSERT ON data.shared_memory_entries FOR EACH ROW
  EXECUTE FUNCTION data.fence_deleted_account_insert('owner_user_id','committed-only');
CREATE TRIGGER account_fence BEFORE INSERT ON data.shared_memory_workspace_entries FOR EACH ROW
  EXECUTE FUNCTION data.fence_deleted_account_insert('owner_user_id','committed-only');
CREATE TRIGGER account_fence BEFORE INSERT ON data.roles FOR EACH ROW
  EXECUTE FUNCTION data.fence_deleted_account_insert('owner_user_id','committed-only');
CREATE TRIGGER account_fence BEFORE INSERT ON data.workspaces FOR EACH ROW
  EXECUTE FUNCTION data.fence_deleted_account_insert('owner_user_id','committed-only');
