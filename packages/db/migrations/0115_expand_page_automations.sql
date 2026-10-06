-- An Automation belongs to a page (docs/design/pages-live-document.md §6).
-- Its section is wherever the page's text references it, so only the page is
-- stored; it still runs in its own conversation (channel_id). detached_at
-- records that its reference left the page and paused it; the reference
-- coming back resumes it.

-- Fail fast instead of queueing Automation traffic behind this transaction.
SET LOCAL lock_timeout = '5s';

ALTER TABLE data.automations ADD COLUMN page_id TEXT
  CHECK (page_id IS NULL OR length(page_id) BETWEEN 1 AND 300);
ALTER TABLE data.automations ADD COLUMN detached_at TIMESTAMPTZ;

CREATE INDEX automations_page_idx ON data.automations (page_id) WHERE page_id IS NOT NULL;
