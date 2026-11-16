-- What a Norn program said to someone (`say`), until it is posted to the program's conversation.
SET LOCAL lock_timeout = '5s';
CREATE TABLE data.norn_notices (
  space_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  program_id TEXT NOT NULL,
  notice_id TEXT NOT NULL,
  -- Who it is for, as the program names them.
  recipient TEXT NOT NULL,
  body TEXT NOT NULL,
  posted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(space_id,program_id,notice_id),
  -- Deferred: a Channel that moves to another Space takes its programs and their notices in one transaction.
  FOREIGN KEY(space_id,program_id) REFERENCES data.norn_programs(space_id,program_id)
    ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX norn_notices_unposted_idx ON data.norn_notices(channel_id) WHERE posted_at IS NULL;
