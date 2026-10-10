-- Where a person can be reached when no client of theirs is open: one row per
-- device or browser they registered for push. Account-level, like sign-in
-- sessions, so it lives beside them rather than in any Space's shard.
--   apns     token = the APNs device token
--   fcm      token = the FCM registration token
--   webpush  token = the subscription endpoint, keys_json = its p256dh and auth
-- device_id is a digest of platform and token: a token belongs to one account
-- at a time, and registering it again moves it to whoever signed in last.
CREATE TABLE control.push_devices (
  device_id TEXT PRIMARY KEY CHECK (length(device_id) = 64),
  user_id TEXT NOT NULL CHECK (length(user_id) BETWEEN 1 AND 300),
  platform TEXT NOT NULL CHECK (platform IN ('apns', 'fcm', 'webpush')),
  token TEXT NOT NULL CHECK (length(token) BETWEEN 1 AND 4096),
  keys_json JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX push_devices_user_idx ON control.push_devices (user_id);

-- A closing or deleted account registers nothing new.
CREATE TRIGGER account_fence BEFORE INSERT ON control.push_devices FOR EACH ROW
  EXECUTE FUNCTION data.fence_deleted_account_insert('user_id');
