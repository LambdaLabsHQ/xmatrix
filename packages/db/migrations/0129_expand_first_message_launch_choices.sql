-- A new conversation's first message that summons nobody offers its author a
-- short window to choose which harness starts, or that none does, while Jev
-- reads the message in parallel. One row per message: whoever writes `choice`
-- first (the author, or Jev once the window closes) decides; the other loses.
-- `recommendation` is what Jev read, shown before the window closes.

-- Fail fast instead of queueing Runtime traffic behind this transaction.
SET LOCAL lock_timeout = '5s';

CREATE TABLE data.first_message_launch_choices (
  channel_id TEXT NOT NULL CHECK (length(channel_id) BETWEEN 1 AND 300),
  message_id TEXT NOT NULL CHECK (length(message_id) BETWEEN 1 AND 300),
  space_id TEXT NOT NULL CHECK (length(space_id) BETWEEN 1 AND 300),
  author_user_id TEXT NOT NULL CHECK (length(author_user_id) BETWEEN 1 AND 300),
  deadline_at TIMESTAMPTZ NOT NULL,
  recommendation TEXT CHECK (recommendation IS NULL OR recommendation IN ('start', 'none')),
  recommended_harness TEXT CHECK (recommended_harness IS NULL OR length(recommended_harness) BETWEEN 1 AND 64),
  choice TEXT CHECK (choice IS NULL OR choice IN ('start', 'none')),
  chosen_harness TEXT CHECK (chosen_harness IS NULL OR length(chosen_harness) BETWEEN 1 AND 64),
  chosen_by TEXT CHECK (chosen_by IS NULL OR chosen_by IN ('author', 'jev')),
  chosen_at TIMESTAMPTZ,
  launch_id TEXT CHECK (launch_id IS NULL OR length(launch_id) BETWEEN 1 AND 300),
  failure_code TEXT CHECK (failure_code IS NULL OR length(failure_code) BETWEEN 1 AND 120),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (channel_id, message_id),
  CHECK ((recommendation = 'start') = (recommended_harness IS NOT NULL)),
  CHECK ((choice IS NULL) = (chosen_by IS NULL) AND (choice IS NULL) = (chosen_at IS NULL)),
  CHECK ((choice = 'start') = (chosen_harness IS NOT NULL)),
  CHECK (launch_id IS NULL OR choice = 'start'),
  CHECK (updated_at >= created_at)
);

CREATE INDEX first_message_launch_choices_space_idx ON data.first_message_launch_choices (space_id);
