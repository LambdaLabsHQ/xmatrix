/** A generalized explicit choice is bound to its original Human publication.
 * Legacy first-message choices have no snapshot. They retain their existing
 * contract; no arbitrary message can acquire that legacy form through Ask. */
export function messageChoiceSourceCurrentSql(choice: string): string {
  return `(${choice}.source_input_version IS NULL OR (${choice}.failure_code IS NULL AND EXISTS (SELECT 1 FROM data.messages original
    WHERE original.space_id=${choice}.space_id AND original.channel_id=${choice}.channel_id
      AND original.message_id=${choice}.message_id AND original.author_kind='user'
      AND original.author_id=${choice}.author_user_id
      AND COALESCE(original.invocation_input_version,original.entity_version)=${choice}.source_input_version
      AND original.body_hash=${choice}.source_body_hash
      AND original.edited_at IS NULL AND original.deleted_at IS NULL AND original.recalled_at IS NULL)))`;
}
