-- xmatrix:online-indexes
-- Private-record decision maintenance reads next-due and due rows in
-- data.content_gc_candidates per Space. Migration 0219 indexed content_refs
-- and blob_upload_intents for this pass, leaving content_gc_candidates with
-- only (status, not_before, space_id, object_id), so both maintenance queries
-- scanned the table (~20.9k pending rows on 2026-11-19). This partial
-- expression index lets nextDecisionMaintenance read MIN(...) in one index
-- probe and lets dueDecisionObjects read due rows in effective due order
-- without scanning rows waiting on the 31-day safety window or deleted rows.
CREATE INDEX CONCURRENTLY private_record_gc_due_idx
  ON data.content_gc_candidates (space_id, (GREATEST(not_before, COALESCE(lease_until, not_before))), object_id)
  WHERE reason IN ('decision-expired', 'decision-upload-expired')
    AND status IN ('pending', 'leased')
    AND attempts < 100;
