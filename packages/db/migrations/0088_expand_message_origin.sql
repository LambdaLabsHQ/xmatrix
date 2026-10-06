-- A cross-Channel link (docs/design/evolving-system-zh.md §5): an Agent Run
-- that writes outside its own Channel leaves the Channel it came from and the
-- message it was handling at the time, plus the Run itself so a reply can be
-- relayed back under that Run owner's authority. All are stamped by the server
-- from the Run's own records, never taken from the caller. They stay NULL for
-- every message written in its author's own Channel. The append is the only
-- writer and sets channel and Run together. Plain nullable columns keep this a
-- metadata-only change on the message table: no rewrite, no validation scan.
ALTER TABLE data.messages
  ADD COLUMN origin_channel_id TEXT,
  ADD COLUMN origin_message_id TEXT,
  ADD COLUMN origin_run_id TEXT;
