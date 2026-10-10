-- A mention asks its target to respond, so it stays with them until they do:
-- reading it no longer clears it. TRUE while the target has not replied in
-- the conversation or reacted to the message; NULL on rows written before
-- this column and on replies and broadcasts, which still clear on read.

-- Fail fast instead of queueing message writes behind this transaction.
SET LOCAL lock_timeout = '5s';

ALTER TABLE data.message_attention ADD COLUMN awaiting_response BOOLEAN;
CREATE INDEX message_attention_awaiting_response_idx
  ON data.message_attention (space_id, subject_id, channel_id) WHERE awaiting_response;
