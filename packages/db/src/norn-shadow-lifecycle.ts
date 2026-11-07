/** Shared SQL for the placed operator and the existing lifecycle runner.
 * Source lifetime, rather than an independent comparison timer, owns cleanup.
 * $1 is the maintenance page size; $2 is a Space or NULL for the global runner.
 */
export const nornShadowLifecycleSql = `WITH selected AS MATERIALIZED (
  SELECT comparison.space_id,comparison.comparison_id,
    source.binding_id IS NULL OR source.expires_at<=clock_timestamp() AS expired
  FROM data.norn_shadow_comparisons comparison
  LEFT JOIN data.agent_message_executions source ON source.binding_id=comparison.source_binding_id
    AND source.space_id=comparison.space_id AND source.channel_id=comparison.channel_id
  WHERE ($2::text IS NULL OR comparison.space_id=$2) AND (
    source.binding_id IS NULL OR source.expires_at<=clock_timestamp() OR
    comparison.encrypted_value_json IS NOT NULL AND source.state IN ('completed','failed','interrupted','unknown'))
  ORDER BY comparison.updated_at,comparison.space_id,comparison.comparison_id
  LIMIT $1 FOR UPDATE OF comparison SKIP LOCKED
), closed AS (
  UPDATE data.norn_shadow_comparisons target SET state='incomplete',reason='source_ended',
    revision=revision+1,encrypted_value_json=NULL,next_due_at=NULL,updated_at=clock_timestamp()
  FROM selected WHERE target.space_id=selected.space_id AND target.comparison_id=selected.comparison_id
    AND NOT selected.expired RETURNING target.*
), receipts AS (
  INSERT INTO data.norn_shadow_transitions
    (space_id,comparison_id,channel_id,revision,kind,classification,reason)
  SELECT space_id,comparison_id,channel_id,revision,'end','incomplete','source_ended' FROM closed
), deleted AS (
  DELETE FROM data.norn_shadow_comparisons target USING selected
  WHERE target.space_id=selected.space_id AND target.comparison_id=selected.comparison_id AND selected.expired
  RETURNING target.comparison_id
)
SELECT comparison_id,'closed' AS action FROM closed UNION ALL SELECT comparison_id,'deleted' AS action FROM deleted`;
