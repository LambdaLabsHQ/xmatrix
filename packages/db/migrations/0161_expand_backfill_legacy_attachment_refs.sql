-- Attachments written before PostgreSQL became the message authority
-- (2026-09-08) kept their object facts in the message row but never got an
-- attachment ref, so no reader could open them: product media refused every
-- one, and Agents reading those histories retried each refused image on every
-- read (about 2.5 refusals a second on 2026-10-05, the largest single source
-- of database round trips). Record each such attachment's ref from the facts
-- its own message already carries. Its R2 object is the content-addressed
-- `objects/<sha256>` the message names, and its owner is the human the
-- message's author belongs to. Additive and idempotent: an existing ref is
-- never changed, and a fact that does not have the stored shape is skipped.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $$
DECLARE
  pending BIGINT;
BEGIN
  -- Refuse an unexpectedly large operation before any row is written.
  SELECT count(*) INTO pending
  FROM data.messages message
  CROSS JOIN LATERAL jsonb_array_elements(message.attachments_json) attachment
  WHERE jsonb_typeof(message.attachments_json) = 'array'
    AND message.deleted_at IS NULL AND message.recalled_at IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM data.message_attachment_refs ref
      WHERE ref.space_id = message.space_id AND ref.message_id = message.message_id
        AND ref.attachment_id = attachment->>'id'
    );
  IF pending > 100000 THEN RAISE EXCEPTION 'Legacy attachment ref backfill exceeds 100000 rows'; END IF;
END $$;

INSERT INTO data.message_attachment_refs
  (space_id, attachment_id, message_id, channel_id, owner_user_id, object_key, content_hash,
   encoded_bytes, mime_type, name, presentation_residual_json, version, created_at, updated_at)
SELECT message.space_id, attachment->>'id', message.message_id, message.channel_id,
  CASE
    WHEN message.author_kind = 'user' THEN message.author_id
    WHEN message.author_kind = 'agent' AND message.author_id ~ '^agent:[^:]+:' THEN split_part(message.author_id, ':', 2)
  END,
  attachment->>'objectKey', attachment->>'contentHash', (attachment->>'size')::bigint,
  attachment->>'mimeType', attachment->>'name',
  NULLIF(attachment - ARRAY['id', 'kind', 'name', 'size', 'version', 'mimeType', 'channelId', 'messageId',
    'objectKey', 'contentHash'], '{}'::jsonb),
  (attachment->>'version')::bigint, message.sent_at, message.sent_at
FROM data.messages message
CROSS JOIN LATERAL jsonb_array_elements(message.attachments_json) attachment
WHERE jsonb_typeof(message.attachments_json) = 'array'
  AND jsonb_typeof(attachment) = 'object'
  AND message.deleted_at IS NULL AND message.recalled_at IS NULL
  AND length(attachment->>'id') BETWEEN 1 AND 300
  AND attachment->>'contentHash' ~ '^[a-f0-9]{64}$'
  AND attachment->>'objectKey' = 'objects/' || (attachment->>'contentHash')
  AND attachment->>'size' ~ '^[1-9][0-9]{0,15}$'
  AND attachment->>'version' ~ '^[1-9][0-9]{0,15}$'
  AND length(attachment->>'mimeType') BETWEEN 1 AND 300
  AND length(attachment->>'name') BETWEEN 1 AND 1000
  AND COALESCE(attachment->>'channelId', message.channel_id) = message.channel_id
  AND COALESCE(attachment->>'messageId', message.message_id) = message.message_id
ON CONFLICT (space_id, message_id, attachment_id) DO NOTHING;
