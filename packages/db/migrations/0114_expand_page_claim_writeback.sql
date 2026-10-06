-- A claim that ended (its pull request merged, released, or lapsed) leaves
-- its section owing an update until the section is edited or the Run says
-- nothing there changed (docs/design/pages-live-document.md §5). The owed
-- update is derived from the claim and the page's revisions; this records only
-- the Run's word that nothing needed writing.
ALTER TABLE data.page_claims ADD COLUMN written_back_at TIMESTAMPTZ;

CREATE INDEX page_claims_ended_idx ON data.page_claims (space_id, page_id, updated_at DESC)
  WHERE written_back_at IS NULL;
