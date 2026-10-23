/** Metadata only. The send-time owner survives Instance/Run cleanup. Messages
 * predating sender previews use their persisted Run registration, when present.
 * A present preview without an owner (including erased profiles) stays unattributed.
 */
export const POSTGRES_ADMIN_MESSAGE_FACTS_QUERY = `SELECT
  message.space_id, message.author_id, message.author_kind, message.created_at,
  CASE WHEN message.author_kind = 'user' THEN message.author_id
    WHEN message.author_kind = 'agent' THEN
      CASE WHEN message.preview_json IS NULL THEN binding.owner_user_id
        ELSE NULLIF(message.preview_json#>>'{senderSnapshot,userId}', '') END
    END AS activity_user_id
  FROM data.messages message
  LEFT JOIN data.instances instance ON message.author_kind = 'agent'
    AND message.preview_json IS NULL AND instance.instance_id = message.author_id
  LEFT JOIN data.run_agent_registrations binding ON binding.run_id = instance.run_id
    AND binding.space_id = message.space_id
  WHERE message.deleted_at IS NULL`;
