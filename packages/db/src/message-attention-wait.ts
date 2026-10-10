/**
 * Whether a declared wait (`awaiting_response`) on the attention row `alias`
 * still stands. It ends with its asker: once the Agent Instance that asked
 * rests in a state no message wakes (stopped, or a wake that failed), nobody
 * is left to take the answer. A sleeping or interrupted Instance still waits:
 * the answer wakes it. Read through the timeline index, only for a row that
 * carries the flag.
 */
export function declaredWaitStandsSql(alias: string): string {
  return `(${alias}.awaiting_response IS TRUE AND NOT EXISTS (
    SELECT 1 FROM data.messages asked JOIN data.instances asker ON asker.instance_id=asked.author_id
    WHERE asked.space_id=${alias}.space_id AND asked.channel_id=${alias}.channel_id
      AND asked.timeline_sequence=${alias}.timeline_sequence AND asked.author_kind='agent'
      AND asker.rest_state IN ('stopped','wake_failed')))`;
}
