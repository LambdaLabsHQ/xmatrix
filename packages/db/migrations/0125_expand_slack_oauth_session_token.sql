-- An approved Slack authorization holds its token, encrypted, on its own
-- session row until the daemon consumes it or it expires. The owner's personal
-- secret catalog held it before; secrets now belong to Spaces, and nothing
-- else uses that catalog.
SET LOCAL lock_timeout = '5s';

ALTER TABLE data.slack_oauth_sessions ADD COLUMN token_json JSONB;
ALTER TABLE data.slack_oauth_sessions ADD CONSTRAINT slack_oauth_sessions_token_json_check
  CHECK (token_json IS NULL OR (jsonb_typeof(token_json) = 'object' AND status = 'approved')) NOT VALID;
